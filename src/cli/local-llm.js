// Local code LLM adapter. Keeps the exact same run() contract as createClaudeLLM for agent.js:
//   run({ system, messages, tools, onText }) -> { content: [blocks], stop_reason }
// Underneath it speaks the OpenAI-compatible protocol (both vLLM and llama.cpp server accept it),
// so this file's whole job is three translations:
//   1) Anthropic tool defs (input_schema)  ->  OpenAI tools (function.parameters)
//   2) Anthropic message history (text / tool_use / tool_result blocks) <-> OpenAI messages
//   3) OpenAI streaming SSE (choices[].delta) -> Anthropic content blocks (text + tool_use)
//
// Once this layer works, the CLI's brain can be swapped to a local model without making a single Anthropic call.

// On the first call a local model cold-loads its weights into memory, so the server is slow to send
// headers and trips Node fetch's default headers timeout. Use a relaxed dispatcher to avoid that.
let _dispatcher = null;
async function bigTimeoutDispatcher(ms) {
  if (_dispatcher !== null) return _dispatcher;
  try {
    const { Agent } = await import('undici');
    _dispatcher = new Agent({ headersTimeout: ms, bodyTimeout: ms, keepAliveTimeout: 60000 });
  } catch {
    _dispatcher = undefined; // fall back to default fetch if undici isn't available
  }
  return _dispatcher;
}

export function createLocalLLM({
  baseURL = 'http://localhost:8000/v1',
  model = 'qwen-coder',
  maxTokens = 8000,
  apiKey = 'local',
  timeoutMs = 600000, // grace for cold load + long generation: 10 minutes
  maxRetries = 2,     // resample count on backend 5xx (often the model emitting bad tool-call JSON)
  logprobs = false,   // when on, ask the backend for per-token logprobs; the result carries confidence (for routing/halting)
  topLogprobs = 5,
} = {}) {
  const endpoint = baseURL.replace(/\/$/, '') + '/chat/completions';
  return {
    async run({ system, messages, tools, onText, toolChoice }) {
      const oaMessages = toOpenAIMessages(system, messages);
      const oaTools = toOpenAITools(tools);
      const body = {
        model,
        max_tokens: maxTokens,
        messages: oaMessages,
        stream: true,
      };
      // Routable distillation of Mercury T_A: don't build the whole sensor grid, just grab token confidence at decision points.
      // ollama's /v1/chat/completions stream carries per-token logprob + top_logprobs in delta.logprobs.content[].
      if (logprobs) { body.logprobs = true; body.top_logprobs = topLogprobs; }
      const toolNames = oaTools.map((t) => t.function.name);
      if (oaTools.length) {
        body.tools = oaTools;
        // Small models often "narrate then stop" instead of actually calling a tool. When needed the caller can pass
        // toolChoice='required' to force a tool call this turn, pushing all-talk-no-action back into action. Defaults to 'auto'.
        body.tool_choice = toolChoice || 'auto';
      }

      const dispatcher = await bigTimeoutDispatcher(timeoutMs);
      // Small models occasionally emit broken tool-call JSON and the backend returns a 5xx. Resampling usually fixes it,
      // and a single bad turn shouldn't blow up the whole session. Retry a few times on 5xx, then give up and throw.
      let lastErr = '';
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          ...(dispatcher ? { dispatcher } : {}),
        });
        if (res.ok) return await parseOpenAISSE(res, onText, toolNames);
        const txt = await res.text().catch(() => '');
        lastErr = `Local LLM ${res.status}: ${txt.slice(0, 300)}`;
        // a 4xx is a problem with the request itself; retrying won't help, so throw immediately
        if (res.status < 500 || attempt === maxRetries) throw new Error(lastErr);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      throw new Error(lastErr);
    },
  };
}

// ── 1) Tool definition conversion ───────────────────────────────
// Anthropic: { name, description, input_schema }
// OpenAI:    { type:'function', function:{ name, description, parameters } }
export function toOpenAITools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

// ── 2) Message history conversion ───────────────────────────────
// An Anthropic message's content can be a string or an array of blocks:
//   assistant: [{type:'text',text}, {type:'tool_use', id, name, input}]
//   user:      [{type:'tool_result', tool_use_id, content}]  (tool output)
// OpenAI equivalents:
//   assistant with tool_use -> { role:'assistant', content, tool_calls:[{id,type,function:{name,arguments}}] }
//   tool_result             -> { role:'tool', tool_call_id, content }
export function toOpenAIMessages(system, messages) {
  const out = [];
  if (system) {
    const sysText = Array.isArray(system)
      ? system.map((s) => (typeof s === 'string' ? s : s.text || '')).join('\n')
      : String(system);
    if (sysText.trim()) out.push({ role: 'system', content: sysText });
  }

  for (const m of messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const toolUses = blocks.filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant', content: text || '' };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function',
          function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
        }));
      }
      out.push(msg);
      continue;
    }

    // user role: may carry tool_result blocks; in OpenAI each tool_result is its own separate tool message
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    const textParts = blocks.filter((b) => b.type === 'text').map((b) => b.text);
    if (toolResults.length) {
      for (const tr of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: typeof tr.content === 'string'
            ? tr.content
            : Array.isArray(tr.content)
              ? tr.content.map((c) => c.text || '').join('')
              : String(tr.content ?? ''),
        });
      }
    }
    if (textParts.length) out.push({ role: 'user', content: textParts.join('') });
  }
  return out;
}

// ── 3) OpenAI streaming SSE -> Anthropic blocks ─────────────────
// OpenAI delta shape: choices[0].delta = { content?, tool_calls?:[{index,id?,function:{name?,arguments?}}] }
// A tool_call's arguments arrive as a chunked JSON string that must be accumulated by index and stitched back together.
// finish_reason: 'tool_calls' -> stop_reason 'tool_use'; 'stop'/'length' -> 'end_turn'
async function parseOpenAISSE(res, onText, toolNames = []) {
  const decoder = new TextDecoder();
  let buf = '';
  let textBlock = null;          // { type:'text', text }
  const toolCalls = [];          // aligned by OpenAI index: { id, name, _args }
  let finishReason = null;
  const tokenLps = [];           // logprob of every content token this turn (confidence trace)
  let firstTok = null;           // distribution of the first content token: the narrate-vs-call decision point

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const payload = dataLine.slice(5).trim();
      if (payload === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }

      const choice = ev.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        if (!textBlock) textBlock = { type: 'text', text: '' };
        textBlock.text += delta.content;
        onText?.(delta.content);
      }

      // logprobs extraction: accumulate token confidence and remember the top-candidate distribution of the first content token
      for (const lp of choice.logprobs?.content || []) {
        if (typeof lp.logprob === 'number') tokenLps.push(lp.logprob);
        if (!firstTok) {
          firstTok = {
            token: lp.token,
            logprob: lp.logprob,
            top: (lp.top_logprobs || []).map((t) => ({ token: t.token, logprob: t.logprob })),
          };
        }
      }

      for (const tc of delta.tool_calls || []) {
        const idx = tc.index ?? 0;
        if (!toolCalls[idx]) toolCalls[idx] = { id: null, name: '', _args: '' };
        const slot = toolCalls[idx];
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot._args += tc.function.arguments;
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  const content = [];
  const structured = toolCalls.filter(Boolean);

  // Fallback chain: different models on ollama emit tool calls as plain text in different shapes.
  //   (a) Hermes template <tool_call>{...}</tool_call> (qwen streaming)
  //   (b) bare JSON or ```json {"name","arguments"} ``` (qwen2.5-coder)
  // When no structured tool call arrives, try each extractor in order and strip that span from the visible text.
  let fallback = [];
  if (!structured.length && textBlock) {
    if (textBlock.text.includes('</tool_call>')) {
      const r = extractHermesToolCalls(textBlock.text);
      fallback = r.calls;
      textBlock.text = r.cleaned;
    }
    if (!fallback.length) {
      const r = extractJsonToolCalls(textBlock.text, toolNames);
      fallback = r.calls;
      textBlock.text = r.cleaned;
    }
  }

  if (textBlock && textBlock.text.trim()) content.push({ type: 'text', text: textBlock.text });
  for (const tc of structured) {
    let input = {};
    try { input = JSON.parse(tc._args || '{}'); } catch { input = {}; }
    content.push({ type: 'tool_use', id: tc.id || genId(), name: tc.name, input });
  }
  for (const fb of fallback) {
    content.push({ type: 'tool_use', id: genId(), name: fb.name, input: fb.input });
  }

  const hasTool = structured.length > 0 || fallback.length > 0;
  const stop_reason = finishReason === 'tool_calls' || hasTool ? 'tool_use' : 'end_turn';
  const confidence = computeConfidence(tokenLps, firstTok, hasTool);
  return { content, stop_reason, confidence };
}

// Distill this turn's token logprobs into a confidence summary for routing/halting.
// This is the usable version of Mercury T_A "reading the output-layer logits" for a coding agent: don't store the whole grid,
// just grab token confidence at decision points. Two things matter:
//   wantedToolMass = within the first content token's candidates, the probability mass on a "{ opener (JSON/tool-call start)".
//     This is the core of narrate-instead-of-call: the model actually wanted to call (the { has sizable mass) but sampled a prose token.
//   meanLogprob / minLogprob = confidence over the whole generation; closer to 0 means more certain, very negative means it's making things up.
export function computeConfidence(tokenLps, firstTok, hasTool) {
  const n = tokenLps.length;
  const mean = n ? tokenLps.reduce((a, b) => a + b, 0) / n : null;
  const min = n ? Math.min(...tokenLps) : null;
  let wantedToolMass = hasTool ? 1 : 0;
  let firstToken = null;
  if (firstTok) {
    firstToken = { token: firstTok.token, logprob: firstTok.logprob };
    const cands = firstTok.top && firstTok.top.length ? firstTok.top : [{ token: firstTok.token, logprob: firstTok.logprob }];
    let m = 0;
    for (const c of cands) {
      const t = String(c.token || '').trim();
      if (t.startsWith('{') || t.startsWith('```') || t === '{"') m += Math.exp(c.logprob);
    }
    if (!hasTool) wantedToolMass = m; // this mass is only diagnostically meaningful when no tool was actually called
  }
  return { nTokens: n, meanLogprob: mean, minLogprob: min, wantedToolMass, firstToken, hadTool: hasTool };
}

function genId() {
  return 'local_' + Math.random().toString(36).slice(2, 10);
}

// Extract tool calls from text containing the Hermes template. Some backends chop up or drop the opening
// <tool_call> tag, so we split only on the closing </tool_call> and scan backward for the first balanced {...} as JSON.
export function extractHermesToolCalls(text) {
  const calls = [];
  let cleaned = text;
  const closeTag = '</tool_call>';
  let idx;
  while ((idx = cleaned.indexOf(closeTag)) !== -1) {
    const before = cleaned.slice(0, idx);
    const braceStart = before.indexOf('{');
    let parsedOk = false;
    if (braceStart !== -1) {
      const obj = balancedSlice(before, braceStart);
      if (obj) {
        try {
          const j = JSON.parse(obj);
          if (j && j.name) {
            calls.push({ name: j.name, input: j.arguments ?? j.parameters ?? {} });
            parsedOk = true;
          }
        } catch { /* not valid JSON, treat as ordinary text */ }
      }
    }
    // strip the <tool_call>...</tool_call> span (including a possibly chopped-up opener) from the text
    let cutFrom = idx;
    if (parsedOk) {
      const openIdx = before.lastIndexOf('<tool_call>');
      if (openIdx !== -1) {
        cutFrom = openIdx;
      } else {
        // the opening tag was chopped up by the backend (a "...call>" remnant appears); strip that whole line too
        const frag = before.lastIndexOf('call>');
        if (frag !== -1 && braceStart - frag < 40) {
          const nl = before.lastIndexOf('\n', frag);
          cutFrom = nl !== -1 ? nl : frag;
        } else {
          const nl = before.lastIndexOf('\n', braceStart);
          cutFrom = nl !== -1 ? nl : braceStart;
        }
      }
    }
    cleaned = cleaned.slice(0, cutFrom) + cleaned.slice(idx + closeTag.length);
  }
  return { calls, cleaned: cleaned.trim() };
}

// Fallback (b): the model emits the tool call as bare JSON or a ```json block in the text (qwen2.5-coder does this).
// Only treat a JSON object as a tool call when it has both name (and the name is a real tool) and arguments,
// to avoid mistaking a normal JSON answer for a tool. Once extracted, strip that span from the visible text.
export function extractJsonToolCalls(text, toolNames = []) {
  const calls = [];
  let cleaned = text;
  const known = new Set(toolNames);
  const isCall = (j) => j && typeof j.name === 'string' && 'arguments' in j &&
    (known.size === 0 || known.has(j.name));

  // first scan ```...``` fenced blocks
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  const toRemove = [];
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1].trim();
    const start = inner.indexOf('{');
    if (start === -1) continue;
    const obj = balancedSlice(inner, start);
    if (!obj) continue;
    try {
      const j = JSON.parse(obj);
      if (isCall(j)) {
        calls.push({ name: j.name, input: j.arguments ?? {} });
        toRemove.push(m[0]);
      }
    } catch { /* not valid JSON */ }
  }
  for (const seg of toRemove) cleaned = cleaned.replace(seg, '');

  // no fence, then try the whole thing as bare JSON
  if (!calls.length) {
    const start = cleaned.indexOf('{');
    if (start !== -1) {
      const obj = balancedSlice(cleaned, start);
      if (obj) {
        try {
          const j = JSON.parse(obj);
          if (isCall(j)) {
            calls.push({ name: j.name, input: j.arguments ?? {} });
            cleaned = cleaned.slice(0, start) + cleaned.slice(start + obj.length);
          }
        } catch { /* skip, leave it to lenient recovery */ }
      }
    }
  }

  // Lenient recovery (last resort): the model often emits a write call in "the right tool-call shape but invalid JSON" ——
  // code inside content with unescaped newlines/quotes, or the whole thing truncated by max_tokens with no closing brace, all of which break strict parsing.
  // But name/path/content can still be dug out with regex. Only recognize write/read tools; recover what's found, and writes are guarded by verify.
  if (!calls.length) {
    const r = lenientRecover(cleaned, known);
    if (r) { calls.push(r.call); cleaned = r.cleaned; }
  }
  return { calls, cleaned: cleaned.trim() };
}

// Forcibly dig a write or read call out of text that's "in tool-call shape but invalid/truncated".
export function lenientRecover(text, known = new Set()) {
  const s = String(text || '');
  const nameM = s.match(/"name"\s*:\s*"([a-zA-Z_]+)"/);
  if (!nameM) return null;
  let name = nameM[1];
  // the model often misuses the edit_file we've hidden and stuffs in content (write_file's schema). Remap to write_file.
  const unesc = (v) => v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const pathM = s.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const path = pathM ? unesc(pathM[1]) : undefined;
  // content: grab from after "content":" up to the last unescaped " (tolerating unescaped newlines in between)
  let content;
  const ci = s.search(/"content"\s*:\s*"/);
  if (ci !== -1) {
    const vStart = s.indexOf('"', s.indexOf(':', ci) + 1) + 1;
    let end = -1, i = vStart;
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '"') end = i; // remember the last quote (if truncated and the closer is missing, fall back to the last one)
      i++;
    }
    if (end > vStart) content = unesc(s.slice(vStart, end));
    else if (vStart < s.length) content = unesc(s.slice(vStart)); // truncated, take the whole rest (verify will block a broken file)
  }

  const isWrite = name === 'write_file' || (name === 'edit_file' && content != null);
  const isRead = name === 'read_file';
  if (isWrite) {
    if (path == null || content == null) return null;
    return { call: { name: 'write_file', input: { path, content } }, cleaned: '' };
  }
  if (isRead && (known.size === 0 || known.has('read_file'))) {
    if (path == null) return null;
    return { call: { name: 'read_file', input: { path } }, cleaned: '' };
  }
  return null;
}

// From the '{' at str[start], extract the balanced-brace substring (good-enough version, ignores the edge case of braces inside strings)
function balancedSlice(str, start) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}
