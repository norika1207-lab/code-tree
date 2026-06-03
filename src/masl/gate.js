// MASL gate (pure logic): before the agent edits a file, work out who that edit would take down with it (the blast radius),
// and assemble a report for the developer. The intercept / approval UI lives in the CLI; this module only computes.
//
// Data source: the snapshot the CLI receives from core (cells + edges).
//   cell  = { id: absolute path, path: relative path, ... }
//   edge  = { from: absolute path, to: absolute path, type:'import' }  // from imports to
// So "who breaks" = the reverse: who imports me → importers. Taking the transitive closure along reverse edges is the blast radius.
import path from 'node:path';

// Which tools "actually change things" → must pass the gate. Read-only ones like Read / list / grep are allowed through.
const MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['Bash', 'bash']);

export function isMutation(toolName) {
  return MUTATION_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName);
}

// Build a reverse-dependency index from the snapshot. relById maps absolute paths back to relative paths.
export function buildDepIndex(cells = [], edges = [], root = '') {
  const relById = new Map();
  for (const c of cells) relById.set(c.id, c.path);
  const relOf = (abs) => relById.get(abs) || (root ? path.relative(root, abs) : abs);

  const importersByRel = new Map(); // rel(the imported file) -> Set(rel) (the files that import it)
  for (const e of edges) {
    if (e.type && e.type !== 'import') continue;
    const toRel = relOf(e.to);
    const fromRel = relOf(e.from);
    if (!importersByRel.has(toRel)) importersByRel.set(toRel, new Set());
    importersByRel.get(toRel).add(fromRel);
  }
  return { relById, importersByRel };
}

// Transitive closure: editing startRel, which files get dragged down (those that import it directly + indirectly).
export function blastRadius(index, startRel) {
  const seen = new Set();
  const q = [startRel];
  while (q.length) {
    const cur = q.shift();
    const importers = index.importersByRel.get(cur);
    if (!importers) continue;
    for (const imp of importers) {
      if (!seen.has(imp) && imp !== startRel) {
        seen.add(imp);
        q.push(imp);
      }
    }
  }
  return [...seen];
}

// Assess a single tool call into a report. The input shape varies by tool:
//   Write/Edit → file_path; write_file/edit_file → path; Bash → command (no explicit file)
export function assessTool({ index, toolName, input = {}, root = '' }) {
  const shell = SHELL_TOOLS.has(toolName);
  const rawPath = input.file_path ?? input.path ?? null;
  const targetRel = rawPath
    ? (path.isAbsolute(rawPath) && root ? path.relative(root, rawPath) : rawPath)
    : null;

  // Bash has no explicit target file → can't derive a blast radius, so mark it "needs a human look".
  if (shell) {
    return {
      tool: toolName,
      kind: 'shell',
      targetRel: null,
      command: (input.command || '').slice(0, 200),
      blast: [],
      blastCount: 0,
      severity: 'review', // a command could delete files / run migrations, so always require the dev's nod
      reason: "This is a shell command. Its blast radius can't be derived from the dependency graph, so it needs your review.",
    };
  }

  const blast = targetRel ? blastRadius(index, targetRel) : [];
  // Severity: the more it drags down, the redder. 0 = safe, 1-2 = caution, 3+ = high risk.
  const severity = blast.length === 0 ? 'safe' : blast.length <= 2 ? 'caution' : 'high';
  return {
    tool: toolName,
    kind: 'edit',
    targetRel,
    command: null,
    blast,
    blastCount: blast.length,
    severity,
    reason: blast.length === 0
      ? 'Nothing else imports it, relatively safe to change.'
      : `${blast.length} file(s) import it. Breaking it will cascade to them.`,
  };
}

// ── New criteria (v2): don't "intercept whenever something looks off", that fires every time and is maddening. ──
// Switched to "stay quiet by default, only speak up for these four genuinely dangerous cases":
//   1. irreversible    shell deleting files / reset / push -f / migration / overwriting redirect
//   2. touches public interface  edited/removed an export others import (not an internal implementation change)
//   3. off-script      says it'll edit A but actually edits B
//   4. thrashing       same file edited over and over + the same error keeps recurring (spinning in place)
// blastRadius no longer triggers an intercept on its own; it's demoted to a "background signal" added to reason.

// Dangerous shell patterns: the kind you can't undo.
const DANGEROUS_SHELL = [
  /\brm\s+-[rf]/i, /\brm\s+-rf?\b/i, /\brm\s+\//i,
  /git\s+reset\s+--hard/i, /git\s+push\s+[^|]*(-f\b|--force)/i,
  /git\s+clean\s+-[a-z]*f/i, /git\s+checkout\s+--\s+\./i,
  /\bdrop\s+table\b/i, /\btruncate\s+table\b/i, /\bmigrate\b/i,
  /\bmkfs\b/i, /\bdd\s+if=/i, /:\s*>\s*\S+/, /\bchmod\s+-R\b/i,
];

// Roughly extract public export names + a rough signature from source (for functions, the arg count).
// Not a full parser, just enough to judge "did the interface change".
export function extractExports(source = '') {
  const map = new Map();
  const add = (name, sig) => { if (name) map.set(name, sig || name); };
  // export function NAME(args) / export async function NAME(args)
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g)) {
    const args = m[2].split(',').map((s) => s.trim()).filter(Boolean).length;
    add(m[1], `fn:${args}`);
  }
  // export class NAME
  for (const m of source.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) add(m[1], 'class');
  // export const/let/var NAME
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) add(m[1], 'const');
  // export { a, b as c }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) add(name, 'reexport');
    }
  }
  if (/export\s+default\b/.test(source)) add('default', 'default');
  return map;
}

// Diff exports before vs after: return the lists of "removed" and "signature changed". Additions don't count (they won't break existing dependencies).
export function diffExports(prevSource, nextSource) {
  const prev = extractExports(prevSource);
  const next = extractExports(nextSource);
  const removed = [];
  const changed = [];
  for (const [name, sig] of prev) {
    if (!next.has(name)) removed.push(name);
    else if (next.get(name) !== sig) changed.push(name);
  }
  return { removed, changed, breaking: removed.length + changed.length > 0 };
}

// Main decision. report = assessTool's output (with blast radius as background). ctx carries this action's context:
//   { prevSource, nextSource, declaredTarget, actualTarget, modCount, errorRecurring }
// Returns { gate, category, reason, blast } (only gate=true interrupts the human).
export function decideGate(report, ctx = {}) {
  const blast = report.blast || [];
  const blastNote = report.blastCount > 0 ? `(background: ${report.blastCount} file(s) import it)` : '';

  // 1. irreversible shell
  if (report.kind === 'shell') {
    const cmd = report.command || '';
    const hit = DANGEROUS_SHELL.some((re) => re.test(cmd));
    if (hit) return { gate: true, category: 'irreversible', reason: `Irreversible command, no undo: ${cmd.slice(0, 120)}`, blast };
    return { gate: false, category: 'shell-safe', reason: 'Ordinary shell command, allowed.', blast };
  }

  // 3. off-script: claims to edit A but edits B instead
  const declared = ctx.declaredTarget;
  const actual = ctx.actualTarget || report.targetRel;
  if (declared && actual && declared !== actual) {
    return { gate: true, category: 'off-script', reason: `agent said it would edit ${declared} but is touching ${actual} instead, looks off-script.`, blast };
  }

  // 4. thrashing: repeated edits + the same error recurring (takes priority over "internal-only is allowed", because spinning in place should stop even if only internals are touched)
  if ((ctx.modCount || 0) >= 4 && ctx.errorRecurring) {
    return { gate: true, category: 'thrashing', reason: `This file was edited ${ctx.modCount}x and the same error keeps recurring, looks like thrashing. Pause and try another approach.`, blast };
  }

  // 2. touches the public interface (removed/changed export) and something actually depends on it
  if (ctx.prevSource != null && ctx.nextSource != null) {
    const d = diffExports(ctx.prevSource, ctx.nextSource);
    if (d.breaking && report.blastCount > 0) {
      const what = [...d.removed.map((n) => `removed ${n}`), ...d.changed.map((n) => `changed signature of ${n}`)].join(', ');
      return { gate: true, category: 'breaking-api', reason: `Touches the public interface (${what}), ${report.blastCount} dependent file(s) will break.`, blast };
    }
    // edited but only internals / only added exports → stay quiet and allow
    return { gate: false, category: 'internal-edit', reason: `Internal change only, public interface untouched, allowed ${blastNote}`, blast };
  }

  // everything else is allowed (quiet by default)
  return { gate: false, category: 'default-pass', reason: `None of the four red lines hit, allowed ${blastNote}`, blast };
}

// For CLI rendering: flatten the report into a few lines of text.
export function reportLines(report, agentSaid = '') {
  const lines = [];
  const head = report.kind === 'shell'
    ? `⛔ MASL intercept: shell command`
    : `⛔ MASL intercept: ${report.tool} → ${report.targetRel || '(unknown file)'}`;
  lines.push(head);
  if (report.command) lines.push(`  Command: ${report.command}`);
  if (agentSaid) lines.push(`  agent said: ${agentSaid.slice(0, 120)}`);
  lines.push(`  Impact: ${report.reason}`);
  if (report.blastCount > 0) {
    lines.push(`  Hits: ${report.blast.slice(0, 6).join(', ')}${report.blastCount > 6 ? ` …+${report.blastCount - 6}` : ''}`);
  }
  return lines;
}
