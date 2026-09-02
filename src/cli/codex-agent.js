// Codex backend: use @openai/codex-sdk to drive the agent by borrowing the ChatGPT login, symmetric to the Claude backend.
// Same deal, just translation: Codex's ThreadEvent / item stream → the CLI's onEvent, feeding the same live tree.
// No apiKey → the SDK uses the codex CLI's own ChatGPT OAuth login (no API key needed).
import { Codex } from '@openai/codex-sdk';
import { minimalDiscipline } from './minimal-discipline.js';

export function createCodexAgent({ root, model, effort = 'medium', sandboxMode = 'workspace-write', approvalPolicy = 'never', onEvent, emit }) {
  const codex = new Codex();
  let currentAbort = null;
  const thread = codex.startThread({
    workingDirectory: root,
    sandboxMode,
    approvalPolicy,
    skipGitRepoCheck: true, // can run in non-git directories (like sample) too
    modelReasoningEffort: effort,
    ...(model ? { model } : {}),
  });

  async function send(userText) {
    const abort = new AbortController();
    currentAbort = abort;
    try {
      const images = [];
      const text = String(userText || '').replace(/^__CODETREE_LOCAL_IMAGE__=(.+)$/gm, (_m, p) => {
        images.push(String(p).trim());
        return '';
      }).trim();
      const disciplinedText = [minimalDiscipline(), text].filter(Boolean).join('\n\n---\nTask: ');
      const input = images.length
        ? [{ type: 'text', text: disciplinedText }, ...images.map((p) => ({ type: 'local_image', path: p }))]
        : disciplinedText;
      const { events } = await thread.runStreamed(input, { signal: abort.signal });
      for await (const ev of events) {
        if (ev.type === 'item.completed') {
          const item = ev.item;
          if (item.type === 'file_change') {
            for (const ch of item.changes || []) {
              onEvent({ type: 'tool', name: 'edit:' + ch.kind, path: ch.path, input: ch });
              onEvent({ type: 'active', path: ch.path }); // view jumps to this cell
              // the actual file write is caught by core's file watcher; here we only handle the cell jump
            }
          } else if (item.type === 'command_execution') {
            onEvent({
              type: 'tool_result',
              id: item.id,
              name: 'bash',
              path: null,
              input: { command: item.command },
              output: item.aggregated_output || '',
              exitCode: item.exit_code,
              isError: item.status === 'failed',
            });
          } else if (item.type === 'mcp_tool_call') {
            onEvent({
              type: 'tool_result',
              id: item.id,
              name: item.tool,
              input: item.arguments,
              output: item.error?.message || JSON.stringify(item.result?.content || item.result || ''),
              isError: item.status === 'failed',
            });
          } else if (item.type === 'agent_message' || item.type === 'reasoning') {
            onEvent({ type: 'text', delta: item.text || '' });
          } else if (item.type === 'error') {
            onEvent({ type: 'error', message: item.message });
          }
        } else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
          onEvent({ type: 'tool', id: ev.item.id, name: 'bash', path: null, input: { command: ev.item.command } });
        } else if (ev.type === 'item.started' && ev.item?.type === 'mcp_tool_call') {
          onEvent({ type: 'tool', id: ev.item.id, name: ev.item.tool, path: null, input: ev.item.arguments });
        } else if (ev.type === 'turn.completed') {
          if (ev.usage) {
            onEvent({
              type: 'usage',
              usage: {
                input_tokens: ev.usage.input_tokens || 0,
                output_tokens: ev.usage.output_tokens || 0,
                reasoning_output_tokens: ev.usage.reasoning_output_tokens || 0,
                cache_read_input_tokens: ev.usage.cached_input_tokens || 0,
              },
            });
          }
          onEvent({ type: 'turn_end' });
        } else if (ev.type === 'turn.failed') {
          onEvent({ type: 'error', message: ev.error?.message || 'turn failed' });
          onEvent({ type: 'turn_end' });
        } else if (ev.type === 'thread.error') {
          onEvent({ type: 'error', message: ev.message || 'thread error' });
        }
      }
    } catch (e) {
      if (abort.signal.aborted) return;
      onEvent({ type: 'error', message: e.message });
      onEvent({ type: 'turn_end' });
    } finally {
      if (currentAbort === abort) currentAbort = null;
    }
  }

  function cancel() {
    try { currentAbort?.abort(); } catch {}
  }

  return { send, cancel };
}
