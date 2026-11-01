/*
 * 同步：把提示词、星标和隐藏记录保存到用户自己的 WebDAV 网盘（坚果云等）。
 * 网盘地址、账号和应用密码只保存在 chrome.storage.local，代码和仓库里没有任何个人数据。
 * 内容脚本不能跨域访问网盘，所以网络请求都放在这里。
 */
const FOLDER = 'chat-outline/';
const PROMPTS_FILE = FOLDER + 'prompts.json'; // 手机端也读写这个文件，格式不能随意改
const OUTLINE_FILE = FOLDER + 'outline.json';
const OPEN_INTERVAL = 60 * 1000; // 打开页面时最多每分钟拉取一次，避免触发网盘的频率限制
const TOMBSTONE_KEEP = 180 * 24 * 3600 * 1000; // 删除记录保留 180 天
const TIMEOUT = 30 * 1000;

const read = async (key, fallback) => {
  const r = await chrome.storage.local.get(key);
  return r[key] === undefined ? fallback : r[key];
};
const write = (key, value) => chrome.storage.local.set({ [key]: value });

// 按修改时间合并，较新的优先；删除记录比提示词新时删除生效
function mergeData(a, b, now = Date.now()) {
  const deleted = new Map();
  for (const t of [...a.tombstones, ...b.tombstones]) {
    if (now - t.deletedAt > TOMBSTONE_KEEP) continue;
    if ((deleted.get(t.id) || 0) < t.deletedAt) deleted.set(t.id, t.deletedAt);
  }
  const prompts = new Map();
  for (const p of [...a.prompts, ...b.prompts]) {
    const cur = prompts.get(p.id);
    if (!cur || (p.updatedAt || 0) > (cur.updatedAt || 0)) prompts.set(p.id, p);
  }
  for (const [id, p] of prompts) {
    if (!deleted.has(id)) continue;
    if ((p.updatedAt || 0) > deleted.get(id)) deleted.delete(id);
    else prompts.delete(id);
  }
  return {
    prompts: [...prompts.values()],
    tombstones: [...deleted].map(([id, deletedAt]) => ({ id, deletedAt })),
  };
}

const canonical = (d) =>
  JSON.stringify({
    prompts: [...d.prompts].sort((x, y) => (x.id < y.id ? -1 : 1)),
    tombstones: [...d.tombstones].sort((x, y) => (x.id < y.id ? -1 : 1)),
  });

// 星标和隐藏：同一项取修改时间较新的，取消后的记录保留 180 天
function mergeItems(a = {}, b = {}, now) {
  const out = {};
  for (const items of [a, b]) {
    for (const [key, item] of Object.entries(items)) {
      if (!item.on && now - item.at > TOMBSTONE_KEEP) continue;
      if (!out[key] || item.at > out[key].at) out[key] = item;
    }
  }
  return out;
}

function mergeOutline(a, b, now = Date.now()) {
  const conversations = {};
  for (const id of new Set([...Object.keys(a.conversations), ...Object.keys(b.conversations)])) {
    const x = a.conversations[id] || {};
    const y = b.conversations[id] || {};
    const marks = { stars: mergeItems(x.stars, y.stars, now), hidden: mergeItems(x.hidden, y.hidden, now) };
    if (Object.keys(marks.stars).length || Object.keys(marks.hidden).length) conversations[id] = marks;
  }
  return { conversations };
}

const sortedItems = (items = {}) => Object.keys(items).sort().map((k) => [k, items[k].on, items[k].at]);
const canonicalMarks = (m) => JSON.stringify([sortedItems(m.stars), sortedItems(m.hidden)]);
const canonicalOutline = (d) =>
  JSON.stringify(Object.keys(d.conversations).sort().map((id) => [id, canonicalMarks(d.conversations[id])]));

// 旧版本按网页路径保存星标和隐藏，这里改成按对话保存
async function migrateMarks() {
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => /^(stars|hidden):/.test(k));
  if (!old.length) return;
  const changed = {};
  for (const key of old) {
    const [, kind, host, path] = key.match(/^(stars|hidden):([^/]+)(.*)$/);
    const conv = (path.match(/\/(?:c|chat)\/([^/]+)/) || [])[1] || path;
    const target = 'marks:' + host + ':' + conv;
    const marks = changed[target] || all[target] || { stars: {}, hidden: {} };
    for (const item of all[key]) marks[kind][item] = marks[kind][item] || { on: true, at: 1 };
    changed[target] = marks;
  }
  await chrome.storage.local.set(changed);
  await chrome.storage.local.remove(old);
}

function authHeader(cfg) {
  const bytes = new TextEncoder().encode(cfg.user + ':' + cfg.pass);
  return 'Basic ' + btoa(String.fromCharCode(...bytes));
}

function dav(cfg, method, path, headers = {}, body) {
  return fetch(cfg.url + path, {
    method,
    headers: { Authorization: authHeader(cfg), ...headers },
    body,
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

function httpError(status) {
  if (status === 401 || status === 403) return '账号或应用密码不对';
  if (status === 429 || status === 503) return '网盘请求太频繁，请稍后再试';
  return '网盘返回错误 ' + status;
}

function friendly(e) {
  if (e.name === 'TimeoutError') return '连接网盘超时';
  if (e.name === 'TypeError') return '连不上网盘，请检查网络或地址';
  return e.message;
}

const promptsStore = {
  file: PROMPTS_FILE,
  empty: { prompts: [], tombstones: [] },
  parse(remote) {
    if (!Array.isArray(remote.prompts)) return null;
    return { prompts: remote.prompts, tombstones: remote.tombstones || [] };
  },
  read: async () => ({ prompts: await read('prompts', []), tombstones: await read('promptTombstones', []) }),
  async write(merged) {
    await write('prompts', merged.prompts);
    await write('promptTombstones', merged.tombstones);
  },
  merge: mergeData,
  canonical,
};

const outlineStore = {
  file: OUTLINE_FILE,
  empty: { conversations: {} },
  parse: (remote) => (remote.conversations ? { conversations: remote.conversations } : null),
  async read() {
    const all = await chrome.storage.local.get(null);
    const conversations = {};
    for (const key of Object.keys(all)) {
      const id = key.startsWith('marks:') && key.slice(6);
      // /new 这类页面不是对话，不同步
      if (id && !id.split(':')[1].startsWith('/')) conversations[id] = all[key];
    }
    return { conversations };
  },
  // 只写有变化的对话，避免打扰其他对话的页面
  async write(merged, local) {
    const changed = {};
    for (const [id, marks] of Object.entries(merged.conversations)) {
      const old = local.conversations[id];
      if (!old || canonicalMarks(old) !== canonicalMarks(marks)) changed['marks:' + id] = marks;
    }
    await chrome.storage.local.set(changed);
  },
  merge: mergeOutline,
  canonical: canonicalOutline,
};

async function syncFile(cfg, kind) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await dav(cfg, 'GET', kind.file);
    // 坚果云在文件夹还不存在时返回 409，其他网盘一般返回 404
    if (![200, 404, 409].includes(got.status)) throw new Error(httpError(got.status));
    let remote = null;
    if (got.status === 200) {
      try {
        remote = kind.parse(await got.json());
      } catch (e) {
        remote = null;
      }
      // 文件损坏时不能覆盖，否则可能丢掉其他电脑的数据
      if (!remote) throw new Error('网盘里的同步文件已损坏');
    }
    const etag = got.headers.get('ETag');

    const local = await kind.read();
    const merged = kind.merge(local, remote || kind.empty);
    const text = kind.canonical(merged);
    const pulled = text !== kind.canonical(local);
    if (pulled) await kind.write(merged, local);
    if (remote && text === kind.canonical(remote)) return { pulled, pushed: false };
    if (!remote && text === kind.canonical(kind.empty)) return { pulled, pushed: false };

    // 只在文件没被其他电脑改过时写入；改过就重新读取并合并
    const guard = etag ? { 'If-Match': etag } : remote ? {} : { 'If-None-Match': '*' };
    const body = JSON.stringify({ app: 'chat-outline', version: 1, ...merged }, null, 2);
    const put = (h) => dav(cfg, 'PUT', kind.file, { 'Content-Type': 'application/json', ...h }, body);
    let res = await put(guard);
    if (res.status === 404 || res.status === 409) {
      const made = await dav(cfg, 'MKCOL', FOLDER);
      if (!made.ok && made.status !== 405) throw new Error(httpError(made.status));
      res = await put(guard);
    }
    if (res.status === 412) continue;
    if (!res.ok) throw new Error(httpError(res.status));
    return { pulled, pushed: true };
  }
  throw new Error('其他电脑正在同步，请稍后再试');
}

async function syncOnce(cfg) {
  const scopes = await read('syncScopes', {});
  await migrateMarks();
  const result = { pulled: false, pushed: false };
  for (const [name, kind] of [['prompts', promptsStore], ['outline', outlineStore]]) {
    if (scopes[name] === false) continue;
    const r = await syncFile(cfg, kind);
    result.pulled = result.pulled || r.pulled;
    result.pushed = result.pushed || r.pushed;
  }
  return result;
}

let running = null;
let queued = false;

async function runSync(reason) {
  const cfg = await read('syncConfig', null);
  if (!cfg) return { ok: false, error: '还没有设置同步' };
  if (running) {
    queued = queued || reason !== 'open';
    return running;
  }
  if (reason === 'open') {
    const status = await read('syncStatus', null);
    if (status && Date.now() - status.at < OPEN_INTERVAL) return status;
  }
  running = (async () => {
    let status;
    try {
      const r = await syncOnce(cfg);
      status = { ok: true, at: Date.now(), ...r };
    } catch (e) {
      status = { ok: false, at: Date.now(), error: friendly(e) };
    }
    await write('syncStatus', status);
    return status;
  })();
  const status = await running;
  running = null;
  if (queued) {
    queued = false;
    return runSync('change');
  }
  return status;
}

async function testConfig(cfg) {
  try {
    const res = await dav(cfg, 'PROPFIND', '', { Depth: '0' });
    if (res.status === 207 || res.ok) return { ok: true };
    return { ok: false, error: httpError(res.status) };
  } catch (e) {
    return { ok: false, error: friendly(e) };
  }
}

chrome.runtime.onInstalled.addListener(migrateMarks);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'sync') runSync(msg.reason).then(reply);
  else if (msg.type === 'test-sync') testConfig(msg.cfg).then(reply);
  else if (msg.type === 'open-sync-settings') chrome.runtime.openOptionsPage().then(() => reply({ ok: true }));
  else return false;
  return true;
});
