// Electron shell: wraps core (file watcher + WS + agent runner) and the visual editor (cosmos.html)
// into a double-click-to-open desktop app. No terminal, no npm.
// Startup flow: pick a project folder → start core inside the app → open a window loading the world-tree canvas.
import { app, BrowserWindow, dialog, Menu, shell, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { startCore } from '../src/core/server.js';

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

let core = null;
let win = null;

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
function scratchRoot() {
  const dir = path.join(app.getPath('userData'), 'no-project');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function startOn(root, opts = {}) {
  if (core) { try { core.close(); } catch {} core = null; }
  logln('startCore on', root, 'shell cwd', opts.terminalCwd || root);
  core = startCore({
    root, terminalCwd: opts.terminalCwd,
    projectLabel: opts.label, noProject: !!opts.noProject, quiet: false,
  });
  logln('core webPort', core.webPort, 'wsPort', core.port);
  if (opts.remember !== false) savePrefs({ lastProject: root });   // only remember real projects, not the no-project scratch
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

function openProjectFlow(root, opts = {}) {
  const c = startOn(root, opts);
  if (!win) createWindow();
  loadWithRetry(`http://localhost:${c.webPort}/`);
  if (win) win.setTitle('Code Tree · ' + (opts.label || path.basename(root)));
}

// No project, just a terminal: the terminal opens in the home directory, and the visualization stays empty until you touch a file.
function openNoProject() {
  openProjectFlow(scratchRoot(), { terminalCwd: os.homedir(), label: 'No project', noProject: true, remember: false });
}

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
  logln('app ready, userData=', app.getPath('userData'));
  buildMenu();
  createWindow();
  // show a welcome screen first to avoid a blank window
  win.loadFile(path.join(__dirname, 'welcome.html'));
  const prefs = loadPrefs();
  // Priority for auto-loading a project at startup:
  //   1. env (the current dir passed in by the `codetree [dir]` launcher)
  //   2. the last opened project (if its path still exists)
  //   3. pop the picker and let the user choose (won't silently drop into an empty scratch; the right-side tree must have something growing)
  // Rule: never silently enter no-project mode at startup. No-project is a state you enter only when "the user explicitly clicks the button",
  // not a fallback. An empty scratch folder has no cells, so the right side is always blank and looks like the product is broken.
  const envRoot = process.env.CODE_TREE_ROOT;
  let root = envRoot && fs.existsSync(envRoot) ? envRoot
    : (prefs.lastProject && fs.existsSync(prefs.lastProject) ? prefs.lastProject : null);
  if (root) { openProjectFlow(root); return; }
  // No usable project: pop the picker. Only fall back to no-project if the user cancels (their own choice, not the default).
  logln('no env/lastProject, prompting picker');
  const picked = await pickProject();
  if (picked) openProjectFlow(picked);
  else openNoProject();
});

app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (core) try { core.close(); } catch {} });
