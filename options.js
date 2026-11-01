const $ = (id) => document.getElementById(id);

function show(text, ok) {
  $('msg').textContent = text;
  $('msg').className = ok === undefined ? '' : ok ? 'ok' : 'err';
}

function describe(status) {
  if (!status.ok) return '同步失败：' + status.error;
  return `同步完成（${new Date(status.at).toLocaleTimeString()}）`;
}

async function load() {
  const { syncConfig: cfg, syncStatus: status, syncScopes: scopes = {} } = await chrome.storage.local.get([
    'syncConfig',
    'syncStatus',
    'syncScopes',
  ]);
  $('scope-prompts').checked = scopes.prompts !== false;
  $('scope-outline').checked = scopes.outline !== false;
  if (!cfg) return;
  $('url').value = cfg.url;
  $('name').value = cfg.name || '';
  $('user').value = cfg.user;
  $('pass').value = cfg.pass;
  $('off').hidden = false;
  if (status) show(describe(status), status.ok);
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  let url;
  try {
    url = new URL($('url').value.trim());
  } catch (err) {
    return show('WebDAV 地址不正确', false);
  }
  if (!/^https?:$/.test(url.protocol)) return show('WebDAV 地址要以 https:// 开头', false);
  // 权限申请必须紧跟在用户点击之后
  const granted = await chrome.permissions.request({ origins: [url.origin + '/*'] });
  if (!granted) return show('没有授权访问这个地址，无法同步', false);

  const href = url.href.endsWith('/') ? url.href : url.href + '/';
  const cfg = { name: $('name').value.trim(), url: href, user: $('user').value.trim(), pass: $('pass').value };
  show('正在连接网盘…');
  const test = await chrome.runtime.sendMessage({ type: 'test-sync', cfg });
  if (!test.ok) return show('连接失败：' + test.error, false);

  const syncScopes = { prompts: $('scope-prompts').checked, outline: $('scope-outline').checked };
  await chrome.storage.local.set({ syncConfig: cfg, syncEnabled: true, syncScopes });
  show('正在同步…');
  const status = await chrome.runtime.sendMessage({ type: 'sync', reason: 'manual' });
  show(describe(status), status.ok);
  $('off').hidden = false;
});

$('off').addEventListener('click', async () => {
  await chrome.storage.local.remove(['syncConfig', 'syncStatus']);
  await chrome.storage.local.set({ syncEnabled: false });
  $('user').value = '';
  $('pass').value = '';
  $('off').hidden = true;
  show('已关闭同步。本地和网盘里的数据都还在。', true);
});

load();
