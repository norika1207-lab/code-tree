// Token waste measurement (pure Node version, porting the token-saving math from mercury_cache_panel.py).
// Goal: drop the python dependency so the app packages cleanly. Reads only local ~/.claude/projects/*/*.jsonl, nothing leaves the machine.
// Algorithm matches python: session_cost (actual vs naive vs saved), detect_waste (cache written but never read back),
// clear_now_savings (roughly how much clearing now saves over the next hour).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const PRICING = { input: 3.0, output: 15.0, cache_read: 0.3, cache_write_5m: 3.75, cache_write_1h: 6.0 };
const TTL_1H = 3600, TTL_5M = 300, ACTIVE_WINDOW = 900;

function parseTs(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : 0; // seconds
}

// Read one session file → extract the usage of each assistant message
async function parseSession(file) {
  let txt;
  try { txt = await fs.readFile(file, 'utf8'); } catch { return null; }
  const msgs = [];
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant') continue;
    const m = d.message || {};
    const u = m.usage;
    if (!u) continue;
    const cc = u.cache_creation || {};
    msgs.push({
      ts: parseTs(d.timestamp || m.timestamp),
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cache_read: u.cache_read_input_tokens || 0,
      cache_write_1h: cc.ephemeral_1h_input_tokens || 0,
      cache_write_5m: cc.ephemeral_5m_input_tokens || 0,
    });
  }
  if (!msgs.length) return null;
  return { msgs, start: msgs[0].ts, end: msgs[msgs.length - 1].ts };
}

function sessionCost(msgs) {
  let ti = 0, to = 0, tcr = 0, tw1 = 0, tw5 = 0;
  for (const m of msgs) { ti += m.input; to += m.output; tcr += m.cache_read; tw1 += m.cache_write_1h; tw5 += m.cache_write_5m; }
  const actual = ti / 1e6 * PRICING.input + to / 1e6 * PRICING.output + tcr / 1e6 * PRICING.cache_read
    + tw1 / 1e6 * PRICING.cache_write_1h + tw5 / 1e6 * PRICING.cache_write_5m;
  const naive = (ti + tcr + tw1 + tw5) / 1e6 * PRICING.input + to / 1e6 * PRICING.output;
  return { actual, naive, saved: naive - actual };
}

// Waste: written into cache but no later message reads it back within the TTL
function detectWaste(msgs) {
  let w1 = 0, w5 = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const rest = msgs.slice(i + 1);
    if (m.cache_write_1h > 0 && !rest.some((n) => n.ts - m.ts < TTL_1H && n.cache_read > 0)) w1 += m.cache_write_1h;
    if (m.cache_write_5m > 0 && !rest.some((n) => n.ts - m.ts < TTL_5M && n.cache_read > 0)) w5 += m.cache_write_5m;
  }
  return { wastedTokens: w1 + w5, wastedUsd: w1 / 1e6 * PRICING.cache_write_1h + w5 / 1e6 * PRICING.cache_write_5m };
}

function msgCost(m) {
  return m.input / 1e6 * PRICING.input + m.output / 1e6 * PRICING.output + m.cache_read / 1e6 * PRICING.cache_read
    + m.cache_write_1h / 1e6 * PRICING.cache_write_1h + m.cache_write_5m / 1e6 * PRICING.cache_write_5m;
}

// Scan all sessions, returning numbers in the same shape as the python wrapper
export async function computeSavings() {
  let dirs;
  try { dirs = await fs.readdir(CLAUDE_DIR, { withFileTypes: true }); } catch {
    return { ok: false, error: '讀不到 ~/.claude/projects' };
  }
  const files = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let inner;
    try { inner = await fs.readdir(path.join(CLAUDE_DIR, d.name)); } catch { continue; }
    for (const f of inner) if (f.endsWith('.jsonl')) files.push(path.join(CLAUDE_DIR, d.name, f));
  }

  const now = Date.now() / 1000;
  let actualUsd = 0, savedUsd = 0, wastedUsd = 0, wastedTokens = 0, clearNow = 0, nActive = 0, nSessions = 0;

  const parsed = await Promise.all(files.map(parseSession));
  for (const s of parsed) {
    if (!s) continue;
    nSessions++;
    const c = sessionCost(s.msgs);
    const w = detectWaste(s.msgs);
    actualUsd += c.actual; savedUsd += c.saved; wastedUsd += w.wastedUsd; wastedTokens += w.wastedTokens;
    if (now - s.end < ACTIVE_WINDOW) {
      nActive++;
      const recent = s.msgs.filter((m) => now - m.ts < 3600);
      const recentCost = recent.reduce((a, m) => a + msgCost(m), 0);
      if (recentCost > 1) clearNow += recentCost * 0.3; // rough savings estimate from clearing: avoids rebuilding stale cache over the next hour
    }
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    n_sessions: nSessions,
    n_active: nActive,
    wasted_tokens: Math.round(wastedTokens),
    wasted_usd: +wastedUsd.toFixed(4),
    clear_now_savings_usd: +clearNow.toFixed(4),
    saved_usd: +savedUsd.toFixed(2),
    actual_usd: +actualUsd.toFixed(2),
  };
}
