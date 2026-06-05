#!/usr/bin/env node
// Cosmos Tree CLI: a native coding agent interface.
// Instead of the usual scrolling text, the view jumps to whichever file the agent is writing to right now.
// Hit Tab anytime to switch to Tree View and see how big a tree your whole codebase has grown into.
// Launches with Claude, borrowing your Claude Code OAuth session to log in.
import { createElement as h, useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { exec } from 'node:child_process';
import { startCore } from '../src/core/server.js';
import { WS_PORT, WEB_PORT } from '../src/config.js';
import { authStatus, getAuth } from '../src/cli/auth.js';
import { createScriptedLLM, createClaudeLLM } from '../src/cli/llm.js';
import { createLocalLLM } from '../src/cli/local-llm.js';
import { detectLocalLLM } from '../src/cli/local-detect.js';
import { createAgent } from '../src/cli/agent.js';
import { createMemory } from '../src/cli/memory.js';
import { createSdkAgent } from '../src/cli/sdk-agent.js';
import { createCodexAgent } from '../src/cli/codex-agent.js';
import { createRoutedAgent } from '../src/cli/routed-agent.js';
import { demoScript, resetSample } from '../src/cli/demo.js';
import { createTokenMeter, fetchSavings, fmtTok } from '../src/cli/tokens.js';
import { reportLines } from '../src/masl/gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// ── args ──
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const modelArg = argv.find((a) => a.startsWith('--model='))?.split('=')[1];
// Engine selection: --codex uses ChatGPT login; --local / --no-cloud forces a local model (zero cloud login);
// the default, claude, borrows the Claude Code login, but falls back to a detected local model if not logged in.
const ENGINE = flags.has('--codex')
  ? 'codex'
  : flags.has('--local') || flags.has('--no-cloud')
    ? 'local'
    : argv.find((a) => a.startsWith('--engine='))?.split('=')[1] || 'claude';
// Local engine: points at an OpenAI-compatible endpoint (vLLM / llama.cpp). Defaults to localhost; use --base-url to point at GX10.
const baseURLArg = argv.find((a) => a.startsWith('--base-url='))?.split('=')[1] || 'http://localhost:8000/v1';
// Small models (7B) often describe the next step in prose instead of actually emitting a tool call, which breaks the loop.
// This discipline is only added for the local engine; Claude / codex are left untouched.
const LOCAL_DISCIPLINE = `(Important work discipline)
- Until the task is done, emit ONLY one tool call per turn. Do not describe in prose what you "intend" to call. Want to read a file? Send read_file directly. Want to change a file? Send edit_file directly.
- Do not paste tool calls as markdown or JSON examples in your reply. If you mean to call a tool, actually call it.
- Once you have enough information, make the change (edit_file / write_file). Do not stop at describing a plan.
- For small files (roughly under 40 lines), just rewrite the whole file with write_file. This is the most reliable approach. edit_file's old_str must match the text in the file exactly (including whitespace and punctuation); if it doesn't match it will fail.
- If a tool tells you it "could not find the text to replace", that edit did not take effect. Switch to write_file and rewrite the whole file. Do not paste the same old_str again.
- Only when the entire task is truly done should you give a final plain-text wrap-up; do not emit any tool call on that turn.`;

// Subcommands: login / status → just report auth status (borrows Claude Code, no re-login needed)
if (positional[0] === 'login' || positional[0] === 'status') {
  const s = await authStatus();
  if (s.ok) console.log(`✓ ${s.label} (mode: ${s.mode}). Run code-tree <project-path> to start.`);
  else {
    console.log(`✗ ${s.label}`);
    // No cloud login: check whether a local model is ready → offer a zero-login path instead of just telling them to log into Claude
    const local = await detectLocalLLM({});
    if (local && local.model) {
      console.log(`✓ But a local model is ready: ${local.model} (${local.provider}, no login). Run code-tree --local <project-path> to use it.`);
      process.exit(0);
    }
    if (local && !local.model) console.log(`A ${local.provider} server is running but has no model. Run: ollama pull qwen2.5-coder`);
    console.log('Either log into Claude Code (run `claude` once), or run a local model. See "No-login local mode" in the README.');
  }
  process.exit(s.ok ? 0 : 1);
}

const DEMO = flags.has('--demo');

// Remote project over ssh: `code-tree host:/path/to/project` or `code-tree ssh://host/path`.
// The world-tree maps the project on that machine (for people who do their real work over ssh).
function parseRemote(arg) {
  if (!arg) return null;
  let m = arg.match(/^ssh:\/\/([^/]+)(\/.*)$/);
  if (m) return { host: m[1], root: m[2] };
  // host:/abs/path  (the ':' + a path; exclude local existing paths and bare drive letters)
  m = arg.match(/^([A-Za-z0-9._@-]+):(\/?\S+)$/);
  if (m && !arg.startsWith('/') && !arg.startsWith('.')) {
    // only treat as remote if it isn't actually a local file/dir
    try { if (fs.existsSync(arg)) return null; } catch {}
    return { host: m[1], root: m[2] };
  }
  return null;
}
const remote = DEMO ? null : parseRemote(positional[0]);
const target = DEMO ? path.join(REPO_ROOT, 'sample')
  : remote ? process.env.HOME || process.cwd() // shell opens at home; the tree is the remote project
  : path.resolve(positional[0] || process.cwd());
if (DEMO) resetSample(target);

// ── start core (reuse the existing one if it's already running) ──
const alreadyRunning = await portInUse(WS_PORT);
const core = alreadyRunning ? null : startCore({ root: target, port: WS_PORT, quiet: true, remote, projectLabel: remote ? `${remote.host}:${remote.root}` : undefined });

// By default everything lives in the terminal, no browser pops up. Use --web to open the full world-tree web view.
if (flags.has('--web')) {
  setTimeout(() => exec(`open http://localhost:${core ? core.webPort : WEB_PORT}`), 700);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(400, () => { s.destroy(); resolve(false); });
  });
}

// ── color / tree helpers ──
const STATUS = {
  idle: { color: 'gray', dot: '·' },
  active: { color: 'green', dot: '◉' },
  modified: { color: 'yellow', dot: '●' },
  error: { color: 'red', dot: '●' },
};

function buildForest(cells) {
  const root = { name: '', dir: true, children: new Map() };
  for (const c of cells) {
    const parts = c.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      if (!node.children.has(part)) node.children.set(part, { name: part, dir: !leaf, children: new Map() });
      node = node.children.get(part);
      if (leaf) node.cell = c;
    });
  }
  return root;
}

function renderForest(node, prefix, out, activePath) {
  const kids = [...node.children.values()].sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  kids.forEach((k, i) => {
    const last = i === kids.length - 1;
    const branch = last ? '└─ ' : '├─ ';
    if (k.dir) {
      out.push({ text: prefix + branch + k.name + '/', color: 'cyan', bold: false });
      renderForest(k, prefix + (last ? '   ' : '│  '), out, activePath);
    } else {
      const c = k.cell;
      const st = STATUS[c.status] || STATUS.idle;
      const dots = c.modification_count > 0 ? ' ' + st.dot.repeat(Math.min(c.modification_count, 5)) : '';
      const warn = c.anomaly === 'repeat' ? ' ⚠ repeated' : c.anomaly === 'stall' ? ' ⚠ stalled' : '';
      const here = c.path === activePath ? ' ◀ here now' : '';
      out.push({ text: prefix + branch + k.name + dots + warn + here, color: c.path === activePath ? 'whiteBright' : st.color });
    }
  });
}

// ── App ──
function App() {
  const app = useApp();
  const [view, setView] = useState('split'); // split | tree
  const [cells, setCells] = useState([]);
  const [activePath, setActivePath] = useState(null);
  const [feed, setFeed] = useState([]); // transcript: user prompt + files the agent touched
  const [thinking, setThinking] = useState(''); // streaming thinking text (not yet finalized)
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [authLabel, setAuthLabel] = useState('Checking login…');
  const [authOk, setAuthOk] = useState(false);
  const [notice, setNotice] = useState(DEMO ? '🎬 Demo mode: scripted agent replays scenario one' : '');
  const [tok, setTok] = useState({ total: { burned: 0, all: 0 }, turn: { burned: 0 } }); // live usage
  const [tier, setTier] = useState(null); // routed engine's current tier: 'local' → 'claude'
  const [savings, setSavings] = useState(null); // machine-wide cache waste (mercury tool)
  const [savingBusy, setSavingBusy] = useState(false);
  const [gate, setGate] = useState(null); // MASL pending approval: { report, agentSaid }
  const [visited, setVisited] = useState([]); // cells the agent visited (in time order) → right-pane flow diagram
  const [tick, setTick] = useState(0); // animation beat: drives the light ball down the line
  const visitedRef = useRef([]);
  const wsRef = useRef(null);
  const agentRef = useRef(null);
  const thinkingRef = useRef('');
  const feedRef = useRef([]);
  const meterRef = useRef(createTokenMeter());
  const stateRef = useRef({ cells: [], edges: [], root: target }); // latest snapshot (used by gate to compute blast radius)
  const gateResolveRef = useRef(null); // resolve for the current gate (triggered by y/n)

  function pushFeed(item) {
    feedRef.current = [...feedRef.current, item].slice(-200);
    setFeed(feedRef.current);
  }
  function flushThinking() {
    const t = thinkingRef.current.trim();
    if (t) pushFeed({ kind: 'text', text: t });
    thinkingRef.current = '';
    setThinking('');
  }

  // connect to core
  useEffect(() => {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);
    wsRef.current = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'state') {
        setCells(msg.payload.cells);
        stateRef.current = { cells: msg.payload.cells, edges: msg.payload.edges || [], root: msg.payload.root || target };
      }
    });
    return () => ws.close();
  }, []);

  // build the agent (demo → replayable scripted; otherwise SDK borrowing Claude Code login)
  useEffect(() => {
    (async () => {
      // Mutable final engine and local config: defaults to ENGINE / baseURLArg, but may fall back to local below if not logged in.
      let engine = ENGINE;
      let localCfg = { baseURL: baseURLArg, model: modelArg || 'qwen2.5-coder' };

      if (DEMO) {
        setAuthOk(true);
        setAuthLabel('🎬 demo (no login needed)');
      } else if (engine === 'codex') {
        // Codex uses the codex CLI's own ChatGPT OAuth; status is only known once the SDK starts, so optimistically mark connected
        setAuthOk(true);
        setAuthLabel('Codex login (ChatGPT OAuth)');
      } else if (engine === 'local') {
        // User explicitly wants local (--local / --engine=local): detect the local server, fill in baseURL + model
        const found = await detectLocalLLM({ preferModel: modelArg });
        if (found && found.model) {
          localCfg = { baseURL: found.baseURL, model: found.model };
          setAuthOk(true);
          setAuthLabel(`🖥 local · ${found.model} (${found.provider}, no login)`);
        } else if (found && !found.model) {
          // server is running but no model installed
          setAuthOk(false);
          setAuthLabel(`🖥 ${found.provider} running but no model. Run: ollama pull qwen2.5-coder`);
        } else {
          setAuthOk(false);
          setAuthLabel('No local model found. Install Ollama + run: ollama pull qwen2.5-coder');
        }
      } else {
        // Default claude: first check if a Claude Code login can be borrowed; if not, fall back to a local model (zero login).
        const s = await authStatus();
        if (s.ok) {
          setAuthOk(true);
          setAuthLabel(s.label);
        } else {
          const found = await detectLocalLLM({ preferModel: modelArg });
          if (found && found.model) {
            engine = 'local';
            localCfg = { baseURL: found.baseURL, model: found.model };
            setAuthOk(true);
            setAuthLabel(`🖥 local · ${found.model} (${found.provider}, no login)`);
            setNotice(`No cloud login found, using your local model ${found.model} (${found.provider}). Zero login.`);
          } else {
            setAuthOk(false);
            setAuthLabel('Claude Code login (borrowed via SDK)');
          }
        }
      }

      const emit = (action, p) => {
        if (action === 'read' && wsRef.current?.readyState === 1) {
          wsRef.current.send(JSON.stringify({ type: 'agent_read', path: p }));
        }
        // modify is caught by core's file watcher, so don't send it twice
      };
      const onEvent = (e) => {
        if (e.type === 'text') {
          thinkingRef.current += e.delta;
          setThinking(thinkingRef.current.slice(-400));
        } else if (e.type === 'tool') {
          flushThinking(); // a tool arrived, so collapse this thinking into one line first
          pushFeed({ kind: 'tool', name: e.name, path: e.path });
        } else if (e.type === 'active' && e.path) {
          setActivePath(e.path);
          // only record a step when moving to a new cell → the right-pane flow diagram is the agent's footprint chain
          if (visitedRef.current[visitedRef.current.length - 1] !== e.path) {
            visitedRef.current = [...visitedRef.current, e.path].slice(-40);
            setVisited(visitedRef.current);
          }
          // report which cell the agent is on now → core broadcasts → the browser world-tree camera flies over
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'agent_active', path: e.path }));
          }
        } else if (e.type === 'usage') {
          meterRef.current.add(e.usage);
          setTok(meterRef.current.snapshot());
          // also push real usage to core so the browser world-tree's token bar goes live too
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'cli_usage', usage: e.usage }));
          }
        } else if (e.type === 'recall') {
          // cross-session memory kicked in → show it in the CLI feed and surface it in the browser
          const n = (e.text.match(/^- Task:/gm) || []).length || 1;
          pushFeed({ kind: 'tool', name: `💡 recalled ${n} past fix${n > 1 ? 'es' : ''} in this project`, path: '' });
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'recall', count: n, text: e.text.slice(0, 600) }));
          }
        } else if (e.type === 'design') {
          pushFeed({ kind: 'tool', name: '🎨 design system applied (premium UI discipline)', path: '' });
        } else if (e.type === 'tier') {
          setTier(e.name);
          pushFeed({ kind: 'tool', name: e.index === 0 ? `↳ using ${e.name} (trying the cheap one first)` : `↗ escalating to ${e.name}`, path: '' });
        } else if (e.type === 'error') {
          setNotice('⚠ ' + (e.message || '').slice(0, 120));
        } else if (e.type === 'turn_end') {
          flushThinking();
          setBusy(false);
        }
      };

      // MASL gate: before the agent edits a file / runs a command, open the approval panel and wait for the dev's y/n
      const onGate = (report, agentSaid) => new Promise((resolve) => {
        gateResolveRef.current = resolve;
        setGate({ report, agentSaid });
      });
      const getState = () => stateRef.current;
      const lastSaid = () => thinkingRef.current.trim().slice(-160);

      agentRef.current = DEMO
        ? createAgent({ llm: createScriptedLLM(demoScript), root: target, emit, onEvent })
        : engine === 'codex'
          ? createCodexAgent({ root: target, model: modelArg, emit, onEvent })
          : engine === 'claude-api'
            ? createAgent({ llm: createClaudeLLM({ getAuth, model: modelArg || 'claude-sonnet-4-6' }), root: target, emit, onEvent, memory: createMemory({ root: target, model: modelArg || 'claude' }) })
          : engine === 'local'
            ? createAgent({ llm: createLocalLLM({ baseURL: localCfg.baseURL, model: localCfg.model }), root: target, emit, onEvent, systemSuffix: LOCAL_DISCIPLINE, memory: createMemory({ root: target, model: localCfg.model }) })
            : engine === 'routed'
              ? createRoutedAgent({
                  root: target, model: modelArg, emit, onEvent,
                  baseURL: localCfg.baseURL, localModel: localCfg.model,
                  systemSuffix: LOCAL_DISCIPLINE,
                  sdkOpts: { getState, onGate, lastSaid },
                })
              : createSdkAgent({ root: target, model: modelArg, emit, onEvent, getState, onGate, lastSaid, memory: createMemory({ root: target, model: 'claude' }) });

      if (DEMO) {
        setTimeout(() => runPrompt('fix the intermittent session failure bug'), 700);
      }
    })();
  }, []);

  // measure machine-wide cache waste (runs python in the background, doesn't block the UI)
  function refreshSavings() {
    if (savingBusy) return;
    setSavingBusy(true);
    fetchSavings().then((s) => {
      if (s && s.ok) setSavings(s);
      setSavingBusy(false);
    }).catch(() => setSavingBusy(false));
  }

  // measure once at startup, then re-measure every 90s (cache state drifts as you develop)
  useEffect(() => {
    refreshSavings();
    const t = setInterval(refreshSavings, 90 * 1000);
    return () => clearInterval(t);
  }, []);

  // animation beat: light ball runs down the connecting line (for the right-pane flow diagram)
  useEffect(() => {
    const t = setInterval(() => setTick((x) => (x + 1) % 1000), 140);
    return () => clearInterval(t);
  }, []);

  function runPrompt(text) {
    if (!agentRef.current || busy) return;
    setBusy(true);
    meterRef.current.startTurn();
    thinkingRef.current = '';
    setThinking('');
    setNotice('');
    pushFeed({ kind: 'user', text });
    const id = 'p_' + Date.now();
    wsRef.current?.send(JSON.stringify({ type: 'prompt', id, text }));
    agentRef.current.send(text).catch((err) => {
      setNotice('⚠ ' + err.message);
      setBusy(false);
    });
  }

  // Skip raw mode on non-TTY (self-running demo / CI) to avoid crashing Ink
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === 'c') { core?.close(); app.exit(); process.exit(0); }
      // MASL gate pending: only accept y (allow) / n (block); ignore all other keys so the agent can't sneak ahead
      if (gate) {
        if (ch === 'y' || ch === 'Y' || key.return) {
          gateResolveRef.current?.(true);
          gateResolveRef.current = null;
          pushFeed({ kind: 'tool', name: '✓ allowed', path: gate.report.targetRel || '' });
          setGate(null);
        } else if (ch === 'n' || ch === 'N' || key.escape) {
          gateResolveRef.current?.(false);
          gateResolveRef.current = null;
          setNotice('⛔ Blocked: ' + (gate.report.targetRel || 'command') + '. The agent was asked to stop and explain.');
          setGate(null);
        }
        return;
      }
      // Ctrl+L: clear / re-measure cache waste. Cosmos measures it for you; to actually release it, hit /clear in your agent's terminal.
      if (key.ctrl && ch === 'l') {
        const w = savings?.wasted_tokens || 0;
        const usd = savings?.clear_now_savings_usd || 0;
        meterRef.current.startTurn();
        setTok(meterRef.current.snapshot());
        refreshSavings();
        setNotice(w > 0
          ? `🧹 About ${fmtTok(w)} tokens of waste can be cleared (clearing now saves $${usd.toFixed(2)}). Hit /clear in the terminal running your agent to release it. Re-measuring…`
          : '🧹 Re-measuring cache waste…');
        return;
      }
      if (key.tab) { setView((v) => (v === 'split' ? 'tree' : 'split')); return; } // Tree View can be toggled anytime
      if (busy) return;
      if (key.return) {
        const t = input.trim();
        if (t === 'exit' || t === 'quit') { core?.close(); app.exit(); process.exit(0); }
        if (t) runPrompt(t);
        setInput('');
        return;
      }
      if (key.delete || key.backspace) { setInput((s) => s.slice(0, -1)); return; }
      if (!key.ctrl && !key.meta && ch) setInput((s) => s + ch);
    },
    { isActive: Boolean(process.stdin.isTTY) }
  );

  const fileCount = cells.length;
  const dirCount = new Set(cells.map((c) => c.path.split('/').slice(0, -1).join('/')).filter(Boolean)).size;

  // ── header ──
  const header = h(
    Box,
    { justifyContent: 'space-between' },
    h(Text, { color: 'green', bold: true }, '🌳 Code Tree'),
    h(Text, { color: authOk || DEMO ? 'green' : 'red' }, (authOk || DEMO ? '● ' : '○ ') + authLabel)
  );
  const subhead = h(Text, { color: 'gray' }, `${target}　|　${fileCount} files · ${dirCount} folders`);

  // ── single transcript line ──
  function feedLine(it, i) {
    if (it.kind === 'user') return h(Text, { key: i, color: 'cyan', wrap: 'truncate-end' }, '› ' + it.text);
    if (it.kind === 'tool') {
      const base = it.path ? it.path.split('/').pop() : '';
      const col = /edit|write/i.test(it.name) ? 'green' : 'blueBright';
      return h(Text, { key: i, color: col, wrap: 'truncate-end' }, '● ' + it.name + (base ? '  ' + base : ''));
    }
    return h(Text, { key: i, color: 'gray', wrap: 'truncate-end' }, it.text);
  }

  // ── right pane: flow diagram. The cells the agent visited are strung top-to-bottom into a chain;
  //    every cell is always connected by a line, and a light ball runs down the newest segment → you can see the flow and order. ──
  function flowLines() {
    const shown = visited.slice(-10);
    const out = [];
    if (!shown.length) {
      out.push({ text: '(Not started yet. On your next', color: 'gray' });
      out.push({ text: ' prompt, it grows where the agent goes.)', color: 'gray' });
      return out;
    }
    const SEG = 3; // how many rows each segment spans → the light ball moves across these rows
    shown.forEach((p, i) => {
      const c = cells.find((x) => x.path === p);
      const st = STATUS[(c && c.status) || 'idle'] || STATUS.idle;
      const name = p.split('/').pop();
      const here = p === activePath;
      const warn = c && c.anomaly === 'repeat' ? ' ⚠ repeated' : c && c.anomaly === 'stall' ? ' ⚠ stalled' : '';
      out.push({
        text: (here ? '◉ ' : st.dot + ' ') + name + (here ? '  ◀ you are here' : '') + warn,
        color: here ? 'greenBright' : st.color, bold: here,
      });
      if (i < shown.length - 1) {
        const activeEdge = i === shown.length - 2; // the most recent jump → the light ball flows along this segment
        for (let r = 0; r < SEG; r++) {
          const ball = activeEdge && tick % SEG === r;
          out.push({ text: '  ' + (ball ? '●' : '│'), color: ball ? 'greenBright' : 'gray' });
        }
      }
    });
    return out;
  }

  // ── split view (default): transcript on the left (terminal text stream), flow diagram on the right ──
  function splitView() {
    const flow = flowLines();
    const feedLines = feed.slice(-16);

    return h(
      Box,
      { flexDirection: 'row', marginTop: 1 },
      // left: agent transcript (typing, text scrolls up, just like a CLI)
      h(Box, { flexDirection: 'column', flexGrow: 1, paddingRight: 1 },
        h(Text, { color: 'gray' }, 'agent'),
        feedLines.length ? feedLines.map((it, i) => feedLine(it, i))
          : h(Text, { color: 'gray' }, '(Nothing yet. Your next prompt takes you in.)'),
        thinking
          ? h(Text, { color: 'yellow', wrap: 'truncate-end' }, thinking)
          : busy ? h(Text, { color: 'yellow' }, 'Thinking…') : null,
      ),
      // right: flow diagram (agent footprint chain + light ball)
      h(Box, {
          flexDirection: 'column', width: 34, paddingLeft: 1,
          borderStyle: 'single', borderColor: 'gray',
          borderTop: false, borderRight: false, borderBottom: false,
        },
        h(Text, { color: 'green' }, `Flow · ${visited.length} visited / ${fileCount} files`),
        ...flow.map((l, i) => h(Text, { key: i, color: l.color, bold: l.bold, wrap: 'truncate-end' }, l.text)),
      ),
    );
  }

  // ── tree view ──
  function treeView() {
    const out = [];
    renderForest(buildForest(cells), '', out, activePath);
    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(Text, { color: 'green' }, `Your code as a tree of ${fileCount} files / ${dirCount} folders`),
      ...out.slice(0, 40).map((l, i) => h(Text, { key: i, color: l.color, bold: l.bold }, l.text)),
      out.length > 40 ? h(Text, { color: 'gray' }, `… ${out.length - 40} more lines`) : null
    );
  }

  // ── token bar: burned this session / in use now / total + machine-wide clearable waste ──
  const wasteTok = savings?.wasted_tokens || 0;
  const clearUsd = savings?.clear_now_savings_usd || 0;
  const tokenBar = h(
    Box,
    { borderStyle: 'single', borderColor: 'gray', borderLeft: false, borderRight: false, paddingX: 1, justifyContent: 'space-between' },
    h(Box, {},
      h(Text, { color: 'gray' }, 'tokens '),
      h(Text, { color: 'yellow' }, 'burned ' + fmtTok(tok.total.burned)),
      h(Text, { color: 'gray' }, '  ·  '),
      h(Text, { color: busy ? 'greenBright' : 'green' }, 'now ' + fmtTok(tok.turn.burned)),
      h(Text, { color: 'gray' }, '  ·  '),
      h(Text, { color: 'cyan' }, 'total ' + fmtTok(tok.total.all)),
      tier ? h(Text, { color: 'gray' }, '  ·  ') : null,
      tier ? h(Text, { color: tier === 'local' ? 'greenBright' : 'magenta' }, 'tier ' + tier) : null,
    ),
    h(Box, {},
      savingBusy
        ? h(Text, { color: 'gray' }, 'measuring…')
        : wasteTok > 0
          ? h(Text, { color: 'red' }, fmtTok(wasteTok) + ' waste clearable (save $' + clearUsd.toFixed(2) + ')')
          : h(Text, { color: 'gray' }, savings ? 'no waste' : '—'),
      h(Text, { color: 'gray' }, '  [Ctrl+L] clear'),
    ),
  );

  // ── MASL intercept panel: when pending approval, overlays above the input area with a red border and lists the blast radius ──
  const SEV = { safe: 'green', caution: 'yellow', high: 'red', review: 'magenta' };
  const gatePanel = gate ? h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: SEV[gate.report.severity] || 'red', paddingX: 1 },
    ...reportLines(gate.report, gate.agentSaid).map((l, i) =>
      h(Text, { key: i, color: i === 0 ? (SEV[gate.report.severity] || 'red') : 'white', bold: i === 0 }, l)),
    h(Text, { color: 'cyan' }, '  [y] allow　[n] block and make the agent explain'),
  ) : null;

  // ── footer ──
  const footer = h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    notice ? h(Text, { color: 'red' }, notice) : null,
    gatePanel,
    tokenBar,
    h(Box, {},
      h(Text, { color: busy ? 'gray' : 'cyan' }, '> '),
      h(Text, {}, busy ? '(agent working…)' : input + '▏')),
    h(Text, { color: 'gray' }, '[Enter] send　[Tab] ' + (view === 'split' ? 'open full tree' : 'back to flow') + '　[Ctrl+L] clear tokens　[Ctrl+C] exit')
  );

  // Fill the terminal height and anchor the conversation + input to the BOTTOM (chat-style: content grows
  // upward, the command line sits at the very bottom), instead of bunching everything at the top.
  const rows = process.stdout.rows || 30;
  return h(
    Box,
    { flexDirection: 'column', height: rows, paddingX: 1 },
    header,
    subhead,
    h(Box, { flexGrow: 1 }), // elastic spacer pushes the conversation + input down to the bottom
    view === 'split' ? splitView() : treeView(),
    footer
  );
}

render(h(App));
