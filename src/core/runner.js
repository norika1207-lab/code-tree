// Agent runner（在 core 跑）。讓瀏覽器當主介面：網頁透過 WS 送 prompt，
// core 這邊跑 agent，把 agent 的每一步（思考文字 / 工具 / 改檔 / token / MASL 關卡）廣播回網頁。
// 這是「圖像編輯器」的後端脊椎：agent 不再綁在終端機 CLI 裡。
//
// makeAgent({ onEvent, emit, getState, onGate, lastSaid }) → { send(text) }
//   注入式，預設給 SDK agent；測試時可換 scripted agent（不燒 token）。
// broadcast(msg)：把訊息推給所有 WS client（CLI + 瀏覽器）。

// 即時 token 累加（input + output + cache write = 真的燒掉的；cache read 是省下的）
function makeMeter() {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turn = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    startTurn() { turn = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; },
    add(u) {
      if (!u) return;
      const i = u.input_tokens || 0, o = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
      total.input += i; total.output += o; total.cacheRead += cr; total.cacheWrite += cw;
      turn.input += i; turn.output += o; turn.cacheRead += cr; turn.cacheWrite += cw;
    },
    snapshot() {
      const burned = (b) => b.input + b.output + b.cacheWrite;
      return {
        total: { ...total, burned: burned(total), all: total.input + total.output + total.cacheRead + total.cacheWrite },
        turn: { ...turn, burned: burned(turn) },
      };
    },
  };
}

export function createRunner({ root, graph, broadcast, makeAgent }) {
  const meter = makeMeter();
  const gatePending = new Map(); // gateId -> resolve
  let lastSaidBuf = '';
  let agent = null;
  let busy = false;

  const onEvent = (e) => {
    if (e.type === 'text') {
      lastSaidBuf = (lastSaidBuf + e.delta).slice(-2000);
      broadcast({ type: 'agent_text', payload: { delta: e.delta } });
    } else if (e.type === 'tool') {
      broadcast({ type: 'agent_tool', payload: { name: e.name, path: e.path } });
    } else if (e.type === 'active' && e.path) {
      const abs = resolveAbs(e.path);
      const cell = graph.record(abs, 'active');
      broadcast({ type: 'active', payload: { path: cell.path, id: abs } });
      broadcast({ type: 'state', payload: graph.snapshot() });
    } else if (e.type === 'usage') {
      meter.add(e.usage);
      broadcast({ type: 'usage', payload: meter.snapshot() });
    } else if (e.type === 'error') {
      broadcast({ type: 'agent_error', payload: { message: e.message } });
    } else if (e.type === 'turn_end') {
      busy = false;
      broadcast({ type: 'agent_turn_end', payload: {} });
    }
  };

  const emit = (action, relPath) => {
    if (action === 'read') {
      const cell = graph.record(resolveAbs(relPath), 'read');
      broadcast({ type: 'activity', payload: { path: cell.path, action: 'read', ts: Date.now() } });
    }
    // modify / create 由 file watcher 抓，不重複送
  };

  const getState = () => graph.snapshot();
  const lastSaid = () => lastSaidBuf.trim().slice(-160);

  // MASL 關卡：要動手前先廣播 gate 給網頁，等網頁回 gate_reply
  const onGate = (report, agentSaid) => new Promise((resolve) => {
    const id = 'g_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);
    gatePending.set(id, resolve);
    broadcast({ type: 'gate', payload: { id, report, agentSaid } });
  });

  function resolveAbs(rel) {
    // agent 給的多半已是絕對路徑；相對的話補成專案內絕對路徑
    return rel.startsWith('/') ? rel : root.replace(/\/$/, '') + '/' + rel;
  }

  function ensureAgent() {
    if (!agent) agent = makeAgent({ onEvent, emit, getState, onGate, lastSaid });
    return agent;
  }

  async function run(text, id) {
    if (busy) { broadcast({ type: 'agent_error', payload: { message: '上一個 prompt 還在跑' } }); return; }
    busy = true;
    lastSaidBuf = '';
    meter.startTurn();
    graph.activePromptId = id || ('p_' + Date.now());
    broadcast({ type: 'prompt', payload: { id: graph.activePromptId, text, ts: Date.now() } });
    try {
      await ensureAgent().send(text);
    } catch (e) {
      busy = false;
      broadcast({ type: 'agent_error', payload: { message: e.message } });
      broadcast({ type: 'agent_turn_end', payload: {} });
    }
  }

  // 網頁回覆 MASL 關卡（放行 / 擋下）
  function replyGate(id, approve) {
    const resolve = gatePending.get(id);
    if (resolve) { gatePending.delete(id); resolve(!!approve); }
  }

  return { run, replyGate, get busy() { return busy; }, meterSnapshot: () => meter.snapshot() };
}
