// Conditional routing (Path B): send a task to the cheapest model first, and escalate to a larger one if it can't pass the quality floor.
//
// Why this division of labor has observational backing: Mercury's per-cell observation of qwen2.5 3B/7B shows
// the small model's "universal backbone" is actually larger (3B has 2.4× more than 7B), but its "specialist cells" are far fewer
// (2.08× fewer for physics). In plain terms: small models hold up on common/general tasks, and only the genuinely hard specialist tasks need a large model.
// This router turns that finding into runtime behavior: 80% of tasks run on the small model to save cost, and only the hard ones bubble up.
//
// The supervision signal uses the off-the-shelf "quality floor" (verify gate): the outcome.ok returned by agent.send()
// already means "finished cleanly and passed verify". On failure, rollback (discard the files this tier broke, the next tier starts from a clean state)
// then escalate. Not inheriting the weak model's broken files is reasonable production behavior and also keeps "completion rate" cleanly measurable.

export function createRouter({ tiers, buildAgent, reset, onTier } = {}) {
  if (!Array.isArray(tiers) || !tiers.length) throw new Error('router needs at least one tier');
  if (typeof buildAgent !== 'function') throw new Error('router needs buildAgent(tier) -> { send }');

  async function run(task) {
    const attempts = [];
    let priorNote = ''; // the "stitched-in confound" left by the previous tier: which files it changed and why verify failed. Passed to the next tier so it doesn't repeat the mistakes.
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      const last = i === tiers.length - 1;
      if (reset) await reset(tier, i); // each tier starts from a clean baseline (discarding what the previous tier broke)
      onTier?.({ tier: tier.name, index: i, last });
      const agent = buildAgent(tier);
      let outcome;
      try {
        // the first tier gets the clean task; every later tier appends the "previous tier's clue" after the task.
        // the files themselves are already reset to the clean baseline, and the clue only enters the conversation without polluting the code, effectively pulling the confound back in to pin it down.
        outcome = await agent.send(priorNote ? task + priorNote : task);
      } catch (e) {
        outcome = { ok: false, error: String(e?.message || e), confTrace: [] };
      }
      // a true "solved" only counts verifyPassed===true: files were changed and full verify (including npm test) passed.
      // the agent's soft ok doesn't count —— "finishing cleanly without changing any file" is a narrate-instead-of-call failure for a bug-fix task,
      // not completion. This is exactly what changes the router from "trusting the model thinks it's done" to "trusting the quality floor actually passed".
      const solved = outcome.verifyPassed === true;
      attempts.push({
        tier: tier.name,
        solved,
        softOk: !!outcome.ok,
        verifyPassed: outcome.verifyPassed ?? null,
        nEdits: (outcome.filesModified || []).length,
        filesModified: outcome.filesModified || [],
        conf: summarizeConfidence(outcome.confTrace),
        error: outcome.error,
      });
      if (solved) return { solved: true, tier: tier.name, tierIndex: i, attempts };
      priorNote = buildPriorNote(tier, outcome); // failed: distill this tier's confound into a clue and pass it to the next tier
    }
    return { solved: false, tier: null, tierIndex: -1, attempts };
  }

  return { run };
}

// Compress a failed tier's "confound" into a clue appended after the next tier's task.
// Carries two signals: (1) which files the previous tier touched (narrows the search surface, no flailing from scratch again);
// (2) why verify failed (syntax/import/test tail), pointing directly at where the previous tier stitched it wrong.
// Note it carries only the "why it's wrong" facts, not the previous tier's specific fix —— the fix itself may be wrong, and carrying it over would steer the next tier wrong too.
function buildPriorNote(tier, outcome) {
  const files = (outcome.filesModified || []);
  const probs = (outcome.verifyProblems || []);
  if (!files.length && !probs.length) return '';
  const lines = [];
  lines.push(`\n\n(A smaller model (${tier.name}) tried this but didn't fix it. Here are the traps it fell into, so you can avoid repeating its mistakes:)`);
  if (files.length) lines.push(`- It changed: ${files.join(', ')} (the root cause is likely nearby, but its fix was wrong - don't copy it)`);
  for (const p of probs.slice(0, 6)) lines.push(`- Verify failed [${p.kind}] ${p.file}: ${p.message}`);
  lines.push('- Re-diagnose the root cause independently. Your fix must also pass verification (including npm test) to count as done.');
  return lines.join('\n');
}

// Compress a task's multi-turn confidence trace into a few numbers, to later check "can confidence predict failure".
//   meanLogprob: average confidence over the whole generation (closer to 0 means more certain)
//   minLogprob: the most uncertain token (very negative when making things up)
//   maxWantedToolMass: the highest mass of "actually wanted to call a tool but didn't" across any turn (narrate-instead-of-call indicator)
//   turns / toolTurns: total turns / turns that actually emitted a tool
export function summarizeConfidence(confTrace = []) {
  if (!Array.isArray(confTrace) || !confTrace.length) return null;
  const means = confTrace.map((c) => c.meanLogprob).filter((x) => typeof x === 'number');
  const mins = confTrace.map((c) => c.minLogprob).filter((x) => typeof x === 'number');
  const narrateMass = confTrace.filter((c) => !c.hadTool).map((c) => c.wantedToolMass || 0);
  return {
    turns: confTrace.length,
    toolTurns: confTrace.filter((c) => c.hadTool).length,
    meanLogprob: means.length ? means.reduce((a, b) => a + b, 0) / means.length : null,
    minLogprob: mins.length ? Math.min(...mins) : null,
    maxWantedToolMass: narrateMass.length ? Math.max(...narrateMass) : 0,
  };
}
