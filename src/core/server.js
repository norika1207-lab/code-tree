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
import { WS_PORT, WEB_PORT, isIgnored, ANOMALY, CODE_EXT } from '../config.js';
import { Graph } from './state.js';
import { parseImports } from './parser.js';
import { createRemoteSource, findRemoteProject } from './remote-source.js';
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
import { injectSshControlIntoCommand, sshControlArgs, sshControlEnv } from './ssh-control.js';
import {
  cellsFromText,
  expandHome,
  projectPathFromText,
  remoteSpecFromText,
  looksLikeProject as looksLikeTextProject,
  scanLocalProject,
} from './text-tree.js';

// Work discipline for the local small model (used by routed's first tier). Makes the small model actually call tools instead of just describing a plan.
const LOCAL_DISCIPLINE = `(Important work discipline)
- Until the task is done, emit ONLY one tool call per turn. Do not describe in prose what you "intend" to call. Want to read a file? Send read_file directly. Want to change a file? Send edit_file directly.
- Do not paste tool calls as markdown or JSON examples in your reply. If you mean to call a tool, actually call it.
- Once you have enough information, make the change (edit_file / write_file). Do not stop at describing a plan.
- For small files (roughly under 40 lines), just rewrite the whole file with write_file. This is the most reliable approach. edit_file's old_str must match the text in the file exactly (including whitespace and punctuation); if it doesn't match it will fail.
- If a tool tells you it "could not find the text to replace", that edit did not take effect. Switch to write_file and rewrite the whole file. Do not paste the same old_str again.
- Only when the entire task is truly done should you give a final plain-text wrap-up; do not emit any tool call on that turn.`;

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseRequestText(raw) {
  const body = String(raw || '');
  try {
    const j = JSON.parse(body || '{}');
    return { json: j, text: j.text || j.prompt || j.root || body };
  } catch {
    return { json: null, text: body };
  }
}

function projectNameFromText(text) {
  const m = String(text || '').match(/(?:open|開啟|打開|進入|切到|改|查|找|掃描|scan|project|專案)\s*([A-Za-z0-9_.-]{3,100})/i);
  if (!m) return null;
  const name = m[1].replace(/[，。；;:：]+$/g, '');
  if (/^(project|repo|code|tree|scan|open|local|remote)$/i.test(name)) return null;
  return name;
}

function findLocalProjectByName(name) {
  const wanted = String(name || '').toLowerCase();
  if (!wanted) return null;
  const roots = [
    path.join(os.homedir(), 'Dropbox'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Projects'),
    path.join(os.homedir(), 'workspace'),
  ];
  const privacyDirs = new Set([
    'Library',
    'Mobile Documents',
    'Pictures',
    'Photos Library.photoslibrary',
    'Music',
    'Movies',
    'Photo Booth Library',
    '.Trash',
  ]);
  const seen = new Set();
  const queue = [];
  for (const r of roots) {
    const abs = path.resolve(r);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory() && !seen.has(abs)) {
        seen.add(abs);
        queue.push({ dir: abs, depth: 0 });
      }
    } catch {}
  }
  let checked = 0;
  while (queue.length && checked < 12000) {
    const { dir, depth } = queue.shift();
    checked++;
    const base = path.basename(dir).toLowerCase();
    if ((base === wanted || base.includes(wanted)) && looksLikeTextProject(dir)) return dir;
    if (depth >= 5) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === 'node_modules' || ent.name === '.git' || privacyDirs.has(ent.name)) continue;
      if (ent.name.startsWith('.') && ent.name !== '.config') continue;
      const abs = path.join(dir, ent.name);
      if (!seen.has(abs)) {
        seen.add(abs);
        queue.push({ dir: abs, depth: depth + 1 });
      }
    }
  }
  return null;
}

// makeAgent is injectable: defaults to the SDK agent (borrowing Claude Code's login); tests swap in scripted (burns no token).
export function startCore({ root = process.cwd(), port = WS_PORT, webPort = WEB_PORT, quiet = false, makeAgent, terminalCwd, projectLabel, noProject = false, remote = null } = {}) {
  root = path.resolve(root);
  // Remote mode: the project lives on another machine, mapped over ssh (see remote-source.js).
  // The local graph/chokidar are bypassed; the tree comes from periodic remote snapshots.
  let remoteSnap = null;
  let remoteSource = null;
  let remoteFocusRel = null;
  let remoteSingleContent = new Map();
  let staticSnap = null;
  let textSnap = null;
  let textSeq = 0;
  let activeSshTarget = null;
  const baselines = new Map(); // absPath → original content at session start, for ledger "revert" (local mode)
  // Which folder the terminal opens in: defaults to the same place as the watch root; in no-project mode it can point at the home directory,
  // so the shell is immediately usable while the visualization doesn't have to scan all of home.
  const shellCwd = path.resolve(terminalCwd || root);
  const initialNoProjectRoot = noProject ? root : null;
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
  let currentProjectLabel = projLabel;
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
  const webServer = http.createServer(async (req, res) => {
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
    if (req.method === 'POST' && (u.pathname === '/api/text' || u.pathname === '/api/open')) {
      try {
        const { json, text } = parseRequestText(await readBody(req));
        const result = u.pathname === '/api/open'
          ? await openProjectRequest(json?.root || text, { requestId: json?.requestId || null })
          : await routeTextRequest(text, { requestId: json?.requestId || null });
        writeJson(res, result.ok ? 200 : 422, result);
      } catch (e) {
        writeJson(res, 500, { ok: false, message: e.message || String(e) });
      }
      return;
    }
    // Full visualization view (the iframe to the right of the terminal loads this; can also be opened standalone)
    if (u.pathname === '/viz') { serveHtml(res, HTML_PATH, 'cosmos.html'); return; }
    // /file?path=rel → return a single file's content (click a cell to drill in and see the code being run)
    if (u.pathname === '/file') {
      const rel = u.searchParams.get('path') || '';
      // Remote mode: serve the content fetched over ssh (the file doesn't exist locally)
      if (remote) {
        const txt = remoteSource?.getContent(rel) ?? remoteSingleContent.get(rel);
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
  function currentSnapshot() { return textSnap || remoteSnap || staticSnap || graph.snapshot(); }
  function pushState() {
    broadcast({ type: 'state', payload: currentSnapshot() });
  }

  function clearTextSnapshot() {
    textSnap = null;
  }

  function showTextCells(text) {
    const cells = cellsFromText(text, { startSeq: textSeq });
    if (!cells.length) return { ok: false, message: 'no code block found' };
    textSeq += cells.length;
    clearTextSnapshot();
    staticSnap = null;
    textSnap = {
      root: 'gpt-text',
      label: 'GPT text',
      cells,
      edges: [],
      recent: cells.map((c) => ({ timestamp: Date.now(), path: c.path, action: 'active' })),
    };
    broadcast({ type: 'project', payload: { root: 'gpt-text', label: 'GPT text' } });
    pushState();
    for (const c of cells) broadcast({ type: 'active', payload: { path: c.path, id: c.id } });
    return { ok: true, kind: 'text', boxes: cells.length };
  }

  function isBlockedRoot(candidate) {
    const resolved = path.resolve(expandHome(candidate || ''));
    const HOME = os.homedir();
    return resolved === HOME
      || resolved === path.dirname(HOME)
      || resolved === path.parse(resolved).root
      || resolved === '/Users'
      || resolved === '/Applications'
      || resolved === '/Library'
      || resolved === '/System';
  }

  function cleanRemoteRoot(remoteRoot) {
    const r = String(remoteRoot || '').trim().replace(/^["'`]|["'`]$/g, '').replace(/\/+$/g, '');
    return r || '/';
  }

  function isBroadRemoteRoot(remoteRoot) {
    const r = cleanRemoteRoot(remoteRoot);
    return r === '~'
      || r === '/'
      || r === '/root'
      || r === '/home'
      || r === '/opt'
      || r === '/var'
      || r === '/var/www'
      || r === '/srv'
      || r === '/tmp'
      || r === '/usr'
      || r === '/etc';
  }

  function projectRootForLocalPath(absPath) {
    const markers = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'requirements.txt', 'tsconfig.json', 'README.md', 'src'];
    let dir = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
    while (dir && !isBlockedRoot(dir)) {
      for (const m of markers) {
        try { if (fs.existsSync(path.join(dir, m))) return dir; } catch {}
      }
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      dir = parent;
    }
    return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory() ? absPath : path.dirname(absPath);
  }

  function focusLocalPath(absPath) {
    const rel = path.relative(root, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    try {
      if (fs.existsSync(absPath) && fs.statSync(absPath).isFile() && graph.isCode(absPath)) {
        graph.record(absPath, 'active');
        reparse(absPath);
        pushState();
        broadcast({ type: 'active', payload: { path: rel, id: absPath } });
      }
    } catch {}
  }

  function resolveRemoteTarget(host, target) {
    const script = `
import json, os, sys
p=os.path.abspath(os.path.expanduser(sys.argv[1]))
markers=['.git','package.json','pyproject.toml','Cargo.toml','go.mod','composer.json','requirements.txt','tsconfig.json','README.md','src']
broad=set(['/','/root','/home','/opt','/var','/var/www','/srv','/tmp','/usr','/etc'])
if os.path.isdir(p):
    print(json.dumps({'ok': True, 'kind': 'dir', 'root': p, 'focus': None, 'broad': p.rstrip('/') in broad}))
    sys.exit(0)
if not os.path.isfile(p):
    print(json.dumps({'ok': False, 'message': 'not found: '+p}))
    sys.exit(0)
start=os.path.dirname(p)
cur=start
found=None
while True:
    if any(os.path.exists(os.path.join(cur,m)) for m in markers):
        found=cur
        break
    if cur.rstrip('/') in broad:
        break
    parent=os.path.dirname(cur)
    if not parent or parent==cur:
        break
    cur=parent
root=found or start
print(json.dumps({'ok': True, 'kind': 'file', 'root': root, 'focus': os.path.relpath(p, root), 'file': p, 'broad': root.rstrip('/') in broad}))
`;
    return new Promise((resolve) => {
      execFile('ssh', [...sshControlArgs({ batch: true }), host, 'python3', '-c', script, target], {
        env: { ...process.env, ...sshControlEnv() },
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, message: (stderr || err.message || 'remote path check failed').trim() });
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch (e) { resolve({ ok: false, message: 'remote path check returned invalid JSON: ' + e.message }); }
      });
    });
  }

  function remoteFileSnapshot(host, fileAbs) {
    const script = `
import json, os, sys
p=os.path.abspath(os.path.expanduser(sys.argv[1]))
if not os.path.isfile(p):
    print(json.dumps({'ok': False, 'message': 'not a file: '+p}))
    sys.exit(0)
try:
    with open(p,'r',encoding='utf-8',errors='replace') as f:
        text=f.read(4096)
except Exception as e:
    text=''
st=os.stat(p)
print(json.dumps({'ok': True, 'file': p, 'root': os.path.dirname(p), 'name': os.path.basename(p), 'text': text, 'mtime': st.st_mtime}, ensure_ascii=False))
`;
    return new Promise((resolve) => {
      execFile('ssh', [...sshControlArgs({ batch: true }), host, 'python3', '-c', script, fileAbs], {
        env: { ...process.env, ...sshControlEnv() },
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, message: (stderr || err.message || 'remote file read failed').trim() });
          return;
        }
        try { resolve(JSON.parse(stdout)); }
        catch (e) { resolve({ ok: false, message: 'remote file read returned invalid JSON: ' + e.message }); }
      });
    });
  }

  async function showRemoteFileOnly(host, fileAbs, { requestId = null } = {}) {
    const r = await remoteFileSnapshot(host, fileAbs);
    if (!r.ok) return { ok: false, requestId, message: r.message || 'cannot read remote file' };
    clearTextSnapshot();
    staticSnap = null;
    remoteFocusRel = r.name;
    remoteSingleContent = new Map([[r.name, r.text || '']]);
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (remoteSource) { remoteSource.stop(); remoteSource = null; }
    remote = { host, root: r.root };
    currentProjectLabel = `${host}:${r.name}`;
    const ext = path.extname(r.name).replace(/^\./, '') || 'txt';
    remoteSnap = {
      root: `${host}:${r.root}`,
      label: currentProjectLabel,
      remote: true,
      scanMode: 'remote-file',
      cells: [{
        id: r.name,
        path: r.name,
        language: ext,
        size_lines: r.text ? String(r.text).split('\n').length : 0,
        preview: String(r.text || '').replace(/\t/g, '  ').split('\n').slice(0, 10).join('\n'),
        category: 'file',
        status: 'active',
        modification_count: 0,
        anomaly: null,
        lastModified: r.mtime * 1000,
      }],
      edges: [],
      recent: [{ timestamp: Date.now(), path: r.name, action: 'active' }],
    };
    broadcast({ type: 'project', payload: { root: `${host}:${r.root}`, label: currentProjectLabel, remote: true, fileOnly: true } });
    pushState();
    broadcast({ type: 'active', payload: { path: r.name, id: r.name } });
    return { ok: true, requestId, kind: 'remote-file', root: `${host}:${r.root}`, focus: r.name };
  }

  async function openProjectRequest(target, { requestId = null } = {}) {
    const raw = String(target || '').trim();
    if (!raw) return { ok: false, requestId, message: 'missing project path' };
    const remoteSpec = remoteSpecFromText(raw);
    if (remoteSpec) {
      const resolvedRemote = await resolveRemoteTarget(remoteSpec.host, remoteSpec.root);
      if (resolvedRemote.ok) {
        if (resolvedRemote.broad && !resolvedRemote.focus) {
          return { ok: false, requestId, message: `refusing to scan broad remote root: ${remoteSpec.host}:${resolvedRemote.root}` };
        }
        if (resolvedRemote.broad && resolvedRemote.file) {
          return showRemoteFileOnly(remoteSpec.host, resolvedRemote.file, { requestId });
        }
        clearTextSnapshot();
        enterRemote(remoteSpec.host, resolvedRemote.root, { focus: resolvedRemote.focus || null, explicit: true });
        return {
          ok: true,
          requestId,
          kind: 'remote',
          root: `${remoteSpec.host}:${resolvedRemote.root}`,
          focus: resolvedRemote.focus || null,
        };
      }
      clearTextSnapshot();
      if (isBroadRemoteRoot(remoteSpec.root)) {
        return { ok: false, requestId, message: `refusing to scan broad remote root: ${remoteSpec.host}:${remoteSpec.root}` };
      }
      enterRemote(remoteSpec.host, remoteSpec.root, { explicit: true });
      return { ok: true, requestId, kind: 'remote', root: `${remoteSpec.host}:${remoteSpec.root}` };
    }
    const resolved = path.resolve(expandHome(raw));
    if (isBlockedRoot(resolved)) return { ok: false, requestId, message: 'refusing to scan an over-broad root' };
    let st = null;
    try {
      if (!fs.existsSync(resolved)) {
        return { ok: false, requestId, message: `not found: ${resolved}` };
      }
      st = fs.statSync(resolved);
    } catch (e) {
      return { ok: false, requestId, message: e.message || String(e) };
    }
    const targetIsFile = st.isFile();
    const projectRoot = targetIsFile ? projectRootForLocalPath(resolved) : resolved;
    if (isBlockedRoot(projectRoot)) return { ok: false, requestId, message: 'refusing to scan an over-broad root' };
    clearTextSnapshot();
    if (remote) exitRemote();
    if (projectRoot === root) {
      if (!watcher && !staticSnap) attachWatcher();
      broadcast({ type: 'project', payload: { root, label: path.basename(root) || root } });
      pushState();
    } else {
      reroot(projectRoot);
    }
    if (targetIsFile) focusLocalPath(resolved);
    return { ok: true, requestId, kind: 'local', root: projectRoot, focus: targetIsFile ? path.relative(projectRoot, resolved) : null };
  }

  async function routeTextRequest(text, { requestId = null } = {}) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, requestId, message: 'empty request' };
    const remoteSpec = remoteSpecFromText(raw);
    if (remoteSpec) return openProjectRequest(`${remoteSpec.host}:${remoteSpec.root}`, { requestId });
    const directPath = projectPathFromText(raw);
    if (directPath) {
      const host = remote?.host || activeSshTarget;
      if (host) {
        const localPath = path.resolve(expandHome(directPath));
        try {
          if (!fs.existsSync(localPath)) return openProjectRequest(`${host}:${directPath}`, { requestId });
        } catch {
          return openProjectRequest(`${host}:${directPath}`, { requestId });
        }
      }
      return openProjectRequest(directPath, { requestId });
    }
    const name = projectNameFromText(raw);
    if (name) {
      const local = findLocalProjectByName(name);
      if (local) return openProjectRequest(local, { requestId });
      const host = remote?.host || activeSshTarget;
      if (host) {
        const found = await findRemoteProject(host, name);
        if (found) return openProjectRequest(`${host}:${found}`, { requestId });
      }
    }
    const textResult = showTextCells(raw);
    if (textResult.ok) return { ...textResult, requestId };
    return { ok: false, requestId, message: 'no project path/name or code block detected' };
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

  const WATCH_FILE_LIMIT = Number(process.env.CODETREE_WATCH_FILE_LIMIT || 5000);
  const STATIC_SCAN_LIMIT = Number(process.env.CODETREE_STATIC_SCAN_LIMIT || 5000);
  function countCodeFiles(dir, cap = WATCH_FILE_LIMIT + 1) {
    const stack = [dir];
    let count = 0;
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        const abs = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          if (!isIgnored(abs)) stack.push(abs);
        } else if (ent.isFile() && CODE_EXT.includes(path.extname(ent.name).toLowerCase())) {
          count++;
          if (count >= cap) return count;
        }
      }
    }
    return count;
  }

  function staticScan(reason = 'large-project') {
    try {
      staticSnap = scanLocalProject(root, { limit: STATIC_SCAN_LIMIT });
      const idByPath = new Map(staticSnap.cells.map((c) => [c.path, c.id]));
      staticSnap.edges = staticSnap.edges.map((e) => ({
        ...e,
        from: idByPath.get(e.from) || e.from,
        to: idByPath.get(e.to) || e.to,
      }));
      staticSnap.scanMode = 'static';
      staticSnap.reason = reason;
      staticSnap.scannedAt = Date.now();
      log(`static scan complete: ${staticSnap.cells.length} file nodes, ${staticSnap.edges.length} dependency edges${staticSnap.truncated ? ' (truncated)' : ''}`);
      pushState();
    } catch (e) {
      staticSnap = { root, cells: [], edges: [], error: e.message || String(e), scanMode: 'static' };
      broadcast({ type: 'agent_error', payload: { message: `Static scan failed: ${staticSnap.error}` } });
      pushState();
    }
  }

  function attachWatcher() {
    ready = false;
    staticSnap = null;
    if (initialNoProjectRoot && root === initialNoProjectRoot) {
      log('no-project scratch mode — keeping the tree empty until the shell cd/ssh enters a project');
      ready = true;
      watcher = null;
      pushState();
      return;
    }
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
    const estimatedFiles = countCodeFiles(root);
    if (estimatedFiles > WATCH_FILE_LIMIT) {
      log(`project has at least ${estimatedFiles} files; using scan-only tree instead of opening thousands of file watchers`);
      ready = true;
      watcher = null;
      staticScan('too-many-files-for-watch');
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
  function enterRemote(host, root, options = {}) {
    root = cleanRemoteRoot(root);
    if (!host || !root || root === '~' || root === '/') return false;
    if (isBroadRemoteRoot(root)) {
      log(`skip remote broad root ${host}:${root}; waiting for a real project path`);
      if (watcher) { try { watcher.close(); } catch {} watcher = null; }
      if (remoteSource) { remoteSource.stop(); remoteSource = null; }
      remote = { host, root };
      remoteFocusRel = null;
      remoteSnap = { root: `${host}:${root}`, remote: true, cells: [], edges: [], recent: [], scanMode: 'remote-empty', reason: 'broad-root' };
      currentProjectLabel = `${host}:${root}`;
      broadcast({ type: 'project', payload: { root: `${host}:${root}`, label: `${host}:${root}`, remote: true, waitingForProject: true } });
      pushState();
      return false;
    }
    if (remote && remote.host === host && remote.root === root) {
      if (options.focus) {
        remoteFocusRel = options.focus;
        broadcast({ type: 'active', payload: { path: remoteFocusRel, id: remoteFocusRel } });
      }
      return true;
    }
    clearTextSnapshot();
    staticSnap = null;
    remoteFocusRel = options.focus || null;
    if (watcher) { try { watcher.close(); } catch {} watcher = null; }
    if (remoteSource) { remoteSource.stop(); remoteSource = null; }
    remote = { host, root };
    currentProjectLabel = `${host}:${root.split('/').pop()}`;
    remoteSnap = null;
    log(`auto-follow → remote ${host}:${root}`);
    remoteSource = createRemoteSource({
      host, root,
      onSnapshot: (snap) => {
        remoteSnap = snap;
        broadcast({ type: 'state', payload: snap });
        if (remoteFocusRel && snap.cells.some((c) => c.path === remoteFocusRel)) {
          broadcast({ type: 'active', payload: { path: remoteFocusRel, id: remoteFocusRel } });
          return;
        }
        if (snap.changed && snap.changed.length) {
          // Light up each changed/new file (card glows + code streams in) and fly the camera to the newest —
          // so when the agent writes or creates a file on the remote, the world-tree jumps to that cell.
          for (const p of snap.changed) { broadcast({ type: 'activity', payload: { path: p, action: 'modify', ts: Date.now() } }); lieFeed('file', root.replace(/\/$/, '') + '/' + p); }
          broadcast({ type: 'active', payload: { path: snap.changed[0], id: snap.changed[0] } });
        }
      },
      onStatus: (s) => {
        if (s.ok) log(`remote scan: ${s.files} files on ${s.host}:${s.root}`);
        else {
          log(`remote scan failed on ${s.host}:${s.root}: ${s.error}`);
          broadcast({ type: 'agent_error', payload: { message: `Remote (${s.host}): ${s.error}` } });
        }
      },
    });
    remoteSource.start();
    broadcast({ type: 'project', payload: { root: `${host}:${root}`, label: currentProjectLabel, remote: true } });
    return true;
  }
  // Back to the local project when the ssh session ends.
  function exitRemote() {
    if (!remote) return;
    log('auto-follow ← back to local');
    if (remoteSource) { remoteSource.stop(); remoteSource = null; }
    remote = null; remoteSnap = null; staticSnap = null;
    currentProjectLabel = path.basename(root);
    attachWatcher();
    broadcast({ type: 'project', payload: { root, label: currentProjectLabel } });
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
    clearTextSnapshot();
    staticSnap = null;
    log('reroot ->', resolved);
    root = resolved;
    currentProjectLabel = path.basename(root);
    if (watcher) { try { watcher.close(); } catch {} }
    graph = new Graph(root);
    if (!runner.busy) runner = makeRunner(); // only swap the runner when idle, to avoid interrupting a running agent
    attachWatcher();
    broadcast({ type: 'project', payload: { root, label: currentProjectLabel } });
  }

  // ── Follow the terminal's cwd: when the shell cd's into a project, the right side auto-switches root. Non-invasive (doesn't modify the user's shell) ──
  let cwdTimer = null, followPid = null, lastCwd = shellCwd;
  function shellCwdOf(pid) {
    return new Promise((res) => {
      try {
        execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }, (err, out) => {
          if (err) return res(null);
          const line = String(out).split('\n').find((l) => l[0] === 'n');
          res(line ? line.slice(1) : null);
        });
      } catch {
        res(null);
      }
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
    followPid = pid;
    const adopt = async () => {
      if (!followPid) return;
      const cwd = await shellCwdOf(followPid);
      if (!cwd) return;
      lastCwd = cwd;
      // Don't reroot to the home directory itself — it's not a project and scanning all of $HOME is slow/noisy.
      const resolved = path.resolve(cwd);
      if (resolved !== os.homedir() && looksLikeProject(cwd) && resolved !== root) reroot(cwd);
    };
    adopt();
    if (cwdTimer) return;
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
    if (remote) ws.send(JSON.stringify({ type: 'project', payload: { root: `${remote.host}:${remote.root}`, label: currentProjectLabel, remote: true } }));
    else ws.send(JSON.stringify({ type: 'project', payload: { root, label: currentProjectLabel } }));
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
      // node-pty's spawn-helper can be blocked by macOS (Gatekeeper/hardened-runtime after an ad-hoc re-sign),
      // throwing "posix_spawnp failed". That must NOT kill the whole core (which would blank the command line and
      // the tree). Catch it, tell the page the terminal is unavailable, and keep the visualization alive.
      function ptyEnv() {
        const env = { ...process.env };
        delete env.NO_COLOR;
        env.TERM = env.TERM && env.TERM.includes('256') ? env.TERM : 'xterm-256color';
        env.COLORTERM = env.COLORTERM || 'truecolor';
        env.CLICOLOR = '1';
        env.CLICOLOR_FORCE = '1';
        env.FORCE_COLOR = env.FORCE_COLOR || '3';
        env.GREP_COLORS = env.GREP_COLORS || 'mt=01;38;5;214:ms=01;38;5;214:mc=01;38;5;214';
        env.LSCOLORS = env.LSCOLORS || 'Gxfxcxdxbxegedabagacad';
        env.LS_COLORS = env.LS_COLORS || 'di=1;34:ln=36:so=35:pi=33:ex=32:bd=33;01:cd=33;01:su=37;41:sg=30;43:tw=30;42:ow=34;42:ex=32';
        env.CODETREE_TERMINAL = '1';
        Object.assign(env, sshControlEnv());
        return env;
      }
      let pty;
      try {
        const cwdSafe = (() => { try { return fs.existsSync(shellCwd) && fs.statSync(shellCwd).isDirectory() ? shellCwd : os.homedir(); } catch { return os.homedir(); } })();
        pty = mod.spawn(shell, loginArgs, { name: 'xterm-256color', cols: cols || 80, rows: rows || 24, cwd: cwdSafe, env: ptyEnv() });
      } catch (e) {
        log('pty spawn failed (terminal unavailable, tree still works):', e && e.message);
        try { ws.send(JSON.stringify({ type: 'pty_missing' })); } catch {}
        return;
      }
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
        if (m && m[1] && !/^-/.test(m[1])) { entry.sshTarget = m[1]; activeSshTarget = m[1]; }
        // user explicitly leaves the ssh session → tree goes back to the local project (robust; ignores flaky disconnects)
        if (entry.sshTarget && /^\s*(exit|logout)\s*$/.test(line)) { entry.sshTarget = null; activeSshTarget = null; entry.outbuf = ''; exitRemote(); }
      }
      // Ctrl-D also ends the shell
      if (entry.sshTarget && data.includes('\x04')) { entry.sshTarget = null; activeSshTarget = null; entry.outbuf = ''; exitRemote(); }
      if (entry.inbuf.length > 400) entry.inbuf = entry.inbuf.slice(-400);
    }
    function writePtyInput(entry, data) {
      const s = String(data || '');
      if ((s === '\r' || s === '\n') && entry.inbuf.trim().startsWith('ssh')) {
        const rewritten = injectSshControlIntoCommand(entry.inbuf);
        if (rewritten && rewritten !== entry.inbuf) {
          entry.pty.write('\x15' + rewritten + '\r');
          entry.inbuf = '';
          detectSshFromInput(entry, rewritten + '\n');
          return;
        }
      }
      entry.pty.write(data);
      detectSshFromInput(entry, data);
    }
    // Figure out WHICH project the terminal is working in from whatever it prints — covers an in-terminal agent
    // (claude/codex) doing its own ssh/edits, plain shells, scp/rsync, host:/path mentions, cd, git -C, etc.
    // All the messy format-matching lives in agent-trace.js (unit-tested against dozens of real shapes).
    function detectRemoteFromOutput(entry, data) {
      const clean = data.replace(ANSI, '');
      entry.outbuf = (entry.outbuf + data).replace(ANSI, '').slice(-4000);
      lieAgentBuf += clean; if (lieAgentBuf.length > 12000) lieAgentBuf = lieAgentBuf.slice(-12000); // feed the agent's output to the lie monitor
      draftStream.feed(clean); // and to the live draft-cell watcher: code on screen → unnamed cell → named on save
      // (a) precise: you ssh'd in OUR shell → follow the remote prompt's cwd
      if (entry.sshTarget) {
        activeSshTarget = entry.sshTarget;
        const last = entry.outbuf.split('\n').pop();
        const p = PROMPT_RE.exec(last || '');
        if (p && p[3].startsWith('/')) { enterRemote(entry.sshTarget, p[3]); return; }
      }
      // (b) inferred: read every signal in the recent output and follow the project it points at
      const tr = traceProject(entry.outbuf, { sshAliases: SSH_ALIASES });
      // In terminal-only/no-project mode, do not let stale text or an agent's prose silently jump to an old VPS tree.
      // A remote tree should start from a real ssh command/prompt, or from an explicit open request.
      if (tr.host && tr.root && (!noProject || entry.sshTarget || activeSshTarget)) { enterRemote(tr.host, tr.root); return; }
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
        if (e) writePtyInput(e, msg.data);
        return;
      }
      if (msg.type === 'pty_resize') { try { ptys.get(msg.sessionId || 'default')?.pty.resize(msg.cols, msg.rows); } catch {} return; }
      if (msg.type === 'visible_terminal_output') {
        const sessionId = msg.sessionId || activePtyId || 'default';
        const data = String(msg.data || '');
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'pty_output', sessionId, data }));
        return;
      }
      if (msg.type === 'agent_prompt_submit') {
        const sessionId = msg.sessionId || activePtyId || 'default';
        const e = ptys.get(sessionId);
        const text = String(msg.text || '');
        ws.send(JSON.stringify({ type: 'agent_prompt_passthrough', sessionId, payload: { kind: 'command', text } }));
        if (e && text.trim()) {
          const line = text.replace(/\r?\n$/, '');
          const rewritten = injectSshControlIntoCommand(line) || line;
          e.pty.write(rewritten + '\r');
          detectSshFromInput(e, rewritten + '\n');
        }
        return;
      }
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
    if (msg.type === 'project_open') {
      openProjectRequest(msg.root || msg.path || msg.text, { requestId: msg.requestId || null })
        .then((r) => broadcast({ type: 'project_open_ack', payload: r }))
        .catch((e) => broadcast({ type: 'project_open_ack', payload: { ok: false, requestId: msg.requestId || null, message: e.message || String(e) } }));
    } else if (msg.type === 'gpt_text' || msg.type === 'text_ingest') {
      const r = showTextCells(msg.text || msg.prompt || '');
      broadcast({ type: 'text_ingest_ack', payload: r });
    } else if (msg.type === 'gpt_prompt' || msg.type === 'project_prompt') {
      routeTextRequest(msg.text || msg.prompt || '', { requestId: msg.requestId || null })
        .then((r) => broadcast({ type: 'gpt_prompt_ack', payload: r }))
        .catch((e) => broadcast({ type: 'gpt_prompt_ack', payload: { ok: false, requestId: msg.requestId || null, message: e.message || String(e) } }));
    } else if (msg.type === 'visible_test') {
      broadcast({ type: 'visible_test_ack', payload: msg.payload || {} });
    } else if (msg.type === 'agent_read' && msg.path) {
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
