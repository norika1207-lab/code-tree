#!/usr/bin/env node
// Cosmos Tree CLI：一個原生的 coding agent 介面。
// 不是傳統的文字捲動，而是「程式現在寫到哪個檔案，視角就跳到那一格」。
// 隨時按 Tab 切 Tree View，看整個 codebase 長成多大一棵樹。
// 用 Claude 啟動，借你 Claude Code 的 OAuth session 登入。
import { createElement as h, useState, useEffect, useRef } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { exec } from 'node:child_process';
import { startCore } from '../src/core/server.js';
import { WS_PORT, WEB_PORT } from '../src/config.js';
import { authStatus } from '../src/cli/auth.js';
import { createScriptedLLM } from '../src/cli/llm.js';
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

// ── 參數 ──
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const modelArg = argv.find((a) => a.startsWith('--model='))?.split('=')[1];
// 引擎選擇：--codex 走 ChatGPT 登入；--local / --no-cloud 強制走本機模型（零雲端登入）；
// 預設 claude 借 Claude Code 登入，但若沒登入會自動退回偵測到的本機模型。
const ENGINE = flags.has('--codex')
  ? 'codex'
  : flags.has('--local') || flags.has('--no-cloud')
    ? 'local'
    : argv.find((a) => a.startsWith('--engine='))?.split('=')[1] || 'claude';
// 本地引擎：指向 OpenAI 相容 endpoint（vLLM / llama.cpp）。預設本機，可用 --base-url 指到 GX10。
const baseURLArg = argv.find((a) => a.startsWith('--base-url='))?.split('=')[1] || 'http://localhost:8000/v1';
// 小模型(7B)常把下一步寫成白話而不真的發工具呼叫，迴圈就斷了。
// 這段紀律只加在 local 引擎，不動 Claude / codex。
const LOCAL_DISCIPLINE = `（重要工作紀律）
- 任務還沒完成前，每一輪「只」輸出一個工具呼叫，不要用文字描述你「打算」呼叫什麼。想讀檔就直接發 read_file，想改檔就直接發 edit_file。
- 不要把工具呼叫寫成 markdown 或 JSON 範例貼在回覆裡。要呼叫就真的呼叫。
- 掌握足夠資訊就動手改（edit_file / write_file），不要只停在描述計畫。
- 改小檔（大約 40 行以內）就直接用 write_file 把整個檔案重寫一遍，這最可靠。edit_file 的 old_str 必須跟檔案裡的文字一字不差（含空白與標點），對不上就會失敗。
- 工具回你「找不到要替換的文字」就代表那次編輯沒生效，改用 write_file 整檔重寫，不要重複貼同樣的 old_str。
- 只有在整個任務確實做完時，才用純文字做最後收尾；那一輪不要再發工具呼叫。`;

// 子指令：login / status → 只回報認證狀態（借用 Claude Code，不需重新登入）
if (positional[0] === 'login' || positional[0] === 'status') {
  const s = await authStatus();
  if (s.ok) console.log(`✓ ${s.label} (mode: ${s.mode}). Run code-tree <project-path> to start.`);
  else {
    console.log(`✗ ${s.label}`);
    // 沒雲端登入時，看看本機有沒有可直接用的模型 → 給零登入路徑，不要只叫人去登 Claude
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
const target = DEMO ? path.join(REPO_ROOT, 'sample') : path.resolve(positional[0] || process.cwd());
if (DEMO) resetSample(target);

// ── 起 core（已在跑就連現有的）──
const alreadyRunning = await portInUse(WS_PORT);
const core = alreadyRunning ? null : startCore({ root: target, port: WS_PORT, quiet: true });

// 預設全部活在終端機裡，不彈瀏覽器。要看完整世界樹再用 --web 開那張網頁版。
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

// ── 顏色 / tree helpers ──
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
  const [feed, setFeed] = useState([]); // transcript：使用者 prompt + agent 碰的檔
  const [thinking, setThinking] = useState(''); // 串流中的思考文字（還沒收尾）
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const [authLabel, setAuthLabel] = useState('Checking login…');
  const [authOk, setAuthOk] = useState(false);
  const [notice, setNotice] = useState(DEMO ? '🎬 Demo mode: scripted agent replays scenario one' : '');
  const [tok, setTok] = useState({ total: { burned: 0, all: 0 }, turn: { burned: 0 } }); // 即時用量
  const [tier, setTier] = useState(null); // routed engine 的當前層：'local' → 'claude'
  const [savings, setSavings] = useState(null); // 全機 cache 浪費（mercury 工具）
  const [savingBusy, setSavingBusy] = useState(false);
  const [gate, setGate] = useState(null); // MASL 待核准：{ report, agentSaid }
  const [visited, setVisited] = useState([]); // agent 走過的格子（依時間順序）→ 右 pane 流向圖
  const [tick, setTick] = useState(0); // 動畫節拍：讓光球沿著線往下跑
  const visitedRef = useRef([]);
  const wsRef = useRef(null);
  const agentRef = useRef(null);
  const thinkingRef = useRef('');
  const feedRef = useRef([]);
  const meterRef = useRef(createTokenMeter());
  const stateRef = useRef({ cells: [], edges: [], root: target }); // 最新 snapshot（gate 算爆炸範圍用）
  const gateResolveRef = useRef(null); // 目前那道關卡的 resolve（y/n 觸發）

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

  // 連 core
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

  // 建 agent（demo → scripted 可重播；否則 SDK 借 Claude Code 登入）
  useEffect(() => {
    (async () => {
      // 可變的最終引擎與本機設定：預設沿用 ENGINE / baseURLArg，但下面可能因「沒登入」自動退回本機。
      let engine = ENGINE;
      let localCfg = { baseURL: baseURLArg, model: modelArg || 'qwen2.5-coder' };

      if (DEMO) {
        setAuthOk(true);
        setAuthLabel('🎬 demo (no login needed)');
      } else if (engine === 'codex') {
        // Codex 走 codex CLI 自己的 ChatGPT OAuth，狀態由 SDK 啟動時才知道，先樂觀標已連
        setAuthOk(true);
        setAuthLabel('Codex login (ChatGPT OAuth)');
      } else if (engine === 'local') {
        // 使用者明確要本機（--local / --engine=local）：偵測本機 server，填好 baseURL + model
        const found = await detectLocalLLM({ preferModel: modelArg });
        if (found && found.model) {
          localCfg = { baseURL: found.baseURL, model: found.model };
          setAuthOk(true);
          setAuthLabel(`🖥 local · ${found.model} (${found.provider}, no login)`);
        } else if (found && !found.model) {
          // server 在跑但沒裝模型
          setAuthOk(false);
          setAuthLabel(`🖥 ${found.provider} running but no model. Run: ollama pull qwen2.5-coder`);
        } else {
          setAuthOk(false);
          setAuthLabel('No local model found. Install Ollama + run: ollama pull qwen2.5-coder');
        }
      } else {
        // 預設 claude：先看有沒有借到 Claude Code 登入；借不到就自動退回本機模型（零登入）。
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
        // modify 由 core 的 file watcher 抓，不重複送
      };
      const onEvent = (e) => {
        if (e.type === 'text') {
          thinkingRef.current += e.delta;
          setThinking(thinkingRef.current.slice(-400));
        } else if (e.type === 'tool') {
          flushThinking(); // 工具到了，先把這段思考收成一行
          pushFeed({ kind: 'tool', name: e.name, path: e.path });
        } else if (e.type === 'active' && e.path) {
          setActivePath(e.path);
          // 走到新的一格才記一筆 → 右 pane 的流向圖就是 agent 的足跡鏈
          if (visitedRef.current[visitedRef.current.length - 1] !== e.path) {
            visitedRef.current = [...visitedRef.current, e.path].slice(-40);
            setVisited(visitedRef.current);
          }
          // 回報 agent 現在在哪一格 → core 廣播 → 瀏覽器世界樹鏡頭飛過去
          if (wsRef.current?.readyState === 1) {
            wsRef.current.send(JSON.stringify({ type: 'agent_active', path: e.path }));
          }
        } else if (e.type === 'usage') {
          meterRef.current.add(e.usage);
          setTok(meterRef.current.snapshot());
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

      // MASL 關卡：agent 要改檔/跑指令前，開核准面板，等開發者 y/n
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
          : engine === 'local'
            ? createAgent({ llm: createLocalLLM({ baseURL: localCfg.baseURL, model: localCfg.model }), root: target, emit, onEvent, systemSuffix: LOCAL_DISCIPLINE, memory: createMemory({ root: target, model: localCfg.model }) })
            : engine === 'routed'
              ? createRoutedAgent({
                  root: target, model: modelArg, emit, onEvent,
                  baseURL: localCfg.baseURL, localModel: localCfg.model,
                  systemSuffix: LOCAL_DISCIPLINE,
                  sdkOpts: { getState, onGate, lastSaid },
                })
              : createSdkAgent({ root: target, model: modelArg, emit, onEvent, getState, onGate, lastSaid });

      if (DEMO) {
        setTimeout(() => runPrompt('fix the intermittent session failure bug'), 700);
      }
    })();
  }, []);

  // 量測全機 cache 浪費（背景跑 python，不擋 UI）
  function refreshSavings() {
    if (savingBusy) return;
    setSavingBusy(true);
    fetchSavings().then((s) => {
      if (s && s.ok) setSavings(s);
      setSavingBusy(false);
    }).catch(() => setSavingBusy(false));
  }

  // 開頭量一次，之後每 90 秒重量（cache 狀態會隨開發飄）
  useEffect(() => {
    refreshSavings();
    const t = setInterval(refreshSavings, 90 * 1000);
    return () => clearInterval(t);
  }, []);

  // 動畫節拍：光球沿著連線往下跑（右 pane 流向圖用）
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

  // 非 TTY（demo 自走 / CI）不開 raw mode，避免 Ink 崩潰
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === 'c') { core?.close(); app.exit(); process.exit(0); }
      // MASL 關卡待決：只收 y（放行）/ n（擋下），其餘鍵全部忽略，不讓 agent 偷跑
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
      // Ctrl+L：清掉 / 重新量測 cache 浪費。Cosmos 量給你看，實際釋放在你的 agent 終端機按 /clear。
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
      if (key.tab) { setView((v) => (v === 'split' ? 'tree' : 'split')); return; } // Tree View 隨時可切
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

  // ── transcript 單行 ──
  function feedLine(it, i) {
    if (it.kind === 'user') return h(Text, { key: i, color: 'cyan', wrap: 'truncate-end' }, '› ' + it.text);
    if (it.kind === 'tool') {
      const base = it.path ? it.path.split('/').pop() : '';
      const col = /edit|write/i.test(it.name) ? 'green' : 'blueBright';
      return h(Text, { key: i, color: col, wrap: 'truncate-end' }, '● ' + it.name + (base ? '  ' + base : ''));
    }
    return h(Text, { key: i, color: 'gray', wrap: 'truncate-end' }, it.text);
  }

  // ── 右 pane：流向圖。agent 走過的格子由上往下串成一條鏈，
  //    格子之間 100% 有線連著，最新那段線上有一顆光球往下跑 → 看得到流向跟順序。──
  function flowLines() {
    const shown = visited.slice(-10);
    const out = [];
    if (!shown.length) {
      out.push({ text: '(Not started yet. On your next', color: 'gray' });
      out.push({ text: ' prompt, it grows where the agent goes.)', color: 'gray' });
      return out;
    }
    const SEG = 3; // 每段連線畫幾列 → 光球在這幾列間移動
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
        const activeEdge = i === shown.length - 2; // 最新跳的那一段 → 光球在這段流動
        for (let r = 0; r < SEG; r++) {
          const ball = activeEdge && tick % SEG === r;
          out.push({ text: '  ' + (ball ? '●' : '│'), color: ball ? 'greenBright' : 'gray' });
        }
      }
    });
    return out;
  }

  // ── split view（預設）：左 transcript（終端機文字流），右流向圖 ──
  function splitView() {
    const flow = flowLines();
    const feedLines = feed.slice(-16);

    return h(
      Box,
      { flexDirection: 'row', marginTop: 1 },
      // 左：agent transcript（打字、文字一直往上捲，跟 CLI 一樣）
      h(Box, { flexDirection: 'column', flexGrow: 1, paddingRight: 1 },
        h(Text, { color: 'gray' }, 'agent'),
        feedLines.length ? feedLines.map((it, i) => feedLine(it, i))
          : h(Text, { color: 'gray' }, '(Nothing yet. Your next prompt takes you in.)'),
        thinking
          ? h(Text, { color: 'yellow', wrap: 'truncate-end' }, thinking)
          : busy ? h(Text, { color: 'yellow' }, 'Thinking…') : null,
      ),
      // 右：流向圖（agent 足跡鏈 + 光球）
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

  // ── token 橫欄：本次開發用掉 / 正在用 / 總計 + 全機可清掉的浪費 ──
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

  // ── MASL 攔截面板：待核准時蓋在輸入區上方，紅框、列爆炸範圍 ──
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

  return h(Box, { flexDirection: 'column', paddingX: 1 }, header, subhead, view === 'split' ? splitView() : treeView(), footer);
}

render(h(App));
