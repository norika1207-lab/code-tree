// 本地 code LLM 接線。對 agent.js 維持跟 createClaudeLLM 一模一樣的 run() 合約：
//   run({ system, messages, tools, onText }) -> { content: [blocks], stop_reason }
// 底下講的是 OpenAI 相容協定（vLLM / llama.cpp server 都吃這套），
// 所以這支檔案的工作就是三道翻譯：
//   1) Anthropic 工具定義 (input_schema)  ->  OpenAI tools (function.parameters)
//   2) Anthropic 訊息歷史 (text / tool_use / tool_result blocks) <-> OpenAI messages
//   3) OpenAI 串流 SSE (choices[].delta) -> Anthropic content blocks (text + tool_use)
//
// 這層通了，CLI 的腦就能換成本機模型，一個 Anthropic call 都不打。

// 本機模型第一次呼叫會冷載入權重進記憶體，server 遲遲不送 header，
// 會踩到 Node fetch 預設的 headers timeout。給一個寬鬆的 dispatcher 擋住這件事。
let _dispatcher = null;
async function bigTimeoutDispatcher(ms) {
  if (_dispatcher !== null) return _dispatcher;
  try {
    const { Agent } = await import('undici');
    _dispatcher = new Agent({ headersTimeout: ms, bodyTimeout: ms, keepAliveTimeout: 60000 });
  } catch {
    _dispatcher = undefined; // 拿不到 undici 就用預設 fetch
  }
  return _dispatcher;
}

export function createLocalLLM({
  baseURL = 'http://localhost:8000/v1',
  model = 'qwen-coder',
  maxTokens = 8000,
  apiKey = 'local',
  timeoutMs = 600000, // 冷載入 + 長生成的寬限：10 分鐘
  maxRetries = 2,     // 後端 5xx（常是模型吐壞 tool-call JSON）時重抽樣次數
  logprobs = false,   // 開了就跟後端要 per-token logprobs，回傳物件多帶 confidence（路由/halting 用）
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
      // Mercury T_A 的可路由蒸餾：不建整張 sensor grid，只取決策點的 token 信心。
      // ollama 的 /v1/chat/completions 串流會在 delta.logprobs.content[] 帶 per-token logprob + top_logprobs。
      if (logprobs) { body.logprobs = true; body.top_logprobs = topLogprobs; }
      const toolNames = oaTools.map((t) => t.function.name);
      if (oaTools.length) {
        body.tools = oaTools;
        // 小模型常「narrate 完就收工」不肯真的呼叫工具。需要時上層可傳 toolChoice='required'
        // 強迫這一回合一定要吐工具呼叫，把光說不做頂回行動。預設 'auto'。
        body.tool_choice = toolChoice || 'auto';
      }

      const dispatcher = await bigTimeoutDispatcher(timeoutMs);
      // 小模型偶爾吐出壞掉的 tool-call JSON，後端會回 5xx。重抽樣通常就好了，
      // 單一壞回合不該炸掉整個 session。5xx 重試幾次，再不行才丟出去。
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
        lastErr = `本地 LLM ${res.status}: ${txt.slice(0, 300)}`;
        // 4xx 是請求本身的問題，重試沒用，直接丟
        if (res.status < 500 || attempt === maxRetries) throw new Error(lastErr);
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
      throw new Error(lastErr);
    },
  };
}

// ── 1) 工具定義轉換 ──────────────────────────────────────────────
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

// ── 2) 訊息歷史轉換 ──────────────────────────────────────────────
// Anthropic 一則訊息的 content 可能是字串，或 blocks 陣列：
//   assistant: [{type:'text',text}, {type:'tool_use', id, name, input}]
//   user:      [{type:'tool_result', tool_use_id, content}]  (工具回傳)
// OpenAI 對應：
//   assistant 帶 tool_use -> { role:'assistant', content, tool_calls:[{id,type,function:{name,arguments}}] }
//   tool_result           -> { role:'tool', tool_call_id, content }
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

    // user role：可能夾帶 tool_result blocks，每個 tool_result 在 OpenAI 是獨立的一則 tool 訊息
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

// ── 3) OpenAI 串流 SSE -> Anthropic blocks ───────────────────────
// OpenAI delta 形狀：choices[0].delta = { content?, tool_calls?:[{index,id?,function:{name?,arguments?}}] }
// tool_call 的 arguments 是分段的 JSON 字串，要按 index 累積拼回。
// finish_reason: 'tool_calls' -> stop_reason 'tool_use'；'stop'/'length' -> 'end_turn'
async function parseOpenAISSE(res, onText, toolNames = []) {
  const decoder = new TextDecoder();
  let buf = '';
  let textBlock = null;          // { type:'text', text }
  const toolCalls = [];          // 依 OpenAI index 對齊：{ id, name, _args }
  let finishReason = null;
  const tokenLps = [];           // 這一回合每個 content token 的 logprob（信心軌跡）
  let firstTok = null;           // 第一個 content token 的分佈：narrate-vs-call 的決策點

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

      // logprobs 抽取：累積 token 信心，並記住第一個 content token 的 top 候選分佈
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

  // 後備鏈：不同模型在 ollama 會用不同形狀把工具呼叫吐成純文字。
  //   (a) Hermes 模板 <tool_call>{...}</tool_call>（qwen 串流）
  //   (b) 裸 JSON 或 ```json {"name","arguments"} ```（qwen2.5-coder）
  // 沒拿到結構化工具時，依序試著從文字挖出來，並把那段從可見文字剝掉。
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

// 把這一回合的 token logprobs 蒸餾成路由/halting 用的信心摘要。
// 這就是 Mercury T_A「讀輸出層 logits」對 coding agent 的可用版：不存整張 grid，
// 只取決策點的 token 信心。重點兩個：
//   wantedToolMass = 第一個 content token 的候選裡，落在「{ 開頭（JSON/工具呼叫起手式）」的機率質量。
//     narrate-instead-of-call 的核心就是這裡：模型其實想呼叫（{ 有可觀質量），卻抽到散文 token。
//   meanLogprob / minLogprob = 整段生成的信心，越接近 0 越篤定，很負代表它在亂掰。
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
    if (!hasTool) wantedToolMass = m; // 沒真的呼叫工具時，這個質量才有診斷意義
  }
  return { nTokens: n, meanLogprob: mean, minLogprob: min, wantedToolMass, firstToken, hadTool: hasTool };
}

function genId() {
  return 'local_' + Math.random().toString(36).slice(2, 10);
}

// 從含 Hermes 模板的文字挖出工具呼叫。開頭的 <tool_call> 標籤在某些後端會被
// 切碎或漏掉，所以只靠結尾的 </tool_call> 切段，往前抓第一個平衡的 {...} 當 JSON。
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
        } catch { /* 不是合法 JSON，當普通文字 */ }
      }
    }
    // 把 <tool_call>...</tool_call> 這段（含可能被切碎的開頭）從文字剝掉
    let cutFrom = idx;
    if (parsedOk) {
      const openIdx = before.lastIndexOf('<tool_call>');
      if (openIdx !== -1) {
        cutFrom = openIdx;
      } else {
        // 開頭標籤被後端切碎（出現 "...call>" 殘骸），連那一行一起剝掉
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

// 後備 (b)：模型把工具呼叫當裸 JSON 或 ```json 區塊吐在文字裡（qwen2.5-coder 這樣幹）。
// 只在 JSON 物件同時有 name（且 name 是真工具）跟 arguments 時才認定是工具呼叫，
// 避免把正常的 JSON 回答誤判成工具。挖出後把那段從可見文字剝掉。
export function extractJsonToolCalls(text, toolNames = []) {
  const calls = [];
  let cleaned = text;
  const known = new Set(toolNames);
  const isCall = (j) => j && typeof j.name === 'string' && 'arguments' in j &&
    (known.size === 0 || known.has(j.name));

  // 先掃 ```...``` 圍欄區塊
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
    } catch { /* 不是合法 JSON */ }
  }
  for (const seg of toRemove) cleaned = cleaned.replace(seg, '');

  // 沒圍欄，再試整段裸 JSON
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
        } catch { /* 略過，交給寬容復原 */ }
      }
    }
  }

  // 寬容復原（最後手段）：模型常把寫檔呼叫吐成「對的 tool-call 形狀但 JSON 不合法」——
  // content 裡的程式碼沒跳脫換行/引號、或整段被 max_tokens 截斷收不了尾，嚴格 parse 全炸。
  // 但 name/path/content 用 regex 挖得出來。只認寫/讀檔工具，挖到就救回，寫檔有 verify 守門。
  if (!calls.length) {
    const r = lenientRecover(cleaned, known);
    if (r) { calls.push(r.call); cleaned = r.cleaned; }
  }
  return { calls, cleaned: cleaned.trim() };
}

// 從「tool-call 形狀但不合法/被截斷」的文字裡硬挖一個寫檔或讀檔呼叫出來。
export function lenientRecover(text, known = new Set()) {
  const s = String(text || '');
  const nameM = s.match(/"name"\s*:\s*"([a-zA-Z_]+)"/);
  if (!nameM) return null;
  let name = nameM[1];
  // 模型常誤用我們藏掉的 edit_file，且塞 content（write_file 的 schema）。重映射成 write_file。
  const unesc = (v) => v.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const pathM = s.match(/"path"\s*:\s*"((?:\\.|[^"\\])*)"/);
  const path = pathM ? unesc(pathM[1]) : undefined;
  // content：從 "content":" 之後抓到最後一個未跳脫的 " 為止（容忍中間有未跳脫換行）
  let content;
  const ci = s.search(/"content"\s*:\s*"/);
  if (ci !== -1) {
    const vStart = s.indexOf('"', s.indexOf(':', ci) + 1) + 1;
    let end = -1, i = vStart;
    while (i < s.length) {
      if (s[i] === '\\') { i += 2; continue; }
      if (s[i] === '"') end = i; // 記住最後一個引號（截斷時抓不到收尾就用最後一個）
      i++;
    }
    if (end > vStart) content = unesc(s.slice(vStart, end));
    else if (vStart < s.length) content = unesc(s.slice(vStart)); // 被截斷，整段拿來（verify 會擋壞檔）
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

// 從 str[start] 的 '{' 起抓出平衡括號的子字串（夠用版，忽略字串內括號的極端情況）
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
