// Token 計量：本次開發的即時用量（從 agent 的 usage 累加）+ 全機 cache 浪費（借 mercury 工具算）。
// 給 CLI 的 token 橫欄用：現在用掉 / 正在用 / 總計 / 可清掉省多少浪費。
import { computeSavings } from '../core/token-savings.js';

// ── 即時計量：把 SDK 每步的 usage 累加起來 ──
// usage 形狀（Claude）：{ input_tokens, output_tokens, cache_read_input_tokens,
//   cache_creation_input_tokens }
export function createTokenMeter() {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turn = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // 本回合（正在用）

  function startTurn() {
    turn = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  function add(usage) {
    if (!usage) return;
    const i = usage.input_tokens || 0;
    const o = usage.output_tokens || 0;
    const cr = usage.cache_read_input_tokens || 0;
    const cw = usage.cache_creation_input_tokens || 0;
    total.input += i; total.output += o; total.cacheRead += cr; total.cacheWrite += cw;
    turn.input += i; turn.output += o; turn.cacheRead += cr; turn.cacheWrite += cw;
  }

  // 「用掉」= 真正算錢的 token（input + output + cache write）。cache read 是省下來的，不重複算進「燒掉」。
  const burned = (b) => b.input + b.output + b.cacheWrite;

  function snapshot() {
    return {
      total: { ...total, burned: burned(total), all: total.input + total.output + total.cacheRead + total.cacheWrite },
      turn: { ...turn, burned: burned(turn) },
    };
  }

  return { startTurn, add, snapshot };
}

// ── 全機 cache 浪費：純 Node 讀 ~/.claude/projects log（無 python 依賴）──
// 回 { ok, wasted_tokens, wasted_usd, clear_now_savings_usd, saved_usd, actual_usd, n_active }
export async function fetchSavings() {
  try { return await computeSavings(); }
  catch (e) { return { ok: false, error: e.message }; }
}

// 數字縮寫：12_345 → 12.3k，8_108_008 → 8.1M
export function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
