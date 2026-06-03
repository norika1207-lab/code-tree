// Codex 後端：用 @openai/codex-sdk 借 ChatGPT 登入驅動 agent，跟 Claude 後端對稱。
// 一樣只做翻譯：Codex 的 ThreadEvent / item 流 → CLI 的 onEvent，餵同一棵活樹。
// 不給 apiKey → SDK 走 codex CLI 自己的 ChatGPT OAuth 登入（免 API key）。
import { Codex } from '@openai/codex-sdk';

export function createCodexAgent({ root, model, onEvent, emit }) {
  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: root,
    sandboxMode: 'workspace-write', // 能改檔，但鎖在工作目錄內
    approvalPolicy: 'never', // 原生 agent 體驗，不卡審核彈窗
    skipGitRepoCheck: true, // 非 git 目錄（如 sample）也能跑
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
              onEvent({ type: 'active', path: ch.path }); // 視角跳到這一格
              // 實際寫檔由 core 的 file watcher 抓，這裡只負責跳格
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
