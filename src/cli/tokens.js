// Token metering: real-time usage of this dev session (accumulated from the agent's usage) + machine-wide cache waste (computed via the mercury tool).
// Used by the CLI's token bar: used so far / in use now / total / how much waste can be cleared away.
import { computeSavings } from '../core/token-savings.js';

// ── Real-time metering: accumulate the SDK's per-step usage ──
// usage shape (Claude): { input_tokens, output_tokens, cache_read_input_tokens,
//   cache_creation_input_tokens }
export function createTokenMeter() {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let turn = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }; // this turn (in use now)

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

  // "burned" = the tokens that actually cost money (input + output + cache write). cache read is saved, so don't count it into "burned".
  const burned = (b) => b.input + b.output + b.cacheWrite;

  function snapshot() {
    return {
      total: { ...total, burned: burned(total), all: total.input + total.output + total.cacheRead + total.cacheWrite },
      turn: { ...turn, burned: burned(turn) },
    };
  }

  return { startTurn, add, snapshot };
}

// ── Machine-wide cache waste: pure Node reading ~/.claude/projects logs (no python dependency) ──
// Returns { ok, wasted_tokens, wasted_usd, clear_now_savings_usd, saved_usd, actual_usd, n_active }
export async function fetchSavings() {
  try { return await computeSavings(); }
  catch (e) { return { ok: false, error: e.message }; }
}

// Number abbreviation: 12_345 → 12.3k, 8_108_008 → 8.1M
export function fmtTok(n) {
  if (n == null) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}
