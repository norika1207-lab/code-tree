// Reads the session JSONL that Claude Code writes itself, pulling out the real token usage
// from your "running claude in the terminal" session to feed the token bar above. This is not
// Code Tree's built-in agent (that's a separate stream); it's the one you're actually using.
//
// Claude Code stores each project's conversation in ~/.claude/projects/<encoded cwd>/<session>.jsonl,
// one event per line. The assistant ones carry message.usage:
//   input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
// The same message.id can appear multiple times in the file (streaming snapshots), so dedupe by id, otherwise it double-counts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// cwd → Claude Code's folder name: every non-alphanumeric char becomes '-' (/Users/x/Code Tree → -Users-x-Code-Tree)
export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// Find the most-recently-modified session file in this cwd's folder (= the current conversation)
export function newestSession(cwd) {
  const dir = path.join(projectsDir(), encodeCwd(cwd));
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch { return null; }
  if (!files.length) return null;
  let best = null, bestMs = -1;
  for (const f of files) {
    try { const ms = fs.statSync(f).mtimeMs; if (ms > bestMs) { bestMs = ms; best = f; } } catch {}
  }
  return best;
}

// Sum up a session file's token usage (deduped by message.id)
export function sumSession(file) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, file };
  if (!file) return out;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const msg = d.message;
    const u = msg && msg.usage;
    if (!u) continue;
    const id = msg.id || d.uuid || line.length; // fall back to line content as key when there's no id
    if (seen.has(id)) continue;
    seen.add(id);
    out.input += u.input_tokens || 0;
    out.output += u.output_tokens || 0;
    out.cacheRead += u.cache_read_input_tokens || 0;
    out.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  return out;
}

// Given a cwd, return the current session's cumulative usage directly
export function readUsage(cwd) {
  return sumSession(newestSession(cwd));
}
