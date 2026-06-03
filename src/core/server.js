// Cosmos Tree Core。
// 職責：掃描專案 → 建活樹 → 監聽檔案變化 → 偵測異常 → WebSocket 廣播給 CLI / 視覺。
// 設計原則（spec）：以 file watcher 為主要訊號，agent log 為輔。
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WS_PORT, WEB_PORT, isIgnored, ANOMALY } from '../config.js';
import { Graph } from './state.js';
import { parseImports } from './parser.js';
import { createRunner } from './runner.js';
import { createSdkAgent } from '../cli/sdk-agent.js';
import { createRoutedAgent } from '../cli/routed-agent.js';
import { readUsage } from './token-meter.js';
import { computeSavings } from './token-savings.js';
import { createSessionLogger } from './session-log.js';

// 給本地小模型的工作紀律（routed 第一層用）。讓小模型真的呼叫工具、別只敘述計畫。
const LOCAL_DISCIPLINE = `（重要工作紀律）
- 任務還沒完成前，每一輪「只」輸出一個工具呼叫，不要用文字描述你「打算」呼叫什麼。想讀檔就直接發 read_file，想改檔就直接發 edit_file。
- 不要把工具呼叫寫成 markdown 或 JSON 範例貼在回覆裡。要呼叫就真的呼叫。
- 掌握足夠資訊就動手改（edit_file / write_file），不要只停在描述計畫。
- 改小檔（大約 40 行以內）就直接用 write_file 把整個檔案重寫一遍，這最可靠。
- 只有在整個任務確實做完時，才用純文字做最後收尾；那一輪不要再發工具呼叫。`;

// makeAgent 可注入：預設用 SDK agent（借 Claude Code 登入）；測試時換 scripted（不燒 token）。
export function startCore({ root = process.cwd(), port = WS_PORT, webPort = WEB_PORT, quiet = false, makeAgent, terminalCwd, projectLabel, noProject = false } = {}) {
  root = path.resolve(root);
  // 終端機開在哪個資料夾：預設跟監看根同一處；無專案模式時可以指到家目錄，
  // 讓 shell 立刻能用，視覺化卻不必去掃整個 home。
  const shellCwd = path.resolve(terminalCwd || root);
  // graph / root 可被 reroot 換掉（右邊世界樹跟著終端機 cwd 走），所以用 let
  let graph = new Graph(root);
  const wss = new WebSocketServer({ port });
  const clients = new Set();

  // ── 真 shell 的 PTY：用現成的 node-pty（VS Code / Hyper 同一顆），不自己重寫終端機。──
  // 守護式載入：沒裝也讓 core 照常跑，終端 pane 只回報「shell 未就緒」。
  let ptyMod = null, ptyTried = false;
  async function getPty() {
    if (ptyTried) return ptyMod;
    ptyTried = true;
    try { ptyMod = await import('node-pty'); }
    catch { ptyMod = null; }
    return ptyMod;
  }

  // ── 靜態服務：/ 吐「終端機 + 視覺化」分屏頁；/viz 吐純視覺化大圖。──
  const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web');
  const HTML_PATH = path.join(WEB_DIR, 'cosmos.html');
  const TERM_PATH = path.join(WEB_DIR, 'terminal.html');
  // 把實際 WS 埠 + 專案標籤注進頁面，前端才連得到本 core、底下那條列才顯示得出開的是什麼
  const projLabel = noProject ? '無專案' : (projectLabel || path.basename(root));
  const injectPort = (html) => html.replace('<head>',
    `<head><script>window.__WS_PORT__=${port};window.__PROJECT_LABEL__=${JSON.stringify(projLabel)};window.__NO_PROJECT__=${noProject ? 'true' : 'false'}</script>`);
  const serveHtml = (res, file, label) => {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(injectPort(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(label + ' 讀不到：' + e.message);
    }
  };
  const webServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    // 純視覺化大圖（終端右邊的 iframe 載這個；也可單開）
    if (u.pathname === '/viz') { serveHtml(res, HTML_PATH, 'cosmos.html'); return; }
    // /file?path=rel → 回單一檔案內容（點格子切進去看正在跑的 code）
    if (u.pathname === '/file') {
      const rel = u.searchParams.get('path') || '';
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('超出專案範圍');
        return;
      }
      try {
        const txt = fs.readFileSync(abs, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(txt);
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('讀不到：' + e.message);
      }
      return;
    }
    // /preview/<相對路徑> → 用正確 MIME 直接吐檔案（UI 檔在詳情面板裡渲染預覽用）。
    // 用路徑式 URL（不是 query），HTML 裡的相對資源（./app.js、圖片、css）才解析得到。
    if (u.pathname.startsWith('/preview/')) {
      const rel = decodeURIComponent(u.pathname.slice('/preview/'.length));
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('超出專案範圍');
        return;
      }
      const MIME = {
        '.html': 'text/html', '.htm': 'text/html', '.svg': 'image/svg+xml',
        '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
        '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
      };
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME[ext] || 'text/plain';
      const charset = mime.startsWith('text/') || mime === 'application/json' || mime === 'image/svg+xml';
      try {
        const buf = fs.readFileSync(abs);
        res.writeHead(200, { 'content-type': mime + (charset ? '; charset=utf-8' : '') });
        res.end(buf);
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('讀不到：' + e.message);
      }
      return;
    }
    // 其餘一律回「終端機 + 視覺化」分屏主頁
    serveHtml(res, TERM_PATH, 'terminal.html');
  });
  // web port 被占用就往後挪，視覺化才不會默默開不起來
  let actualWebPort = webPort;
  webServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && actualWebPort < webPort + 10) {
      actualWebPort++;
      setTimeout(() => webServer.listen(actualWebPort), 80);
    } else {
      log('web 服務起不來:', e.message);
    }
  });
  webServer.on('listening', () => log(`世界樹開在 http://localhost:${actualWebPort}`));
  webServer.listen(actualWebPort);

  const log = (...a) => !quiet && console.log('[core]', ...a);

  // ── Session 逐字稿：每條 pty（一次 CLI 開啟）配一個記錄器，整段過程寫成 txt。──
  const sessionLogs = new Set();
  function logEvent(tag, text) { for (const l of sessionLogs) l.event(tag, text); }
  // 把「網頁派工」流（不經過終端 pane）的 agent 動作也記進逐字稿，才算「完整記錄」。
  function logBroadcast(msg) {
    if (!sessionLogs.size || !msg || !msg.payload) return;
    const p = msg.payload;
    switch (msg.type) {
      case 'prompt': logEvent('prompt', p.text); break;
      case 'agent_text': for (const l of sessionLogs) l.stream('agent', p.delta); break;
      case 'agent_tool': logEvent('tool', `${p.name}${p.path ? ' → ' + p.path : ''}`); break;
      case 'agent_error': logEvent('error', p.message); break;
      case 'gate': logEvent('MASL', p.report && p.report.reason ? p.report.reason : 'gate'); break;
      case 'anomaly': logEvent('anomaly', p.message); break;
      default: break;
    }
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(data);
    }
    logBroadcast(msg);
  }

  function pushState() {
    broadcast({ type: 'state', payload: graph.snapshot() });
  }

  // ── Agent runner：讓瀏覽器（或 CLI）透過 WS 派 prompt，agent 在 core 這邊跑 ──
  // 省 token 引擎：CODETREE_ENGINE=routed 時，每個任務先丟本地小模型（baseURL 指的那台），
  // verify 過就收工，整段 0 Anthropic token；本地跑不過品質地板才升級到 Claude SDK。
  // 沒設 env（或本地那台沒開）就退回純 SDK，現有使用者零影響。
  const ENGINE = process.env.CODETREE_ENGINE || 'sdk';
  const LOCAL_URL = process.env.CODETREE_LOCAL_URL || 'http://localhost:8000/v1';
  const LOCAL_MODEL = process.env.CODETREE_LOCAL_MODEL || 'qwen-coder';
  const defaultAgent = ({ onEvent, emit, getState, onGate, lastSaid }) => {
    if (ENGINE === 'routed') {
      log(`省 token 引擎啟用：先本地 ${LOCAL_MODEL}（${LOCAL_URL}），跑不過才升級 Claude`);
      return createRoutedAgent({
        root, emit, onEvent,
        baseURL: LOCAL_URL, localModel: LOCAL_MODEL,
        systemSuffix: LOCAL_DISCIPLINE,
        sdkOpts: { getState, onGate, lastSaid },
      });
    }
    return createSdkAgent({ root, onEvent, emit, getState, onGate, lastSaid });
  };
  const makeAgentFn = makeAgent || defaultAgent;
  // reroot 時要拿新的 graph/root 重綁，所以包成工廠；idle 才換，不打斷正在跑的 agent
  function makeRunner() { return createRunner({ root, graph, broadcast, makeAgent: makeAgentFn }); }
  let runner = makeRunner();

  function reparse(absPath) {
    if (!graph.isCode(absPath)) return;
    graph.setImports(absPath, parseImports(absPath, root));
  }

  // ── 掃描 watcher：可被 reroot 換根，右邊世界樹跟著終端機 cwd 走 ──
  let ready = false;
  let watcher = null;
  function attachWatcher() {
    ready = false;
    watcher = chokidar.watch(root, {
      ignored: (p) => isIgnored(p), // chokidar v4：ignored 吃 function，不再吃 glob
      ignoreInitial: false,
      persistent: true,
    });
    watcher
    .on('add', (p) => {
      if (!graph.isCode(p)) return;
      graph.ensureCell(p);
      reparse(p);
      if (ready) {
        const cell = graph.record(p, 'create');
        emitActivity(cell, 'create');
        pushState();
      }
    })
    .on('change', (p) => {
      if (!graph.isCode(p)) return;
      reparse(p);
      const cell = graph.record(p, 'modify');
      emitActivity(cell, 'modify');
      // 異常：反覆修改
      if (cell.modification_count >= ANOMALY.REPEAT_MODIFY) {
        broadcast({
          type: 'anomaly',
          payload: {
            rule: 'repeat_modify',
            cell_id: cell.id,
            path: cell.path,
            count: cell.modification_count,
            message: `第 ${cell.modification_count} 次修改 ${cell.path}，方向可能未收斂`,
          },
        });
      }
      pushState();
    })
    .on('unlink', (p) => {
      if (!graph.cells.has(p)) return;
      graph.record(p, 'delete');
      pushState();
    })
    .on('ready', () => {
      ready = true;
      log(`掃描完成，${graph.cells.size} 個檔案節點，${graph.edges.size} 條依賴連線`);
      pushState();
    });
  }
  attachWatcher();

  // 換監看根：終端機 cd 到別的專案 → 右邊重新長那個專案。WS / web server 都不動，
  // 同一條連線直接換掉底下的 graph，重掃完一次 pushState，畫面平順換成新專案。
  function reroot(newDir) {
    const resolved = path.resolve(newDir);
    if (resolved === root) return;
    log('reroot ->', resolved);
    root = resolved;
    if (watcher) { try { watcher.close(); } catch {} }
    graph = new Graph(root);
    if (!runner.busy) runner = makeRunner(); // idle 才換 runner，不打斷正在跑的 agent
    attachWatcher();
    broadcast({ type: 'project', payload: { root, label: path.basename(root) } });
  }

  // ── 跟著終端機 cwd：shell cd 進某個專案，右邊自動換根。非侵入式（不改使用者 shell）──
  let cwdTimer = null, followPid = null, lastCwd = shellCwd;
  function shellCwdOf(pid) {
    return new Promise((res) => {
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }, (err, out) => {
        if (err) return res(null);
        const line = String(out).split('\n').find((l) => l[0] === 'n');
        res(line ? line.slice(1) : null);
      });
    });
  }
  function looksLikeProject(dir) {
    try { return fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, 'package.json')); }
    catch { return false; }
  }
  function startCwdFollow(pid) {
    if (cwdTimer) return;
    followPid = pid;
    cwdTimer = setInterval(async () => {
      if (!followPid) return;
      const cwd = await shellCwdOf(followPid);
      if (!cwd || cwd === lastCwd) return;
      lastCwd = cwd;
      if (looksLikeProject(cwd) && path.resolve(cwd) !== root) reroot(cwd);
    }, 1500);
  }
  function stopCwdFollow() { if (cwdTimer) clearInterval(cwdTimer); cwdTimer = null; followPid = null; }

  // ── Token 列：讀「你在這個 cwd 跑 claude」那場 Claude Code session 的真實用量，
  // 每 2 秒推一次給輸入框上方那條。baseline 是「清掉」按鈕的歸零點（扣掉它才是本次累計）；
  // 換 session 檔（開新對話）就自動把 baseline 歸零，數字重新從 0 起算。──
  let tokTimer = null;
  let tokBaseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let tokSessionFile = null;
  function tokensSnapshot() {
    const u = readUsage(lastCwd); // { input, output, cacheRead, cacheWrite, file }
    if (u.file !== tokSessionFile) { // 換了 session 檔 → 新對話，歸零基準
      tokSessionFile = u.file;
      tokBaseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const d = (k) => Math.max(0, (u[k] || 0) - (tokBaseline[k] || 0));
    const input = d('input'), output = d('output');
    const cacheRead = d('cacheRead'), cacheWrite = d('cacheWrite');
    return {
      input, output, cacheRead, cacheWrite,
      saved: cacheRead,                       // cache 命中 = 沒重送的 token = 省下的
      burned: input + output + cacheWrite,    // 真的燒掉的
    };
  }
  function broadcastTokens() { broadcast({ type: 'tokens', payload: tokensSnapshot() }); }
  function startTokens() {
    if (tokTimer) return;
    broadcastTokens();
    tokTimer = setInterval(broadcastTokens, 2000);
  }
  function clearTokens() { // 「清掉」：把目前的原始累計設成新基準，顯示歸零
    const u = readUsage(lastCwd);
    tokSessionFile = u.file;
    tokBaseline = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 };
    broadcastTokens();
  }
  function stopTokens() { if (tokTimer) clearInterval(tokTimer); tokTimer = null; }
  startTokens();

  // ── 「不清的代價」：掃全機 session 算 cache 浪費，廣播給 token 列旁邊那塊。
  // 比 token 列慢（讀很多檔），10 秒一次就好；上一輪沒算完不疊下一輪。──
  let saveTimer = null, savingBusy = false;
  async function broadcastSavings() {
    if (savingBusy) return;
    savingBusy = true;
    try {
      const s = await computeSavings();
      if (s && s.ok) broadcast({ type: 'savings', payload: {
        clearNowUsd: s.clear_now_savings_usd || 0, // 現在清，下一小時省這麼多 = 不清的代價
        wastedUsd: s.wasted_usd || 0,              // 已經寫進 cache 卻沒被讀回 = 已浪費
        wastedTokens: s.wasted_tokens || 0,
        nActive: s.n_active || 0,
      } });
    } catch {} finally { savingBusy = false; }
  }
  function startSavings() {
    if (saveTimer) return;
    broadcastSavings();
    saveTimer = setInterval(broadcastSavings, 10000);
  }
  function stopSavings() { if (saveTimer) clearInterval(saveTimer); saveTimer = null; }
  startSavings();

  function emitActivity(cell, action) {
    broadcast({
      type: 'activity',
      payload: { path: cell.path, action, count: cell.modification_count, ts: Date.now() },
    });
  }

  // ── WebSocket：CLI、視覺化、終端機都連這裡 ──
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', payload: graph.snapshot() }));
    ws.send(JSON.stringify({ type: 'tokens', payload: tokensSnapshot() }));
    let pty = null; // 這條連線專屬的 shell（終端 pane 要求時才開）
    let slog = null; // 這條連線的 session 逐字稿（pty 起來才開）

    async function startPty(cols, rows) {
      if (pty) return;
      const mod = await getPty();
      if (!mod) { // 沒裝 node-pty：照實回報，不假裝有終端機
        ws.send(JSON.stringify({ type: 'pty_missing' }));
        return;
      }
      const shell = process.env.SHELL || '/bin/zsh';
      // 從 Finder 雙擊開的 GUI app 只拿得到 launchd 的精簡 PATH（沒有 /opt/homebrew/bin
      // 之類），打 claude、brew 裝的工具會「找不到指令」像沒反應。用登入 shell（-l）開，
      // 讓它 source 使用者的 .zprofile / .zshrc 把完整 PATH 補回來。VS Code、Hyper 同招。
      const loginArgs = /\/(zsh|bash|sh|fish)$/.test(shell) ? ['-l'] : [];
      pty = mod.spawn(shell, loginArgs, {
        name: 'xterm-color',
        cols: cols || 80, rows: rows || 24,
        cwd: shellCwd, env: process.env,
      });
      // CLI 一開就起逐字稿，把這條 shell 的所有可見輸出寫進 txt（給日後記憶訓練用）。
      slog = createSessionLogger({ root, label: projLabel });
      if (slog.ok) {
        sessionLogs.add(slog);
        ws.send(JSON.stringify({ type: 'session_log', payload: { file: slog.file } }));
        log('session 逐字稿 ->', slog.file);
      }
      pty.onData((d) => {
        if (slog) slog.stream('term', d);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pty_output', data: d }));
      });
      pty.onExit(() => {
        ws.send(JSON.stringify({ type: 'pty_exit' }));
        stopCwdFollow();
        if (slog) { sessionLogs.delete(slog); slog.close('shell exited'); slog = null; }
        pty = null;
      });
      startCwdFollow(pty.pid); // 終端機開了就盯它的 cwd，cd 進專案右邊自動換根
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // 終端 pane 的訊息走專線（真 shell 的 stdin / resize），其餘交給共用處理
      if (msg.type === 'pty_start') { startPty(msg.cols, msg.rows); return; }
      if (msg.type === 'pty_input') { if (pty) pty.write(msg.data); return; }
      if (msg.type === 'pty_resize') { if (pty) try { pty.resize(msg.cols, msg.rows); } catch {} return; }
      handleInbound(msg);
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (pty) { try { pty.kill(); } catch {} pty = null; }
      if (slog) { sessionLogs.delete(slog); slog.close('disconnected'); slog = null; }
    });
  });

  // CLI 端把 agent 動作（read / prompt）回報進來，當作輔助訊號
  function handleInbound(msg) {
    if (msg.type === 'agent_read' && msg.path) {
      const abs = path.resolve(root, msg.path);
      const cell = graph.record(abs, 'read', msg.prompt_id);
      emitActivity(cell, 'read');
      pushState();
    } else if (msg.type === 'agent_active' && msg.path) {
      // CLI 回報 agent 正在哪一格 → 廣播，讓 3D 鏡頭飛過去
      const abs = path.resolve(root, msg.path);
      const cell = graph.record(abs, 'active');
      broadcast({ type: 'active', payload: { path: cell.path, id: abs } });
      pushState();
    } else if (msg.type === 'run' && msg.text) {
      // 瀏覽器當主介面：在視窗下 prompt → core 跑 agent，事件串回網頁
      runner.run(msg.text, msg.id);
    } else if (msg.type === 'gate_reply') {
      // 網頁回覆 MASL 關卡：放行 / 擋下
      runner.replyGate(msg.id, msg.approve);
    } else if (msg.type === 'tokens_clear') {
      // 輸入框上方那條的「清掉」按鈕：把目前累計設成新基準，數字歸零
      clearTokens();
    } else if (msg.type === 'prompt') {
      graph.activePromptId = msg.id || null; // 之後 watcher 抓到的修改都歸這個 prompt
      broadcast({ type: 'prompt', payload: { id: msg.id, text: msg.text, ts: Date.now() } });
    } else if (msg.type === 'error_seen' && msg.message) {
      const n = (graph.errorSeen.get(msg.message) || 0) + 1;
      graph.errorSeen.set(msg.message, n);
      if (n >= 2) {
        broadcast({
          type: 'anomaly',
          payload: { rule: 'error_recurring', message: `錯誤未解決（第 ${n} 次）：${msg.message}` },
        });
      }
    }
  }

  // ── 卡住偵測：週期性掃描 ──
  const stallTimer = setInterval(() => {
    const stalled = graph.checkStall();
    for (const cell of stalled) {
      broadcast({
        type: 'anomaly',
        payload: { rule: 'stall', cell_id: cell.id, path: cell.path, message: `${cell.path} 停滯超過 10 分鐘，可能卡住` },
      });
    }
    if (stalled.length) pushState();
  }, 30 * 1000);

  log(`WebSocket 開在 ws://localhost:${port}，監看 ${root}`);

  return {
    graph,
    port,
    get webPort() { return actualWebPort; },
    close() {
      clearInterval(stallTimer);
      stopCwdFollow();
      stopTokens();
      stopSavings();
      for (const l of sessionLogs) l.close('core shutdown');
      sessionLogs.clear();
      if (watcher) watcher.close();
      wss.close();
      webServer.close();
    },
  };
}

// 允許直接 `node src/core/server.js [targetDir]` 起動
// 用 pathToFileURL 比對，路徑含空白（如 "Cosmos Tree"）才不會誤判。
import { pathToFileURL } from 'node:url';
// process.argv[1] 在打包後的 Electron 裡可能是 undefined，先擋一下才不會在 import 時就炸。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] || process.cwd();
  startCore({ root: target });
}
