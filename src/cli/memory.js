// Trajectory memory (the continuously-evolving "fast loop"):
// Each time the agent finishes a task, write "task / which files read / which files modified / approach summary / whether it finished cleanly"
// as one JSONL line. On the next similar task, recall the most similar few and stuff them into the system prompt,
// so the small model stands on its own past experience and gets "more familiar with this codebase the more it's used" without retraining weights.
//
// No network, no embedding service: score by token overlap (ascii words + Chinese characters/bigrams),
// runs locally, zero deps, unit-testable. The corpus is the agent's own trajectories across this project.
import fs from 'node:fs';
import path from 'node:path';

const MEM_DIR = '.cosmos-tree';
const MEM_FILE = 'trajectories.jsonl';

// Split a string into a comparable token set: alphanumeric words + Chinese characters + Chinese bigrams
export function tokenize(s) {
  const str = String(s || '').toLowerCase();
  const toks = new Set();
  for (const m of str.matchAll(/[a-z0-9_]{2,}/g)) toks.add(m[0]);
  const cjk = str.match(/[一-鿿]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    toks.add(cjk[i]);
    if (i + 1 < cjk.length) toks.add(cjk[i] + cjk[i + 1]);
  }
  return toks;
}

export function overlapScore(queryToks, text) {
  const t = tokenize(text);
  let s = 0;
  for (const tok of queryToks) if (t.has(tok)) s++;
  return s;
}

export function createMemory({ root, model = 'unknown', topK = 3, maxChars = 1200 } = {}) {
  const dir = path.join(root, MEM_DIR);
  const file = path.join(dir, MEM_FILE);

  function loadAll() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  // For a new task, recall the most similar old trajectories that "finished cleanly and actually changed files", and assemble a prompt snippet
  function recall(task) {
    const all = loadAll();
    if (!all.length) return '';
    const q = tokenize(task);
    if (!q.size) return '';
    const ranked = all
      .filter((r) => r.endedCleanly && (r.filesModified?.length || 0) > 0)
      .map((r) => ({
        r,
        s: overlapScore(q, r.task) + overlapScore(q, (r.filesModified || []).join(' ')),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, topK);
    if (!ranked.length) return '';
    // For small models, the wording must "give it permission to follow" rather than "tell it not to copy".
    // Observed that the old wording "for reference only, don't copy" made weak models deliberately ignore the verified fix and invent a wrong approach instead.
    let out = '(You have fixed almost the same problem in this project before. Below is the fix that "passed verification" back then. First use read_file to check the current state; as long as the problem is essentially the same, apply this fix directly with edit_file/write_file on the SAME file. Do not invent a new approach and do not add new files.)\n';
    for (const { r } of ranked) {
      const line =
        `- Task: ${String(r.task).slice(0, 120)}\n` +
        `  Files changed then: ${(r.filesModified || []).join(', ')}\n` +
        `  Approach summary: ${String(r.summary || '').replace(/\s+/g, ' ').slice(0, 160)}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return out.trim();
  }

  // Write one trajectory (append-only; a bad line won't corrupt the others)
  function record(traj = {}) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const row = {
        ts: new Date().toISOString(),
        model,
        task: String(traj.task || ''),
        filesRead: [...new Set(traj.filesRead || [])],
        filesModified: [...new Set(traj.filesModified || [])],
        toolCount: traj.toolCount || 0,
        endedCleanly: !!traj.endedCleanly,
        summary: String(traj.summary || '').replace(/\s+/g, ' ').slice(0, 500),
      };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    } catch {
      return null; // a memory write failure must never drag down the main task
    }
  }

  return { recall, record, loadAll, file };
}
