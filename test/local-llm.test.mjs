// Local unit tests (no GPU): mock out fetch, feed vLLM-style OpenAI SSE,
// and verify all three translation layers of createLocalLLM are correct.
//   node test/local-llm.test.mjs
import assert from 'node:assert';
import { createLocalLLM, toOpenAITools, toOpenAIMessages, extractHermesToolCalls, extractJsonToolCalls, lenientRecover, computeConfidence } from '../src/cli/local-llm.js';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  pass++;
}

// Split a string into multiple chunks to simulate streaming (including tool_call arguments spanning chunks)
function sse(lines) {
  return lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('');
}
function streamResponse(text) {
  const enc = new TextEncoder();
  // Deliberately chop it up to flush out bugs in the accumulation logic
  const pieces = [];
  for (let i = 0; i < text.length; i += 7) pieces.push(text.slice(i, i + 7));
  return {
    ok: true,
    body: (async function* () {
      for (const p of pieces) yield enc.encode(p);
    })(),
    text: async () => '',
  };
}

// ── Test 1: tool schema conversion ──
{
  const TOOL_DEFS = [
    { name: 'read_file', description: '讀檔', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];
  const oa = toOpenAITools(TOOL_DEFS);
  ok('tools wrapped as function', oa[0].type === 'function');
  ok('tools name preserved', oa[0].function.name === 'read_file');
  ok('input_schema -> parameters', oa[0].function.parameters.required[0] === 'path');
}

// ── Test 2: message history conversion (including tool_use / tool_result) ──
{
  const system = 'you are a coding agent';
  const messages = [
    { role: 'user', content: '修 bug' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我先讀檔' },
        { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.js' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file body' }],
    },
  ];
  const oa = toOpenAIMessages(system, messages);
  ok('system goes first', oa[0].role === 'system');
  ok('user string passed through as-is', oa[1].role === 'user' && oa[1].content === '修 bug');
  const asst = oa.find((m) => m.role === 'assistant');
  ok('assistant text merged into content', asst.content.includes('我先讀檔'));
  ok('tool_use -> tool_calls', asst.tool_calls[0].id === 'tu_1' && asst.tool_calls[0].function.name === 'read_file');
  ok('arguments is a JSON string', JSON.parse(asst.tool_calls[0].function.arguments).path === 'a.js');
  const toolMsg = oa.find((m) => m.role === 'tool');
  ok('tool_result -> role tool', toolMsg.tool_call_id === 'tu_1' && toolMsg.content === 'file body');
}

// ── Test 3: plain text streaming -> end_turn ──
await (async () => {
  globalThis.fetch = async () => streamResponse(sse([
    { choices: [{ delta: { content: '你好' }, finish_reason: null }] },
    { choices: [{ delta: { content: '，世界' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]));
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm' });
  let streamed = '';
  const r = await llm.run({ system: 's', messages: [{ role: 'user', content: 'hi' }], tools: [], onText: (t) => (streamed += t) });
  ok('text block reassembled', r.content[0].type === 'text' && r.content[0].text === '你好，世界');
  ok('onText streamed', streamed === '你好，世界');
  ok('stop_reason end_turn', r.stop_reason === 'end_turn');
})();

// ── Test 4: tool_call streaming (arguments span chunks) -> tool_use ──
await (async () => {
  globalThis.fetch = async () => streamResponse(sse([
    { choices: [{ delta: { content: '讓我寫檔' }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'write_file', arguments: '{"path":"out' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '.js","content":"hi"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]));
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm' });
  const r = await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'write_file', input_schema: {} }] });
  ok('text + tool in same turn', r.content[0].type === 'text' && r.content.some((b) => b.type === 'tool_use'));
  const tu = r.content.find((b) => b.type === 'tool_use');
  ok('tool_use id preserved', tu.id === 'call_9' && tu.name === 'write_file');
  ok('arguments reassembled across chunks', tu.input.path === 'out.js' && tu.input.content === 'hi');
  ok('stop_reason tool_use', r.stop_reason === 'tool_use');
})();

// ── Test 5: Hermes template fallback (ollama streaming emits <tool_call> as plain text) ──
{
  const leaked = '我來讀檔。\n<tool_call>\n{"name":"read_file","arguments":{"path":"config.json"}}\n</tool_call>';
  const r = extractHermesToolCalls(leaked);
  ok('tool name extracted', r.calls[0].name === 'read_file');
  ok('arguments extracted', r.calls[0].input.path === 'config.json');
  ok('template stripped, clean text remains', r.cleaned === '我來讀檔。');
}

// ── Test 6: Hermes fallback in streaming mode (opening tag chopped up) through a full run() ──
await (async () => {
  globalThis.fetch = async () => streamResponse(sse([
    { choices: [{ delta: { content: '讓我看看。\n' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'call>\n{"name":"write_file","arguments":{"path":"a.js","content":"x"}}\n</tool_' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'call>' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]));
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm' });
  const r = await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'write_file', input_schema: {} }] });
  const tu = r.content.find((b) => b.type === 'tool_use');
  ok('fallback works on the streaming path', !!tu && tu.name === 'write_file' && tu.input.path === 'a.js');
  ok('fallback triggers stop_reason tool_use', r.stop_reason === 'tool_use');
  const txt = r.content.find((b) => b.type === 'text');
  ok('fallback keeps leading text', txt && txt.text === '讓我看看。');
})();

// ── Test 7: bare JSON / ```json tool-call fallback (how qwen2.5-coder emits them) ──
{
  const fenced = '好的，讓我先查看。\n```json\n{\n  "name": "list_dir",\n  "arguments": {"path": "src"}\n}\n```';
  const r = extractJsonToolCalls(fenced, ['list_dir', 'read_file']);
  ok('fenced JSON extracts the tool', r.calls[0].name === 'list_dir' && r.calls[0].input.path === 'src');
  ok('fence stripped, text remains', r.cleaned === '好的，讓我先查看。');

  const bare = '{"name":"read_file","arguments":{"path":"a.js"}}';
  const r2 = extractJsonToolCalls(bare, ['read_file']);
  ok('bare JSON extracts the tool', r2.calls[0].name === 'read_file' && r2.calls[0].input.path === 'a.js');

  // JSON whose name isn't a known tool should not be misread as a tool call
  const notCall = '這是答案：{"name":"小明","arguments":"無關"}';
  const r3 = extractJsonToolCalls(notCall, ['read_file']);
  ok('non-tool-name JSON not misclassified', r3.calls.length === 0);
}

// ── Test 8: streaming emits a ```json tool call, through a full run() ──
await (async () => {
  globalThis.fetch = async () => streamResponse(sse([
    { choices: [{ delta: { content: '先看目錄。\n```json\n{"name":"list_dir",' }, finish_reason: null }] },
    { choices: [{ delta: { content: '"arguments":{"path":"src"}}\n```' }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    '[DONE]',
  ]));
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm' });
  const r = await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [{ name: 'list_dir', input_schema: {} }] });
  const tu = r.content.find((b) => b.type === 'tool_use');
  ok('streaming fenced-JSON fallback works', !!tu && tu.name === 'list_dir' && tu.input.path === 'src');
  ok('streaming fence triggers tool_use', r.stop_reason === 'tool_use');
})();

// ── Test 9: backend 5xx (bad tool-call JSON) retries, then catches the next success ──
await (async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500, text: async () => '{"error":{"message":"error parsing tool call"}}' };
    return streamResponse(sse([
      { choices: [{ delta: { content: '好了' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]));
  };
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm', maxRetries: 2 });
  const r = await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [] });
  ok('retry succeeds after 5xx', calls === 2 && r.content[0]?.text === '好了');
})();

// ── Test 10: 4xx does not retry, throws immediately ──
await (async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' }; };
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm', maxRetries: 2 });
  let threw = false;
  try { await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [] }); }
  catch { threw = true; }
  ok('4xx throws without retrying', threw && calls === 1);
})();

// ── Test 11: lenient recovery — content has unescaped newlines so strict parse blows up, but write_file is still recovered ──
{
  const bad = '{"name": "write_file", "arguments": {"path": "src/auth.js", "content": "line1\nline2"}}';
  assert.throws(() => JSON.parse(bad)); // confirm strict parse really does fail
  const r = lenientRecover(bad, new Set(['write_file']));
  ok('lenient recovery gets write_file name', r && r.call.name === 'write_file');
  ok('lenient recovery gets the right path', r.call.input.path === 'src/auth.js');
  ok('lenient recovery restores newlines', r.call.input.content === 'line1\nline2');
}

// ── Test 12: lenient recovery — a write_file truncated by max_tokens (content never closes) is still recovered ──
{
  const truncated = '{"name":"write_file","arguments":{"path":"a.js","content":"import x from \'y\';\nconst z = 1; // 還沒寫完就被截';
  const r = lenientRecover(truncated, new Set(['write_file']));
  ok('truncated write_file still recovered', r && r.call.name === 'write_file' && r.call.input.path === 'a.js');
  ok('truncated content taken as a whole', r.call.input.content.includes('import x'));
}

// ── Test 13: model misuses a hidden edit_file but passes content, remapped to write_file ──
{
  const wrong = '{"name":"edit_file","arguments":{"path":"src/m.js","content":"export const a = 1;"}}';
  const r = lenientRecover(wrong, new Set(['write_file'])); // edit_file is not in the known set
  ok('edit_file+content remapped to write_file', r && r.call.name === 'write_file');
  ok('remap preserves path/content', r.call.input.path === 'src/m.js' && r.call.input.content === 'export const a = 1;');
}

// ── Test 14: an ordinary JSON answer (no tool name) is not misread as a tool call ──
{
  const plain = '{"answer": 42, "reason": "because"}';
  ok('pure-data JSON not misclassified', lenientRecover(plain, new Set(['write_file'])) === null);
}

// ── Test 15: extractJsonToolCalls chained with lenient recovery — a bad-JSON write_file call recovered through the whole chain ──
{
  const text = '我來修這個檔：\n{"name": "write_file", "arguments": {"path": "f.js", "content": "a\nb\nc"}}';
  const { calls } = extractJsonToolCalls(text, ['write_file']);
  ok('parse chain ultimately recovers bad-JSON write_file', calls.length === 1 && calls[0].name === 'write_file' && calls[0].input.content === 'a\nb\nc');
}

// ── Test 16: computeConfidence — a tool was actually emitted, wantedToolMass=1, hadTool=true ──
{
  const c = computeConfidence([-0.1, -0.2], { token: '{', logprob: -0.1, top: [] }, true);
  ok('confidence flags correct when a tool call exists', c.hadTool === true && c.wantedToolMass === 1 && c.nTokens === 2);
}

// ── Test 17: narrate-instead-of-call — no tool was called, but { has notable mass among the first token's candidates ──
{
  // The first token sampled prose, but the top candidates include '{' (logprob -0.7 ≈ 0.50 mass) and '```' (-2.3 ≈ 0.10)
  const firstTok = { token: 'I', logprob: -1.2, top: [
    { token: 'I', logprob: -1.2 }, { token: '{', logprob: -0.7 }, { token: '```', logprob: -2.3 },
  ] };
  const c = computeConfidence([-1.2, -0.5], firstTok, false);
  ok('with no tool call, wantedToolMass captures the mass of { and ```', c.hadTool === false && c.wantedToolMass > 0.55 && c.wantedToolMass < 0.65);
}

// ── Test 18: empty logprobs (disabled or not returned by the backend) — returns null fields without crashing ──
{
  const c = computeConfidence([], null, false);
  ok('safe fallback when no logprobs', c.nTokens === 0 && c.meanLogprob === null && c.minLogprob === null && c.wantedToolMass === 0);
}

console.log(`\n全部通過：${pass} 項`);
