// Agent runner (runs in core). Lets the browser act as the main UI: the web page sends a prompt over WS,
// core runs the agent here and broadcasts each of the agent's steps (thinking text / tool / file edit / token / MASL gate) back to the page.
// This is the backend spine of the "graphical editor": the agent is no longer tied to the terminal CLI.
//
// makeAgent({ onEvent, emit, getState, onGate, lastSaid }) → { send(text) }
//   Injectable; defaults to the SDK agent, swappable for a scripted agent in tests (burns no token).
// broadcast(msg): push a message to all WS clients (CLI + browser).

// Live token accumulation (input + output + cache write = what's actually burned; cache read is what's saved)
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
    // modify / create are caught by the file watcher, so don't send them again
  };

  const getState = () => graph.snapshot();
  const lastSaid = () => lastSaidBuf.trim().slice(-160);

  // MASL gate: before taking action, broadcast the gate to the page and wait for its gate_reply
  const onGate = (report, agentSaid) => new Promise((resolve) => {
    const id = 'g_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);
    gatePending.set(id, resolve);
    broadcast({ type: 'gate', payload: { id, report, agentSaid } });
  });

  function resolveAbs(rel) {
    // What the agent gives is usually already absolute; if relative, expand it to an in-project absolute path
    return rel.startsWith('/') ? rel : root.replace(/\/$/, '') + '/' + rel;
  }

  function ensureAgent() {
    if (!agent) agent = makeAgent({ onEvent, emit, getState, onGate, lastSaid });
    return agent;
  }

  async function run(text, id) {
    if (busy) { broadcast({ type: 'agent_error', payload: { message: 'previous prompt is still running' } }); return; }
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

  // The page replies to the MASL gate (allow / block)
  function replyGate(id, approve) {
    const resolve = gatePending.get(id);
    if (resolve) { gatePending.delete(id); resolve(!!approve); }
  }

  return { run, replyGate, get busy() { return busy; }, meterSnapshot: () => meter.snapshot() };
}
