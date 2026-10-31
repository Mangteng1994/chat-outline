/*
 * 提示词同步：把提示词保存到用户自己的 WebDAV 网盘（坚果云等）。
 * 网盘地址、账号和应用密码只保存在 chrome.storage.local，代码和仓库里没有任何个人数据。
 * 内容脚本不能跨域访问网盘，所以网络请求都放在这里。
 */
const FOLDER = 'chat-outline/';
const FILE = FOLDER + 'prompts.json';
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

async function syncOnce(cfg) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const got = await dav(cfg, 'GET', FILE);
    // 坚果云在文件夹还不存在时返回 409，其他网盘一般返回 404
    if (![200, 404, 409].includes(got.status)) throw new Error(httpError(got.status));
    let remote = null;
    if (got.status === 200) {
      try {
        remote = await got.json();
      } catch (e) {
        remote = null;
      }
      // 文件损坏时不能覆盖，否则可能丢掉其他电脑的提示词
      if (!remote || !Array.isArray(remote.prompts)) throw new Error('网盘里的同步文件已损坏');
      remote.tombstones = remote.tombstones || [];
    }
    const etag = got.headers.get('ETag');

    const local = { prompts: await read('prompts', []), tombstones: await read('promptTombstones', []) };
    const merged = mergeData(local, remote || { prompts: [], tombstones: [] });
    const text = canonical(merged);
    const pulled = text !== canonical(local);
    if (pulled) {
      await write('prompts', merged.prompts);
      await write('promptTombstones', merged.tombstones);
    }
    if (remote && text === canonical(remote)) return { pulled, pushed: false };

    // 只在文件没被其他电脑改过时写入；改过就重新读取并合并
    const guard = etag ? { 'If-Match': etag } : remote ? {} : { 'If-None-Match': '*' };
    const body = JSON.stringify({ app: 'chat-outline', version: 1, ...merged }, null, 2);
    const put = (h) => dav(cfg, 'PUT', FILE, { 'Content-Type': 'application/json', ...h }, body);
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

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'sync') runSync(msg.reason).then(reply);
  else if (msg.type === 'test-sync') testConfig(msg.cfg).then(reply);
  else if (msg.type === 'open-sync-settings') chrome.runtime.openOptionsPage().then(() => reply({ ok: true }));
  else return false;
  return true;
});
