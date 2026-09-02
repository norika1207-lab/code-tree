// SDK-based agent: use @anthropic-ai/claude-agent-sdk's query() instead of the hand-rolled llm+loop+tools.
// We do just one thing: subscribe to the event stream and translate "which file is being touched now" into the CLI's onEvent, feeding the live tree.
// Auth, tool execution, context, and permissions are all handled by the SDK (borrowing the Claude Code login).
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildDepIndex, assessTool, isMutation, decideGate } from '../masl/gate.js';
import { designGuidance } from './design.js';
import { minimalDiscipline } from './minimal-discipline.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

// Use the user's already-installed Claude Code binary instead of the SDK's bundled 205MB copy.
// Code Tree borrows the Claude Code login, so `claude` is always present; this keeps full SDK
// power while shedding the duplicate binary from the package and the app.
let _claudeBin;
function systemClaude() {
  if (_claudeBin !== undefined) return _claudeBin;
  _claudeBin = (() => {
    if (process.env.CODETREE_CLAUDE_BIN) return process.env.CODETREE_CLAUDE_BIN;
    try {
      const p = execFileSync('/usr/bin/which', ['claude'], { encoding: 'utf8' }).trim();
      if (p) return p;
    } catch {}
    for (const p of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', `${process.env.HOME || ''}/.local/bin/claude`]) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return null; // not found → let the SDK resolve on its own
  })();
  return _claudeBin;
}

function toolContentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part == null) return '';
      if (typeof part === 'string') return part;
      if (typeof part.text === 'string') return part.text;
      if (typeof part.content === 'string') return part.content;
      if (part.type === 'image') return '[image]';
      try { return JSON.stringify(part); } catch { return String(part); }
    }).filter(Boolean).join('\n');
  }
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  try { return JSON.stringify(content); } catch { return String(content); }
}

// onEvent contract matches the old agent: {type:'text',delta} / {type:'tool',name,path,input}
//   / {type:'active',path} / {type:'turn_end'} / {type:'error',message} / {type:'usage',usage}
// emit('read', relPath): a read isn't a filesystem event, so actively report it to core to light up that cell.
// gate: the MASL gate. Before changing a file / running a command, intercept to compute the blast radius and let the developer nod it through.
//   getState() → { cells, edges, root } (the latest snapshot the CLI received from core)
//   onGate(report, agentSaid) → Promise<boolean> (true to allow / false to block)
//   lastSaid() → the agent's most recent sentence, used as a clue for "why change it this way"
export function createSdkAgent({ root, model, permissionMode = 'review', systemSuffix, onEvent, emit, getState, onGate, lastSaid, memory }) {
  let currentAbort = null;
  // MASL interception: read-only tools pass straight through; acting tools (Write/Edit/Bash…) go through the gate first.
  async function canUseTool(toolName, input) {
    if (!isMutation(toolName) || !onGate) return { behavior: 'allow', updatedInput: input };
    const st = getState?.() || { cells: [], edges: [], root };
    const index = buildDepIndex(st.cells, st.edges, st.root || root);
    const report = assessTool({ index, toolName, input, root: st.root || root });
    if (permissionMode === 'full-access') return { behavior: 'allow', updatedInput: input };
    if (report.kind === 'shell') {
      const decision = decideGate(report);
      if (!decision.gate) return { behavior: 'allow', updatedInput: input };
    }
    if (permissionMode === 'auto-review' && report.kind === 'edit' && report.severity !== 'high') {
      return { behavior: 'allow', updatedInput: input };
    }
    let ok = false;
    try { ok = await onGate(report, lastSaid?.() || ''); } catch { ok = false; }
    return ok
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `Blocked by the MASL gate: the developer did not approve touching ${report.targetRel || 'this command'}. Stop, and first explain clearly why you're changing it this way and how you'll verify it.` };
  }

  async function send(userText) {
    const abortController = new AbortController();
    currentAbort = abortController;
    // Cross-session recall: pull this project's past similar fixes and prepend them, so the agent
    // stands on prior trajectories (survives compaction — it's on disk, not in the model's context).
    let recalled = '';
    try { recalled = memory?.recall?.(userText) || ''; } catch {}
    if (recalled) onEvent({ type: 'recall', text: recalled });
    const design = designGuidance(userText); // premium-UI discipline for frontend tasks
    if (design) onEvent({ type: 'design' });
    const filesModified = new Set();
    const toolsById = new Map();
    let lastText = '';

    const preamble = [minimalDiscipline(), systemSuffix, recalled, design].filter(Boolean).join('\n\n');
    const q = query({
      prompt: preamble ? `${preamble}\n\n---\nTask: ${userText}` : userText,
      options: {
        cwd: root,
        canUseTool, // MASL: use the permission hook as the last gate, no more bypass
        includePartialMessages: true, // want the char-by-char streaming "thinking" text
        abortController,
        ...(model ? { model } : {}),
        ...(systemClaude() ? { pathToClaudeCodeExecutable: systemClaude() } : {}),
      },
    });

    try {
      for await (const msg of q) {
        if (msg.type === 'stream_event') {
          const ev = msg.event;
          if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
            onEvent({ type: 'text', delta: ev.delta.text });
            lastText += ev.delta.text;
          }
        } else if (msg.type === 'assistant') {
          // each inference step's token usage → feed the CLI's token bar (accumulated live)
          if (msg.message?.usage) onEvent({ type: 'usage', usage: msg.message.usage });
          for (const block of msg.message.content || []) {
            if (block.type === 'tool_use') {
              const p = block.input?.file_path ?? block.input?.path ?? null;
              if (block.id) toolsById.set(block.id, { name: block.name, path: p, input: block.input });
              onEvent({ type: 'tool', id: block.id, name: block.name, path: p, input: block.input });
              if (p) {
                onEvent({ type: 'active', path: p }); // view jumps to this cell
                if (block.name === 'Read') emit?.('read', p); // a read → light up that cell in core
                else if (/Write|Edit/.test(block.name)) filesModified.add(p); // track changes for the memory trajectory
              }
            }
          }
        } else if (msg.type === 'user') {
          const blocks = Array.isArray(msg.message?.content) ? msg.message.content : [];
          for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const meta = toolsById.get(block.tool_use_id) || {};
            onEvent({
              type: 'tool_result',
              id: block.tool_use_id,
              name: meta.name,
              path: meta.path,
              input: meta.input,
              output: toolContentText(block.content),
              isError: !!block.is_error,
            });
          }
        } else if (msg.type === 'system' && msg.subtype === 'local_command_output') {
          onEvent({ type: 'tool_result', name: 'local command', output: toolContentText(msg.content) });
        } else if (msg.type === 'result') {
          if (msg.is_error) {
            onEvent({ type: 'error', message: (msg.result ?? msg.errors ?? 'Execution failed').toString() });
          }
          // Record this run so the next similar task in this project can recall it.
          try {
            memory?.record?.({
              task: userText,
              filesModified: [...filesModified],
              summary: (msg.result || lastText || '').toString().slice(-500),
              endedCleanly: !msg.is_error && filesModified.size > 0,
              toolCount: filesModified.size,
            });
          } catch {}
          onEvent({ type: 'turn_end' });
        }
      }
    } catch (e) {
      if (abortController.signal.aborted) return;
      onEvent({ type: 'error', message: e.message });
      onEvent({ type: 'turn_end' });
    } finally {
      if (currentAbort === abortController) currentAbort = null;
    }
  }

  function cancel() {
    try { currentAbort?.abort(); } catch {}
  }

  return { send, cancel };
}
