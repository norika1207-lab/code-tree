// Agent tool loop: prompt → Claude stream → run tools → feed results back → loop until end_turn.
// Every tool action fires onEvent({type:'active', path}) so the CLI's view jumps to that cell.
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DEFS, makeExecutor } from './tools.js';
import { verifyChangedFiles, formatProblems } from './verify.js';
import { designGuidance } from './design.js';

// Small models often narrate "the file I'll read next" in text instead of actually issuing read_file (narrate-instead-of-call).
// Pull from this closing text the source paths it named that actually exist and haven't been read, and have the loop issue read_file on its behalf,
// so it reads what it should before moving on to diagnose→act, rather than spinning on "please use read_file to read…".
// Only salvage reads (read-only, safe); writes are never auto-issued from text and always go through the verify gate.
export function extractNarratedReads(text, { exists, alreadyRead = new Set(), max = 3, requireIntent = true } = {}) {
  const s = String(text || '');
  // without a read-intent signal, don't salvage, to avoid mistaking a filename mentioned in normal closing text for something to read.
  // requireIntent=false is used for "suspect files the task itself lists": those are explicitly flagged by the user and need no intent keyword.
  if (requireIntent && !/(read_file|read|look|view|check|inspect|open|see)\b/i.test(s)) return [];
  const out = [];
  const seen = new Set();
  for (const m of s.matchAll(/[\w./-]+\.(?:mjs|cjs|jsx|tsx|js|ts|json|py)\b/g)) {
    const p = m[0].replace(/^\.\//, '');
    if (seen.has(p) || alreadyRead.has(p)) continue;
    seen.add(p);
    if (exists && !exists(p)) continue;
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

const SYSTEM = `You are a coding agent working inside the user's project. The interface is called Cosmos Tree.
Rules:
- Before acting, use list_dir / read_file to see the actual current state. Don't guess.
- To change files, use edit_file (precise replacement) or write_file (new file / full-file rewrite).
- Do one clear thing at a time, and after each action briefly say what you did in which file.
- When done, wrap up in a sentence or two. Don't ramble.`;

const READ_TOOLS = new Set(['read_file', 'list_dir', 'search_code']);
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export function createAgent({ llm, root, emit, onEvent, model, systemSuffix, memory, verify = true, maxVerifyRounds = 3, maxNoWorkNudges = 2, tools = TOOL_DEFS }) {
  const execute = makeExecutor(root, emit);
  const system = systemSuffix ? `${SYSTEM}\n${systemSuffix}` : SYSTEM;
  const messages = [];
  const activeTools = tools; // can be trimmed by the caller (e.g. give a local small model only write_file to avoid confusing it with edit_file's schema)
  const forceTarget = activeTools.some((t) => t.name === 'write_file') ? 'write_file' : (activeTools.find((t) => WRITE_TOOLS.has(t.name))?.name);

  async function send(userText) {
    messages.push({ role: 'user', content: userText });
    let guard = 0;

    // Continuous evolution (fast loop): before starting, recall trajectories of past similar tasks and prepend them to this run's system prompt
    let runSystem = system;
    if (memory) {
      const recalled = memory.recall(userText);
      if (recalled) {
        runSystem = `${system}\n\n${recalled}`;
        onEvent({ type: 'recall', text: recalled });
      }
    }
    // Design taste: if this task builds/styles a UI, inject the design discipline so the output is premium, not generic
    const design = designGuidance(userText);
    if (design) { runSystem = `${runSystem}\n\n${design}`; onEvent({ type: 'design' }); }

    // Trajectory collection: which files this task read/modified, how many tool calls, and what the last turn said
    const filesRead = new Set();
    const filesModified = new Set();
    let toolCount = 0;
    let lastTurnText = '';
    let verifyRounds = 0;
    let verifyPassed = null; // null=not verified (no file changes), true/false=verified passed/failed
    let lastVerifyProblems = null; // details of the last failed verify (syntax/import/test tail): passed to the next tier as a clue on escalation
    let noWorkNudges = 0;    // small models often "glance once then quit": when trying to end with zero edits, push back to make it actually act
    let forceToolNext = false; // force a tool call next turn (push narrate-then-stop back into action)
    let salvagedReads = 0;   // count of times the model's "say in text which file to read" was issued as a real read_file (guards against infinite salvaging)
    const maxSalvageReads = 4;
    const confTrace = [];    // per-turn token confidence summary (only present when the local engine has logprobs on): the criterion for routing/halting
    const fileExists = (rel) => { try { return fs.statSync(path.join(root, rel)).isFile(); } catch { return false; } };

    const finish = (endedCleanly) => {
      onEvent({ type: 'turn_end' });
      // a true "clean finish" also requires verify to pass (with no file changes, defer to the model's own end-of-turn judgment)
      const ok = endedCleanly && verifyPassed !== false;
      if (memory) {
        memory.record({
          task: userText,
          filesRead: [...filesRead],
          filesModified: [...filesModified],
          toolCount,
          endedCleanly: ok,
          verifyPassed,
          summary: lastTurnText,
        });
      }
      // Return the result to the caller (router): whether it finished cleanly, whether verify passed, which files changed, the confidence trace.
      // The router uses this to decide whether to escalate the same task to a larger model.
      return {
        ok,
        endedCleanly,
        verifyPassed,
        verifyProblems: lastVerifyProblems,
        filesModified: [...filesModified],
        filesRead: [...filesRead],
        toolCount,
        summary: lastTurnText,
        confTrace,
      };
    };

    while (guard++ < 30) {
      lastTurnText = '';
      // narrate-then-stop small models: after a nudge, this turn offers ONLY write tools to force it from "all talk" into "action".
      // Observed that on ollama 0.30, even when write_file is named, the model dodges to read_file to avoid acting.
      // Fix: on the forced turn remove read-class tools entirely, leaving only write_file/edit_file on the table, so a call can only be a write.
      // By now it has read the files and recall has supplied a fix, so there's enough information.
      const turnTools = forceToolNext ? activeTools.filter((t) => WRITE_TOOLS.has(t.name)) : activeTools;
      const res = await llm.run({
        system: runSystem,
        tools: turnTools,
        messages,
        // Name write_file. ollama 0.30 doesn't honor tool_choice:'required', but it does honor "naming a specific function",
        // emitting that call as content JSON, which local-llm's fallback parser picks back up as a tool_use.
        toolChoice: forceToolNext ? { type: 'function', function: { name: forceTarget } } : undefined,
        onText: (delta) => {
          lastTurnText += delta;
          onEvent({ type: 'text', delta });
        },
      });
      forceToolNext = false;
      if (res.usage) onEvent({ type: 'usage', usage: res.usage });
      if (res.confidence) { confTrace.push(res.confidence); onEvent({ type: 'confidence', ...res.confidence }); }
      messages.push({ role: 'assistant', content: res.content });

      const toolUses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || toolUses.length === 0) {
        // Quality floor: the model wants to finish, but if any file was changed, run real verification first and on failure feed the errors back to make it fix them
        if (verify && filesModified.size && verifyRounds < maxVerifyRounds) {
          verifyRounds++;
          const { ok, problems } = verifyChangedFiles(root, [...filesModified], { tests: true });
          verifyPassed = ok;
          lastVerifyProblems = ok ? null : problems;
          onEvent({ type: 'verify', ok, problems });
          if (!ok) {
            messages.push({ role: 'user', content: formatProblems(problems) });
            continue; // not allowed to finish, loop back to fix
          }
        }
        // Narration salvage: the model hasn't acted and hasn't pasted code, it just says in text "please use read_file to read X, Y".
        // It has narrated the read action away too. Rather than nudge into a spin, directly read in the named, existing, not-yet-read files on its behalf
        // and feed them back, so it reads what it should before moving on to diagnose→act. Only salvage reads (read-only, safe), with a cap to prevent spinning.
        if (filesModified.size === 0 && !/```/.test(lastTurnText) && salvagedReads < maxSalvageReads) {
          const budget = Math.min(3, maxSalvageReads - salvagedReads);
          // Candidates = files named for reading in the narration ∪ suspect files the task itself lists (the latter need no intent keyword).
          // The latter specifically fixes the stall where "the model finishes list_dir, doesn't read the prime suspect, and produces vague narration".
          const fromText = extractNarratedReads(lastTurnText, { exists: fileExists, alreadyRead: filesRead, max: budget });
          const fromTask = extractNarratedReads(userText, { exists: fileExists, alreadyRead: filesRead, max: budget, requireIntent: false });
          const wanted = [...new Set([...fromText, ...fromTask])].slice(0, budget);
          if (wanted.length) {
            const parts = [];
            for (const rel of wanted) {
              salvagedReads++;
              toolCount++;
              filesRead.add(rel);
              onEvent({ type: 'tool', name: 'read_file', path: rel, input: { path: rel } });
              onEvent({ type: 'active', path: rel });
              let out;
              try { out = await execute('read_file', { path: rel }); }
              catch (e) { out = `Tool error: ${e.message}`; }
              parts.push(`File ${rel}:\n${String(out)}`);
            }
            onEvent({ type: 'salvage', reads: wanted });
            messages.push({ role: 'user', content: `(I went ahead and read in the files you mentioned. Their contents are below. Now act directly: find the root cause, then fix it by rewriting the whole file with write_file. Don't describe the steps in prose anymore.)\n\n${parts.join('\n\n')}` });
            continue; // after reading, loop back so it moves on to diagnose→act
          }
        }
        // Wanting to finish with zero edits: the two most common ways small models slack off ——
        //   (1) give up after one glance; (2) paste the fixed code as a markdown block to "tell" the user, instead of actually calling a tool.
        // The latter is the deadliest: the model thinks it fixed it but wrote not a single character to the file. Detecting a ``` code block in the closing text calls it out.
        if (verify && filesModified.size === 0 && noWorkNudges < maxNoWorkNudges) {
          noWorkNudges++;
          const dumpedCode = /```/.test(lastTurnText);
          onEvent({ type: 'nudge', reason: dumpedCode ? 'code_in_text' : 'no_edit' });
          const msg = dumpedCode
            ? "(You pasted the code into the message, but that has NO effect at all - not a single character of the file changed. Issue a write_file tool call RIGHT NOW: set path to the file you want to change, and content to the complete fixed contents of that file. Stop explaining in prose, just call the tool.)"
            : "(You haven't modified any file so far. If this task requires changing code, ACT with the tools directly: first read_file the suspect files to find the root cause, then fix it by rewriting the whole file with write_file or editing with edit_file. Don't just describe the steps in prose. If you're sure no file actually needs changing, then wrap up with a one-sentence explanation of why.)";
          messages.push({ role: 'user', content: msg });
          forceToolNext = true; // next turn offer only write tools and force the named one, making it actually write the fixed content to the file
          continue;
        }
        return finish(true);
      }

      const results = [];
      for (const tu of toolUses) {
        const p = tu.input?.path;
        toolCount++;
        if (p && READ_TOOLS.has(tu.name)) filesRead.add(p);
        if (p && WRITE_TOOLS.has(tu.name)) filesModified.add(p);
        onEvent({ type: 'tool', name: tu.name, path: p, input: tu.input });
        if (p) onEvent({ type: 'active', path: p }); // view jumps to this cell
        let out;
        try {
          out = await execute(tu.name, tu.input || {});
        } catch (e) {
          out = `Tool error: ${e.message}`;
        }
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) });
      }
      messages.push({ role: 'user', content: results });
    }
    return finish(false);
  }

  return { send, messages };
}
