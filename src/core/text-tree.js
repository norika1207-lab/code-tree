import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { CODE_EXT, IGNORE_DIRS, isIgnored } from '../config.js';
import { parseImports } from './parser.js';

const MAX_PREVIEW_BYTES = 4 * 1024;
const DEFAULT_LIMIT = 5000;
const LANG_BY_EXT = new Map([
  ['.js', 'js'], ['.jsx', 'jsx'], ['.mjs', 'js'], ['.cjs', 'js'],
  ['.ts', 'ts'], ['.tsx', 'tsx'], ['.py', 'py'], ['.go', 'go'],
  ['.html', 'html'], ['.htm', 'html'], ['.css', 'css'], ['.json', 'json'],
  ['.md', 'md'], ['.sh', 'sh'], ['.zsh', 'sh'], ['.bash', 'sh'],
]);

export function expandHome(input) {
  const s = String(input || '').trim().replace(/^["'`]|["'`]$/g, '');
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  return s;
}

export function isCodePath(file) {
  return CODE_EXT.includes(path.extname(file).toLowerCase());
}

function safeRead(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_PREVIEW_BYTES);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  }
}

function previewOfText(text) {
  return String(text || '').replace(/\t/g, '  ').split('\n').slice(0, 10).join('\n');
}

function languageFor(file, fallback = 'txt') {
  return LANG_BY_EXT.get(path.extname(file).toLowerCase()) || fallback;
}

function categoryOf(rel) {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return 'root';
  if (parts[0] === 'src' && parts[1]) return parts[1];
  return parts[0];
}

function makeCell({ id, path: rel, text = '', source = 'local', root = '', index = 0, status = 'idle' }) {
  const preview = previewOfText(text);
  return {
    id,
    path: rel,
    source,
    root,
    language: languageFor(rel),
    category: categoryOf(rel),
    preview,
    size_lines: text ? String(text).split('\n').length : 0,
    status,
    born_seq: index,
  };
}

function shouldEnterDir(abs) {
  if (isIgnored(abs)) return false;
  const name = path.basename(abs);
  if (IGNORE_DIRS.includes(name)) return false;
  if (name === '.git' || name === 'node_modules') return false;
  return true;
}

function walkFiles(root, limit = DEFAULT_LIMIT) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let i = entries.length - 1; i >= 0; i--) {
      const ent = entries[i];
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (shouldEnterDir(abs)) stack.push(abs);
      } else if (ent.isFile() && isCodePath(abs)) {
        files.push(abs);
        if (files.length >= limit) break;
      }
    }
  }
  return files.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
}

export function looksLikeProject(root) {
  try {
    if (!fs.statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  const markers = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'composer.json', 'README.md', 'src'];
  return markers.some((m) => fs.existsSync(path.join(root, m)));
}

export function scanLocalProject(root, options = {}) {
  const resolved = path.resolve(expandHome(root));
  const limit = options.limit || DEFAULT_LIMIT;
  const files = walkFiles(resolved, limit);
  const relByAbs = new Map(files.map((f) => [f, path.relative(resolved, f) || path.basename(f)]));
  const cells = files.map((abs, index) => {
    const rel = relByAbs.get(abs);
    return makeCell({
      id: `local:${rel}`,
      path: rel,
      text: safeRead(abs),
      source: 'local',
      root: resolved,
      index,
    });
  });
  const edges = [];
  for (const abs of files) {
    const fromRel = relByAbs.get(abs);
    for (const target of parseImports(abs, resolved)) {
      const toRel = relByAbs.get(target);
      if (toRel) edges.push({ id: `local:${fromRel}->${toRel}`, from: fromRel, to: toRel, type: 'import' });
    }
  }
  return {
    root: resolved,
    label: path.basename(resolved) || resolved,
    source: 'local',
    cells,
    edges,
    truncated: files.length >= limit,
  };
}

function extForLang(lang = '') {
  const l = lang.toLowerCase();
  if (l.includes('python') || l === 'py') return '.py';
  if (l.includes('typescript') || l === 'ts') return '.ts';
  if (l.includes('tsx')) return '.tsx';
  if (l.includes('jsx')) return '.jsx';
  if (l.includes('javascript') || l === 'js') return '.js';
  if (l.includes('html')) return '.html';
  if (l.includes('css')) return '.css';
  if (l.includes('shell') || l === 'sh' || l === 'bash' || l === 'zsh') return '.sh';
  if (l.includes('json')) return '.json';
  return '.txt';
}

function filenameNear(text, startIndex, lang) {
  const before = String(text).slice(Math.max(0, startIndex - 420), startIndex);
  const patterns = [
    /(?:file|path|檔案|文件)\s*[:：]\s*([A-Za-z0-9_./@ -]+\.[A-Za-z0-9]+)/i,
    /(?:create|write|update|新增|建立|寫入|修改)\s+([A-Za-z0-9_./@ -]+\.[A-Za-z0-9]+)/i,
    /([A-Za-z0-9_./@ -]+\.(?:js|jsx|ts|tsx|py|html|css|json|md|sh|go|rs|java|php))\s*$/i,
  ];
  for (const re of patterns) {
    const m = before.match(re);
    if (m) return m[1].trim().replace(/\s+/g, '_').replace(/^\.?\//, '');
  }
  return `drafts/gpt-${Date.now().toString(36)}${extForLang(lang)}`;
}

export function cellsFromText(text, options = {}) {
  const input = String(text || '');
  const cells = [];
  const fence = /```([A-Za-z0-9_+.-]*)\s*\n([\s\S]*?)```/g;
  let match;
  let seq = options.startSeq || 0;
  while ((match = fence.exec(input))) {
    const lang = match[1] || '';
    const code = match[2] || '';
    if (!code.trim()) continue;
    const rel = filenameNear(input, match.index, lang);
    cells.push(makeCell({
      id: `text:${rel}`,
      path: rel,
      text: code,
      source: 'gpt-text',
      root: 'gpt-text',
      index: seq++,
      status: 'active',
    }));
    cells[cells.length - 1].content = code;
  }
  if (!cells.length && looksLikeCode(input)) {
    const rel = `drafts/gpt-${Date.now().toString(36)}.txt`;
    cells.push(makeCell({
      id: `text:${rel}`,
      path: rel,
      text: input,
      source: 'gpt-text',
      root: 'gpt-text',
      index: seq++,
      status: 'active',
    }));
    cells[cells.length - 1].content = input;
  }
  return cells;
}

function looksLikeCode(text) {
  const s = String(text || '');
  if (s.split('\n').length < 2) return false;
  return /\b(function|class|const|let|var|def|import|export|return|if|for|while)\b/.test(s);
}

export function projectPathFromText(text) {
  const raw = String(text || '');
  const direct = raw.match(/(?:open|開啟|打開|進入|切到|改|掃描|scan|project|專案)\s+((?:~|\/Users\/|\/Volumes\/|\/opt\/|\/var\/|\/srv\/|\/root\/)[^\n\r"'`]+)/i)
    || raw.match(/((?:~|\/Users\/|\/Volumes\/|\/opt\/|\/var\/|\/srv\/|\/root\/)[^\n\r"'`]+)/);
  if (!direct) return null;
  return expandHome(direct[1].trim().replace(/[，。；;]+$/g, ''));
}

export function remoteSpecFromText(text) {
  const raw = String(text || '').trim();
  const spec = raw.match(/(?:open|開啟|打開|掃描|scan|project|專案)?\s*([A-Za-z0-9._@-]+):(\/[^\s"'`]+)/i)
    || raw.match(/ssh:\/\/([A-Za-z0-9._@-]+)(\/[^\s"'`]+)/i);
  if (!spec) return null;
  if (spec.length === 3 && raw.includes('ssh://')) return { host: spec[1], root: spec[2] };
  return { host: spec[1], root: spec[2] };
}

export function scanRemoteProject(host, root, options = {}) {
  const limit = Number(options.limit || DEFAULT_LIMIT);
  const timeoutMs = Number(options.timeoutMs || 15000);
  const script = `
import json, os, sys
root=sys.argv[1]
limit=int(sys.argv[2])
exts=set(${JSON.stringify(CODE_EXT)})
ignore=set(${JSON.stringify(IGNORE_DIRS)})
cells=[]
for cur, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in ignore and not d.startswith('.git')]
    for name in sorted(files):
        if len(cells) >= limit: break
        ext=os.path.splitext(name)[1].lower()
        if ext not in exts: continue
        p=os.path.join(cur,name)
        rel=os.path.relpath(p, root)
        try:
            with open(p,'r',encoding='utf-8',errors='replace') as f:
                txt=''.join(f.readlines()[:18])
        except Exception:
            txt=''
        cells.append({'id':'%s:%s' % (${JSON.stringify(host)}, rel), 'path':rel, 'source':${JSON.stringify(host)}, 'root':root, 'language':ext[1:] or 'txt', 'category':rel.split('/')[0] if '/' in rel else 'root', 'preview':txt, 'size_lines':txt.count('\\n')+1 if txt else 0, 'status':'idle', 'born_seq':len(cells)})
    if len(cells) >= limit: break
print(json.dumps({'root':root,'label':${JSON.stringify(host)}+':'+os.path.basename(root.rstrip('/')),'source':${JSON.stringify(host)},'cells':cells,'edges':[],'truncated':len(cells)>=limit}, ensure_ascii=False))
`;
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', [host, 'python3', '-c', script, root, String(limit)], { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || err.message || 'remote scan failed').trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error('remote scan returned invalid JSON: ' + e.message));
      }
    });
    child.on('error', reject);
  });
}
