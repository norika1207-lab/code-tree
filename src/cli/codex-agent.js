// Codex backend: use @openai/codex-sdk to drive the agent by borrowing the ChatGPT login, symmetric to the Claude backend.
// Same deal, just translation: Codex's ThreadEvent / item stream → the CLI's onEvent, feeding the same live tree.
// No apiKey → the SDK uses the codex CLI's own ChatGPT OAuth login (no API key needed).
import { Codex } from '@openai/codex-sdk';

export function createCodexAgent({ root, model, onEvent, emit }) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: root,
    sandboxMode: 'workspace-write', // can change files, but locked inside the working directory
    approvalPolicy: 'never', // native agent experience, no approval popups in the way
    skipGitRepoCheck: true, // can run in non-git directories (like sample) too
    ...(model ? { model } : {}),
  });

  async function send(userText) {
    try {
      const { events } = await thread.runStreamed(userText);
      for await (const ev of events) {
        if (ev.type === 'item.completed') {
          const item = ev.item;
          if (item.type === 'file_change') {
            for (const ch of item.changes || []) {
              onEvent({ type: 'tool', name: 'edit:' + ch.kind, path: ch.path, input: ch });
              onEvent({ type: 'active', path: ch.path }); // view jumps to this cell
              // the actual file write is caught by core's file watcher; here we only handle the cell jump
            }
          } else if (item.type === 'agent_message' || item.type === 'reasoning') {
            onEvent({ type: 'text', delta: item.text || '' });
          } else if (item.type === 'error') {
            onEvent({ type: 'error', message: item.message });
          }
        } else if (ev.type === 'item.started' && ev.item?.type === 'command_execution') {
          onEvent({ type: 'tool', name: 'bash', path: null, input: { command: ev.item.command } });
        } else if (ev.type === 'turn.completed') {
          onEvent({ type: 'turn_end' });
        } else if (ev.type === 'turn.failed') {
          onEvent({ type: 'error', message: ev.error?.message || 'turn failed' });
          onEvent({ type: 'turn_end' });
        } else if (ev.type === 'thread.error') {
          onEvent({ type: 'error', message: ev.message || 'thread error' });
        }
      }
    } catch (e) {
      onEvent({ type: 'error', message: e.message });
      onEvent({ type: 'turn_end' });
    }
  }

  return { send };
}
