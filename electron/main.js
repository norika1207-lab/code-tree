// Electron shell: wraps core (file watcher + WS + agent runner) and the visual editor (cosmos.html)
// into a double-click-to-open desktop app. No terminal, no npm.
// Startup flow: pick a project folder → start core inside the app → open a window loading the world-tree canvas.
import { app, BrowserWindow, dialog, Menu, shell, ipcMain, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core/server.js';
import { startBragi, stopBragi } from './bragi.js';

// Code Tree does not store browser passwords or app secrets in Chromium storage.
// Without this, Electron/Chromium may ask macOS Keychain for "code-tree Safe Storage"
// on every launch, especially while the app is being rebuilt and ad-hoc signed.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('use-mock-keychain');
}
app.commandLine.appendSwitch('password-store', 'basic');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREF = path.join(app.getPath('userData'), 'prefs.json');
const LOG = path.join(app.getPath('userData'), 'codetree.log');

function logln(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ') + '\n';
  try { fs.appendFileSync(LOG, line); } catch {}
  process.stdout.write(line);
}
process.on('uncaughtException', (e) => logln('UNCAUGHT', e && e.stack || e));
process.on('unhandledRejection', (e) => logln('UNHANDLED', e && e.stack || e));
// Core (server.js) runs IN this main process and logs via console.log. From a Finder launch that output
// goes nowhere, which blinds us to whether remote detection/scan actually fired. Route it into codetree.log.
console.log = (...a) => logln('[core]', ...a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())));
console.error = (...a) => logln('[core:err]', ...a.map(String));

let core = null;
let win = null;
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// Remember the last opened project so we can go straight in next time
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREF, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
  try { fs.writeFileSync(PREF, JSON.stringify(p)); } catch {}
}

async function pickProject() {
  const r = await dialog.showOpenDialog({
    title: 'Choose a project folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open here',
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
}

// Watch root for no-project mode: an empty folder owned by the app. The visualization watches it (empty, light),
// while the terminal opens in the home directory and works as usual. Avoids recursively scanning all of home.
// A root is safe to open as a "project" only if it isn't the home dir, '/Users', or a volume root —
// watching those recursively saturates the file watcher and hangs the app. (See core attachWatcher guard.)
function isSafeRoot(p) {
  if (!p) return false;
  const abs = path.resolve(p);
  const home = os.homedir();
  if (abs === home || abs === path.dirname(home) || abs === path.parse(abs).root) return false;
  if (home.startsWith(abs + path.sep)) return false; // an ancestor of home (e.g. /Users)
  return true;
}

// Looks like a real project: has a marker file OR a top-level src/. Used to decide whether process.cwd() is
// worth opening as the root. Mirrors looksLikeProject in core/server.js, intentionally narrower (we want a
// strong signal at startup; cwd-follow handles the runtime cd's later).
function looksLikeProject(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    const markers = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'tsconfig.json', 'pom.xml', 'Gemfile', 'composer.json', 'setup.py'];
    for (const m of markers) if (fs.existsSync(path.join(dir, m))) return true;
    return fs.existsSync(path.join(dir, 'src'));
  } catch { return false; }
}

function scratchRoot() {
  const dir = path.join(app.getPath('userData'), 'no-project');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function startOn(root, opts = {}) {
  if (core) { try { core.close(); } catch {} core = null; }
  logln('startCore on', root, 'shell cwd', opts.terminalCwd || root, opts.remote ? `remote ${opts.remote.host}:${opts.remote.root}` : '');
  core = startCore({
    root, terminalCwd: opts.terminalCwd,
    projectLabel: opts.label, noProject: !!opts.noProject, quiet: false,
    remote: opts.remote || null,
  });
  logln('core webPort', core.webPort, 'wsPort', core.port);
  if (opts.remember !== false && isSafeRoot(root)) savePrefs({ lastProject: root });   // remember only real, safe project roots (never home/scratch)
  return core;
}

// loadURL may run a step ahead of the web server listening; retry on failure
function loadWithRetry(url, tries = 30) {
  win.loadURL(url).catch(() => {
    if (tries > 0) setTimeout(() => loadWithRetry(url, tries - 1), 150);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 980, minHeight: 640,
    backgroundColor: '#060a12',
    titleBarStyle: 'hiddenInset',
    title: 'Code Tree',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'), // expose window.codetree for the buttons in the bottom bar
    },
  });
  win.on('closed', () => { win = null; });
}

function installPermissionPolicy() {
  const denied = new Set([
    'camera',
    'microphone',
    'media',
    'audioCapture',
    'videoCapture',
    'bluetooth',
    'midi',
    'midiSysex',
    'geolocation',
    'notifications',
  ]);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!denied.has(permission));
  });
}

function openProjectFlow(root, opts = {}) {
  const c = startOn(root, opts);
  if (!win) createWindow();
  loadWithRetry(`http://localhost:${c.webPort}/`);
  if (win) win.setTitle('Code Tree · ' + (opts.label || path.basename(root)));
}

// No project, just a terminal: the terminal opens in the home directory, and the visualization stays empty until you touch a file.
function openNoProject() {
  const scratch = scratchRoot();
  openProjectFlow(scratch, { terminalCwd: scratch, label: 'No project', noProject: true, remember: false });
}

// Remote project over ssh: map a codebase that lives on another machine. `spec` is host:/path or ssh://host/path.
function parseRemoteSpec(spec) {
  if (!spec) return null;
  spec = spec.trim();
  let m = spec.match(/^ssh:\/\/([^/]+)(\/.*)$/);
  if (m) return { host: m[1], root: m[2] };
  m = spec.match(/^([A-Za-z0-9._@-]+):(\/?\S+)$/);
  if (m) return { host: m[1], root: m[2] };
  return null;
}
function openRemoteFlow(spec) {
  const remote = parseRemoteSpec(spec);
  if (!remote) { dialog.showMessageBox({ type: 'warning', message: 'Could not parse that. Use host:/path or ssh://host/path', detail: spec || '' }); return; }
  // the local watch root is just a scratch dir; the tree comes from the remote project
  openProjectFlow(scratchRoot(), { terminalCwd: os.homedir(), label: `${remote.host}:${remote.root}`, remote, remember: false });
}

// A small input window to type the remote target (Electron has no native text-prompt dialog).
let promptWin = null;
function openRemotePrompt() {
  if (promptWin) { promptWin.focus(); return; }
  promptWin = new BrowserWindow({
    width: 520, height: 200, resizable: false, parent: win || undefined, modal: !!win,
    title: 'Open remote project', backgroundColor: '#0b0f17',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'remote-preload.cjs') },
  });
  promptWin.setMenuBarVisibility(false);
  promptWin.loadFile(path.join(__dirname, 'remote-prompt.html'));
  promptWin.on('closed', () => { promptWin = null; });
}
ipcMain.on('ct:remote-submit', (_e, spec) => { if (promptWin) { promptWin.close(); } openRemoteFlow(spec); });
ipcMain.on('ct:remote-cancel', () => { if (promptWin) promptWin.close(); });

// Buttons in the bottom bar → reach here via preload
ipcMain.handle('ct:pick-project', async () => {
  const root = await pickProject();
  if (root) openProjectFlow(root);
  return root ? path.basename(root) : null;
});
ipcMain.handle('ct:open-no-project', () => { openNoProject(); return true; });

function buildMenu() {
  const template = [
    { role: 'appMenu' },
    {
      label: 'Project',
      submenu: [
        {
          label: 'Open another project…', accelerator: 'CmdOrCtrl+O',
          click: async () => { const root = await pickProject(); if (root) openProjectFlow(root); },
        },
        {
          label: 'Open remote project (ssh)…', accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openRemotePrompt(),
        },
        {
          label: 'Terminal only (no project)', accelerator: 'CmdOrCtrl+N',
          click: () => openNoProject(),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Code Tree on GitHub', click: () => shell.openExternal('https://github.com/norika1207-lab/Cosmos-Tree') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  logln('app ready, userData=', app.getPath('userData'));
  // The in-app agent uses a cloud model (Claude via the borrowed Claude Code login by default). The bundled
  // on-device model is disabled — keep the app small and rely on a real cloud LLM. (startBragi left importable
  // for users who still run the local stack manually via the `bragi` command.)
  void startBragi;
  buildMenu();
  installPermissionPolicy();
  createWindow();
  // show a welcome screen first to avoid a blank window
  win.loadFile(path.join(__dirname, 'welcome.html'));
  const prefs = loadPrefs();
  // Priority for auto-loading a project at startup:
  //   1. env CODE_TREE_ROOT (set by the `codetree [dir]` launcher)
  //   2. process.cwd() when it's safe AND looks like a project — covers `npm run app`, `electron .`, IDE-launched dev runs.
  //      The point: open the project the user is sitting in, not whatever they opened last week.
  //   3. prefs.lastProject (if still exists) — for double-click-from-Finder, where cwd is '/'
  //   4. no-project follow mode (terminal in home, tree grows when you cd into a project)
  // Rule: never silently enter no-project mode at startup if any of the above is available. An empty scratch folder
  // has no cells, so the right side stays blank and looks like the product is broken.
  const envRoot = process.env.CODE_TREE_ROOT;
  const cwdRoot = process.cwd();
  const cwdLooksGood = isSafeRoot(cwdRoot) && looksLikeProject(cwdRoot);
  let root = envRoot && fs.existsSync(envRoot) ? envRoot
    : (cwdLooksGood ? cwdRoot
    : (prefs.lastProject && fs.existsSync(prefs.lastProject) ? prefs.lastProject : null));
  // Drop an over-broad remembered root (e.g. the home dir) so we never reopen into a watcher-saturating hang.
  if (root && !isSafeRoot(root)) { logln('ignoring over-broad lastProject root:', root); savePrefs({}); root = null; }
  logln('startup root pick:', root || '(none)', '| env=', envRoot || '-', 'cwd-good=', cwdLooksGood, 'lastProject=', prefs.lastProject || '-');
  if (root) { openProjectFlow(root); return; }
  // First run / no remembered project: do NOT wall the user behind a native picker (that's a button, and it kept
  // dropping people into the empty no-project scratch → a permanently blank tree). Open straight into follow mode:
  // the terminal is live in your home dir, and the moment you cd into any project the tree grows there by itself.
  // The picker still exists under the Project menu (Cmd+O) for anyone who wants to point at a folder directly.
  logln('no env/lastProject, opening in follow mode (no picker wall)');
  openNoProject();
});

app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { try { stopBragi(); } catch {} if (core) try { core.close(); } catch {} });
