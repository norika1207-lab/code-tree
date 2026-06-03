// SDK 版 agent：用 @anthropic-ai/claude-agent-sdk 的 query() 取代手刻的 llm+loop+tools。
// 我們只做一件事：訂閱事件流，把「現在動到哪個檔」翻譯成 CLI 的 onEvent，餵活樹。
// 認證、工具執行、context、權限全由 SDK（借用 Claude Code 登入）處理。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildDepIndex, assessTool, isMutation } from '../masl/gate.js';

// onEvent 契約跟舊 agent 一致：{type:'text',delta} / {type:'tool',name,path,input}
//   / {type:'active',path} / {type:'turn_end'} / {type:'error',message} / {type:'usage',usage}
// emit('read', relPath)：讀檔不是檔案系統事件，主動回報 core 讓那一格亮起來。
// gate：MASL 關卡。要改檔 / 跑指令前先攔下來算爆炸範圍，交給開發者點頭。
//   getState() → { cells, edges, root }（CLI 從 core 收到的最新 snapshot）
//   onGate(report, agentSaid) → Promise<boolean>（true 放行 / false 擋下）
//   lastSaid() → agent 最近講的一句話，當「為什麼要這樣改」的線索
export function createSdkAgent({ root, model, onEvent, emit, getState, onGate, lastSaid }) {
  // MASL 攔截：唯讀工具直接放行；要動手的（Write/Edit/Bash…）先過關卡。
  async function canUseTool(toolName, input) {
    if (!isMutation(toolName) || !onGate) return { behavior: 'allow', updatedInput: input };
    const st = getState?.() || { cells: [], edges: [], root };
    const index = buildDepIndex(st.cells, st.edges, st.root || root);
    const report = assessTool({ index, toolName, input, root: st.root || root });
    let ok = false;
    try { ok = await onGate(report, lastSaid?.() || ''); } catch { ok = false; }
    return ok
      ? { behavior: 'allow', updatedInput: input }
      : { behavior: 'deny', message: `MASL 關卡擋下：開發者沒有核准動 ${report.targetRel || '這個指令'}。停下來，先說清楚為什麼這樣改、怎麼驗證。` };
  }

  async function send(userText) {
    const q = query({
      prompt: userText,
      options: {
        cwd: root,
        canUseTool, // MASL：用權限鉤子當最後一道關卡，不再 bypass
        includePartialMessages: true, // 要逐字串流的「思考中」文字
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
          // 每一步推論的 token 用量 → 餵 CLI 的 token 橫欄（即時累加）
          if (msg.message?.usage) onEvent({ type: 'usage', usage: msg.message.usage });
          for (const block of msg.message.content || []) {
            if (block.type === 'tool_use') {
              const p = block.input?.file_path ?? block.input?.path ?? null;
              onEvent({ type: 'tool', name: block.name, path: p, input: block.input });
              if (p) {
                onEvent({ type: 'active', path: p }); // 視角跳到這一格
                if (block.name === 'Read') emit?.('read', p); // 讀檔 → 點亮 core 那格
              }
            }
          }
        } else if (msg.type === 'result') {
          if (msg.is_error) {
            onEvent({ type: 'error', message: (msg.result ?? msg.errors ?? '執行失敗').toString() });
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
