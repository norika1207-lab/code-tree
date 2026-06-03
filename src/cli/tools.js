// File tools for the agent. Every action is emitted → core → the matching cell on the tree lights up / grows.
// This is the seam where "the tree grows out of the agent's trajectory across the codebase".
import fs from 'node:fs';
import path from 'node:path';
import { CODE_EXT } from '../config.js';

// Lock the tool's relative path inside the project, blocking ../ escapes
function safeResolve(root, p) {
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path is outside the project: ${p}`);
  }
  return abs;
}

const ignoreDir = (name) => ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cosmos-tree'].includes(name);

export const TOOL_DEFS = [
  {
    name: 'list_dir',
    description: 'List the files and subfolders inside a folder (relative to the project root). If path is omitted, lists the root directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path, defaults to "."' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file (with line numbers).',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite the full contents of a file. A new file grows a new cell on the tree.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a piece of text old_str in a file with new_str (old_str must be unique within the file).',
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
    description: 'Search the whole project for a keyword/string and return "file:line: line content" for each occurrence. Before reading an entire file, use this to quickly locate which files a symbol, function, or variable appears in, then read_file the relevant ones.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The keyword or snippet to search for' },
        max_results: { type: 'number', description: 'Maximum number of results to return, defaults to 40' },
      },
      required: ['query'],
    },
  },
];

const searchable = (name) =>
  CODE_EXT.includes(path.extname(name)) || /\.(json|md|txt|css|html)$/.test(name);

// emit(action, relPath, extra) is injected by the caller and reports back to core
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
      return lines.length ? lines.sort().join('\n') : '(empty)';
    }

    if (name === 'read_file') {
      const abs = safeResolve(root, input.path);
      const src = fs.readFileSync(abs, 'utf8');
      emit('read', rel(abs));
      const lines = src.split('\n');
      const capped = lines.slice(0, 600);
      const numbered = capped.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`).join('\n');
      return numbered + (lines.length > 600 ? `\n… (${lines.length - 600} more lines)` : '');
    }

    if (name === 'write_file') {
      const abs = safeResolve(root, input.path);
      const existed = fs.existsSync(abs);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.content);
      emit('modify', rel(abs), { created: !existed });
      return `${existed ? 'Overwrote' : 'Created'} ${rel(abs)} (${input.content.split('\n').length} lines)`;
    }

    if (name === 'edit_file') {
      const abs = safeResolve(root, input.path);
      const src = fs.readFileSync(abs, 'utf8');
      const idx = src.indexOf(input.old_str);
      if (idx === -1) return `Error: could not find the text to replace in ${rel(abs)}`;
      if (src.indexOf(input.old_str, idx + 1) !== -1) return `Error: old_str appears multiple times in ${rel(abs)}, please give a more precise snippet`;
      fs.writeFileSync(abs, src.slice(0, idx) + input.new_str + src.slice(idx + input.old_str.length));
      emit('modify', rel(abs));
      return `Modified ${rel(abs)}`;
    }

    if (name === 'search_code') {
      const q = String(input.query || '');
      if (!q) return 'Error: query cannot be empty';
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
      for (const f of matchedFiles) emit('read', f); // the matched cells light up on the tree
      return hits.length ? hits.join('\n') : `No matches found for "${q}"`;
    }

    return `Unknown tool: ${name}`;
  };
}
