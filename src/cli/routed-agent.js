// 路由式 agent（省 token 的主軸）：同一個任務先丟最便宜的本地小模型，verify 過就收工，
// 整段 0 Anthropic token；本地跑不過品質地板才升級到 Claude SDK。
// 對 CLI 的合約跟其他 agent 一致：{ send(text) }。
//
// 行為要點：
// 1) 內部多層底層 agent。turn_end 只在「最後一層真的收工」時往上吐，
//    UI 才不會在第一層剛跑完就把 busy 解掉。
// 2) 每換一層會 emit { type:'tier', name, index, last } 給 UI 顯示「現在跑 local 還是 claude」。
// 3) v1 不做 git rollback：如果本地把檔改壞，Claude 會看到改壞版本再修；多數情況下沒問題。
//    要做「逐層乾淨基線」之後接 git stash 再展開。

import { createRouter } from './router.js';
import { createAgent } from './agent.js';
import { createLocalLLM } from './local-llm.js';
import { createMemory } from './memory.js';
import { createSdkAgent } from './sdk-agent.js';

export function createRoutedAgent({
  root, model, emit, onEvent,
  systemSuffix,         // 給 local agent 的紀律提示
  baseURL,              // 本地 LLM endpoint
  localModel,           // 本地 LLM 模型名（qwen-coder 等）
  sdkOpts = {},         // 透傳給 createSdkAgent（getState/onGate/lastSaid 那些）
} = {}) {
  let suppressTurnEnd = true; // 非最後一層的 turn_end 不往上吐
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
    // claude SDK：包一層讓 router 拿到對的 outcome 形狀。
    // 由於 SDK 不直接回傳 outcome，這裡用「整段沒丟 error 事件」當善終訊號。
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
      suppressTurnEnd = !last; // 最後一層才把 turn_end 送出去
      onEvent({ type: 'tier', name: tier, index, last });
    },
  });

  return {
    async send(text) {
      suppressTurnEnd = true;
      try {
        const r = await router.run(text);
        // 保險：router 完成後 UI 一定要收到一個 turn_end
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
