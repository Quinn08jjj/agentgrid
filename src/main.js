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

// Coding agents driven by an API key or a local model.
// tool "claude"   = Claude Code pointed at an Anthropic-compatible endpoint
// tool "opencode" = opencode pointed at an OpenAI-compatible endpoint
const API_PRESETS = [
  { id: 'kimi', label: 'Kimi (Moonshot)', tool: 'claude', baseUrl: 'https://api.moonshot.ai/anthropic', model: 'kimi-k2-turbo-preview' },
  { id: 'deepseek', label: 'DeepSeek', tool: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat' },
  { id: 'glm', label: 'GLM (Z.ai)', tool: 'claude', baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6' },
  { id: 'qwen', label: 'Qwen (Alibaba Model Studio)', tool: 'claude', baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic', model: 'qwen3-coder-plus' },
  { id: 'ollama', label: 'Local model (Ollama, no key)', tool: 'claude', baseUrl: 'http://localhost:11434', model: 'qwen2.5-coder:7b', noKey: true },
  { id: 'grok', label: 'Grok (xAI, via opencode)', tool: 'opencode', baseUrl: 'https://api.x.ai/v1', model: 'grok-code-fast-1' },
  { id: 'custom-anthropic', label: 'Custom Anthropic-compatible endpoint', tool: 'claude', baseUrl: 'https://', model: '', askUrl: true },
  { id: 'custom-openai', label: 'Custom OpenAI-compatible endpoint (via opencode)', tool: 'opencode', baseUrl: 'https://', model: '', askUrl: true },
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
function agentCommand(kind, hasApi) {
  if (kind === 'claude') {
    // Claude Code's built-in prompt says "you are Claude"; for third-party models tell the model what it really is.
    const flag = hasApi ? ' --append-system-prompt "$AGENTGRID_IDENTITY"' : '';
    return `command -v claude >/dev/null 2>&1 || { echo "Claude Code is not installed. See https://claude.com/claude-code"; exit 127; }; claude${flag}`;
  }
  const bin = kind === 'codex' ? 'codex' : 'opencode';
  return `command -v ${bin} >/dev/null 2>&1 || { echo "Installing ${bin} into ~/.agentgrid/tools ..."; npm i --prefix "$HOME/.agentgrid/tools" ${NPM_PKG[bin]} || exit 1; }; ${bin}`;
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
  if (t.api) {
    const key = getKey(id) || (t.api.noKey ? 'local' : '');
    if (kind === 'claude') {
      delete env.ANTHROPIC_API_KEY;
      env.AGENTGRID_IDENTITY = `You are running inside the Claude Code CLI, but the underlying model is "${t.api.model}" from provider "${t.api.label || t.api.provider}" (endpoint ${t.api.baseUrl}). You are not an Anthropic Claude model. If the user asks which model you are, say that.`;
      Object.assign(env, {
        ANTHROPIC_BASE_URL: t.api.baseUrl, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_MODEL: t.api.model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: t.api.model, ANTHROPIC_DEFAULT_SONNET_MODEL: t.api.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: t.api.model,
        CLAUDE_CODE_SUBAGENT_MODEL: t.api.model, API_TIMEOUT_MS: '3000000', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
    } else {
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
  }
  let dir = cwd; try { fs.accessSync(dir); } catch { dir = os.homedir(); }
  const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-ilc', agentCommand(kind, !!t.api)], { name: 'xterm-256color', cols: cols || 100, rows: rows || 30, cwd: dir, env });
  ptys.set(id, p);
  p.onData((data) => { if (win) win.webContents.send('pty:data', { id, data }); });
  p.onExit(({ exitCode }) => { ptys.delete(id); if (win) win.webContents.send('pty:exit', { id, exitCode }); });
});
ipcMain.on('pty:input', (_e, { id, data }) => ptys.get(id)?.write(data));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => { try { ptys.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); } catch {} });
ipcMain.on('pty:kill', (_e, { id }) => { try { ptys.get(id)?.kill(); } catch {} ptys.delete(id); });
app.on('before-quit', () => { for (const p of ptys.values()) try { p.kill(); } catch {} });

// ---------- misc IPC ----------
ipcMain.handle('state:load', () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return null; } });
ipcMain.on('state:save', (_e, s) => { try { fs.writeFileSync(stateFile(), JSON.stringify(s)); } catch {} });
ipcMain.on('key:set', (_e, { id, key }) => { try { setKey(id, key); } catch (e) { dialog.showErrorBox('Could not store key', String(e.message || e)); } });
ipcMain.handle('pickFolder', async (_e, label) => {
  const f = await dialog.showOpenDialog(win, { title: `Project folder for ${label}`, properties: ['openDirectory', 'createDirectory'], defaultPath: app.getPath('home') });
  return f.canceled ? null : f.filePaths[0];
});
ipcMain.handle('tile:remove', async (_e, { id, name, term }) => {
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Remove', 'Cancel'], cancelId: 1, defaultId: 1, message: `Remove "${name}"?`,
    detail: term ? 'The terminal is closed. Its login folder is kept on disk.' : 'The login of this tile is deleted.',
  });
  if (r.response === 1) return false;
  if (term) { try { setKey(id, ''); } catch {} }
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

ipcMain.on('menu:add', (e, { x, y }) => {
  const tpl = [
    { label: 'Claude Code (subscription login)', click: () => askAccount(e, 'claude') },
    { label: 'Codex (ChatGPT login)', click: () => askAccount(e, 'codex') },
    { type: 'separator' },
    { label: 'Coding agent via API key / local model', submenu: API_PRESETS.map((p) => ({ label: p.label, click: () => e.sender.send('tile:addApi', { ...p, home: HOME_DIR }) })) },
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
