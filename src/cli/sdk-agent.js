// SDK-based agent: use @anthropic-ai/claude-agent-sdk's query() instead of the hand-rolled llm+loop+tools.
// We do just one thing: subscribe to the event stream and translate "which file is being touched now" into the CLI's onEvent, feeding the live tree.
// Auth, tool execution, context, and permissions are all handled by the SDK (borrowing the Claude Code login).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildDepIndex, assessTool, isMutation } from '../masl/gate.js';

// onEvent contract matches the old agent: {type:'text',delta} / {type:'tool',name,path,input}
//   / {type:'active',path} / {type:'turn_end'} / {type:'error',message} / {type:'usage',usage}
// emit('read', relPath): a read isn't a filesystem event, so actively report it to core to light up that cell.
// gate: the MASL gate. Before changing a file / running a command, intercept to compute the blast radius and let the developer nod it through.
//   getState() → { cells, edges, root } (the latest snapshot the CLI received from core)
//   onGate(report, agentSaid) → Promise<boolean> (true to allow / false to block)
//   lastSaid() → the agent's most recent sentence, used as a clue for "why change it this way"
export function createSdkAgent({ root, model, onEvent, emit, getState, onGate, lastSaid }) {
  // MASL interception: read-only tools pass straight through; acting tools (Write/Edit/Bash…) go through the gate first.
  async function canUseTool(toolName, input) {
    if (!isMutation(toolName) || !onGate) return { behavior: 'allow', updatedInput: input };
    const st = getState?.() || { cells: [], edges: [], root };
    const index = buildDepIndex(st.cells, st.edges, st.root || root);
    const report = assessTool({ index, toolName, input, root: st.root || root });
    let ok = false;
    try { ok = await onGate(report, lastSaid?.() || ''); } catch { ok = false; }
    return ok
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `Blocked by the MASL gate: the developer did not approve touching ${report.targetRel || 'this command'}. Stop, and first explain clearly why you're changing it this way and how you'll verify it.` };
  }

  async function send(userText) {
    const q = query({
      prompt: userText,
      options: {
        cwd: root,
        canUseTool, // MASL: use the permission hook as the last gate, no more bypass
        includePartialMessages: true, // want the char-by-char streaming "thinking" text
        ...(model ? { model } : {}),
      },
    });

    try {
      for await (const msg of q) {
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            onEvent({ type: 'text', delta: ev.delta.text });
          }
        } else if (msg.type === 'assistant') {
          // each inference step's token usage → feed the CLI's token bar (accumulated live)
          if (msg.message?.usage) onEvent({ type: 'usage', usage: msg.message.usage });
          for (const block of msg.message.content || []) {
            if (block.type === 'tool_use') {
              const p = block.input?.file_path ?? block.input?.path ?? null;
              onEvent({ type: 'tool', name: block.name, path: p, input: block.input });
              if (p) {
                onEvent({ type: 'active', path: p }); // view jumps to this cell
                if (block.name === 'Read') emit?.('read', p); // a read → light up that cell in core
              }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) {
            onEvent({ type: 'error', message: (msg.result ?? msg.errors ?? 'Execution failed').toString() });
          }
          onEvent({ type: 'turn_end' });
        }
      }
    } catch (e) {
      onEvent({ type: 'error', message: e.message });
      onEvent({ type: 'turn_end' });
    }
  }

  return { send };
}
