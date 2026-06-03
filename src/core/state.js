// 整個 codebase 的活的結構。對齊 spec 的資料模型：Cell / Edge / Activity。
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
    this.cells = new Map(); // id(絕對路徑) -> Cell
    this.edges = new Map(); // "from->to" -> Edge
    this.activities = []; // 時間序事件，最多保留 500 筆
    this.errorSeen = new Map(); // error message -> 次數
    this.activePromptId = null; // 目前正在跑的 prompt，watcher 改檔時用來歸屬
    this.bornSeq = 0; // 單調遞增：格子出生序，前端用來排「先後長出來」
  }

  rel(absPath) {
    return path.relative(this.root, absPath) || path.basename(absPath);
  }

  ensureCell(absPath) {
    if (this.cells.has(absPath)) return this.cells.get(absPath);
    const ext = path.extname(absPath);
    const rel = this.rel(absPath);
    // 出生時間：現有檔案用檔案系統的建立 / 修改時間（還原真實先後），新檔用現在
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
      depth: rel.split(path.sep).length - 1, // 目錄深度
      category: this.categoryOf(rel), // 功能類別 → 前端用來分層（同類同層）
      born_at: bornAt, // 出生時間（先後順序）
      born_seq: this.bornSeq++, // 本 session 內出生序，live 長出來時遞增
      anomaly: null, // null | 'repeat' | 'stall' | 'error'
    };
    this.cells.set(absPath, cell);
    return cell;
  }

  // 功能類別：取 root 底下的第一段功能目錄當分類（src/core→core、src/cli→cli、bin→bin…）
  categoryOf(rel) {
    const parts = rel.split(path.sep);
    if (parts.length === 1) return 'root'; // 專案根的散檔（config、入口）
    if (parts[0] === 'src' && parts.length > 2) return parts[1]; // src/<功能>/…
    return parts[0]; // bin / sample / 其他頂層目錄
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
    // 先清掉這個檔案舊的 import 邊
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

  // 記一次活動並更新 cell 狀態。promptId 省略時用目前 active 的 prompt 歸屬。
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

  // 哪些 cell import 了 target（影響半徑用）
  importersOf(absPath) {
    const out = [];
    for (const e of this.edges.values()) if (e.to === absPath) out.push(e.from);
    return out;
  }

  // 掃描卡住（active 太久沒變化）
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
