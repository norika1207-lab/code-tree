// 本機單元測試（無 GPU）：mock 掉 fetch，餵 vLLM 風格的 OpenAI SSE，
// 驗 createLocalLLM 的三道翻譯都對。
//   node test/local-llm.test.mjs
import assert from 'node:assert';
import { createLocalLLM, toOpenAITools, toOpenAIMessages, extractHermesToolCalls, extractJsonToolCalls, lenientRecover, computeConfidence } from '../src/cli/local-llm.js';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  pass++;
}

// 把字串切成多個 chunk，模擬串流分段（含 tool_call arguments 跨 chunk）
function sse(lines) {
  return lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('');
}
function streamResponse(text) {
  const enc = new TextEncoder();
  // 故意切碎，逼出累積邏輯的 bug
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

// ── 測 1：工具 schema 轉換 ──
{
  const TOOL_DEFS = [
    { name: 'read_file', description: '讀檔', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  ];
  const oa = toOpenAITools(TOOL_DEFS);
  ok('tools -> function 包裝', oa[0].type === 'function');
  ok('tools name 保留', oa[0].function.name === 'read_file');
  ok('input_schema -> parameters', oa[0].function.parameters.required[0] === 'path');
}

// ── 測 2：訊息歷史轉換（含 tool_use / tool_result）──
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
  ok('system 在最前', oa[0].role === 'system');
  ok('user 字串原樣', oa[1].role === 'user' && oa[1].content === '修 bug');
  const asst = oa.find((m) => m.role === 'assistant');
  ok('assistant text 併入 content', asst.content.includes('我先讀檔'));
  ok('tool_use -> tool_calls', asst.tool_calls[0].id === 'tu_1' && asst.tool_calls[0].function.name === 'read_file');
  ok('arguments 是 JSON 字串', JSON.parse(asst.tool_calls[0].function.arguments).path === 'a.js');
  const toolMsg = oa.find((m) => m.role === 'tool');
  ok('tool_result -> role tool', toolMsg.tool_call_id === 'tu_1' && toolMsg.content === 'file body');
}

// ── 測 3：純文字串流 -> end_turn ──
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
  ok('text block 拼回', r.content[0].type === 'text' && r.content[0].text === '你好，世界');
  ok('onText 有串流', streamed === '你好，世界');
  ok('stop_reason end_turn', r.stop_reason === 'end_turn');
})();

// ── 測 4：tool_call 串流（arguments 跨 chunk）-> tool_use ──
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
  ok('文字+工具同回合', r.content[0].type === 'text' && r.content.some((b) => b.type === 'tool_use'));
  const tu = r.content.find((b) => b.type === 'tool_use');
  ok('tool_use id 保留', tu.id === 'call_9' && tu.name === 'write_file');
  ok('arguments 跨 chunk 拼回', tu.input.path === 'out.js' && tu.input.content === 'hi');
  ok('stop_reason tool_use', r.stop_reason === 'tool_use');
})();

// ── 測 5：Hermes 模板後備（ollama 串流會把 <tool_call> 當純文字吐）──
{
  const leaked = '我來讀檔。\n<tool_call>\n{"name":"read_file","arguments":{"path":"config.json"}}\n</tool_call>';
  const r = extractHermesToolCalls(leaked);
  ok('挖出工具名', r.calls[0].name === 'read_file');
  ok('挖出參數', r.calls[0].input.path === 'config.json');
  ok('剝掉模板留下乾淨文字', r.cleaned === '我來讀檔。');
}

// ── 測 6：串流模式下的 Hermes 後備（開頭標籤被切碎）走完整 run() ──
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
  ok('後備在串流路徑生效', !!tu && tu.name === 'write_file' && tu.input.path === 'a.js');
  ok('後備觸發 stop_reason tool_use', r.stop_reason === 'tool_use');
  const txt = r.content.find((b) => b.type === 'text');
  ok('後備保留前導文字', txt && txt.text === '讓我看看。');
})();

// ── 測 7：裸 JSON / ```json 工具呼叫後備（qwen2.5-coder 這樣吐）──
{
  const fenced = '好的，讓我先查看。\n```json\n{\n  "name": "list_dir",\n  "arguments": {"path": "src"}\n}\n```';
  const r = extractJsonToolCalls(fenced, ['list_dir', 'read_file']);
  ok('圍欄 JSON 挖出工具', r.calls[0].name === 'list_dir' && r.calls[0].input.path === 'src');
  ok('圍欄剝掉留下文字', r.cleaned === '好的，讓我先查看。');

  const bare = '{"name":"read_file","arguments":{"path":"a.js"}}';
  const r2 = extractJsonToolCalls(bare, ['read_file']);
  ok('裸 JSON 挖出工具', r2.calls[0].name === 'read_file' && r2.calls[0].input.path === 'a.js');

  // 不是已知工具名的 JSON 不該被誤判成工具呼叫
  const notCall = '這是答案：{"name":"小明","arguments":"無關"}';
  const r3 = extractJsonToolCalls(notCall, ['read_file']);
  ok('非工具名 JSON 不誤判', r3.calls.length === 0);
}

// ── 測 8：串流吐 ```json 工具呼叫，走完整 run() ──
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
  ok('串流圍欄 JSON 後備生效', !!tu && tu.name === 'list_dir' && tu.input.path === 'src');
  ok('串流圍欄觸發 tool_use', r.stop_reason === 'tool_use');
})();

// ── 測 9：後端 5xx（壞 tool-call JSON）會重試，下一次成功就接住 ──
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
  ok('5xx 後重試成功', calls === 2 && r.content[0]?.text === '好了');
})();

// ── 測 10：4xx 不重試，直接丟 ──
await (async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 400, text: async () => 'bad request' }; };
  const llm = createLocalLLM({ baseURL: 'http://x/v1', model: 'm', maxRetries: 2 });
  let threw = false;
  try { await llm.run({ system: 's', messages: [{ role: 'user', content: 'go' }], tools: [] }); }
  catch { threw = true; }
  ok('4xx 不重試直接丟', threw && calls === 1);
})();

// ── 測 11：寬容復原——content 含未跳脫換行、嚴格 parse 會炸，但仍救回 write_file ──
{
  const bad = '{"name": "write_file", "arguments": {"path": "src/auth.js", "content": "line1\nline2"}}';
  assert.throws(() => JSON.parse(bad)); // 確認嚴格 parse 真的失敗
  const r = lenientRecover(bad, new Set(['write_file']));
  ok('寬容復原 write_file 名稱', r && r.call.name === 'write_file');
  ok('寬容復原抓對 path', r.call.input.path === 'src/auth.js');
  ok('寬容復原還原換行', r.call.input.content === 'line1\nline2');
}

// ── 測 12：寬容復原——被 max_tokens 截斷的 write_file（content 收不了尾）也救得回 ──
{
  const truncated = '{"name":"write_file","arguments":{"path":"a.js","content":"import x from \'y\';\nconst z = 1; // 還沒寫完就被截';
  const r = lenientRecover(truncated, new Set(['write_file']));
  ok('截斷的 write_file 仍救回', r && r.call.name === 'write_file' && r.call.input.path === 'a.js');
  ok('截斷 content 整段拿來', r.call.input.content.includes('import x'));
}

// ── 測 13：模型誤用被藏掉的 edit_file 但塞 content，重映射成 write_file ──
{
  const wrong = '{"name":"edit_file","arguments":{"path":"src/m.js","content":"export const a = 1;"}}';
  const r = lenientRecover(wrong, new Set(['write_file'])); // edit_file 不在已知集合
  ok('edit_file+content 重映射成 write_file', r && r.call.name === 'write_file');
  ok('重映射保留 path/content', r.call.input.path === 'src/m.js' && r.call.input.content === 'export const a = 1;');
}

// ── 測 14：一般 JSON 回答（沒有 tool name）不被誤判成工具呼叫 ──
{
  const plain = '{"answer": 42, "reason": "because"}';
  ok('純資料 JSON 不誤判', lenientRecover(plain, new Set(['write_file'])) === null);
}

// ── 測 15：extractJsonToolCalls 串接寬容復原——壞 JSON 寫檔呼叫整條鏈救回 ──
{
  const text = '我來修這個檔：\n{"name": "write_file", "arguments": {"path": "f.js", "content": "a\nb\nc"}}';
  const { calls } = extractJsonToolCalls(text, ['write_file']);
  ok('解析鏈最終救回壞 JSON 寫檔', calls.length === 1 && calls[0].name === 'write_file' && calls[0].input.content === 'a\nb\nc');
}

// ── 測 16：computeConfidence——真的吐了工具，wantedToolMass=1、hadTool=true ──
{
  const c = computeConfidence([-0.1, -0.2], { token: '{', logprob: -0.1, top: [] }, true);
  ok('有工具呼叫時信心標記正確', c.hadTool === true && c.wantedToolMass === 1 && c.nTokens === 2);
}

// ── 測 17：narrate-instead-of-call——沒呼叫工具，但第一個 token 候選裡 { 有可觀質量 ──
{
  // 第一個 token 抽到散文，但 top 候選包含 '{'（logprob -0.7 ≈ 0.50 質量）跟 '```'（-2.3 ≈ 0.10）
  const firstTok = { token: 'I', logprob: -1.2, top: [
    { token: 'I', logprob: -1.2 }, { token: '{', logprob: -0.7 }, { token: '```', logprob: -2.3 },
  ] };
  const c = computeConfidence([-1.2, -0.5], firstTok, false);
  ok('沒呼叫工具時 wantedToolMass 抓到 { 與 ``` 的質量', c.hadTool === false && c.wantedToolMass > 0.55 && c.wantedToolMass < 0.65);
}

// ── 測 18：空 logprobs（沒開或後端沒給）——回傳 null 欄位不炸 ──
{
  const c = computeConfidence([], null, false);
  ok('無 logprobs 時安全回退', c.nTokens === 0 && c.meanLogprob === null && c.minLogprob === null && c.wantedToolMass === 0);
}

console.log(`\n全部通過：${pass} 項`);
