'use strict';
const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let pty = null;
try { pty = require('node-pty'); } catch (e) { console.error('node-pty failed to load:', e.message); }

const HOME_DIR = path.join(os.homedir(), '.agentgrid');
const TOOLS_BIN = path.join(HOME_DIR, 'tools', 'node_modules', '.bin');

const WEB_PRESETS = [
  ['Claude', 'https://claude.ai'],
  ['ChatGPT', 'https://chatgpt.com'],
  ['Kimi', 'https://www.kimi.com'],
  ['Qwen', 'https://chat.qwen.ai'],
  ['DeepSeek', 'https://chat.deepseek.com'],
  ['GLM (Z.ai)', 'https://chat.z.ai'],
  ['Gemini', 'https://gemini.google.com'],
  ['Grok', 'https://grok.com'],
  ['Perplexity', 'https://www.perplexity.ai'],
  ['Mistral Le Chat', 'https://chat.mistral.ai'],
];

// Providers reachable with an API key (or locally). Used for the chat windows and for opencode coding agents.
// format "openai" = /chat/completions (default), "anthropic" = /v1/messages. Model ids are only defaults: the app lists the real ones from the API.
const API_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'kimi', label: 'Kimi (Moonshot)', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k2-turbo-preview' },
  { id: 'glm', label: 'GLM (Z.ai)', baseUrl: 'https://api.z.ai/api/paas/v4', model: 'glm-4.6' },
  { id: 'qwen', label: 'Qwen (Alibaba Model Studio)', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'grok', label: 'Grok (xAI)', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { id: 'anthropic', label: 'Anthropic (API key)', format: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' },
  { id: 'ollama', label: 'Local model (Ollama, no key)', baseUrl: 'http://localhost:11434/v1', model: '', noKey: true },
  { id: 'custom', label: 'Custom OpenAI-compatible endpoint', baseUrl: 'https://', model: '', askUrl: true },
];

const NPM_PKG = { codex: '@openai/codex', opencode: 'opencode-ai' };

let win;
const views = new Map(); // tile id -> WebContentsView
const ptys = new Map();  // tile id -> pty

const stateFile = () => path.join(app.getPath('userData'), 'state.json');
const keysFile = () => path.join(app.getPath('userData'), 'keys.json');
const partitionOf = (id) => 'persist:tile-' + id;
const chromeUA = () => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;

// ---------- API key storage (encrypted with the macOS keychain via safeStorage) ----------
function readKeys() { try { return JSON.parse(fs.readFileSync(keysFile(), 'utf8')); } catch { return {}; } }
function getKey(id) {
  const v = readKeys()[id]; if (!v) return '';
  try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : ''; } catch { return ''; }
}
function setKey(id, key) {
  const keys = readKeys();
  if (!key) delete keys[id];
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable; refusing to store the key in plain text.');
    keys[id] = safeStorage.encryptString(key).toString('base64');
  }
  fs.writeFileSync(keysFile(), JSON.stringify(keys), { mode: 0o600 });
}

// ---------- Web tiles (real websites, one isolated session each) ----------
function ensureView(t) {
  let v = views.get(t.id);
  if (v) return v;
  const ses = session.fromPartition(partitionOf(t.id));
  ses.setUserAgent(chromeUA());
  v = new WebContentsView({ webPreferences: { session: ses, contextIsolation: true, sandbox: true, spellcheck: true } });
  const wc = v.webContents;
  wc.setUserAgent(chromeUA());
  wc.setWindowOpenHandler(({ url }) => {
    // allow login popups inside the same isolated session, open everything else in the default browser
    if (/accounts\.google\.|appleid\.apple|login\.microsoftonline|login\.live|auth0|github\.com\/login|oauth|\/sso|signin|login/i.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: ses } } };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  const send = () => win && !win.isDestroyed() && win.webContents.send('tile:nav', { id: t.id, title: wc.getTitle(), loading: wc.isLoading() });
  for (const ev of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']) wc.on(ev, send);
  wc.on('context-menu', (_e, p) => {
    const items = [];
    if (p.linkURL) items.push({ label: 'Open link in browser', click: () => shell.openExternal(p.linkURL) }, { type: 'separator' });
    if (p.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (p.selectionText) items.push({ role: 'copy' });
    items.push({ type: 'separator' }, { label: 'Reload', click: () => wc.reload() });
    Menu.buildFromTemplate(items).popup();
  });
  wc.loadURL(t.url).catch(() => {});
  views.set(t.id, v);
  win.contentView.addChildView(v);
  return v;
}

function removeView(id) {
  const v = views.get(id);
  if (!v) return;
  win.contentView.removeChildView(v);
  v.webContents.close();
  views.delete(id);
}

ipcMain.on('sync', (_e, { tiles, ids }) => {
  if (!win) return;
  for (const id of [...views.keys()]) if (!ids.includes(id)) removeView(id);
  for (const t of tiles) {
    const v = ensureView(t);
    v.setVisible(!!t.visible && t.rect.w > 20 && t.rect.h > 20);
    v.setBounds({ x: Math.round(t.rect.x), y: Math.round(t.rect.y), width: Math.max(0, Math.round(t.rect.w)), height: Math.max(0, Math.round(t.rect.h)) });
    if (t.zoom && Math.abs(v.webContents.getZoomFactor() - t.zoom) > 0.001) v.webContents.setZoomFactor(t.zoom);
  }
});

ipcMain.on('tile:cmd', (_e, { id, cmd, url }) => {
  const wc = views.get(id)?.webContents; if (!wc) return;
  if (cmd === 'reload') wc.reload();
  else if (cmd === 'back') wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack();
  else if (cmd === 'home') wc.loadURL(url).catch(() => {});
  else if (cmd === 'external') shell.openExternal(wc.getURL());
});

// ---------- Terminal tiles (Claude Code, Codex, opencode) ----------
function agentCommand(kind) {
  if (kind === 'claude') return 'command -v claude >/dev/null 2>&1 || { echo "Claude Code is not installed. See https://claude.com/claude-code"; exit 127; }; claude';
  const bin = kind === 'codex' ? 'codex' : 'opencode';
  const install = `command -v ${bin} >/dev/null 2>&1 || { echo "Installing ${bin} into ~/.agentgrid/tools ..."; npm i --prefix "$HOME/.agentgrid/tools" ${NPM_PKG[bin]} || exit 1; }`;
  // opencode >= 2 shares one background service (fixed port) between all instances, which breaks parallel windows.
  // --standalone gives every window its own private server; older versions don't know the flag.
  if (bin === 'opencode') return `${install}; F=""; opencode --help 2>&1 | grep -q -- "--standalone" && F="--standalone"; opencode $F`;
  return `${install}; ${bin}`;
}

ipcMain.on('pty:start', (_e, t) => {
  const { id, kind, cwd, configDir, cols, rows } = t;
  if (!pty || ptys.has(id)) return;
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(env)) if (/^(CLAUDECODE$|CLAUDE_CODE_)/.test(k)) delete env[k]; // do not inherit markers of a parent session
  env.PATH = [TOOLS_BIN, env.PATH || '/usr/bin:/bin'].join(path.delimiter);
  if (configDir) {
    fs.mkdirSync(configDir, { recursive: true });
    env[kind === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = configDir;
  }
  if (t.api && kind === 'opencode') {
    const key = getKey(id) || (t.api.noKey ? 'local' : '');
    const dataDir = path.join(HOME_DIR, 'opencode', id);
    fs.mkdirSync(dataDir, { recursive: true });
    env.XDG_DATA_HOME = path.join(dataDir, 'data'); env.XDG_STATE_HOME = path.join(dataDir, 'state'); // separate sessions per tile
    env.AGENTGRID_API_KEY = key;
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      provider: { grid: { npm: '@ai-sdk/openai-compatible', name: t.api.label || 'API', options: { baseURL: t.api.baseUrl, apiKey: '{env:AGENTGRID_API_KEY}' }, models: { [t.api.model]: { name: t.api.model } } } },
      model: 'grid/' + t.api.model,
    });
  }
  let dir = cwd; try { fs.accessSync(dir); } catch { dir = os.homedir(); }
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', kind === 'shell' ? ['-il'] : ['-ilc', agentCommand(kind)], { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env });
  ptys.set(id, p);
  p.onData((data) => { if (win) win.webContents.send('pty:data', { id, data }); });
  p.onExit(({ exitCode }) => { ptys.delete(id); if (win) win.webContents.send('pty:exit', { id, exitCode }); });
});
ipcMain.on('pty:input', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch {} });
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });
app.on('before-quit', () => { for (const p of ptys.values()) try { p.kill(); } catch {} });

// ---------- Chat windows: direct API calls, the key never leaves the main process ----------
const chats = new Map();
async function httpError(res) {
  let body = ''; try { body = await res.text(); } catch {}
  let msg = body; try { const j = JSON.parse(body); msg = j.error?.message || j.message || body; } catch {}
  return new Error(`HTTP ${res.status}: ${String(msg).slice(0, 400)}`);
}
async function readSSE(res, onData) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.startsWith('data:')) onData(line.slice(5).trim()); }
  }
  if (buf.startsWith('data:')) onData(buf.slice(5).trim());
}
const trimUrl = (u) => u.replace(/\/+$/, '');
async function streamChat(cfg, key, messages, signal, emit) {
  if (cfg.format === 'anthropic') {
    const res = await fetch(trimUrl(cfg.baseUrl) + '/v1/messages', {
      method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8192, messages, stream: true }),
    });
    if (!res.ok) throw await httpError(res);
    await readSSE(res, (d) => {
      let j; try { j = JSON.parse(d); } catch { return; }
      if (j.type === 'error') throw new Error(j.error?.message || 'stream error');
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') emit({ text: j.delta.text });
      if (j.type === 'content_block_delta' && j.delta?.type === 'thinking_delta') emit({ reasoning: j.delta.thinking });
    });
    return;
  }
  const res = await fetch(trimUrl(cfg.baseUrl) + '/chat/completions', {
    method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
  });
  if (!res.ok) throw await httpError(res);
  await readSSE(res, (d) => {
    if (d === '[DONE]') return;
    let j; try { j = JSON.parse(d); } catch { return; }
    if (j.error) throw new Error(j.error.message || 'stream error');
    const dl = j.choices?.[0]?.delta || {};
    if (dl.reasoning_content) emit({ reasoning: dl.reasoning_content });
    if (dl.content) emit({ text: dl.content });
  });
}
ipcMain.on('chat:send', async (_e, { id, cfg, messages }) => {
  if (chats.has(id)) return;
  const ac = new AbortController(); chats.set(id, ac);
  const out = (ch, d) => win && win.webContents.send(ch, { id, ...d });
  try {
    const key = getKey(id) || (cfg.noKey ? 'local' : '');
    if (!key) throw new Error('No API key stored for this window. Use ⋯ → settings.');
    if (!cfg.model) throw new Error('No model set. Use ⋯ → settings.');
    await streamChat(cfg, key, messages, ac.signal, (d) => out('chat:delta', d));
    out('chat:done', {});
  } catch (err) {
    if (ac.signal.aborted) out('chat:done', { stopped: true });
    else out('chat:error', { message: String(err.message || err) });
  } finally { chats.delete(id); }
});
ipcMain.on('chat:stop', (_e, { id }) => chats.get(id)?.abort());
ipcMain.handle('models:list', async (_e, { id, baseUrl, key, format }) => {
  try {
    key = key || (id ? getKey(id) : '');
    const anth = format === 'anthropic';
    const res = await fetch(trimUrl(baseUrl) + (anth ? '/v1/models' : '/models'), {
      signal: AbortSignal.timeout(8000),
      headers: anth ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : key ? { authorization: 'Bearer ' + key } : {},
    });
    if (!res.ok) return { error: (await httpError(res)).message };
    const j = await res.json();
    const ids = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
    return { models: ids };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('presets:get', () => API_PRESETS);

ipcMain.on('menu:tile', (e, { id, type }) => {
  const act = (action) => () => e.sender.send('tile:menu', { id, action });
  const common = [
    { label: 'Rename', click: act('rename') },
    { label: 'Text larger', click: act('zin') }, { label: 'Text smaller', click: act('zout') },
    { label: 'Snap', submenu: [
      { label: 'Left half', click: act('snap-left') }, { label: 'Right half', click: act('snap-right') },
      { label: 'Top half', click: act('snap-top') }, { label: 'Bottom half', click: act('snap-bottom') },
    ] },
    { type: 'separator' }, { label: 'Hide window', click: act('hide') },
  ];
  const own = type === 'chat' ? [{ label: 'Send last answer to selected agents', click: act('forward') }, { label: 'New chat (clear)', click: act('clear') }, { label: 'Settings (model / key / url)…', click: act('cfg') }]
    : type === 'agent' ? [{ label: 'Restart', click: act('restart') }, { label: 'Settings (model / key / url)…', click: act('cfg') }]
    : type === 'term' ? [{ label: 'Restart', click: act('restart') }]
    : [{ label: 'Back', click: act('back') }, { label: 'Reload', click: act('reload') }, { label: 'Home', click: act('home') }, { label: 'Open in browser', click: act('ext') }];
  Menu.buildFromTemplate([...own, { type: 'separator' }, ...common]).popup({ window: win });
});

// ---------- misc IPC ----------
ipcMain.handle('state:load', () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } });
ipcMain.on('state:save', (_e, s) => { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {} });
ipcMain.on('key:set', (_e, { id, key }) => { try { setKey(id, key); } catch (e) { dialog.showErrorBox('Could not store key', String(e.message || e)); } });
ipcMain.handle('pickFolder', async (_e, label) => {
  const f = await dialog.showOpenDialog(win, { title: `Project folder for ${label}`, properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('home') });
  return f.canceled ? null : f.filePaths[0];
});
ipcMain.handle('tile:remove', async (_e, { id, name, term, chat }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Remove', 'Cancel'], cancelId: 1, defaultId: 1, message: `Remove "${name}"?`,
    detail: chat ? 'The chat history and the stored API key of this window are deleted.' : term ? 'The terminal is closed. Its login folder is kept on disk.' : 'The login of this tile is deleted.',
  });
  if (r.response === 1) return false;
  if (term || chat) { try { setKey(id, ''); } catch {} chats.get(id)?.abort(); }
  else { try { await session.fromPartition(partitionOf(id)).clearStorageData(); } catch {} }
  return true;
});

async function askAccount(e, kind) {
  const label = kind === 'claude' ? 'Claude Code' : 'Codex';
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['New separate login', 'Existing login of this Mac', 'Cancel'], cancelId: 2, defaultId: 0,
    message: `${label}: which account?`,
    detail: 'A new login gets its own config folder, so any number of accounts can run in parallel. You sign in inside the tile on first start.',
  });
  if (r.response === 2) return;
  const f = await dialog.showOpenDialog(win, { title: `Project folder for ${label}`, properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('home') });
  if (f.canceled || !f.filePaths[0]) return;
  e.sender.send('tile:addTerm', { kind, label, cwd: f.filePaths[0], fresh: r.response === 0, home: HOME_DIR });
}

async function askShell(e) {
  const f = await dialog.showOpenDialog(win, { title: 'Start folder for the terminal', properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('home') });
  if (f.canceled || !f.filePaths[0]) return;
  e.sender.send('tile:addTerm', { kind: 'shell', label: 'Terminal', cwd: f.filePaths[0], fresh: false, home: HOME_DIR });
}

ipcMain.on('menu:layout', (e, { x, y }) => {
  const L = (kind) => () => e.sender.send('layout:apply', { kind });
  Menu.buildFromTemplate([
    { label: 'Grid (all equal)', click: L('grid') },
    { label: 'Columns', click: L('cols') },
    { label: 'Rows', click: L('rows') },
    { type: 'separator' },
    { label: 'Main window left 50% · others stacked right', click: L('main-left-50') },
    { label: 'Main window left 66% · others stacked right', click: L('main-left-66') },
    { label: 'Main window top 50% · others below', click: L('main-top-50') },
    { label: 'Main window right 50% · others stacked left', click: L('main-right-50') },
  ]).popup({ window: win, x: Math.round(x), y: Math.round(y) });
});

ipcMain.on('menu:add', (e, { x, y }) => {
  const withHome = (p) => ({ ...p, home: HOME_DIR });
  const tpl = [
    { label: 'Chat via API key', submenu: API_PRESETS.map((p) => ({ label: p.label, click: () => e.sender.send('tile:addChat', withHome(p)) })) },
    { label: 'Coding agent via API key (opencode)', submenu: API_PRESETS.filter((p) => p.id !== 'anthropic').map((p) => ({ label: p.label, click: () => e.sender.send('tile:addApi', withHome(p)) })) },
    { type: 'separator' },
    { label: 'Terminal (plain shell)', click: () => askShell(e) },
    { label: 'Claude Code (subscription login)', click: () => askAccount(e, 'claude') },
    { label: 'Codex (ChatGPT login)', click: () => askAccount(e, 'codex') },
    { type: 'separator' },
    { label: 'Website (chat)', submenu: [
      ...WEB_PRESETS.map(([name, url]) => ({ label: name, click: () => e.sender.send('tile:add', { name, url }) })),
      { type: 'separator' },
      { label: 'Custom URL…', click: () => e.sender.send('tile:addCustom') },
    ] },
  ];
  Menu.buildFromTemplate(tpl).popup({ window: win, x: Math.round(x), y: Math.round(y) });
});

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 920, minWidth: 700, minHeight: 500, title: 'AgentGrid',
    backgroundColor: '#000000', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.AGENTGRID_SCREENSHOT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      fs.writeFileSync(process.env.AGENTGRID_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
      app.quit();
    }, +(process.env.AGENTGRID_DELAY || 9000)));
  }
  win.on('closed', () => { win = null; views.clear(); });
}

app.setName('AgentGrid');
app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
