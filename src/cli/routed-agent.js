// Routed agent (the token-saving backbone): send the same task to the cheapest local small model first, and finish if verify passes,
// the whole run costing 0 Anthropic tokens; only escalate to the Claude SDK when the local model can't pass the quality floor.
// Its contract to the CLI matches the other agents: { send(text) }.
//
// Behavior notes:
// 1) Multiple underlying agent tiers inside. turn_end is only bubbled up when "the last tier actually finishes",
//    so the UI doesn't clear busy right after the first tier finishes.
// 2) On each tier switch, emit { type:'tier', name, index, last } so the UI can show "running local or claude now".
// 3) v1 does no git rollback: if local breaks a file, Claude sees the broken version and fixes it; fine in most cases.
//    To do "per-tier clean baseline", wire in git stash afterward and expand from there.

import { createRouter } from './router.js';
import { createAgent } from './agent.js';
import { createLocalLLM } from './local-llm.js';
import { createMemory } from './memory.js';
import { createSdkAgent } from './sdk-agent.js';

export function createRoutedAgent({
  root, model, emit, onEvent,
  systemSuffix,         // discipline prompt for the local agent
  baseURL,              // local LLM endpoint
  localModel,           // local LLM model name (qwen-coder, etc.)
  sdkOpts = {},         // passed through to createSdkAgent (getState/onGate/lastSaid and friends)
} = {}) {
  let suppressTurnEnd = true; // don't bubble up turn_end from a non-final tier
  const filteredEvent = (e) => {
    if (e.type === 'turn_end' && suppressTurnEnd) return;
    onEvent(e);
  };

  const tiers = [{ name: 'local' }, { name: 'claude' }];

  const buildAgent = (tier) => {
    if (tier.name === 'local') {
      const llm = createLocalLLM({ baseURL, model: localModel || 'qwen-coder' });
      const memory = createMemory({ root, model: localModel || 'qwen-coder' });
      return createAgent({ llm, root, emit, onEvent: filteredEvent, systemSuffix, memory });
    }
    // claude SDK: wrap a layer so the router gets the right outcome shape.
    // since the SDK doesn't return an outcome directly, use "no error event the whole run" as the clean-finish signal.
    let errored = false;
    const sdkOnEvent = (e) => {
      if (e.type === 'error') errored = true;
      filteredEvent(e);
    };
    const sdk = createSdkAgent({ root, model, emit, onEvent: sdkOnEvent, ...sdkOpts });
    return {
      async send(task) {
        try { await sdk.send(task); }
        catch (e) { return { ok: false, error: e.message, confTrace: [] }; }
        return { ok: !errored, verifyPassed: null, filesModified: [], confTrace: [] };
      },
    };
  };

  const router = createRouter({
    tiers,
    buildAgent,
    onTier: ({ tier, index, last }) => {
      suppressTurnEnd = !last; // only the final tier sends turn_end out
      onEvent({ type: 'tier', name: tier, index, last });
    },
  });

  return {
    async send(text) {
      suppressTurnEnd = true;
      try {
        const r = await router.run(text);
        // safety: after the router finishes, the UI must receive exactly one turn_end
        onEvent({ type: 'turn_end' });
        return r;
      } catch (e) {
        onEvent({ type: 'error', message: e.message });
        onEvent({ type: 'turn_end' });
        return { solved: false, error: e.message };
      }
    },
  };
}
