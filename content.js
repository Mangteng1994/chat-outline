/*
 * 对话大纲 + 提示词库
 * 为 claude.ai 与 chatgpt.com 添加：按提问分组的多级标题目录、星标、提示词库（含 {{变量}} 与 // 快速插入）。
 * 所有数据保存在 chrome.storage.local，不发送到任何服务器。
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
    },
    chatgpt: {
      // 按顺序尝试，使用第一个能找到内容的选择器
      // 新版页面的 data-conversation-role 只在隐藏的“You said:”标题上，不能用来取消息内容
      user: ['[data-user-message-bubble="true"]', '[data-message-author-role="user"]', 'article[data-turn="user"]', '[data-turn="user"]'],
      assistant: ['[data-markdown-text-style="assistant-message"]', '[data-message-author-role="assistant"]', 'article[data-turn="assistant"]', '[data-turn="assistant"]'],
      composer: ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'form textarea'],
    },
  };
  const SITE = /(^|\.)claude\.ai$/.test(location.hostname) ? 'claude' : 'chatgpt';
  const CFG = SITES[SITE];

  const HEADING_SEL = 'h1,h2,h3,h4,h5,h6';
  const SCROLL_OFFSET = 90; // 跳转时为顶部固定栏预留的距离
  const DEFAULT_SETTINGS = { open: true, tab: 'outline', depth: 3, starredOnly: false };
  const SEED_PROMPTS = [
    {
      title: '文档逐节分析',
      tags: ['文献'],
      content: '你是一个高效的信息分析助手。请分析我上传的这个文档，逐个部分概括核心内容，并指出每部分的论据是否充分。',
    },
    {
      title: '论文段落润色',
      tags: ['写作'],
      content: '请按 {{期刊}} 的写作风格润色下面这段文字，保持原意，不超过 {{字数上限}} 字，并列出主要修改：\n\n',
    },
    {
      title: '实验方案审查',
      tags: ['实验'],
      content: '请检查下面的实验设计：对照组是否完整、变量是否控制、样本量是否合理，并给出改进建议：\n\n',
    },
  ];

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
  // 读取元素文字，去掉屏幕阅读器专用的隐藏文字（如 ChatGPT 的“You said:”）
  const visibleText = (el) => {
    if (!el.querySelector('.sr-only')) return el.innerText || el.textContent;
    const c = el.cloneNode(true);
    c.querySelectorAll('.sr-only').forEach((x) => x.remove());
    return c.textContent;
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
    up2: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V8M7 13l5-5 5 5M5 4h14"/></svg>',
  };

  // ---------------------------------------------------------------------------
  // 状态
  // ---------------------------------------------------------------------------
  const S = {
    settings: { ...DEFAULT_SETTINGS },
    prompts: [],
    stars: new Set(),
    collapsed: new Set(),
    path: location.pathname,
    model: [],
    sig: '',
    outlineQuery: '',
    searchOpen: false,
    promptQuery: '',
    promptTag: '',
    editing: null, // 正在编辑的提示词（新建时 id 为 null）
    confirmDelete: null,
    activeId: null,
    caret: null, // 输入框中最后的光标位置
    picker: null, // // 快速插入的状态
    varMemory: {},
  };
  const starKey = () => 'stars:' + location.hostname + location.pathname;

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
.tab { padding:4px 10px; border-radius:8px; color:var(--tx2); }
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
.gstar { color:var(--tx3); opacity:0; }
.grp:hover .gstar, .gstar.on { opacity:1; }
.gstar.on { color:var(--star); }
.chev { color:var(--tx3); }
.gtext { font-weight:600; margin:4px 0 2px; cursor:pointer; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; border-radius:6px; padding:1px 4px; margin-left:-4px; }
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
      </div>
      <div class="searchrow" id="osearch" hidden><input id="oq" placeholder="搜索提问和标题" /></div>
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
  function buildModel() {
    const users = outermost(qsaFirst(CFG.user));
    const assistants = outermost(SITE === 'claude' ? qsaAll(CFG.assistant) : qsaFirst(CFG.assistant)).filter(
      (a) => !users.some((u) => u.contains(a) || a.contains(u))
    );
    const items = [
      ...users.map((el) => ({ type: 'user', el })),
      ...assistants.map((el) => ({ type: 'assistant', el })),
    ].sort((a, b) => docOrder(a.el, b.el));

    const groups = [];
    const seen = {};
    let cur = null;
    const newGroup = (el, text) => {
      const base = hash(text.slice(0, 300));
      seen[base] = (seen[base] || 0) + 1;
      cur = { key: base + '-' + seen[base], el, text, headings: [] };
      groups.push(cur);
    };
    for (const it of items) {
      if (it.type === 'user') {
        newGroup(it.el, clean(visibleText(it.el)) || '（空白提问）');
      } else {
        if (!cur) newGroup(it.el, '（对话开头）');
        it.el.querySelectorAll(HEADING_SEL).forEach((h) => {
          if (h.closest('pre, code, .sr-only')) return;
          const text = clean(h.innerText || h.textContent);
          if (text) cur.headings.push({ el: h, level: +h.tagName[1], text });
        });
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
      const visibleKids = n.children.filter((c) => c.depth <= maxDepth);
      const ck = 'h:' + g.key + ':' + n.idx;
      const collapsed = !q && S.collapsed.has(ck);
      const pad = 4 + (n.depth - 1) * 14;
      html += `<div class="node d${Math.min(n.depth, 6)}" data-act="goto-h" data-id="${n.id}" style="padding-left:${pad}px" title="${esc(n.text)}">`;
      html += visibleKids.length
        ? `<span class="tg" data-act="toggle-h" data-ck="${esc(ck)}">${collapsed ? ICON.right : ICON.down}</span>`
        : `<span class="tg"></span>`;
      html += `<span class="t">${highlight(n.text, q)}</span></div>`;
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
      let tree = g.tree;
      if (q) {
        tree = filterTree(g.tree, q);
        if (!tree.length && !g.text.toLowerCase().includes(q)) continue;
      }
      shown++;
      const gk = 'g:' + g.key;
      const collapsed = !q && S.collapsed.has(gk);
      const num = String(g.index + 1).padStart(2, '0');
      html += `<div class="grp" data-key="${esc(g.key)}">
        <div class="ghead">
          <span class="badge">${num}</span><span class="lbl">提问</span><span class="sp"></span>
          <span class="cnt">${g.headings.length ? g.headings.length + ' 个标题' : ''}</span>
          <button class="ib gstar ${starred ? 'on' : ''}" data-act="star" data-key="${esc(g.key)}" title="${starred ? '取消标记' : '标记这个提问'}">${starred ? ICON.starOn : ICON.star}</button>
          ${g.tree.length ? `<button class="ib chev" data-act="toggle-g" data-ck="${esc(gk)}" title="${collapsed ? '展开' : '折叠'}">${collapsed ? ICON.right : ICON.down}</button>` : ''}
        </div>
        <div class="gtext" data-act="goto-u" data-id="${g.id}" title="${esc(g.text.slice(0, 500))}">${highlight(g.text, q)}</div>
        ${!collapsed && tree.length ? `<div class="tree">${renderNodes(g, tree, q)}</div>` : ''}
      </div>`;
    }
    if (!shown) {
      if (!S.model.length) html = `<div class="empty">还没有找到对话内容。<br>开始提问后，这里会显示目录。</div>`;
      else if (S.settings.starredOnly) html = `<div class="empty">还没有标记的提问。<br>鼠标移到提问上，点星星即可标记。</div>`;
      else html = `<div class="empty">没有匹配“${esc(S.outlineQuery)}”的内容。</div>`;
    }
    olist.innerHTML = html;
    S.activeId = null;
    updateActive();
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

  function jumpTo(el) {
    if (!el || !el.isConnected) return;
    el.style.scrollMarginTop = SCROLL_OFFSET + 'px';
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      el.animate([{ backgroundColor: 'rgba(242,182,50,.35)' }, { backgroundColor: 'rgba(242,182,50,0)' }], {
        duration: 1600,
        easing: 'ease-out',
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  // 滚动时高亮当前位置
  function updateActive() {
    if (panel.hidden || S.settings.tab !== 'outline' || !S.model.length) return;
    const line = SCROLL_OFFSET + 40;
    let current = null;
    for (const g of S.model) {
      if (g.el.isConnected && g.el.getBoundingClientRect().top <= line) current = g.id;
      else if (g.el.isConnected) break;
      for (const n of flatNodes(g)) {
        if (n.el.isConnected && n.el.getBoundingClientRect().top <= line) current = n.id;
      }
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
    if (act === 'star') {
      e.stopPropagation();
      const k = t.dataset.key;
      S.stars.has(k) ? S.stars.delete(k) : S.stars.add(k);
      store.set(starKey(), [...S.stars]);
      renderOutline();
    } else if (act === 'toggle-g' || act === 'toggle-h') {
      e.stopPropagation();
      const ck = t.dataset.ck;
      S.collapsed.has(ck) ? S.collapsed.delete(ck) : S.collapsed.add(ck);
      renderOutline();
    } else if (act === 'goto-u') {
      const g = findById(t.dataset.id);
      if (g) jumpTo(g.el);
    } else if (act === 'goto-h') {
      const n = findById(t.dataset.id);
      if (n) jumpTo(n.el);
    }
  });

  $('#depth').addEventListener('click', (e) => {
    const b = e.target.closest('[data-depth]');
    if (!b) return;
    S.settings.depth = +b.dataset.depth;
    saveSettings();
    syncChrome();
    renderOutline();
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
        <button class="ib ${S.searchOpen ? 'on' : ''}" data-tool="search" title="搜索">${ICON.search}</button>
        <button class="ib" data-tool="expand" title="全部展开">${ICON.unfold}</button>
        <button class="ib" data-tool="collapse" title="全部折叠">${ICON.fold}</button>`;
    } else {
      tools.innerHTML = `
        <button class="ib" data-tool="new" title="新建提示词">${ICON.plus}</button>
        <button class="ib" data-tool="export" title="导出提示词">${ICON.down2}</button>
        <button class="ib" data-tool="import" title="导入提示词">${ICON.up2}</button>`;
    }
  }

  $('#tabtools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    const tool = b.dataset.tool;
    if (tool === 'search') toggleOutlineSearch();
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
  const savePrompts = () => store.set('prompts', S.prompts);

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
      Object.assign(p, { title, content, tags, updatedAt: now });
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
          updatedAt: raw.updatedAt || Date.now(),
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
    if (!node || node.nodeType !== 3) return '';
    return node.textContent.slice(0, sel.anchorOffset);
  }

  function checkPicker(target) {
    const el = composerOf(target);
    if (!el) return closePicker();
    const before = textBeforeCaret(el);
    const m = before.match(/(?:^|\s)\/\/([^\s/]{0,30})$/);
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

  function choosePicker(i) {
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
      document.execCommand('delete');
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
      S.collapsed.clear();
      S.outlineQuery = '';
      if (S.searchOpen) toggleOutlineSearch(false);
      S.stars = new Set(await store.get(starKey(), []));
      force = true;
    }
    applyTheme();
    const model = buildModel();
    const sig = signature(model);
    S.model = model;
    if (!force && sig === S.sig) {
      updateActive();
      return;
    }
    S.sig = sig;
    if (!panel.hidden && S.settings.tab === 'outline') renderOutline();
  }
  const scheduleRefresh = debounce(() => refresh(false), 500);

  async function init() {
    S.settings = { ...DEFAULT_SETTINGS, ...(await store.get('settings', {})) };
    let prompts = await store.get('prompts', null);
    if (!Array.isArray(prompts)) {
      prompts = SEED_PROMPTS.map((p, i) => ({ ...p, id: uid() + i, updatedAt: Date.now() - i }));
      store.set('prompts', prompts);
    }
    S.prompts = prompts;
    S.varMemory = await store.get('varMemory', {});
    S.stars = new Set(await store.get(starKey(), []));
    document.documentElement.appendChild(host);
    applyTheme();
    syncChrome();
    await refresh(true);
    if (S.settings.tab === 'prompts') renderPrompts();
    new MutationObserver(scheduleRefresh).observe(document.body, {
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
