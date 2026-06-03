// 給 agent 的檔案工具。每個動作都 emit 出去 → core → 樹上對應的格子亮起來/長出來。
// 這就是「樹從 agent 走過 codebase 的軌跡長出來」的接點。
import fs from 'node:fs';
import path from 'node:path';
import { CODE_EXT } from '../config.js';

// 把工具給的相對路徑鎖在專案內，擋住 ../ 逃逸
function safeResolve(root, p) {
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路徑超出專案範圍: ${p}`);
  }
  return abs;
}

const ignoreDir = (name) => ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cosmos-tree'].includes(name);

export const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: '列出某個資料夾下的檔案與子資料夾（相對於專案根）。不給 path 就列根目錄。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相對路徑，預設 "."' } },
    },
  },
  {
    name: 'read_file',
    description: '讀取一個檔案的內容（附行號）。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: '建立或覆寫一個檔案的完整內容。新檔會在樹上長出新格子。',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: '把檔案裡某段文字 old_str 換成 new_str（old_str 必須在檔案中唯一）。',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
  },
  {
    name: 'search_code',
    description: '在整個專案裡搜尋一個關鍵字/字串，回傳每個出現位置的「檔案:行號: 該行內容」。動手讀整個檔案前，先用這個快速定位某個符號、函式、變數出現在哪些檔案，再針對性地 read_file。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要搜尋的關鍵字或片段' },
        max_results: { type: 'number', description: '最多回傳幾筆，預設 40' },
      },
      required: ['query'],
    },
  },
];

const searchable = (name) =>
  CODE_EXT.includes(path.extname(name)) || /\.(json|md|txt|css|html)$/.test(name);

// emit(action, relPath, extra) 由 caller 注入，負責回報給 core
export function makeExecutor(root, emit) {
  const rel = (abs) => path.relative(root, abs) || path.basename(abs);

  return async function execute(name, input) {
    if (name === 'list_dir') {
      const dir = safeResolve(root, input.path || '.');
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const lines = [];
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!ignoreDir(e.name)) lines.push(`${e.name}/`);
        } else if (CODE_EXT.includes(path.extname(e.name)) || /\.(json|md|txt|css|html)$/.test(e.name)) {
          lines.push(e.name);
        }
      }
      emit('read', rel(dir));
      return lines.length ? lines.sort().join('\n') : '(空)';
    }

    if (name === 'read_file') {
      const abs = safeResolve(root, input.path);
      const src = fs.readFileSync(abs, 'utf8');
      emit('read', rel(abs));
      const lines = src.split('\n');
      const capped = lines.slice(0, 600);
      const numbered = capped.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
      return numbered + (lines.length > 600 ? `\n… (還有 ${lines.length - 600} 行)` : '');
    }

    if (name === 'write_file') {
      const abs = safeResolve(root, input.path);
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.content);
      emit('modify', rel(abs), { created: !existed });
      return `${existed ? '已覆寫' : '已建立'} ${rel(abs)}（${input.content.split('\n').length} 行）`;
    }

    if (name === 'edit_file') {
      const abs = safeResolve(root, input.path);
      const src = fs.readFileSync(abs, 'utf8');
      const idx = src.indexOf(input.old_str);
      if (idx === -1) return `錯誤：在 ${rel(abs)} 找不到要替換的文字`;
      if (src.indexOf(input.old_str, idx + 1) !== -1) return `錯誤：old_str 在 ${rel(abs)} 出現多次，請給更精確的片段`;
      fs.writeFileSync(abs, src.slice(0, idx) + input.new_str + src.slice(idx + input.old_str.length));
      emit('modify', rel(abs));
      return `已修改 ${rel(abs)}`;
    }

    if (name === 'search_code') {
      const q = String(input.query || '');
      if (!q) return '錯誤：query 不可空白';
      const limit = Math.min(Number(input.max_results) || 40, 200);
      const ql = q.toLowerCase();
      const hits = [];
      const matchedFiles = new Set();
      const walk = (dir) => {
        if (hits.length >= limit) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (hits.length >= limit) break;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) { if (!ignoreDir(e.name)) walk(abs); continue; }
          if (!searchable(e.name)) continue;
          let src;
          try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
          if (src.length > 500000) continue;
          const lines = src.split('\n');
          let perFile = 0;
          for (let i = 0; i < lines.length && hits.length < limit && perFile < 5; i++) {
            if (lines[i].toLowerCase().includes(ql)) {
              hits.push(`${rel(abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
              matchedFiles.add(rel(abs));
              perFile++;
            }
          }
        }
      };
      walk(root);
      for (const f of matchedFiles) emit('read', f); // 命中的格子在樹上亮起來
      return hits.length ? hits.join('\n') : `找不到符合「${q}」的內容`;
    }

    return `未知工具: ${name}`;
  };
}
