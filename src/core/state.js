// The live structure of the whole codebase. Matches the spec's data model: Cell / Edge / Activity.
import path from 'node:path';
import fs from 'node:fs';
import { ANOMALY, CODE_EXT } from '../config.js';

const LANG = {
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.ts': 'ts', '.tsx': 'tsx', '.py': 'py', '.go': 'go',
  '.html': 'html', '.htm': 'html', '.svg': 'svg', '.css': 'css',
  '.vue': 'vue', '.svelte': 'svelte',
};

function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

export class Graph {
  constructor(root) {
    this.root = root;
    this.cells = new Map(); // id(absolute path) -> Cell
    this.edges = new Map(); // "from->to" -> Edge
    this.activities = []; // time-ordered events, keep at most 500
    this.errorSeen = new Map(); // error message -> count
    this.activePromptId = null; // the prompt currently running; used to attribute file edits the watcher catches
    this.bornSeq = 0; // monotonically increasing: cell birth order, used by the frontend to order "which grew first"
  }

  rel(absPath) {
    return path.relative(this.root, absPath) || path.basename(absPath);
  }

  ensureCell(absPath) {
    if (this.cells.has(absPath)) return this.cells.get(absPath);
    const ext = path.extname(absPath);
    const rel = this.rel(absPath);
    // Birth time: existing files use the filesystem's create/modify time (to recover the true order), new files use now
    let bornAt = Date.now();
    try {
      const st = fs.statSync(absPath);
      bornAt = Math.min(st.birthtimeMs || Infinity, st.mtimeMs || Infinity);
      if (!Number.isFinite(bornAt)) bornAt = Date.now();
    } catch {}
    const cell = {
      id: absPath,
      type: 'file',
      path: rel,
      status: 'idle', // idle | active | modified | error
      modification_count: 0,
      last_modified_at: null,
      last_active_at: Date.now(),
      language: LANG[ext] || ext.replace('.', '') || 'txt',
      size_lines: countLines(absPath),
      depth: rel.split(path.sep).length - 1, // directory depth
      category: this.categoryOf(rel), // functional category → frontend layers by this (same category, same layer)
      born_at: bornAt, // birth time (ordering)
      born_seq: this.bornSeq++, // birth order within this session, incremented as cells grow live
      anomaly: null, // null | 'repeat' | 'stall' | 'error'
    };
    this.cells.set(absPath, cell);
    return cell;
  }

  // Functional category: take the first functional directory under root as the category (src/core→core, src/cli→cli, bin→bin…)
  categoryOf(rel) {
    const parts = rel.split(path.sep);
    if (parts.length === 1) return 'root'; // loose files at the project root (config, entry points)
    if (parts[0] === 'src' && parts.length > 2) return parts[1]; // src/<feature>/…
    return parts[0]; // bin / sample / other top-level directories
  }

  removeCell(absPath) {
    this.cells.delete(absPath);
    for (const key of [...this.edges.keys()]) {
      if (key.startsWith(absPath + '->') || key.endsWith('->' + absPath)) {
        this.edges.delete(key);
      }
    }
  }

  setImports(absPath, targets) {
    // First clear this file's old import edges
    for (const key of [...this.edges.keys()]) {
      if (key.startsWith(absPath + '->')) this.edges.delete(key);
    }
    for (const to of targets) {
      this.ensureCell(to);
      const key = `${absPath}->${to}`;
      this.edges.set(key, { from: absPath, to, type: 'import', weight: 1 });
    }
  }

  isCode(absPath) {
    return CODE_EXT.includes(path.extname(absPath));
  }

  // Record an activity and update the cell's status. When promptId is omitted, attribute to the currently active prompt.
  record(absPath, action, promptId = this.activePromptId) {
    const cell = this.ensureCell(absPath);
    const now = Date.now();
    cell.last_prompt_id = promptId;
    cell.last_active_at = now;
    if (action === 'modify' || action === 'create') {
      cell.modification_count += 1;
      cell.last_modified_at = now;
      cell.size_lines = countLines(absPath);
      cell.status = cell.modification_count >= ANOMALY.REPEAT_MODIFY ? 'error' : 'modified';
      if (cell.modification_count >= ANOMALY.REPEAT_MODIFY) cell.anomaly = 'repeat';
    } else if (action === 'read' || action === 'active') {
      if (cell.status === 'idle') cell.status = 'active';
    } else if (action === 'delete') {
      this.removeCell(absPath);
    }
    this.activities.push({
      timestamp: now,
      cell_id: absPath,
      path: this.rel(absPath),
      action,
      prompt_id: promptId,
      modification_count: cell.modification_count,
    });
    if (this.activities.length > 500) this.activities.shift();
    return cell;
  }

  // Which cells import the target (used for the blast radius)
  importersOf(absPath) {
    const out = [];
    for (const e of this.edges.values()) if (e.to === absPath) out.push(e.from);
    return out;
  }

  // Scan for stalls (active too long with no change)
  checkStall() {
    const now = Date.now();
    const stalled = [];
    for (const cell of this.cells.values()) {
      if (
        (cell.status === 'active' || cell.status === 'modified') &&
        now - cell.last_active_at > ANOMALY.STALL_MS &&
        cell.anomaly !== 'stall'
      ) {
        cell.anomaly = 'stall';
        stalled.push(cell);
      }
    }
    return stalled;
  }

  snapshot() {
    return {
      root: this.root,
      cells: [...this.cells.values()],
      edges: [...this.edges.values()],
      recent: this.activities.slice(-30),
    };
  }
}
