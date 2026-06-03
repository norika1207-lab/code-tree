// Electron 外殼：把 core（file watcher + WS + agent runner）跟圖像編輯器（cosmos.html）
// 包成一個雙擊就開的桌面 app。不用終端機、不用 npm。
// 啟動流程：選一個專案資料夾 → 在 app 內起 core → 開視窗載入世界樹畫布。
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

// 記住上次開的專案，下次直接進
function loadPrefs() {
  try { return JSON.parse(fs.readFileSync(PREF, 'utf8')); } catch { return {}; }
}
function savePrefs(p) {
  try { fs.writeFileSync(PREF, JSON.stringify(p)); } catch {}
}

async function pickProject() {
  const r = await dialog.showOpenDialog({
    title: '選一個專案資料夾',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '在這裡開工',
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
}

// 無專案模式用的監看根：app 自己的一個空資料夾。視覺化監看它（空的、輕），
// 終端機卻開在家目錄，照常能用。不去遞迴掃整個 home。
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
  if (opts.remember !== false) savePrefs({ lastProject: root });   // 只記真專案，不記無專案 scratch
  return core;
}

// loadURL 可能比 web server listen 早一步，失敗就重試
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
      preload: path.join(__dirname, 'preload.cjs'), // 露出 window.codetree 給底下那條列的按鈕用
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

// 不選專案，只要一個終端機：終端機開在家目錄，視覺化先空著等你動檔。
function openNoProject() {
  openProjectFlow(scratchRoot(), { terminalCwd: os.homedir(), label: '無專案', noProject: true, remember: false });
}

// 底下那條列的按鈕 → 透過 preload 打到這裡
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
      label: '專案',
      submenu: [
        {
          label: '開啟另一個專案…', accelerator: 'CmdOrCtrl+O',
          click: async () => { const root = await pickProject(); if (root) openProjectFlow(root); },
        },
        {
          label: '只開終端機（無專案）', accelerator: 'CmdOrCtrl+N',
          click: () => openNoProject(),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: '檢視',
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
  // 先給一個歡迎畫面，避免空白視窗
  win.loadFile(path.join(__dirname, 'welcome.html'));
  const prefs = loadPrefs();
  // 開機自動帶專案的優先序：
  //   1. env（從 `codetree [dir]` launcher 帶進來的當前目錄）
  //   2. 上次開的專案（路徑當下確實存在）
  //   3. 彈選擇器讓使用者挑（不會偷偷掉進空 scratch，右邊樹至少要有東西長出來）
  // 規矩：絕不在啟動就靜默開無專案模式。無專案是「使用者明確點按鈕」才會進的狀態，
  // 不是 fallback。空 scratch 資料夾沒有 cell，右邊一定空白，看起來像產品壞掉。
  const envRoot = process.env.CODE_TREE_ROOT;
  let root = envRoot && fs.existsSync(envRoot) ? envRoot
    : (prefs.lastProject && fs.existsSync(prefs.lastProject) ? prefs.lastProject : null);
  if (root) { openProjectFlow(root); return; }
  // 沒有可用專案：彈選擇器。使用者取消才退到無專案（這是他自己選的，不是預設）。
  logln('no env/lastProject, prompting picker');
  const picked = await pickProject();
  if (picked) openProjectFlow(picked);
  else openNoProject();
});

app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (core) try { core.close(); } catch {} });
