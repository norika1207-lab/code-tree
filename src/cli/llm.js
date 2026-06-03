// LLM abstraction. agent.js only knows llm.run(...), regardless of whether it's real Claude or scripted underneath.
// run({ system, messages, tools, onText }) -> { content: [blocks], stop_reason }
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const OAUTH_BETA = 'oauth-2025-04-20';
// The OAuth token is bound to the Claude Code identity, so the first system block must be this sentence or the API rejects it.
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function createClaudeLLM({ getAuth, model = 'claude-sonnet-4-6', maxTokens = 8000 }) {
  return {
    async run({ system, messages, tools, onText }) {
      const auth = await getAuth();
      if (!auth) throw new Error('Not logged in: log in with Claude Code first, or set ANTHROPIC_API_KEY');

      const headers = { 'content-type': 'application/json', 'anthropic-version': API_VERSION };
      let sys = Array.isArray(system) ? system : [{ type: 'text', text: system || '' }];
      if (auth.mode === 'oauth') {
        headers['authorization'] = `Bearer ${auth.token}`;
        headers['anthropic-beta'] = OAUTH_BETA;
        sys = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }, ...sys];
      } else {
        headers['x-api-key'] = auth.token;
      }

      const res = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, max_tokens: maxTokens, system: sys, tools, messages, stream: true }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        if (res.status === 401) throw new Error('Authentication expired (401): please log back in through Claude Code');
        throw new Error(`Claude API ${res.status}: ${body.slice(0, 300)}`);
      }
      return await parseSSE(res, onText);
    },
  };
}

async function parseSSE(res, onText) {
  const decoder = new TextDecoder();
  let buf = '';
  const blocks = [];
  let stopReason = null;

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, nl);
      buf = buf.slice(nl + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let ev;
      try {
        ev = JSON.parse(dataLine.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === 'content_block_start') {
        const b = ev.content_block;
        if (b.type === 'tool_use') blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, _json: '' };
        else blocks[ev.index] = { type: 'text', text: '' };
      } else if (ev.type === 'content_block_delta') {
        const b = blocks[ev.index];
        if (ev.delta.type === 'text_delta') {
          b.text += ev.delta.text;
          onText?.(ev.delta.text);
        } else if (ev.delta.type === 'input_json_delta') {
          b._json += ev.delta.partial_json;
        }
      } else if (ev.type === 'content_block_stop') {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') {
          try { b.input = JSON.parse(b._json || '{}'); } catch { b.input = {}; }
          delete b._json;
        }
      } else if (ev.type === 'message_delta') {
        stopReason = ev.delta?.stop_reason ?? stopReason;
      }
    }
  }
  return { content: blocks.filter(Boolean), stop_reason: stopReason };
}

// ── Scripted: for demos / offline verification. Emit pre-written assistant turns one by one. ──
// script: [{ text?, tools?:[{name,input}], stop_reason }] consumed in order
export function createScriptedLLM(script) {
  let i = 0;
  return {
    async run({ onText }) {
      const turn = script[i++] || { text: '(end of script)', stop_reason: 'end_turn' };
      if (turn.text) {
        for (const ch of turn.text) {
          onText?.(ch);
          await new Promise((r) => setTimeout(r, 8)); // simulate streaming
        }
      }
      const content = [];
      if (turn.text) content.push({ type: 'text', text: turn.text });
      for (const t of turn.tools || []) {
        content.push({ type: 'tool_use', id: 'demo_' + Math.random().toString(36).slice(2, 8), name: t.name, input: t.input });
      }
      return { content, stop_reason: turn.stop_reason || (turn.tools ? 'tool_use' : 'end_turn') };
    },
  };
}
