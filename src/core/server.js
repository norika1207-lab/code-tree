// Cosmos Tree Core.
// Responsibilities: scan the project → build the live tree → watch file changes → detect anomalies → broadcast to CLI / visualization over WebSocket.
// Design principle (spec): the file watcher is the primary signal, agent log is secondary.
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WS_PORT, WEB_PORT, isIgnored, ANOMALY } from '../config.js';
import { Graph } from './state.js';
import { parseImports } from './parser.js';
import { createRemoteSource } from './remote-source.js';
import { createDraftStream } from './draft-stream.js';
import { traceProject } from './agent-trace.js';
import { createEmptyState as lmState, ingestEvent as lmIngest, evaluateAll as lmEval, setFileResolver as lmResolver } from './lie-monitor.js';
import { createRunner } from './runner.js';
import { createSdkAgent } from '../cli/sdk-agent.js';
import { createRoutedAgent } from '../cli/routed-agent.js';
import { createAgent } from '../cli/agent.js';
import { createLocalLLM } from '../cli/local-llm.js';
import { createMemory } from '../cli/memory.js';
import { readUsage } from './token-meter.js';
import { computeSavings } from './token-savings.js';
import { createSessionLogger } from './session-log.js';

// Work discipline for the local small model (used by routed's first tier). Makes the small model actually call tools instead of just describing a plan.
const LOCAL_DISCIPLINE = `(Important work discipline)
- Until the task is done, emit ONLY one tool call per turn. Do not describe in prose what you "intend" to call. Want to read a file? Send read_file directly. Want to change a file? Send edit_file directly.
- Do not paste tool calls as markdown or JSON examples in your reply. If you mean to call a tool, actually call it.
- Once you have enough information, make the change (edit_file / write_file). Do not stop at describing a plan.
- For small files (roughly under 40 lines), just rewrite the whole file with write_file. This is the most reliable approach. edit_file's old_str must match the text in the file exactly (including whitespace and punctuation); if it doesn't match it will fail.
- If a tool tells you it "could not find the text to replace", that edit did not take effect. Switch to write_file and rewrite the whole file. Do not paste the same old_str again.
- Only when the entire task is truly done should you give a final plain-text wrap-up; do not emit any tool call on that turn.`;

// makeAgent is injectable: defaults to the SDK agent (borrowing Claude Code's login); tests swap in scripted (burns no token).
export function startCore({ root = process.cwd(), port = WS_PORT, webPort = WEB_PORT, quiet = false, makeAgent, terminalCwd, projectLabel, noProject = false, remote = null } = {}) {
  root = path.resolve(root);
  // Remote mode: the project lives on another machine, mapped over ssh (see remote-source.js).
  // The local graph/chokidar are bypassed; the tree comes from periodic remote snapshots.
  let remoteSnap = null;
  let remoteSource = null;
  const baselines = new Map(); // absPath → original content at session start, for ledger "revert" (local mode)
  // Which folder the terminal opens in: defaults to the same place as the watch root; in no-project mode it can point at the home directory,
  // so the shell is immediately usable while the visualization doesn't have to scan all of home.
  const shellCwd = path.resolve(terminalCwd || root);
  // graph / root can be swapped out by reroot (the world tree on the right follows the terminal's cwd), hence let
  let graph = new Graph(root);
  const wss = new WebSocketServer({ port });
  const clients = new Set();

  // ── Real shell PTY: use the off-the-shelf node-pty (same one as VS Code / Hyper) instead of rewriting a terminal ourselves. ──
  // Guarded load: even if it's not installed, core keeps running and the terminal pane just reports "shell not ready".
  let ptyMod = null, ptyTried = false;
  async function getPty() {
    if (ptyTried) return ptyMod;
    ptyTried = true;
    try { ptyMod = await import('node-pty'); }
    catch { ptyMod = null; }
    return ptyMod;
  }

  // ── Static serving: / returns the "terminal + visualization" split-screen page; /viz returns the full visualization view. ──
  const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../web');
  const HTML_PATH = path.join(WEB_DIR, 'cosmos.html');
  const TERM_PATH = path.join(WEB_DIR, 'terminal.html');
  // Inject the actual WS port + project label into the page, so the frontend can connect to this core and the bottom bar can show what's open
  const projLabel = noProject ? 'no project' : (projectLabel || path.basename(root));
  const injectPort = (html) => html.replace('<head>',
    `<head><script>window.__WS_PORT__=${port};window.__PROJECT_LABEL__=${JSON.stringify(projLabel)};window.__NO_PROJECT__=${noProject ? 'true' : 'false'}</script>`);
  const serveHtml = (res, file, label) => {
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(injectPort(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(label + ' cannot read: ' + e.message);
    }
  };
  const webServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    // Bundled front-end libraries (xterm, d3) served locally so the app works fully offline — no CDN.
    if (u.pathname.startsWith('/vendor/')) {
      const name = path.basename(u.pathname); // no traversal
      const file = path.join(WEB_DIR, 'vendor', name);
      const mime = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      try { res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'cache-control': 'max-age=31536000' }); res.end(fs.readFileSync(file)); }
      catch (e) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('vendor not found'); }
      return;
    }
    // Full visualization view (the iframe to the right of the terminal loads this; can also be opened standalone)
    if (u.pathname === '/viz') { serveHtml(res, HTML_PATH, 'cosmos.html'); return; }
    // /file?path=rel → return a single file's content (click a cell to drill in and see the code being run)
    if (u.pathname === '/file') {
      const rel = u.searchParams.get('path') || '';
      // Remote mode: serve the content fetched over ssh (the file doesn't exist locally)
      if (remote) {
        const txt = remoteSource?.getContent(rel);
        if (typeof txt === 'string') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(txt); }
        else { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not in latest remote scan'); }
        return;
      }
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('outside project scope');
        return;
      }
      try {
        const txt = fs.readFileSync(abs, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(txt);
      } catch (e) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('cannot read: ' + e.message);
      }
      return;
    }
    // /preview/<relative path> → serve the file directly with the correct MIME (for rendering a UI file's preview in the detail panel).
    // Uses a path-style URL (not a query) so relative assets in the HTML (./app.js, images, css) resolve correctly.
    if (u.pathname.startsWith('/preview/')) {
      const rel = decodeURIComponent(u.pathname.slice('/preview/'.length));
      const abs = path.resolve(root, rel);
      if (abs !== root && !abs.startsWith(root + path.sep)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('outside project scope');
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
        res.end('cannot read: ' + e.message);
      }
      return;
    }
    // Everything else returns the "terminal + visualization" split-screen main page
    serveHtml(res, TERM_PATH, 'terminal.html');
  });
  // If the web port is taken, shift to the next one so the visualization doesn't silently fail to open
  let actualWebPort = webPort;
  webServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && actualWebPort < webPort + 10) {
      actualWebPort++;
      setTimeout(() => webServer.listen(actualWebPort), 80);
    } else {
      log('web server failed to start:', e.message);
    }
  });
  webServer.on('listening', () => log(`world tree opened at http://localhost:${actualWebPort}`));
  webServer.listen(actualWebPort);

  const log = (...a) => !quiet && console.log('[core]', ...a);

  // ── Session transcript: each pty (one CLI launch) gets a logger that writes the whole run to a txt file. ──
  const sessionLogs = new Set();
  function logEvent(tag, text) { for (const l of sessionLogs) l.event(tag, text); }
  function logRecord(obj) { for (const l of sessionLogs) l.record(obj); } // clean structured event → .jsonl (change ledger / memory)
  // Also record the agent actions from the "web dispatch" flow (which bypasses the terminal pane) into the transcript, so it's a "complete record".
  function logBroadcast(msg) {
    if (!sessionLogs.size || !msg || !msg.payload) return;
    const p = msg.payload;
    switch (msg.type) {
      case 'prompt': logEvent('prompt', p.text); logRecord({ type: 'prompt', text: p.text }); break;
      case 'agent_text': for (const l of sessionLogs) l.stream('agent', p.delta); break;
      case 'agent_tool':
        logEvent('tool', `${p.name}${p.path ? ' → ' + p.path : ''}`);
        // edit/write are the real "changes"; read/list are just inspection — tag accordingly so the ledger can show only changes
        logRecord({ type: /edit|write/i.test(p.name) ? 'change' : 'tool', tool: p.name, path: p.path || null });
        break;
      case 'agent_error': logEvent('error', p.message); logRecord({ type: 'error', text: p.message }); break;
      case 'gate': logEvent('MASL', p.report && p.report.reason ? p.report.reason : 'gate'); logRecord({ type: 'gate', path: p.report?.targetRel || null, reason: p.report?.reason || null }); break;
      case 'anomaly': logEvent('anomaly', p.message); logRecord({ type: 'anomaly', text: p.message }); break;
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

  // ── Lie Monitor (照妖鏡): watch the gap between what the agent in the terminal CLAIMS and the real evidence.
  // The agent's output is fed as "assistant" turns (its promises), files appearing are fed as evidence. A file
  // it promised that never shows up (or is empty) → alert, with a ready-to-paste reply. Remote paths are judged
  // by whether the remote scanner saw the file (not local fs), to avoid false positives. ──
  const lie = lmState();
  lmResolver((p) => { if (remote) return { ok: false, reason: 'uncheckable' }; return null; });
  let lieAgentBuf = '', lieUserBuf = '';
  // Watch the active terminal's text and turn "code being written" into a live, still-unnamed cell that binds
  // to a filename the moment the agent saves it (see draft-stream.js). Pure broadcast; the page draws it.
  const draftStream = createDraftStream((e) => broadcast({ type: 'draft', payload: e }));
  function broadcastLie(alerts) { if (alerts && alerts.length) broadcast({ type: 'lie', payload: { alerts } }); }
  function lieFeed(role, content) { if (!content) return; try { broadcastLie(lmIngest(lie, { sessionId: 'main', role, content })); } catch {} }
  const lieTimer = setInterval(() => {
    if (lieUserBuf) { lieFeed('user', lieUserBuf.slice(-2000)); lieUserBuf = ''; }
    if (lieAgentBuf) { lieFeed('assistant', lieAgentBuf.slice(-8000)); lieAgentBuf = ''; }
    try { broadcastLie(lmEval(lie)); } catch {}
  }, 4000);
  if (lieTimer.unref) lieTimer.unref();

  // In remote mode the tree comes from the latest ssh snapshot; otherwise from the local graph.
  function currentSnapshot() { return remoteSnap || graph.snapshot(); }
  function pushState() {
    broadcast({ type: 'state', payload: currentSnapshot() });
  }

  // ── Agent runner: lets the browser (or CLI) dispatch a prompt over WS, with the agent running here in core ──
  // Token-saving engine: when CODETREE_ENGINE=routed, each task first goes to the local small model (the one baseURL points at),
  // and if it passes verify, we're done with 0 Anthropic tokens for the whole thing; only when the local run falls below the quality floor do we escalate to the Claude SDK.
  // With no env set (or the local one not running), it falls back to pure SDK, so existing users see zero impact.
  const ENGINE = process.env.CODETREE_ENGINE || 'sdk';
  const LOCAL_URL = process.env.CODETREE_LOCAL_URL || 'http://localhost:8000/v1';
  const LOCAL_MODEL = process.env.CODETREE_LOCAL_MODEL || 'qwen-coder';
  const defaultAgent = ({ onEvent, emit, getState, onGate, lastSaid }) => {
    if (ENGINE === 'local') {
      // Pure on-device: type a request in the app and the bundled Bragi model writes the code. No cloud, no login.
      log(`local engine: using ${LOCAL_MODEL} at ${LOCAL_URL} (fully offline, zero API)`);
      return createAgent({
        llm: createLocalLLM({ baseURL: LOCAL_URL, model: LOCAL_MODEL }),
        root, emit, onEvent, systemSuffix: LOCAL_DISCIPLINE,
        memory: createMemory({ root, model: LOCAL_MODEL }),
      });
    }
    if (ENGINE === 'routed') {
      log(`token-saving engine enabled: try local ${LOCAL_MODEL} first (${LOCAL_URL}), escalate to Claude only if it fails`);
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
  // On reroot we need to rebind to the new graph/root, so wrap it in a factory; only swap when idle, to avoid interrupting a running agent
  function makeRunner() { return createRunner({ root, graph, broadcast, makeAgent: makeAgentFn }); }
  let runner = makeRunner();

  function reparse(absPath) {
    if (!graph.isCode(absPath)) return;
    graph.setImports(absPath, parseImports(absPath, root));
  }

  // ── Scan watcher: its root can be swapped by reroot, so the world tree on the right follows the terminal's cwd ──
  let ready = false;
  let watcher = null;
  // When the bundled Bragi model is active, its intercepted answers are `from engine_lib import X as _eng`.
  // Make that import actually resolve by dropping the ~7 KB engine_lib.py into the project root — but only
  // when a Bragi runtime is present (BRAGI_ENGINE_LIB set) and the project doesn't already have one.
  // Never overwrites an existing file; silent no-op when Bragi isn't in use.
  function ensureEngineLib(dir) {
    try {
      const src = process.env.BRAGI_ENGINE_LIB;
      if (!src || !fs.existsSync(src) || !dir || !fs.existsSync(dir)) return;
      const dst = path.join(dir, 'engine_lib.py');
      if (fs.existsSync(dst)) return;
      fs.copyFileSync(src, dst);
      log('installed engine_lib.py into project (Bragi intercepts can run):', dst);
    } catch {}
  }

  function attachWatcher() {
    ready = false;
    // Safety net: never recursively watch the home directory, '/Users', or a volume root. chokidar would try
    // to traverse hundreds of thousands of files and saturate the event loop — the web server stops responding
    // and the app window never loads. Leave the tree empty but the app alive; cwd-follow repoints it the
    // moment the shell cd's into a real project.
    const HOME = os.homedir();
    if (root === HOME || root === path.dirname(HOME) || path.resolve(root) === path.parse(path.resolve(root)).root) {
      log('refusing to watch an over-broad root (', root, ') — cd into a project and the tree grows there');
      ready = true;
      watcher = null;
      pushState();
      return;
    }
    ensureEngineLib(root); // runs on first start and on every reroot (cd into a new project)
    watcher = chokidar.watch(root, {
      ignored: (p) => isIgnored(p), // chokidar v4: ignored takes a function, no longer a glob
      ignoreInitial: false,
      ignorePermissionErrors: true,
      persistent: true,
    });
    // CRITICAL: a single unwatchable entry (a unix socket, an Adobe IPC control file, a permission-denied path)
    // emits an 'error' on the FSWatcher. Without this handler Node throws it as uncaught and the whole core dies.
    watcher.on('error', (e) => log('watcher error (ignored):', (e && e.message) || e));
    watcher
    .on('add', (p) => {
      if (!graph.isCode(p)) return;
      graph.ensureCell(p);
      reparse(p);
      // Snapshot the original content at scan time so a ledger "revert" can restore the file to how it
      // was before this session. Only at startup (pre-ready), and skip big files to stay light.
      if (!ready && !baselines.has(p)) {
        try { const st = fs.statSync(p); if (st.size <= 512 * 1024) baselines.set(p, fs.readFileSync(p, 'utf8')); } catch {}
      }
      if (ready) {
        const cell = graph.record(p, 'create');
        emitActivity(cell, 'create');
        lieFeed('file', p); // real evidence: a file the agent promised actually appeared
        pushState();
      }
    })
    .on('change', (p) => {
      if (!graph.isCode(p)) return;
      reparse(p);
      const cell = graph.record(p, 'modify');
      emitActivity(cell, 'modify');
      lieFeed('file', p);
      // Anomaly: repeated modification
      if (cell.modification_count >= ANOMALY.REPEAT_MODIFY) {
        broadcast({
          type: 'anomaly',
          payload: {
            rule: 'repeat_modify',
            cell_id: cell.id,
            path: cell.path,
            count: cell.modification_count,
            message: `Modification #${cell.modification_count} of ${cell.path}; direction may not be converging`,
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
      log(`scan complete: ${graph.cells.size} file nodes, ${graph.edges.size} dependency edges`);
      pushState();
    });
  }
  // Switch the world-tree to a remote project over ssh (poll instead of watching the local FS).
  // Called automatically when the terminal ssh's into a host and cd's into a project (auto-follow),
  // or manually via a remote target. No-ops if already on this host:root.
  function enterRemote(host, root) {
    root = String(root || '').replace(/\/$/, '');
    if (!host || !root || root === '~' || root === '/') return;
    if (remote && remote.host === host && remote.root === root) return;
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (remoteSource) { remoteSource.stop(); remoteSource = null; }
    remote = { host, root };
    remoteSnap = null;
    log(`auto-follow → remote ${host}:${root}`);
    remoteSource = createRemoteSource({
      host, root,
      onSnapshot: (snap) => {
        remoteSnap = snap;
        broadcast({ type: 'state', payload: snap });
        if (snap.changed && snap.changed.length) {
          // Light up each changed/new file (card glows + code streams in) and fly the camera to the newest —
          // so when the agent writes or creates a file on the remote, the world-tree jumps to that cell.
          for (const p of snap.changed) { broadcast({ type: 'activity', payload: { path: p, action: 'modify', ts: Date.now() } }); lieFeed('file', root.replace(/\/$/, '') + '/' + p); }
          broadcast({ type: 'active', payload: { path: snap.changed[0], id: snap.changed[0] } });
        }
      },
      onStatus: (s) => {
        if (s.ok) log(`remote scan: ${s.files} files on ${s.host}:${s.root}`);
        else broadcast({ type: 'agent_error', payload: { message: `Remote (${s.host}): ${s.error}` } });
      },
    });
    remoteSource.start();
    broadcast({ type: 'project', payload: { root: `${host}:${root}`, label: `${host}:${root.split('/').pop()}`, remote: true } });
  }
  // Back to the local project when the ssh session ends.
  function exitRemote() {
    if (!remote) return;
    log('auto-follow ← back to local');
    if (remoteSource) { remoteSource.stop(); remoteSource = null; }
    remote = null; remoteSnap = null;
    attachWatcher();
    broadcast({ type: 'project', payload: { root, label: projLabel } });
  }

  if (remote) {
    const r = remote; remote = null; enterRemote(r.host, r.root); // start in remote mode if launched that way
  } else {
    attachWatcher();
  }

  // Switch the watch root: the terminal cd's into another project → the right side regrows that project. WS / web server stay put,
  // the same connection just swaps the underlying graph, does one pushState after rescanning, and the view smoothly switches to the new project.
  function reroot(newDir) {
    if (remote) return; // in remote mode the tree is pinned to the remote project, local cd doesn't reroot
    const resolved = path.resolve(newDir);
    if (resolved === root) return;
    log('reroot ->', resolved);
    root = resolved;
    if (watcher) { try { watcher.close(); } catch {} }
    graph = new Graph(root);
    if (!runner.busy) runner = makeRunner(); // only swap the runner when idle, to avoid interrupting a running agent
    attachWatcher();
    broadcast({ type: 'project', payload: { root, label: path.basename(root) } });
  }

  // ── Follow the terminal's cwd: when the shell cd's into a project, the right side auto-switches root. Non-invasive (doesn't modify the user's shell) ──
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
  // A directory is worth growing a tree for if it has a project marker OR simply contains code (directly or in src/).
  // The old version only accepted .git/package.json, so cd'ing into a plain Python folder, a sample, or a subdir
  // never switched the tree — the right side stayed blank. This is why "I cd into my project and nothing appears".
  const CODE_RE = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rb|rs|java|php|c|h|cpp|hpp|swift|kt|scala|sh)$/;
  function hasCodeFile(dir) {
    try { return fs.readdirSync(dir).some((f) => CODE_RE.test(f)); } catch { return false; }
  }
  function looksLikeProject(dir) {
    try {
      const markers = ['.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'requirements.txt', 'tsconfig.json', 'pom.xml', 'Gemfile', 'composer.json', 'setup.py'];
      for (const m of markers) if (fs.existsSync(path.join(dir, m))) return true;
      return hasCodeFile(dir) || hasCodeFile(path.join(dir, 'src'));
    } catch { return false; }
  }
  function startCwdFollow(pid) {
    if (cwdTimer) return;
    followPid = pid;
    cwdTimer = setInterval(async () => {
      if (!followPid) return;
      const cwd = await shellCwdOf(followPid);
      if (!cwd || cwd === lastCwd) return;
      lastCwd = cwd;
      // Don't reroot to the home directory itself — it's not a project and scanning all of $HOME is slow/noisy.
      const resolved = path.resolve(cwd);
      if (resolved !== os.homedir() && looksLikeProject(cwd) && resolved !== root) reroot(cwd);
    }, 1500);
  }
  function stopCwdFollow() { if (cwdTimer) clearInterval(cwdTimer); cwdTimer = null; followPid = null; }

  // ── Token bar: reads the real usage of the Claude Code session for "you running claude in this cwd",
  // pushing it every 2 seconds to the bar above the input box. The baseline is the zero point of the "clear" button (subtract it to get this run's total);
  // switching session files (starting a new conversation) auto-resets the baseline so the numbers count up from 0 again. ──
  let tokTimer = null;
  let tokBaseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let tokSessionFile = null;
  // When Code Tree's own agent runs (direct API, not the claude CLI) it pushes real usage over WS.
  // That doesn't land in the Claude Code session JSONL, so prefer the pushed totals when present.
  let cliTok = null; // { input, output, cacheRead, cacheWrite } accumulated from cli_usage
  let lastActivePath = null;           // which file the agent is on right now (for token attribution)
  const tokenByFile = new Map();       // path → burned tokens spent while that file was active (a heuristic, labelled "~")
  function tokensSnapshot() {
    if (cliTok) {
      const { input, output, cacheRead, cacheWrite } = cliTok;
      return { input, output, cacheRead, cacheWrite, saved: cacheRead, burned: input + output + cacheWrite };
    }
    const u = readUsage(lastCwd); // { input, output, cacheRead, cacheWrite, file }
    if (u.file !== tokSessionFile) { // session file changed → new conversation, reset the baseline
      tokSessionFile = u.file;
      tokBaseline = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    }
    const d = (k) => Math.max(0, (u[k] || 0) - (tokBaseline[k] || 0));
    const input = d('input'), output = d('output');
    const cacheRead = d('cacheRead'), cacheWrite = d('cacheWrite');
    return {
      input, output, cacheRead, cacheWrite,
      saved: cacheRead,                       // cache hit = tokens not resent = saved
      burned: input + output + cacheWrite,    // actually burned
    };
  }
  function broadcastTokens() { broadcast({ type: 'tokens', payload: tokensSnapshot() }); }
  function startTokens() {
    if (tokTimer) return;
    broadcastTokens();
    tokTimer = setInterval(broadcastTokens, 2000);
  }
  function clearTokens() { // "clear": set the current raw total as the new baseline, so the display reads zero
    const u = readUsage(lastCwd);
    tokSessionFile = u.file;
    tokBaseline = { input: u.input || 0, output: u.output || 0, cacheRead: u.cacheRead || 0, cacheWrite: u.cacheWrite || 0 };
    broadcastTokens();
  }
  function stopTokens() { if (tokTimer) clearInterval(tokTimer); tokTimer = null; }
  startTokens();

  // ── "Cost of not clearing": scan all sessions on the machine to compute cache waste, broadcast to the block next to the token bar.
  // Slower than the token bar (reads many files), so once every 10 seconds is fine; don't stack a new round on top of an unfinished one. ──
  let saveTimer = null, savingBusy = false;
  async function broadcastSavings() {
    if (savingBusy) return;
    savingBusy = true;
    try {
      const s = await computeSavings();
      if (s && s.ok) broadcast({ type: 'savings', payload: {
        clearNowUsd: s.clear_now_savings_usd || 0, // clear now, save this much next hour = the cost of not clearing
        wastedUsd: s.wasted_usd || 0,              // written into cache but never read back = already wasted
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
  // Disabled: the "cost of not clearing cache" figure was a speculative estimate, not a measured number.
  // We only surface real, measured token counts now (input / cache hits / output / burned). No fudge metric.
  void startSavings; void stopSavings;

  function emitActivity(cell, action) {
    broadcast({
      type: 'activity',
      payload: { path: cell.path, action, count: cell.modification_count, ts: Date.now() },
    });
  }

  // Known ssh aliases from ~/.ssh/config — used to validate `alias:/path` mentions before auto-following.
  const SSH_ALIASES = new Set();
  try {
    const cfg = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    for (const m of cfg.matchAll(/^\s*Host\s+(.+)$/gim)) for (const h of m[1].trim().split(/\s+/)) if (h && !h.includes('*')) SSH_ALIASES.add(h);
  } catch {}

  // ── WebSocket: CLI, visualization, and terminal all connect here ──
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', payload: currentSnapshot() }));
    // Also tell a freshly-connected client WHICH project we're on, so its header/label isn't stuck on
    // "no project" when we're already following a remote (the tree arrives via the state above).
    if (remote) ws.send(JSON.stringify({ type: 'project', payload: { root: `${remote.host}:${remote.root}`, label: `${remote.host}:${remote.root.split('/').pop()}`, remote: true } }));
    else ws.send(JSON.stringify({ type: 'project', payload: { root, label: projLabel } }));
    ws.send(JSON.stringify({ type: 'tokens', payload: tokensSnapshot() }));
    // One connection can hold several independent shells (tabs). Each is keyed by a sessionId from the page.
    const ptys = new Map(); // sessionId → { pty, slog, sshTarget, outbuf }
    let activePtyId = null;  // which tab is in front → only its stream drives the auto-follow

    async function startPty(sessionId, cols, rows) {
      sessionId = sessionId || 'default';
      if (ptys.has(sessionId)) return;
      const mod = await getPty();
      if (!mod) { // node-pty not installed: report honestly, don't pretend there's a terminal
        ws.send(JSON.stringify({ type: 'pty_missing' }));
        return;
      }
      const shell = process.env.SHELL || '/bin/zsh';
      // A GUI app launched by double-clicking in Finder only gets launchd's stripped-down PATH (no /opt/homebrew/bin
      // and the like), so claude and brew-installed tools give "command not found" and seem unresponsive. Open with a login shell (-l)
      // so it sources the user's .zprofile / .zshrc and restores the full PATH. VS Code and Hyper do the same.
      const loginArgs = /\/(zsh|bash|sh|fish)$/.test(shell) ? ['-l'] : [];
      const pty = mod.spawn(shell, loginArgs, {
        name: 'xterm-color',
        cols: cols || 80, rows: rows || 24,
        cwd: shellCwd, env: process.env,
      });
      // Each tab records its own transcript.
      const slog = createSessionLogger({ root, label: projLabel });
      const entry = { pty, slog, sshTarget: null, outbuf: '', inbuf: '' };
      ptys.set(sessionId, entry);
      activePtyId = sessionId;
      if (slog.ok) {
        sessionLogs.add(slog);
        ws.send(JSON.stringify({ type: 'session_log', sessionId, payload: { file: slog.file } }));
      }
      pty.onData((d) => {
        if (slog) slog.stream('term', d);
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pty_output', sessionId, data: d }));
        if (sessionId === activePtyId) detectRemoteFromOutput(entry, d); // auto-follow ssh sessions
      });
      pty.onExit(() => {
        ws.send(JSON.stringify({ type: 'pty_exit', sessionId }));
        if (slog) { sessionLogs.delete(slog); slog.close('shell exited'); }
        ptys.delete(sessionId);
      });
      startCwdFollow(pty.pid); // the newly-opened (active) tab drives the world-tree's cwd-follow
    }

    // ── Auto-follow ssh: watch the active terminal's stream. When the user ssh's into a host and the
    // remote prompt shows a project path, switch the world-tree to that remote project — no button. ──
    const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]/g;
    // default bash prompt: user@host:cwd$  (cwd is /abs or ~). Capture the last one in the buffer.
    const PROMPT_RE = /([\w.-]+)@([\w.-]+):((?:\/|~)[^\s#$\x1b]*)\s*[#$]\s*$/;
    // Accumulate typed input; when a line is entered, learn the ssh target (the reconnectable alias).
    function detectSshFromInput(entry, data) {
      entry.inbuf += data;
      let nl;
      while ((nl = entry.inbuf.search(/[\r\n]/)) >= 0) {
        const line = entry.inbuf.slice(0, nl);
        entry.inbuf = entry.inbuf.slice(nl + 1);
        if (line.trim()) { lieUserBuf += line + '\n'; if (lieUserBuf.length > 3000) lieUserBuf = lieUserBuf.slice(-3000); } // what you asked = the instruction
        const m = line.match(/^\s*ssh\s+(?:-\S+\s+|-\S+\s*)*([\w.@-]+(?::\d+)?)\s*$/) || line.match(/^\s*ssh\s+(?:\S+\s+)*?([\w.@-]+)\s*$/);
        if (m && m[1] && !/^-/.test(m[1])) entry.sshTarget = m[1];
        // user explicitly leaves the ssh session → tree goes back to the local project (robust; ignores flaky disconnects)
        if (entry.sshTarget && /^\s*(exit|logout)\s*$/.test(line)) { entry.sshTarget = null; entry.outbuf = ''; exitRemote(); }
      }
      // Ctrl-D also ends the shell
      if (entry.sshTarget && data.includes('\x04')) { entry.sshTarget = null; entry.outbuf = ''; exitRemote(); }
      if (entry.inbuf.length > 400) entry.inbuf = entry.inbuf.slice(-400);
    }
    // Figure out WHICH project the terminal is working in from whatever it prints — covers an in-terminal agent
    // (claude/codex) doing its own ssh/edits, plain shells, scp/rsync, host:/path mentions, cd, git -C, etc.
    // All the messy format-matching lives in agent-trace.js (unit-tested against dozens of real shapes).
    function detectRemoteFromOutput(entry, data) {
      const clean = data.replace(ANSI, '');
      entry.outbuf = (entry.outbuf + data).replace(ANSI, '').slice(-4000);
      // An in-terminal agent (claude) tried an INTERACTIVE ssh but its sandboxed Bash has no TTY, so ssh prints
      // "Pseudo-terminal will not be allocated…" and gives up. Code Tree's own terminal IS a real TTY — open a
      // working interactive ssh to that host in a fresh tab for the user, automatically. (debounced per host)
      if (/Pseudo-terminal will not be allocated/.test(entry.outbuf)) {
        const sm = entry.outbuf.match(/\bssh\s+(?:-\S+\s+)*([a-zA-Z_][\w.@-]+)/);
        const h = sm && sm[1];
        if (h && (h.includes('@') || SSH_ALIASES.has(h)) && entry._sshOffered !== h) {
          entry._sshOffered = h; entry.outbuf = '';
          broadcast({ type: 'open_ssh', payload: { host: h } });
        }
      }
      lieAgentBuf += clean; if (lieAgentBuf.length > 12000) lieAgentBuf = lieAgentBuf.slice(-12000); // feed the agent's output to the lie monitor
      draftStream.feed(clean); // and to the live draft-cell watcher: code on screen → unnamed cell → named on save
      // (a) precise: you ssh'd in OUR shell → follow the remote prompt's cwd
      if (entry.sshTarget) {
        const last = entry.outbuf.split('\n').pop();
        const p = PROMPT_RE.exec(last || '');
        if (p && p[3].startsWith('/')) { enterRemote(entry.sshTarget, p[3]); return; }
      }
      // (b) inferred: read every signal in the recent output and follow the project it points at
      const tr = traceProject(entry.outbuf, { sshAliases: SSH_ALIASES });
      if (tr.host && tr.root) { enterRemote(tr.host, tr.root); return; }
      // (c) local project the agent is editing (e.g. claude Edit(/abs/path)) that our shell never cd'd into.
      // Guard hard: never reroot to a system dir (/tmp, /var, …) and only follow somewhere that looks like a
      // real project — otherwise we'd point the watcher at junk (and choke on sockets/IPC files there).
      if (!remote && !tr.host && tr.root) {
        const SYS = new Set(['/', '/tmp', '/var', '/private', '/private/tmp', '/usr', '/etc', '/bin', '/sbin', '/dev', '/opt', '/Users', '/Applications', '/Library', '/System', os.homedir(), os.tmpdir()]);
        const r = path.resolve(tr.root);
        if (!SYS.has(r) && r !== root) {
          try { if (fs.existsSync(r) && fs.statSync(r).isDirectory() && looksLikeProject(r)) reroot(r); } catch {}
        }
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Terminal pane messages take a dedicated path (the real shell's stdin / resize), everything else goes to the shared handler
      if (msg.type === 'pty_start') { startPty(msg.sessionId, msg.cols, msg.rows); return; }
      if (msg.type === 'pty_input') {
        const e = ptys.get(msg.sessionId || 'default');
        if (e) { e.pty.write(msg.data); detectSshFromInput(e, msg.data); }
        return;
      }
      if (msg.type === 'pty_resize') { try { ptys.get(msg.sessionId || 'default')?.pty.resize(msg.cols, msg.rows); } catch {} return; }
      // Switching tabs: the world-tree follows whichever shell is now in front (local cwd or its ssh session).
      if (msg.type === 'tab_active') {
        const e = ptys.get(msg.sessionId || 'default');
        if (e) { activePtyId = msg.sessionId || 'default'; if (e.sshTarget) { /* its ssh prompt will re-trigger */ } else { exitRemote(); startCwdFollow(e.pty.pid); } }
        return;
      }
      if (msg.type === 'pty_close') { const e = ptys.get(msg.sessionId); if (e) { try { e.pty.kill(); } catch {} } return; }
      handleInbound(msg);
    });
    ws.on('close', () => {
      clients.delete(ws);
      for (const { pty, slog } of ptys.values()) {
        try { pty.kill(); } catch {}
        if (slog) { sessionLogs.delete(slog); slog.close('disconnected'); }
      }
      ptys.clear();
    });
  });

  // The CLI side reports agent actions (read / prompt) back in, as a secondary signal
  function handleInbound(msg) {
    if (msg.type === 'agent_read' && msg.path) {
      const abs = path.resolve(root, msg.path);
      const cell = graph.record(abs, 'read', msg.prompt_id);
      emitActivity(cell, 'read');
      pushState();
    } else if (msg.type === 'agent_active' && msg.path) {
      // The CLI reports which cell the agent is on → broadcast it so the 3D camera flies there
      const abs = path.resolve(root, msg.path);
      const cell = graph.record(abs, 'active');
      lastActivePath = cell.path; // remember for token attribution
      broadcast({ type: 'active', payload: { path: cell.path, id: abs } });
      pushState();
    } else if (msg.type === 'run' && msg.text) {
      // Browser as the main UI: prompt from the window → core runs the agent, events stream back to the page
      runner.run(msg.text, msg.id);
    } else if (msg.type === 'gate_reply') {
      // The page replies to the MASL gate: allow / block
      runner.replyGate(msg.id, msg.approve);
    } else if (msg.type === 'cli_usage' && msg.usage) {
      // Code Tree's own agent reports a turn's real token usage → accumulate and push to the token bar
      const u = msg.usage;
      if (!cliTok) cliTok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      cliTok.input += u.input_tokens || 0;
      cliTok.output += u.output_tokens || 0;
      cliTok.cacheRead += u.cache_read_input_tokens || 0;
      cliTok.cacheWrite += u.cache_creation_input_tokens || 0;
      broadcastTokens();
      // attribute this turn's burn to the file the agent is currently on → "where the tokens went"
      const burn = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (lastActivePath && burn > 0) {
        const t = (tokenByFile.get(lastActivePath) || 0) + burn;
        tokenByFile.set(lastActivePath, t);
        broadcast({ type: 'token_by_file', payload: { path: lastActivePath, total: t } });
        for (const l of sessionLogs) l.record({ type: 'usage', path: lastActivePath, burn });
      }
    } else if (msg.type === 'recall') {
      // the CLI agent recalled past trajectories → surface it in the browser too
      broadcast({ type: 'recall', payload: { count: msg.count || 1, text: msg.text || '' } });
    } else if (msg.type === 'revert' && msg.path) {
      // Restore a file to how it was at session start. The watcher (local) or the next scan (remote)
      // catches the write, so the tree + ledger update on their own.
      if (remote) {
        remoteSource?.revert(msg.path).then((r) => {
          if (r.ok) { logEvent('revert', msg.path); logRecord({ type: 'revert', path: msg.path }); }
          else broadcast({ type: 'agent_error', payload: { message: `Revert failed (${msg.path}): ${r.err}` } });
        });
        return;
      }
      const abs = path.resolve(root, msg.path);
      if (abs !== root && !abs.startsWith(root + path.sep)) return;
      if (baselines.has(abs)) {
        try { fs.writeFileSync(abs, baselines.get(abs)); logEvent('revert', msg.path); logRecord({ type: 'revert', path: msg.path }); }
        catch (e) { broadcast({ type: 'agent_error', payload: { message: 'Revert failed: ' + e.message } }); }
      } else {
        broadcast({ type: 'agent_error', payload: { message: `No session-start snapshot for ${msg.path} (created this session?)` } });
      }
    } else if (msg.type === 'tokens_clear') {
      // The "clear" button on the bar above the input box: set the current total as the new baseline, zeroing the numbers
      cliTok = null;
      clearTokens();
    } else if (msg.type === 'prompt') {
      graph.activePromptId = msg.id || null; // edits the watcher catches afterward are attributed to this prompt
      broadcast({ type: 'prompt', payload: { id: msg.id, text: msg.text, ts: Date.now() } });
    } else if (msg.type === 'error_seen' && msg.message) {
      const n = (graph.errorSeen.get(msg.message) || 0) + 1;
      graph.errorSeen.set(msg.message, n);
      if (n >= 2) {
        broadcast({
          type: 'anomaly',
          payload: { rule: 'error_recurring', message: `Error still unresolved (occurrence #${n}): ${msg.message}` },
        });
      }
    }
  }

  // ── Stall detection: periodic scan ──
  const stallTimer = setInterval(() => {
    const stalled = graph.checkStall();
    for (const cell of stalled) {
      broadcast({
        type: 'anomaly',
        payload: { rule: 'stall', cell_id: cell.id, path: cell.path, message: `${cell.path} has stalled for over 10 minutes; it may be stuck` },
      });
    }
    if (stalled.length) pushState();
  }, 30 * 1000);

  log(`WebSocket on ws://localhost:${port}, watching ${root}`);

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
      if (remoteSource) remoteSource.stop();
      wss.close();
      webServer.close();
    },
  };
}

// Allow launching directly via `node src/core/server.js [targetDir]`
// Compare using pathToFileURL so paths with spaces (like "Cosmos Tree") aren't misjudged.
import { pathToFileURL } from 'node:url';
// process.argv[1] may be undefined inside packaged Electron, so guard it to avoid blowing up at import time.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = process.argv[2] || process.cwd();
  startCore({ root: target });
}
