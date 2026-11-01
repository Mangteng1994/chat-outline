/*
 * 对话大纲 + 提示词库
 * 为 Claude、ChatGPT、DeepSeek、Gemini、Kimi 和豆包网页版添加：按提问分组的多级标题目录、星标、提示词库（含 {{变量}} 与 // 快速插入）。
 * 数据保存在 chrome.storage.local；只有用户设置了自己的网盘时，提示词才会同步过去（见 background.js）。
 */
(() => {
  'use strict';
  if (window.__chatOutlineLoaded) return;
  window.__chatOutlineLoaded = true;

  // ---------------------------------------------------------------------------
  // 站点配置：页面结构变化时，通常只需要改这里的选择器
  // ---------------------------------------------------------------------------
  const SITES = {
    claude: {
      user: ['[data-testid="user-message"]'],
      assistant: ['.font-claude-response', '.font-claude-message', '[data-is-streaming]'],
      composer: ['div.ProseMirror[contenteditable="true"]', 'fieldset [contenteditable="true"]', 'textarea'],
      // 消息在整个对话中的绝对序号，虚拟列表卸载消息后靠它排序
      order: (el) => {
        const row = el.closest('[data-index]');
        return row ? +row.getAttribute('data-index') : null;
      },
    },
    chatgpt: {
      // 按顺序尝试，使用第一个能找到内容的选择器
      // 新版页面的 data-conversation-role 只在隐藏的“You said:”标题上，不能用来取消息内容
      user: ['[data-user-message-bubble="true"]', '[data-message-author-role="user"]', 'article[data-turn="user"]', '[data-turn="user"]'],
      assistant: ['[data-markdown-text-style="assistant-message"]', '[data-message-author-role="assistant"]', 'article[data-turn="assistant"]', '[data-turn="assistant"]'],
      composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'form textarea'],
      // 切换对话后旧对话仍留在页面的隐藏容器里，只读取可见容器中的消息
      pane: '[data-app-action-timeline-scroll]',
      order: (el) => {
        const turn = el.closest('[data-content-search-turn-key]');
        const m = turn && turn.getAttribute('data-content-search-turn-key').match(/(\d+)$/);
        return m ? +m[1] : null;
      },
    },
    deepseek: {
      user: ['.fbb737a4', '.ds-message:not(:has(.ds-markdown))'],
      assistant: ['.ds-message .ds-markdown', '.ds-markdown'],
      composer: ['textarea#chat-input', 'textarea'],
      order: (el) => {
        const row = el.closest('[data-virtual-list-item-key]');
        return row ? +row.getAttribute('data-virtual-list-item-key') : null;
      },
    },
    gemini: {
      user: ['user-query .query-text', 'user-query'],
      assistant: ['model-response .markdown', 'model-response'],
      composer: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]'],
      // 页面上没有绝对序号，id 也不递增，只能标识消息；位置由 fillOrders 推算
      turn: (el) => el.closest('.conversation-container')?.id,
    },
    kimi: {
      // 提问可以只有图片，所以取整个气泡，操作按钮的文字由 HIDDEN_SEL 去掉
      user: ['.segment-user'],
      assistant: ['.segment-assistant'],
      composer: ['.chat-input-editor[contenteditable="true"]', '[data-lexical-editor="true"]', 'textarea'],
      turn: (el) => el.closest('[data-archer-id]')?.getAttribute('data-archer-id'),
      // 消息 id 开头是毫秒时间戳，同一轮的提问和回答相同，回答排在后面
      order: (el) => {
        const m = (CFG.turn(el) || '').match(/^([0-9a-f]{8})-([0-9a-f]{4})/);
        return m ? parseInt(m[1] + m[2], 16) * 2 + (el.matches('.segment-assistant') ? 1 : 0) : null;
      },
    },
    doubao: {
      user: ['[data-testid="send_message"]', '[data-message-role="user"]'],
      assistant: ['[data-testid="receive_message"]', '[data-message-role="assistant"]'],
      composer: ['div.ProseMirror[contenteditable="true"]', 'textarea[data-testid="chat_input_input"]', 'textarea'],
      // 消息 id 不递增，不能当序号；位置由 fillOrders 推算
      turn: (el) => el.querySelector('[data-message-id]')?.getAttribute('data-message-id'),
    },
  };
  const SITE_HOSTS = [
    ['claude', /(^|\.)claude\.ai$/],
    ['deepseek', /(^|\.)deepseek\.com$/],
    ['gemini', /^gemini\.google\.com$/],
    ['kimi', /(^|\.)(kimi\.com|kimi\.moonshot\.cn)$/],
    ['doubao', /(^|\.)doubao\.com$/],
  ];
  const SITE = (SITE_HOSTS.find(([, re]) => re.test(location.hostname)) || ['chatgpt'])[0];
  const CFG = SITES[SITE];

  const HEADING_SEL = 'h1,h2,h3,h4,h5,h6';
  // 不属于消息内容的隐藏文字和按钮
  const HIDDEN_SEL = '.sr-only, .cdk-visually-hidden, .segment-user-action-row, .segment-user-actions, [data-testid="send_message"] time';
  const SCROLL_OFFSET = 90; // 跳转时为顶部固定栏预留的距离
  const DEFAULT_SETTINGS = { open: true, tab: 'outline', depth: 3, starredOnly: false };

  // ---------------------------------------------------------------------------
  // 存储（扩展环境用 chrome.storage.local；否则回退到 localStorage，便于测试）
  // ---------------------------------------------------------------------------
  const hasChromeStorage = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
  const store = {
    async get(key, fallback) {
      try {
        if (hasChromeStorage) {
          const r = await chrome.storage.local.get(key);
          return r[key] === undefined ? fallback : r[key];
        }
        const v = localStorage.getItem('chat-outline:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        if (hasChromeStorage) await chrome.storage.local.set({ [key]: value });
        else localStorage.setItem('chat-outline:' + key, JSON.stringify(value));
      } catch (e) {
        /* 存储失败不影响使用 */
      }
    },
  };

  // ---------------------------------------------------------------------------
  // 工具函数
  // ---------------------------------------------------------------------------
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };
  const qsaAll = (sels) => {
    const set = new Set();
    for (const s of sels) {
      try {
        document.querySelectorAll(s).forEach((el) => set.add(el));
      } catch (e) {
        /* 忽略无效选择器 */
      }
    }
    return [...set];
  };
  // 按顺序尝试选择器，返回第一个有结果的
  const qsaFirst = (sels) => {
    for (const s of sels) {
      try {
        const found = [...document.querySelectorAll(s)];
        if (found.length) return found;
      } catch (e) {
        /* 忽略无效选择器 */
      }
    }
    return [];
  };
  // 读取元素文字，去掉屏幕阅读器专用的隐藏文字（如 ChatGPT 的“You said:”、Gemini 的“你说”）
  const visibleText = (el) => {
    if (!el.querySelector(HIDDEN_SEL)) return el.innerText || el.textContent;
    const c = el.cloneNode(true);
    c.querySelectorAll(HIDDEN_SEL).forEach((x) => x.remove());
    return c.textContent;
  };
  const inActivePane = (els) => {
    if (!CFG.pane) return els;
    const seen = new Map();
    return els.filter((el) => {
      const pane = el.closest(CFG.pane);
      if (!pane) return true;
      if (!seen.has(pane)) seen.set(pane, pane.getBoundingClientRect().width > 0);
      return seen.get(pane);
    });
  };
  // 只保留最外层的匹配元素，避免同一条消息被重复计算
  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));
  const docOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const extractVars = (text) => {
    const names = [];
    const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
    let m;
    while ((m = re.exec(text))) if (!names.includes(m[1])) names.push(m[1]);
    return names;
  };
  const fillVars = (text, values) => text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, n) => (values[n] ?? ''));

  // 提问内容不会变，缓存后刷新时不必再读 innerText（它会触发页面重新排版）
  const userTexts = new WeakMap();
  const userText = (el) => {
    if (userTexts.has(el)) return userTexts.get(el);
    const text = clean(visibleText(el));
    if (text) userTexts.set(el, text);
    return text;
  };

  const ICON = {
    star: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    fold: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4l5 5 5-5M7 20l5-5 5 5"/></svg>',
    unfold: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9l5-5 5 5M7 15l5 5 5-5"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    down2: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12M7 11l5 5 5-5M5 20h14"/></svg>',
    reload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 4v4.5h-4.5"/></svg>',
    sync: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.5 1.5A3.8 3.8 0 0 1 17 18"/><path d="M12 11v8M9 14l3-3 3 3"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4l16 16M10 5.8a9 9 0 0 1 2-.3c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3 3.7M6.5 7.6A16 16 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.2-1"/></svg>',
    up2: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8M7 13l5-5 5 5M5 4h14"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  // 对话 id；不在对话页时用路径，例如 /new
  const convKey = () => (location.pathname.match(/\/(?:c|chat|app)\/(?:s\/)?([^/]+)/) || [])[1] || location.pathname;
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    prompts: [],
    tombstones: [], // 已删除提示词的记录，同步时告诉其他电脑也删除
    syncEnabled: false,
    syncStatus: null,
    stars: new Set(),
    marks: { stars: {}, hidden: {} },
    hidden: new Set(), // 隐藏的条目，key 与折叠状态相同（g:… / h:…）
    showHidden: false,
    collapsed: new Set(),
    path: location.pathname,
    conv: convKey(),
    caches: new Map(), // 对话 id → 消息缓存（消息 id → 消息）
    owners: new Map(), // 消息 id → 所属对话
    seq: 0,
    seek: 0, // 定位未加载条目的序号，变化后旧的定位停止
    model: [],
    sig: '',
    outlineQuery: '',
    searchOpen: false,
    promptQuery: '',
    promptTag: '',
    editing: null, // 正在编辑的提示词（新建时 id 为 null）
    confirmDelete: null,
    activeId: null,
    pin: null, // 点击目录后锁定高亮的条目 { key, idx }，用户滚动时解除
    caret: null, // 输入框中最后的光标位置
    picker: null, // // 快速插入的状态
    varMemory: {},
  };
  // 星标和隐藏按对话保存，每项记录状态和修改时间，同步时才能判断取消和标记哪个新
  const marksKey = () => 'marks:' + location.hostname + ':' + convKey();

  // ---------------------------------------------------------------------------
  // 界面（Shadow DOM，样式与网页互不影响）
  // ---------------------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'chat-outline-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 0; left: 0; width: 0; height: 0;';
  const root = host.attachShadow({ mode: 'open' });
  // 防止网页的全局快捷键抢走面板里输入框的按键
  ['keydown', 'keyup', 'keypress', 'input', 'paste', 'copy', 'cut'].forEach((t) =>
    host.addEventListener(t, (e) => e.stopPropagation())
  );

  root.innerHTML = `
<style>
:host { --bg:#ffffff; --bg2:#f6f6f4; --bd:rgba(0,0,0,.1); --bd2:rgba(0,0,0,.18); --tx:#1f1f1e; --tx2:#5f5e5a; --tx3:#9a9893;
  --ac-bg:#e6f0fb; --ac-tx:#185fa5; --ok-bg:#e3f2e8; --ok-tx:#2b6f3e; --star:#d99a0b; --danger:#b42318; --shadow:0 6px 24px rgba(0,0,0,.12); }
:host([data-theme="dark"]) { color-scheme:dark; --bg:#262624; --bg2:#30302e; --bd:rgba(255,255,255,.1); --bd2:rgba(255,255,255,.2); --tx:#ececea; --tx2:#b4b2a9; --tx3:#85837c;
  --ac-bg:#1d3a5c; --ac-tx:#a9cdf2; --ok-bg:#1f3d2a; --ok-tx:#9fd9b0; --star:#f2b632; --danger:#f19a90; --shadow:0 6px 24px rgba(0,0,0,.45); }
* { box-sizing:border-box; }
[hidden] { display:none !important; }
#view-outline, #view-prompts, #plistview { display:flex; flex-direction:column; min-height:0; flex:1; }
.wrap { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color:var(--tx); }
button { font:inherit; color:inherit; background:none; border:none; cursor:pointer; padding:0; }
input, textarea { font:inherit; color:var(--tx); background:var(--bg); border:1px solid var(--bd2); border-radius:8px; padding:6px 8px; width:100%; outline:none; }
input:focus, textarea:focus { border-color:var(--ac-tx); }
textarea { resize:vertical; min-height:140px; line-height:1.5; }

.panel { position:fixed; top:64px; right:12px; width:310px; max-height:calc(100vh - 88px); display:flex; flex-direction:column;
  background:var(--bg); border:1px solid var(--bd); border-radius:14px; box-shadow:var(--shadow); overflow:hidden; }
.panel[hidden] { display:none; }
.tabs { display:flex; align-items:center; gap:4px; padding:10px 10px 8px; border-bottom:1px solid var(--bd); }
.tab { flex:none; padding:4px 8px; border-radius:8px; color:var(--tx2); white-space:nowrap; }
#tabtools { display:inline-flex; flex:none; }
.tab.on { background:var(--bg2); color:var(--tx); font-weight:600; }
.sp { flex:1; }
.ib { width:26px; height:26px; display:inline-flex; align-items:center; justify-content:center; border-radius:7px; color:var(--tx3); }
.ib:hover { background:var(--bg2); color:var(--tx); }
.ib.on { color:var(--ac-tx); background:var(--ac-bg); }
.bar { display:flex; align-items:center; gap:8px; padding:8px 10px 4px; }
.seg { display:inline-flex; border:1px solid var(--bd); border-radius:8px; overflow:hidden; }
.seg button { padding:2px 9px; font-size:12px; color:var(--tx2); }
.seg button + button { border-left:1px solid var(--bd); }
.seg button.on { background:var(--bg2); color:var(--tx); font-weight:600; }
.chip { display:inline-flex; align-items:center; gap:4px; font-size:12px; color:var(--tx3); padding:2px 6px; border-radius:7px; }
.chip:hover { background:var(--bg2); }
.chip.on { color:var(--star); }
.searchrow { padding:6px 10px 2px; }
.body { overflow:auto; padding:6px 10px 12px; flex:1; }
.empty { color:var(--tx3); padding:24px 6px; text-align:center; line-height:1.7; }

.grp { padding:8px 6px; border-radius:10px; }
.grp + .grp { margin-top:4px; }
.ghead { display:flex; align-items:center; gap:6px; }
.badge { background:var(--ok-bg); color:var(--ok-tx); font-size:11px; font-weight:600; padding:0 6px; border-radius:6px; line-height:18px; }
.lbl, .cnt { font-size:12px; color:var(--tx3); }
.gstar, .ghide { visibility:hidden; flex:none; color:var(--tx3); }
.grp:hover > .ghead .gstar, .grp:hover > .ghead .ghide, .gstar.on, .ghide.on { visibility:visible; }
.ghead .ib { width:22px; height:22px; flex:none; }
.ghead { gap:4px; }
.node { position:relative; }
.nhide { display:none; position:absolute; right:2px; top:2px; color:var(--tx3); background:var(--bg2); }
.node:hover .nhide, .nhide.on { display:inline-flex; }
.gstar.on { color:var(--star); }
.ghide.on, .nhide.on { color:var(--ac-tx); }
.nhide { width:20px; height:20px; }
.hid { opacity:.5; }
.hbar { display:flex; align-items:center; justify-content:space-between; padding:2px 10px; font-size:12px; color:var(--tx3); }
.hbar button { color:var(--ac-tx); }
.chev { color:var(--tx3); }
.gtext { flex:1; min-width:0; font-weight:600; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-radius:6px; padding:1px 4px; }
.gtext:hover { background:var(--bg2); }
.tree { border-left:1px solid var(--bd2); margin:6px 0 0 6px; }
.node { display:flex; align-items:flex-start; gap:2px; border-radius:6px; cursor:pointer; padding:3px 6px 3px 0; }
.node:hover { background:var(--bg2); }
.node .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.node .tg { width:18px; flex:none; height:20px; display:inline-flex; align-items:center; justify-content:center; color:var(--tx3); }
.d1 .t { color:var(--tx); }
.d2 .t { color:var(--tx2); }
.d3 .t, .d4 .t, .d5 .t, .d6 .t { color:var(--tx3); }
.active, .gtext.active { background:var(--ac-bg) !important; }
.active .t, .gtext.active { color:var(--ac-tx) !important; }
mark { background:rgba(242,182,50,.35); color:inherit; border-radius:3px; }

.tags { display:flex; flex-wrap:wrap; gap:6px; padding:6px 10px 2px; }
.tag { font-size:12px; padding:2px 9px; border-radius:8px; color:var(--tx2); border:1px solid var(--bd); }
.tag.on { background:var(--bg2); color:var(--tx); font-weight:600; }
.card { border:1px solid var(--bd); border-radius:10px; padding:8px 10px; margin-top:8px; }
.ctitle { font-weight:600; display:flex; align-items:center; gap:6px; }
.ctag { font-size:11px; color:var(--tx3); font-weight:400; }
.cprev { color:var(--tx3); font-size:12px; margin-top:2px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; white-space:pre-line; }
.cact { display:flex; gap:12px; margin-top:6px; font-size:12px; color:var(--tx2); }
.cact button:hover { color:var(--tx); text-decoration:underline; }
.cact .del:hover, .cact .danger { color:var(--danger); }
.form label { display:block; font-size:12px; color:var(--tx3); margin:10px 0 3px; }
.hint { font-size:12px; color:var(--tx3); margin-top:4px; }
.btns { display:flex; justify-content:flex-end; gap:8px; margin-top:12px; }
.btn { border:1px solid var(--bd2); border-radius:8px; padding:5px 14px; }
.btn:hover { background:var(--bg2); }
.btn.pri { background:var(--tx); color:var(--bg); border-color:var(--tx); }
.btn.pri:hover { opacity:.88; }

.fab { position:fixed; top:120px; right:0; display:flex; align-items:center; gap:4px; padding:8px 8px 8px 10px; background:var(--bg); color:var(--tx2);
  border:1px solid var(--bd); border-right:none; border-radius:10px 0 0 10px; box-shadow:var(--shadow); font-size:12px; writing-mode:horizontal-tb; }
.fab:hover { color:var(--tx); }
.fab[hidden] { display:none; }

.picker { position:fixed; width:340px; max-height:300px; overflow:auto; background:var(--bg); border:1px solid var(--bd); border-radius:10px; box-shadow:var(--shadow); padding:4px; }
.picker[hidden] { display:none; }
.pi { display:flex; justify-content:space-between; gap:10px; padding:6px 8px; border-radius:7px; cursor:pointer; }
.pi .pt { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pi .ptag { font-size:11px; color:var(--tx3); flex:none; }
.pi.on { background:var(--ac-bg); color:var(--ac-tx); }
.pi.on .ptag { color:var(--ac-tx); }
.syncbar { flex:none; display:flex; align-items:center; gap:4px; padding:3px 8px 3px 12px; border-top:1px solid var(--bd); }
.syncbar[hidden] { display:none; }
.syncline { flex:1; min-width:0; font-size:12px; color:var(--tx3); text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.syncline:hover { color:var(--tx); }
.syncline.err { color:var(--danger); }
.pfoot { font-size:11px; color:var(--tx3); padding:4px 8px 2px; border-top:1px solid var(--bd); margin-top:4px; }

.modal { position:fixed; inset:0; background:rgba(0,0,0,.25); display:flex; align-items:center; justify-content:center; }
.modal[hidden] { display:none; }
.dialog { width:360px; max-width:calc(100vw - 32px); background:var(--bg); border:1px solid var(--bd); border-radius:14px; box-shadow:var(--shadow); padding:16px; }
.dtitle { font-weight:600; font-size:14px; }

.toast { position:fixed; bottom:28px; left:50%; transform:translateX(-50%); background:var(--tx); color:var(--bg); padding:7px 14px; border-radius:8px; font-size:13px; }
.toast[hidden] { display:none; }
</style>
<div class="wrap">
  <button class="fab" id="fab" hidden title="打开目录 (Alt+O)">${ICON.list}<span>目录</span></button>
  <div class="panel" id="panel">
    <div class="tabs">
      <button class="tab" data-tab="outline">目录</button>
      <button class="tab" data-tab="prompts">提示词</button>
      <span class="sp"></span>
      <span id="tabtools"></span>
      <button class="ib" id="close" title="收起 (Alt+O)">${ICON.x}</button>
    </div>
    <div id="view-outline">
      <div class="bar">
        <div class="seg" id="depth">
          <button data-depth="1">1级</button><button data-depth="2">2级</button><button data-depth="3">3级</button><button data-depth="9">全部</button>
        </div>
        <span class="sp"></span>
        <button class="chip" id="starred" title="只显示标了星的提问">${ICON.star}<span>只看标记</span></button>
        <button class="ib" id="reoutline" title="刷新目录">${ICON.reload}</button>
      </div>
      <div class="searchrow" id="osearch" hidden><input id="oq" placeholder="搜索提问和标题" /></div>
      <div class="hbar" id="hbar" hidden></div>
      <div class="body" id="olist"></div>
    </div>
    <div id="view-prompts" hidden>
      <div id="plistview">
        <div class="searchrow"><input id="pq" placeholder="搜索提示词" /></div>
        <div class="tags" id="ptags"></div>
        <div class="body" id="plist"></div>
      </div>
      <div class="body form" id="pform" hidden></div>
    </div>
    <div class="syncbar" id="syncbar" hidden>
      <button class="syncline" id="syncline"></button>
      <button class="ib" id="syncnow" title="立即同步">${ICON.sync}</button>
    </div>
  </div>
  <div class="picker" id="picker" hidden></div>
  <div class="modal" id="modal" hidden><div class="dialog" id="dialog"></div></div>
  <div class="toast" id="toast" hidden></div>
  <input type="file" id="file" accept="application/json,.json" hidden />
</div>`;

  const $ = (sel) => root.querySelector(sel);
  const panel = $('#panel');
  const fab = $('#fab');
  const olist = $('#olist');
  const plist = $('#plist');
  const pform = $('#pform');
  const picker = $('#picker');
  const modal = $('#modal');
  const dialog = $('#dialog');

  let toastTimer;
  let edgeTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 1800);
  }

  // ---------------------------------------------------------------------------
  // 深浅色主题：跟随网页
  // ---------------------------------------------------------------------------
  function detectDark() {
    const html = document.documentElement;
    const mode = html.getAttribute('data-mode') || html.getAttribute('data-theme') || '';
    if (/dark/i.test(mode) || html.classList.contains('dark')) return true;
    if (/light/i.test(mode) || html.classList.contains('light')) return false;
    for (const el of [document.body, html]) {
      const m = el && getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && m.length >= 3 && (m[3] === undefined || +m[3] > 0)) {
        const lum = (0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2]) / 255;
        return lum < 0.5;
      }
    }
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function applyTheme() {
    host.setAttribute('data-theme', detectDark() ? 'dark' : 'light');
  }

  // ---------------------------------------------------------------------------
  // 读取对话结构
  // ---------------------------------------------------------------------------
  // 网站没有绝对序号时，按新消息在页面上的前后邻居确定位置，这样往上滚动发现的消息也能排在前面
  function fillOrders(live, cache) {
    for (let i = 0; i < live.length; i++) {
      if (live[i].order !== undefined) continue;
      let end = i;
      while (end < live.length && live[end].order === undefined) end++;
      const count = end - i;
      const before = i ? live[i - 1].order : null;
      const after = end < live.length ? live[end].order : null;
      const known = [...cache.values()].map((m) => m.order).filter((o) => o !== undefined);
      const low = before ?? (after !== null ? after - count - 1 : Math.max(0, ...known));
      const step = after !== null ? (after - low) / (count + 1) : 1;
      for (let k = 0; k < count; k++) live[i + k].order = low + step * (k + 1);
      i = end - 1;
    }
  }

  // 把页面上当前存在的消息写入缓存，返回这些消息
  function scanMessages() {
    const conv = convKey();
    if (!S.caches.has(conv)) S.caches.set(conv, new Map());
    const cache = S.caches.get(conv);
    const users = outermost(inActivePane(qsaFirst(CFG.user)));
    const assistants = outermost(inActivePane(SITE === 'claude' ? qsaAll(CFG.assistant) : qsaFirst(CFG.assistant))).filter(
      (a) => !users.some((u) => u.contains(a) || a.contains(u))
    );
    const items = [
      ...users.map((el) => ({ type: 'user', el })),
      ...assistants.map((el) => ({ type: 'assistant', el })),
    ].sort((a, b) => docOrder(a.el, b.el));

    const live = [];
    const counts = {};
    let lastUser = 'top';
    for (const { type, el } of items) {
      const order = CFG.order ? CFG.order(el) : null;
      const turn = CFG.turn ? CFG.turn(el) : el.closest('[data-turn-key]')?.getAttribute('data-turn-key');
      let slot;
      if (turn) slot = turn + ':' + type;
      else if (order !== null) slot = conv + ':o' + order + ':' + type; // 序号只在同一对话内唯一
      else if (type === 'user') slot = 'u' + hash(userText(el).slice(0, 300)) + ':user';
      else slot = lastUser + ':after'; // 回答的文字还在变，用它前面的提问来标识
      if (type === 'user') lastUser = slot;
      const sub = (counts[slot] = (counts[slot] || 0) + 1) - 1;
      const id = slot + ':' + sub;
      // 切换对话的瞬间页面上可能还是旧对话
      const owner = S.owners.get(id);
      if (owner && owner !== conv) {
        if (owner[0] !== '/') continue;
        S.caches.get(owner).delete(id); // /new 变成正式对话时消息跟着走
      }
      S.owners.set(id, conv);
      const msg = cache.get(id) || { id, type, sub, seq: S.seq++, headings: [] };
      msg.el = el;
      msg.order = order ?? msg.order;
      if (type === 'user') {
        msg.text = userText(el) || '（空白提问）';
        if (!msg.key) {
          msg.base = hash(msg.text.slice(0, 300));
          msg.key = msg.base + '-' + ([...cache.values()].filter((m) => m.base === msg.base).length + 1);
        }
      } else {
        const heads = [];
        el.querySelectorAll(HEADING_SEL).forEach((h) => {
          if (h.closest('pre, code, .sr-only')) return;
          const text = clean(h.textContent);
          if (text) heads.push({ el: h, level: +h.tagName[1], text });
        });
        if (heads.length || !msg.headings.length) msg.headings = heads; // 回答可能还没渲染完
      }
      cache.set(id, msg);
      live.push(msg);
    }
    fillOrders(live, cache);
    // 重新生成或编辑后，同一位置换了新消息，旧的要去掉
    const liveIds = new Set(live.map((m) => m.id));
    const taken = new Set(live.map((m) => m.order + m.type));
    const first = live.length ? live[0].order : 0;
    const last = live.length ? live[live.length - 1].order : 0;
    for (const m of cache.values()) {
      // 页面上的消息是连续的，夹在中间却不在页面上的也已被替换
      if (!liveIds.has(m.id) && (taken.has(m.order + m.type) || (m.order > first && m.order < last))) {
        cache.delete(m.id);
        S.owners.delete(m.id);
      }
    }
    return live;
  }

  function buildModel() {
    scanMessages();
    const msgs = [...S.caches.get(convKey()).values()].sort(
      (a, b) => a.order - b.order || (a.type === b.type ? a.sub - b.sub : a.type === 'user' ? -1 : 1)
    );
    const groups = [];
    let cur = null;
    for (const m of msgs) {
      if (m.type === 'user' || !cur) {
        const isUser = m.type === 'user';
        cur = { key: isUser ? m.key : 'a-' + m.id, el: m.el, msg: m, text: isUser ? m.text : '（提问未加载）', headings: [], answers: [] };
        groups.push(cur);
      }
      if (m.type === 'assistant') {
        cur.answers.push(m);
        m.headings.forEach((h, mi) => cur.headings.push({ ...h, msg: m, mi }));
      }
    }
    // 为每组标题建树：depth 是相对层级（回答里最高一级标题为 1）
    groups.forEach((g, gi) => {
      g.index = gi;
      const rootNode = { level: 0, depth: 0, children: [] };
      const stack = [rootNode];
      g.headings.forEach((h, hi) => {
        while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
        const parent = stack[stack.length - 1];
        const node = { ...h, id: `h${gi}.${hi}`, idx: hi, depth: parent.depth + 1, parentId: parent.id || `u${gi}`, children: [] };
        parent.children.push(node);
        stack.push(node);
      });
      g.tree = rootNode.children;
      g.id = `u${gi}`;
    });
    return groups;
  }

  function signature(model) {
    return model.map((g) => g.key + '|' + g.headings.map((h) => h.level + h.text).join('|')).join('||');
  }

  // ---------------------------------------------------------------------------
  // 目录渲染
  // ---------------------------------------------------------------------------
  function highlight(text, q) {
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return esc(text);
    return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
  }

  function filterTree(nodes, q) {
    const out = [];
    for (const n of nodes) {
      const kids = filterTree(n.children, q);
      if (n.text.toLowerCase().includes(q) || kids.length) out.push({ ...n, children: kids });
    }
    return out;
  }

  function renderNodes(g, nodes, q) {
    const maxDepth = q ? 99 : S.settings.depth;
    let html = '';
    for (const n of nodes) {
      if (n.depth > maxDepth) continue;
      const ck = 'h:' + g.key + ':' + n.idx;
      const isHidden = S.hidden.has(ck);
      if (isHidden && !S.showHidden) continue;
      const visibleKids = n.children.filter(
        (c) => c.depth <= maxDepth && (S.showHidden || !S.hidden.has('h:' + g.key + ':' + c.idx))
      );
      const collapsed = !q && S.collapsed.has(ck);
      const pad = 4 + (n.depth - 1) * 14;
      html += `<div class="node d${Math.min(n.depth, 6)} ${isHidden ? 'hid' : ''}" data-act="goto-h" data-id="${n.id}" style="padding-left:${pad}px" title="${esc(n.text)}">`;
      html += visibleKids.length
        ? `<span class="tg" data-act="toggle-h" data-ck="${esc(ck)}">${collapsed ? ICON.right : ICON.down}</span>`
        : `<span class="tg"></span>`;
      html += `<span class="t">${highlight(n.text, q)}</span>`;
      html += `<button class="ib nhide ${isHidden ? 'on' : ''}" data-act="hide" data-ck="${esc(ck)}" title="${isHidden ? '取消隐藏' : '隐藏这个标题'}">${isHidden ? ICON.eye : ICON.eyeOff}</button></div>`;
      if (visibleKids.length && !collapsed) html += renderNodes(g, n.children, q);
    }
    return html;
  }

  function renderOutline() {
    const q = S.outlineQuery.trim().toLowerCase();
    let html = '';
    let shown = 0;
    for (const g of S.model) {
      const starred = S.stars.has(g.key);
      if (S.settings.starredOnly && !starred) continue;
      const gk = 'g:' + g.key;
      const isHidden = S.hidden.has(gk);
      if (isHidden && !S.showHidden) continue;
      let tree = g.tree;
      if (q) {
        tree = filterTree(g.tree, q);
        if (!tree.length && !g.text.toLowerCase().includes(q)) continue;
      }
      shown++;
      const collapsed = !q && S.collapsed.has(gk);
      const num = String(g.index + 1).padStart(2, '0');
      html += `<div class="grp ${isHidden ? 'hid' : ''}" data-key="${esc(g.key)}">
        <div class="ghead">
          <span class="badge">${num}</span>
          <div class="gtext" data-act="goto-u" data-id="${g.id}" title="${esc(g.text.slice(0, 500))}">${highlight(g.text, q)}</div>
          <span class="cnt" title="${g.headings.length} 个标题">${g.headings.length || ''}</span>
          <button class="ib gstar ${starred ? 'on' : ''}" data-act="star" data-key="${esc(g.key)}" title="${starred ? '取消标记' : '标记这个提问'}">${starred ? ICON.starOn : ICON.star}</button>
          <button class="ib ghide ${isHidden ? 'on' : ''}" data-act="hide" data-ck="${esc(gk)}" title="${isHidden ? '取消隐藏' : '隐藏这个提问'}">${isHidden ? ICON.eye : ICON.eyeOff}</button>
          ${g.tree.length ? `<button class="ib chev" data-act="toggle-g" data-ck="${esc(gk)}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? ICON.right : ICON.down}</button>` : ''}
        </div>
        ${!collapsed && tree.length ? `<div class="tree">${renderNodes(g, tree, q)}</div>` : ''}
      </div>`;
    }
    if (!shown) {
      if (!S.model.length) html = `<div class="empty">还没有找到对话内容。<br>开始提问后，这里会显示目录。</div>`;
      else if (S.hidden.size && !S.showHidden && !q && !S.settings.starredOnly) html = `<div class="empty">所有提问都已隐藏。</div>`;
      else if (S.settings.starredOnly) html = `<div class="empty">还没有标记的提问。<br>鼠标移到提问上，点星星即可标记。</div>`;
      else html = `<div class="empty">没有匹配“${esc(S.outlineQuery)}”的内容。</div>`;
    }
    olist.innerHTML = html;
    renderHiddenBar();
    S.activeId = null;
    updateActive();
  }

  function applyMarks(marks) {
    S.marks = { stars: {}, hidden: {}, ...marks };
    const onKeys = (items) => Object.keys(items).filter((k) => items[k].on);
    S.stars = new Set(onKeys(S.marks.stars));
    S.hidden = new Set(onKeys(S.marks.hidden));
  }
  function toggleMark(kind, key) {
    const item = S.marks[kind][key];
    S.marks[kind][key] = { on: !(item && item.on), at: Date.now() };
    store.set(marksKey(), S.marks);
    applyMarks(S.marks);
    queueSync();
  }

  function renderHiddenBar() {
    const bar = $('#hbar');
    const n = S.model.reduce(
      (sum, g) => sum + (S.hidden.has('g:' + g.key) ? 1 : 0) + g.headings.filter((_, i) => S.hidden.has('h:' + g.key + ':' + i)).length,
      0
    );
    if (!n) S.showHidden = false;
    bar.hidden = !n;
    bar.innerHTML = n ? `<span>已隐藏 ${n} 项</span><button id="hshow">${S.showHidden ? '收起' : '显示'}</button>` : '';
  }

  function findById(id) {
    if (!id) return null;
    if (id[0] === 'u') return S.model[+id.slice(1)] || null;
    const g = S.model[+id.slice(1).split('.')[0]];
    return g ? flatNodes(g).find((n) => n.id === id) || null : null;
  }
  function flatNodes(g) {
    const out = [];
    const walk = (ns) => ns.forEach((n) => (out.push(n), walk(n.children)));
    walk(g.tree);
    return out;
  }

  // 条目现在在页面上的元素，已卸载时返回 null
  function liveEl(item, isGroup) {
    const el = isGroup ? item.msg.el : item.msg.headings[item.mi] && item.msg.headings[item.mi].el;
    return el && el.isConnected ? el : null;
  }

  function jumpTo(el) {
    clearInterval(edgeTimer);
    el.style.scrollMarginTop = SCROLL_OFFSET + 'px';
    el.scrollIntoView({ block: 'start' });
    // 虚拟列表测量高度后位置会变，再校正两次
    [150, 450].forEach((ms) =>
      setTimeout(() => {
        if (el.isConnected && Math.abs(el.getBoundingClientRect().top - SCROLL_OFFSET) > 8) el.scrollIntoView({ block: 'start' });
      }, ms)
    );
    try {
      el.animate([{ backgroundColor: 'rgba(242,182,50,.35)' }, { backgroundColor: 'rgba(242,182,50,0)' }], {
        duration: 1600,
        easing: 'ease-out',
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  async function pinAndJump(id) {
    const item = findById(id);
    if (!item) return;
    const isGroup = id[0] === 'u';
    S.pin = { key: S.model[+id.slice(1).split('.')[0]].key, idx: isGroup ? null : item.idx };
    updateActive();
    scanMessages();
    const seek = ++S.seek;
    const found = liveEl(item, isGroup);
    if (found) return jumpTo(found);

    // 条目已被卸载：比较视口内消息的序号，二分滚动到它所在的位置
    clearInterval(edgeTimer);
    const sc = findScroller();
    const target = item.msg.order;
    let lo = 0;
    let hi = sc.scrollHeight - sc.clientHeight;
    for (let tries = 0; tries < 20; tries++) {
      const orders = scanMessages()
        .filter((m) => {
          const r = m.el.getBoundingClientRect();
          return r.bottom > 0 && r.top < innerHeight;
        })
        .map((m) => m.order);
      const el = liveEl(item, isGroup);
      if (el) return jumpTo(el);
      if (orders.length && (target < Math.min(...orders) || target > Math.max(...orders))) {
        const up = target < Math.min(...orders);
        if (up) hi = sc.scrollTop;
        else lo = sc.scrollTop;
        // 第一步按序号比例估算；高度也是估算的，区间收窄后改为逐屏移动
        if (tries === 0) sc.scrollTop = hi * (target / Math.max(1, ...S.model.map((g) => g.msg.order)));
        else sc.scrollTop = hi - lo > sc.clientHeight ? (lo + hi) / 2 : sc.scrollTop + (up ? -0.7 : 0.7) * sc.clientHeight;
      }
      await new Promise((r) => setTimeout(r, 250));
      if (seek !== S.seek) return;
    }
    toast('没能定位到这条消息，请手动滚动到附近');
  }

  // 对话所在的滚动容器：两个网站都不是滚动整个页面
  function findScroller() {
    const known = S.scroller;
    if (known && known.isConnected && known.getBoundingClientRect().width > 0) return known;
    let el = inActivePane(qsaAll([...CFG.user, ...CFG.assistant]))[0];
    for (; el && el !== document.body; el = el.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 5) return (S.scroller = el);
    }
    return document.scrollingElement;
  }
  function scrollEdge(toTop) {
    const sc = findScroller();
    const target = () => (toTop ? 0 : sc.scrollHeight);
    const stop = () => clearInterval(edgeTimer);
    S.pin = null;
    S.seek++;
    clearInterval(edgeTimer);
    sc.scrollTop = target();
    // 虚拟列表加载新内容后高度会变，短时间内继续校正；用户滚动时立即停止
    let tries = 0;
    sc.addEventListener('wheel', stop, { passive: true, once: true });
    edgeTimer = setInterval(() => {
      if (++tries > 10) return stop();
      sc.scrollTop = target();
    }, 150);
  }

  // 滚动时高亮当前位置
  function updateActive() {
    if (panel.hidden || S.settings.tab !== 'outline' || !S.model.length) return;
    const line = SCROLL_OFFSET + 40;
    let current = null;
    const pinned = S.pin && S.model.find((g) => g.key === S.pin.key);
    if (pinned) {
      current = S.pin.idx === null ? pinned.id : `h${pinned.index}.${S.pin.idx}`;
    } else {
      for (const g of S.model) {
        const anchors = [g.el, ...g.answers.map((a) => a.el)].filter((el) => el.isConnected);
        if (!anchors.length) continue;
        if (anchors[0].getBoundingClientRect().top > line) break;
        current = g.id;
        for (const n of flatNodes(g)) {
          if (n.el.isConnected && n.el.getBoundingClientRect().top <= line) current = n.id;
        }
      }
    }
    // 最后一个回答较短时到底也到不了判定线，这时直接高亮最后一项
    const sc = findScroller();
    if (!pinned && sc.scrollTop > 0 && sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 4) {
      const last = S.model.filter((g) => !S.hidden.has('g:' + g.key)).pop();
      if (last) current = (flatNodes(last).pop() || last).id;
    }
    if (!current) current = S.model[0].id;
    // 当前标题被折叠或隐藏时，高亮最近的可见上级
    let id = current;
    let item = olist.querySelector(`[data-id="${CSS.escape(id)}"]`);
    while (!item && id && id[0] === 'h') {
      const n = findById(id);
      id = n ? n.parentId : null;
      item = id ? olist.querySelector(`[data-id="${CSS.escape(id)}"]`) : null;
    }
    if (id === S.activeId) return;
    S.activeId = id;
    olist.querySelectorAll('.active').forEach((x) => x.classList.remove('active'));
    if (item) {
      item.classList.add('active');
      const top = item.offsetTop - olist.offsetTop;
      if (top < olist.scrollTop || top > olist.scrollTop + olist.clientHeight - 30) {
        olist.scrollTop = top - olist.clientHeight / 3;
      }
    }
  }
  // 用户自己滚动或操作时恢复按位置高亮
  ['wheel', 'touchmove', 'pointerdown', 'keydown'].forEach((t) =>
    window.addEventListener(
      t,
      () => {
        S.pin = null;
        S.seek++;
      },
      { capture: true, passive: true }
    )
  );
  let rafPending = false;
  window.addEventListener(
    'scroll',
    () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        updateActive();
      });
    },
    true
  );

  olist.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'hide') {
      e.stopPropagation();
      const ck = t.dataset.ck;
      toggleMark('hidden', ck);
      renderOutline();
    } else if (act === 'star') {
      e.stopPropagation();
      const k = t.dataset.key;
      toggleMark('stars', k);
      renderOutline();
    } else if (act === 'toggle-g' || act === 'toggle-h') {
      e.stopPropagation();
      const ck = t.dataset.ck;
      S.collapsed.has(ck) ? S.collapsed.delete(ck) : S.collapsed.add(ck);
      renderOutline();
    } else if (act === 'goto-u') {
      pinAndJump(t.dataset.id);
    } else if (act === 'goto-h') {
      pinAndJump(t.dataset.id);
    }
  });

  $('#hbar').addEventListener('click', (e) => {
    if (!e.target.closest('#hshow')) return;
    S.showHidden = !S.showHidden;
    renderOutline();
  });

  $('#depth').addEventListener('click', (e) => {
    const b = e.target.closest('[data-depth]');
    if (!b) return;
    S.settings.depth = +b.dataset.depth;
    saveSettings();
    syncChrome();
    renderOutline();
  });
  $('#reoutline').addEventListener('click', async () => {
    await refresh(true);
    toast('目录已刷新');
  });
  $('#starred').addEventListener('click', () => {
    S.settings.starredOnly = !S.settings.starredOnly;
    saveSettings();
    syncChrome();
    renderOutline();
  });
  $('#oq').addEventListener('input', (e) => {
    S.outlineQuery = e.target.value;
    renderOutline();
  });
  $('#oq').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleOutlineSearch(false);
  });

  function toggleOutlineSearch(force) {
    S.searchOpen = force === undefined ? !S.searchOpen : force;
    $('#osearch').hidden = !S.searchOpen;
    if (S.searchOpen) $('#oq').focus();
    else {
      S.outlineQuery = '';
      $('#oq').value = '';
      renderOutline();
    }
    syncChrome();
  }

  function setAllCollapsed(collapse) {
    S.collapsed.clear();
    if (collapse) S.model.forEach((g) => g.tree.length && S.collapsed.add('g:' + g.key));
    renderOutline();
  }

  // ---------------------------------------------------------------------------
  // 面板框架：标签页、工具按钮、开关
  // ---------------------------------------------------------------------------
  function syncChrome() {
    const st = S.settings;
    panel.hidden = !st.open;
    fab.hidden = st.open;
    root.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === st.tab));
    $('#view-outline').hidden = st.tab !== 'outline';
    $('#view-prompts').hidden = st.tab !== 'prompts';
    root.querySelectorAll('#depth button').forEach((b) => b.classList.toggle('on', +b.dataset.depth === st.depth));
    const sb = $('#starred');
    sb.classList.toggle('on', st.starredOnly);
    sb.firstElementChild.outerHTML = st.starredOnly ? ICON.starOn : ICON.star;
    const tools = $('#tabtools');
    if (st.tab === 'outline') {
      tools.innerHTML = `
        <button class="ib" data-tool="top" title="到顶部">${ICON.up2}</button>
        <button class="ib" data-tool="bottom" title="到底部">${ICON.down2}</button>
        <button class="ib ${S.searchOpen ? 'on' : ''}" data-tool="search" title="搜索">${ICON.search}</button>
        <button class="ib" data-tool="expand" title="全部展开">${ICON.unfold}</button>
        <button class="ib" data-tool="collapse" title="全部折叠">${ICON.fold}</button>`;
    } else {
      tools.innerHTML = `
        <button class="ib" data-tool="new" title="新建提示词">${ICON.plus}</button>
        <button class="ib" data-tool="export" title="导出提示词">${ICON.down2}</button>
        <button class="ib" data-tool="import" title="导入提示词">${ICON.up2}</button>
`;
    }
  }

  $('#tabtools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const tool = b.dataset.tool;
    if (tool === 'top') scrollEdge(true);
    else if (tool === 'bottom') scrollEdge(false);
    else if (tool === 'search') toggleOutlineSearch();
    else if (tool === 'expand') setAllCollapsed(false);
    else if (tool === 'collapse') setAllCollapsed(true);
    else if (tool === 'new') openEditor(null);
    else if (tool === 'export') exportPrompts();
    else if (tool === 'import') $('#file').click();
  });
  root.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      S.settings.tab = t.dataset.tab;
      saveSettings();
      syncChrome();
      if (S.settings.tab === 'outline') renderOutline();
      else renderPrompts();
    })
  );
  function setOpen(open) {
    S.settings.open = open;
    saveSettings();
    syncChrome();
    if (open) {
      refresh(true);
      if (S.settings.tab === 'prompts') renderPrompts();
    }
  }
  $('#close').addEventListener('click', () => setOpen(false));
  panel.addEventListener('pointerdown', () => (S.pressing = true));
  ['pointerup', 'pointercancel'].forEach((t) =>
    window.addEventListener(t, () => {
      if (!S.pressing) return;
      S.pressing = false;
      scheduleRefresh();
    })
  );
  fab.addEventListener('click', () => setOpen(true));

  const saveSettings = () => store.set('settings', S.settings);

  // 快捷键 Alt+O（Mac 上是 Option+O）
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyO') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!S.settings.open);
      }
    },
    true
  );

  // ---------------------------------------------------------------------------
  // 提示词库
  // ---------------------------------------------------------------------------
  const savePrompts = () => {
    store.set('prompts', S.prompts);
    queueSync();
  };

  function allTags() {
    const set = new Set();
    S.prompts.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
    return [...set];
  }

  function matchPrompt(p, q) {
    if (!q) return true;
    q = q.toLowerCase();
    return (
      p.title.toLowerCase().includes(q) ||
      p.content.toLowerCase().includes(q) ||
      (p.tags || []).some((t) => t.toLowerCase().includes(q))
    );
  }

  function renderPrompts() {
    $('#plistview').hidden = !!S.editing;
    pform.hidden = !S.editing;
    if (S.editing) return renderEditor();

    const tags = allTags();
    if (S.promptTag && !tags.includes(S.promptTag)) S.promptTag = '';
    $('#ptags').innerHTML = tags.length
      ? `<button class="tag ${S.promptTag ? '' : 'on'}" data-tag="">全部</button>` +
        tags.map((t) => `<button class="tag ${S.promptTag === t ? 'on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')
      : '';

    const list = S.prompts
      .filter((p) => (!S.promptTag || (p.tags || []).includes(S.promptTag)) && matchPrompt(p, S.promptQuery))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!S.prompts.length) {
      plist.innerHTML = `<div class="empty">还没有提示词。<br>点右上角的 + 新建一条。</div>`;
      return;
    }
    if (!list.length) {
      plist.innerHTML = `<div class="empty">没有匹配的提示词。</div>`;
      return;
    }
    plist.innerHTML = list
      .map((p) => {
        const vars = extractVars(p.content);
        const confirming = S.confirmDelete === p.id;
        return `<div class="card" data-id="${p.id}">
          <div class="ctitle">${esc(p.title)}${(p.tags || []).length ? `<span class="ctag">· ${esc(p.tags.join('、'))}</span>` : ''}</div>
          <div class="cprev">${esc(p.content.slice(0, 200))}</div>
          ${vars.length ? `<div class="hint">变量：${vars.map(esc).join('、')}</div>` : ''}
          <div class="cact">
            ${
              confirming
                ? `<span>确定删除？</span><button class="danger" data-pact="del-yes">删除</button><button data-pact="del-no">取消</button>`
                : `<button data-pact="insert">插入</button><button data-pact="copy">复制</button><button data-pact="edit">编辑</button><span class="sp"></span><button class="del" data-pact="del">删除</button>`
            }
          </div>
        </div>`;
      })
      .join('');
  }

  $('#pq').addEventListener('input', (e) => {
    S.promptQuery = e.target.value;
    renderPrompts();
  });
  $('#ptags').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tag]');
    if (!b) return;
    S.promptTag = b.dataset.tag;
    renderPrompts();
  });
  plist.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pact]');
    if (!b) return;
    const id = b.closest('.card').dataset.id;
    const p = S.prompts.find((x) => x.id === id);
    if (!p) return;
    const act = b.dataset.pact;
    if (act === 'insert') usePrompt(p);
    else if (act === 'copy') {
      const vars = extractVars(p.content);
      const copy = async (text) => {
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制');
        } catch (err) {
          toast('复制失败，请手动复制');
        }
      };
      if (vars.length) askVars(p, (values) => copy(fillVars(p.content, values)), '复制');
      else copy(p.content);
    } else if (act === 'edit') openEditor(p);
    else if (act === 'del') {
      S.confirmDelete = id;
      renderPrompts();
    } else if (act === 'del-no') {
      S.confirmDelete = null;
      renderPrompts();
    } else if (act === 'del-yes') {
      S.prompts = S.prompts.filter((x) => x.id !== id);
      S.tombstones = [...S.tombstones.filter((t) => t.id !== id), { id, deletedAt: Date.now() }];
      store.set('promptTombstones', S.tombstones);
      S.confirmDelete = null;
      savePrompts();
      renderPrompts();
      toast('已删除');
    }
  });

  function openEditor(p) {
    S.settings.tab = 'prompts';
    S.editing = p ? { ...p } : { id: null, title: '', content: '', tags: S.promptTag ? [S.promptTag] : [] };
    syncChrome();
    renderPrompts();
    setTimeout(() => pform.querySelector('#ef-title').focus(), 0);
  }

  function renderEditor() {
    const p = S.editing;
    pform.innerHTML = `
      <div class="dtitle">${p.id ? '编辑提示词' : '新建提示词'}</div>
      <label>标题</label><input id="ef-title" value="${esc(p.title)}" placeholder="论文段落润色" />
      <label>标签（用逗号分隔，可留空）</label><input id="ef-tags" value="${esc((p.tags || []).join('，'))}" placeholder="写作，英文" />
      <label>内容</label><textarea id="ef-content" placeholder="请按 {{期刊}} 的风格润色下面这段文字">${esc(p.content)}</textarea>
      <div class="hint">用 {{变量名}} 标出每次要替换的部分，插入时会让你填写。</div>
      <div class="hint" id="ef-err" style="color:var(--danger)"></div>
      <div class="btns"><button class="btn" id="ef-cancel">取消</button><button class="btn pri" id="ef-save">保存</button></div>`;
    pform.querySelector('#ef-cancel').onclick = () => {
      S.editing = null;
      renderPrompts();
    };
    pform.querySelector('#ef-save').onclick = saveEditor;
    pform.querySelector('#ef-title').addEventListener('keydown', (e) => e.key === 'Enter' && saveEditor());
  }

  function saveEditor() {
    const title = pform.querySelector('#ef-title').value.trim();
    const content = pform.querySelector('#ef-content').value;
    const tags = pform
      .querySelector('#ef-tags')
      .value.split(/[,，、;；]/)
      .map((t) => t.trim())
      .filter(Boolean);
    const err = pform.querySelector('#ef-err');
    if (!title) return (err.textContent = '请填写标题');
    if (!content.trim()) return (err.textContent = '请填写内容');
    const now = Date.now();
    if (S.editing.id) {
      const p = S.prompts.find((x) => x.id === S.editing.id);
      if (p) Object.assign(p, { title, content, tags, updatedAt: now });
      else S.prompts.push({ id: S.editing.id, title, content, tags, updatedAt: now }); // 编辑时被其他电脑删除了
    } else {
      S.prompts.push({ id: uid(), title, content, tags, updatedAt: now });
    }
    S.editing = null;
    savePrompts();
    renderPrompts();
    toast('已保存');
  }

  function exportPrompts() {
    const data = JSON.stringify({ app: 'chat-outline', version: 1, prompts: S.prompts }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
    const d = new Date();
    a.download = `提示词备份-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(`已导出 ${S.prompts.length} 条提示词`);
  }

  $('#file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const arr = Array.isArray(data) ? data : data.prompts;
      if (!Array.isArray(arr)) throw new Error('格式不对');
      let added = 0;
      let updated = 0;
      for (const raw of arr) {
        if (!raw || !raw.title || typeof raw.content !== 'string') continue;
        const item = {
          id: raw.id || uid(),
          title: String(raw.title),
          content: raw.content,
          tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
          // 导入已删除的提示词时算作新修改，否则同步时又会被删掉
          updatedAt: S.tombstones.some((t) => t.id === raw.id) ? Date.now() : raw.updatedAt || Date.now(),
        };
        const existing = S.prompts.find((p) => p.id === item.id);
        if (existing) {
          Object.assign(existing, item);
          updated++;
        } else {
          S.prompts.push(item);
          added++;
        }
      }
      savePrompts();
      renderPrompts();
      toast(`导入完成：新增 ${added} 条，更新 ${updated} 条`);
    } catch (err) {
      toast('导入失败：文件不是有效的提示词备份');
    }
  });

  // ---------------------------------------------------------------------------
  // 同步：网络请求和合并都在 background.js，这里只负责触发和显示状态
  // ---------------------------------------------------------------------------
  async function sendBackground(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return null; // 扩展刚更新时，旧页面连不上后台
    }
  }
  const queueSync = debounce(() => S.syncEnabled && sendBackground({ type: 'sync', reason: 'change' }), 3000);

  async function syncNow() {
    if (!S.syncEnabled) return sendBackground({ type: 'open-sync-settings' });
    toast('正在同步…');
    const status = await sendBackground({ type: 'sync', reason: 'manual' });
    if (!status) toast('同步失败，请刷新网页后再试');
    else toast(status.ok ? '同步完成' : '同步失败：' + status.error);
  }

  function renderSyncLine() {
    const line = $('#syncline');
    if (!hasChromeStorage) return;
    const st = S.syncStatus;
    const failed = S.syncEnabled && st && !st.ok;
    $('#syncbar').hidden = false;
    line.classList.toggle('err', !!failed);
    if (!S.syncEnabled) line.textContent = '同步未开启，点此设置';
    else if (!st) line.textContent = '等待同步…';
    else if (failed) line.textContent = '同步失败：' + st.error;
    else {
      const t = new Date(st.at);
      line.textContent = `已同步 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    }
    line.title = '打开同步设置';
  }
  $('#syncline').addEventListener('click', () => sendBackground({ type: 'open-sync-settings' }));
  $('#syncnow').addEventListener('click', syncNow);

  async function startSync() {
    if (!hasChromeStorage) return;
    S.syncEnabled = await store.get('syncEnabled', false);
    S.syncStatus = await store.get('syncStatus', null);
    renderSyncLine();
    // 其他标签页或后台同步修改数据后，这里跟着更新
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.promptTombstones) S.tombstones = changes.promptTombstones.newValue || [];
      if (changes.prompts && JSON.stringify(changes.prompts.newValue) !== JSON.stringify(S.prompts)) {
        S.prompts = changes.prompts.newValue || [];
        if (S.settings.tab === 'prompts' && !S.editing) renderPrompts();
      }
      if (changes[marksKey()]) {
        applyMarks(changes[marksKey()].newValue || {});
        if (S.settings.tab === 'outline') renderOutline();
      }
      if (changes.syncEnabled) S.syncEnabled = !!changes.syncEnabled.newValue;
      if (changes.syncStatus) S.syncStatus = changes.syncStatus.newValue || null;
      if (changes.syncEnabled || changes.syncStatus) renderSyncLine();
    });
    const pull = () => S.syncEnabled && !document.hidden && sendBackground({ type: 'sync', reason: 'open' });
    document.addEventListener('visibilitychange', pull);
    pull();
  }

  // ---------------------------------------------------------------------------
  // 变量填写对话框
  // ---------------------------------------------------------------------------
  function askVars(p, onDone, actionLabel = '插入') {
    const vars = extractVars(p.content);
    dialog.innerHTML = `
      <div class="dtitle">${esc(p.title)}</div>
      <div class="form">
        ${vars
          .map(
            (v, i) =>
              `<label>${esc(v)}</label><input data-var="${esc(v)}" value="${esc(S.varMemory[v] || '')}" ${i === 0 ? 'autofocus' : ''} />`
          )
          .join('')}
      </div>
      <div class="btns"><button class="btn" id="vd-cancel">取消</button><button class="btn pri" id="vd-ok">${actionLabel}</button></div>`;
    modal.hidden = false;
    const close = () => {
      modal.hidden = true;
      dialog.innerHTML = '';
    };
    const ok = () => {
      const values = {};
      dialog.querySelectorAll('[data-var]').forEach((inp) => {
        values[inp.dataset.var] = inp.value;
        S.varMemory[inp.dataset.var] = inp.value;
      });
      store.set('varMemory', S.varMemory);
      close();
      onDone(values);
    };
    dialog.querySelector('#vd-cancel').onclick = close;
    dialog.querySelector('#vd-ok').onclick = ok;
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        ok();
      }
    });
    modal.onclick = (e) => e.target === modal && close();
    const first = dialog.querySelector('[data-var]');
    if (first) {
      first.focus();
      first.select();
    }
  }

  // ---------------------------------------------------------------------------
  // 写入网页输入框
  // ---------------------------------------------------------------------------
  function findComposer() {
    for (const sel of CFG.composer) {
      const els = [...document.querySelectorAll(sel)].filter((el) => !host.contains(el) && isVisible(el));
      if (els.length) return els[els.length - 1];
    }
    return null;
  }
  function composerOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el) return null;
    for (const sel of CFG.composer) {
      const c = el.closest(sel);
      if (c) return c;
    }
    return null;
  }

  // 记录输入框里的光标位置，从面板插入时放回原处
  document.addEventListener('selectionchange', () => {
    const ae = document.activeElement;
    if (ae && ae.tagName === 'TEXTAREA' && composerOf(ae)) {
      S.caret = { el: ae, start: ae.selectionStart, end: ae.selectionEnd };
      return;
    }
    const sel = getSelection();
    if (sel.rangeCount && composerOf(sel.anchorNode)) {
      S.caret = { el: composerOf(sel.anchorNode), range: sel.getRangeAt(0).cloneRange() };
    }
  });

  function placeCaret(el) {
    const c = S.caret;
    if (el.tagName === 'TEXTAREA') {
      if (c && c.el === el) el.setSelectionRange(c.start, c.end);
      return;
    }
    const sel = getSelection();
    // 优先恢复记录的位置：变量对话框关闭后 focus() 会把光标放到输入框开头
    if (c && c.el === el && c.range && el.contains(c.range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(c.range);
      return;
    }
    if (sel.rangeCount && el.contains(sel.anchorNode)) return;
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertText(text) {
    const el = findComposer();
    if (!el) {
      toast('没找到输入框');
      return false;
    }
    el.focus();
    placeCaret(el);
    if (el.tagName === 'TEXTAREA') {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value.slice(0, start) + text + el.value.slice(end));
      el.setSelectionRange(start + text.length, start + text.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const before = el.textContent;
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch (e) {
      ok = false;
    }
    if (!ok || el.textContent === before) {
      // 备用方案：模拟粘贴
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    }
    return true;
  }

  function usePrompt(p) {
    const go = (text) => insertText(text) && toast('已插入，可修改后发送');
    if (extractVars(p.content).length) askVars(p, (values) => go(fillVars(p.content, values)));
    else go(p.content);
  }

  // ---------------------------------------------------------------------------
  // 在输入框里输入 // 呼出提示词
  // ---------------------------------------------------------------------------
  function textBeforeCaret(el) {
    if (el.tagName === 'TEXTAREA') return el.value.slice(0, el.selectionStart);
    const sel = getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return '';
    const node = sel.anchorNode;
    if (!node || !el.contains(node)) return '';
    if (node.nodeType === 3) return node.textContent.slice(0, sel.anchorOffset);
    // 豆包的编辑器在 input 事件期间会重排文字节点，选区短暂落在段落上
    const range = document.createRange();
    range.selectNodeContents(node);
    range.setEnd(node, sel.anchorOffset);
    return range.toString();
  }

  function checkPicker(target) {
    const el = composerOf(target);
    if (!el) return closePicker();
    const before = textBeforeCaret(el);
    // 任意位置都能呼出，只排除网址里的 ://
    const m = before.match(/(?:^|[^:/])\/\/([^\s/]{0,30})$/);
    if (!m) return closePicker();
    const query = m[1];
    const items = S.prompts.filter((p) => matchPrompt(p, query)).slice(0, 8);
    S.picker = { el, query, items, index: 0 };
    renderPicker();
  }

  function renderPicker() {
    const P = S.picker;
    if (!P) return;
    const r = P.el.getBoundingClientRect();
    const width = Math.min(360, Math.max(260, r.width));
    picker.style.width = width + 'px';
    picker.style.left = Math.max(8, Math.min(r.left, innerWidth - width - 8)) + 'px';
    picker.innerHTML = P.items.length
      ? P.items
          .map(
            (p, i) =>
              `<div class="pi ${i === P.index ? 'on' : ''}" data-i="${i}"><span class="pt">${esc(p.title)}</span><span class="ptag">${esc((p.tags || []).join('、'))}</span></div>`
          )
          .join('') + `<div class="pfoot">↑↓ 选择 · 回车插入 · Esc 关闭</div>`
      : `<div class="pfoot" style="border:none">没有匹配“${esc(P.query)}”的提示词</div>`;
    picker.hidden = false;
    const h = picker.offsetHeight;
    const top = r.top - h - 8 > 8 ? r.top - h - 8 : r.bottom + 8;
    picker.style.top = top + 'px';
  }

  function closePicker() {
    if (!S.picker) return;
    S.picker = null;
    picker.hidden = true;
  }

  const nextTask = () => new Promise((r) => setTimeout(r, 30));
  async function choosePicker(i) {
    const P = S.picker;
    if (!P || !P.items[i]) return;
    const p = P.items[i];
    const el = P.el;
    const n = P.query.length + 2;
    closePicker();
    el.focus();
    // 删除输入的 //关键词
    if (el.tagName === 'TEXTAREA') {
      const pos = el.selectionStart;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, el.value.slice(0, pos - n) + el.value.slice(pos));
      el.setSelectionRange(pos - n, pos - n);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      S.caret = { el, start: pos - n, end: pos - n };
    } else {
      const sel = getSelection();
      for (let k = 0; k < n; k++) sel.modify('extend', 'backward', 'character');
      await nextTask(); // Kimi 的编辑器要等选区同步后才能删除
      document.execCommand('delete');
      await nextTask();
      if (sel.rangeCount) S.caret = { el, range: sel.getRangeAt(0).cloneRange() };
    }
    usePrompt(p);
  }

  document.addEventListener('input', (e) => checkPicker(e.target), true);
  document.addEventListener('click', (e) => {
    if (!host.contains(e.target) && S.picker && !composerOf(e.target)) closePicker();
  });
  window.addEventListener(
    'keydown',
    (e) => {
      const P = S.picker;
      if (!P || e.isComposing) return;
      const keys = ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'];
      if (!keys.includes(e.key)) return;
      if (e.key === 'Escape') {
        closePicker();
      } else if (!P.items.length) {
        if (e.key !== 'Enter') return;
        closePicker();
        return;
      } else if (e.key === 'ArrowDown') {
        P.index = (P.index + 1) % P.items.length;
        renderPicker();
      } else if (e.key === 'ArrowUp') {
        P.index = (P.index - 1 + P.items.length) % P.items.length;
        renderPicker();
      } else {
        choosePicker(P.index);
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true
  );
  picker.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-i]');
    if (!item) return;
    e.preventDefault(); // 保持输入框焦点
    choosePicker(+item.dataset.i);
  });

  // ---------------------------------------------------------------------------
  // 监听页面变化
  // ---------------------------------------------------------------------------
  async function refresh(force) {
    if (location.pathname !== S.path) {
      S.path = location.pathname;
      // ChatGPT 项目里的对话打开后路径会多一段，但还是同一个对话
      if (convKey() !== S.conv) {
        S.conv = convKey();
        S.collapsed.clear();
        S.outlineQuery = '';
        if (S.searchOpen) toggleOutlineSearch(false);
        applyMarks(await store.get(marksKey(), {}));
        S.showHidden = false;
        S.pin = null;
        S.seek++;
        force = true;
      }
    }
    applyTheme();
    const model = buildModel();
    const sig = signature(model);
    // 按下鼠标时不重绘，否则这次点击会落空；松开后再更新
    if (!force && sig !== S.sig && S.pressing) return;
    S.model = model;
    if (!force && sig === S.sig) {
      updateActive();
      return;
    }
    S.sig = sig;
    if (!panel.hidden && S.settings.tab === 'outline') renderOutline();
  }
  // 滚动时页面一直在变：目录最多等 1.5 秒就更新一次
  let refreshTimer;
  let refreshWait = 0;
  const scheduleRefresh = () => {
    const now = Date.now();
    refreshWait = refreshWait || now;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshWait = 0;
      if (!document.hidden) refresh(false);
    }, Math.max(0, Math.min(500, refreshWait + 1500 - now)));
  };
  // 消息可能很快被卸载，页面一变就尽快记下来，不等目录重绘
  let scanTimer;
  const onPageChange = () => {
    scheduleRefresh();
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (!document.hidden) scanMessages();
    }, 200);
  };
  document.addEventListener('visibilitychange', () => document.hidden || scheduleRefresh());

  async function init() {
    S.settings = { ...DEFAULT_SETTINGS, ...(await store.get('settings', {})) };
    const prompts = await store.get('prompts', []);
    S.tombstones = await store.get('promptTombstones', []);
    // 旧版本内置的示例已取消：没改过的删掉，并记录删除，避免同步时被带回来
    S.prompts = prompts.filter((p) => !(/^seed-\d$/.test(p.id) && !p.updatedAt));
    if (S.prompts.length !== prompts.length) {
      const now = Date.now();
      S.tombstones.push(...prompts.filter((p) => !S.prompts.includes(p)).map((p) => ({ id: p.id, deletedAt: now })));
      store.set('prompts', S.prompts);
      store.set('promptTombstones', S.tombstones);
    }
    S.varMemory = await store.get('varMemory', {});
    applyMarks(await store.get(marksKey(), {}));
    document.documentElement.appendChild(host);
    applyTheme();
    syncChrome();
    await refresh(true);
    if (S.settings.tab === 'prompts') renderPrompts();
    startSync();
    new MutationObserver(onPageChange).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    new MutationObserver(applyTheme).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-mode', 'data-theme', 'style'],
    });
    // 单页应用切换对话时 URL 会变，但页面不一定马上有变化
    setInterval(() => location.pathname !== S.path && refresh(true), 1000);
  }

  // 测试用：在非扩展环境下暴露少量接口
  if (!hasChromeStorage) window.__chatOutline = { S, refresh, renderOutline, renderPrompts, root };

  init();
})();
