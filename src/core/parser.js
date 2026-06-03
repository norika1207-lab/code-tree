// 輕量 import 解析。MVP 不用 tree-sitter（避免 native build 卡安裝），
// 用 regex 抽出 import / require / from-import，足夠畫出檔案間的依賴連線。
// Phase 2 再換 tree-sitter 做 function 層級。
import path from 'node:path';
import fs from 'node:fs';

const JS_PATTERNS = [
  /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, // import x from 'y' / import 'y'
  /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
  /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('y')
  /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g, // re-export
];

const PY_PATTERNS = [
  /^\s*from\s+([.\w]+)\s+import\s+/gm, // from x import y
  /^\s*import\s+([.\w]+)/gm, // import x
];

const RESOLVE_EXT = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts'];

function isRelative(spec) {
  return spec.startsWith('.') || spec.startsWith('/');
}

// 把 import specifier 解析成專案內真實檔案路徑（絕對）。解不到回 null（外部套件）。
function resolveJs(fromFile, spec, root) {
  if (!isRelative(spec)) return null; // node_modules / 內建模組，不畫
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) {
    const cand = base + ext;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function resolvePy(fromFile, spec, root) {
  if (!spec.startsWith('.')) return null; // 只解相對 import
  const dots = spec.match(/^\.+/)[0].length;
  const rest = spec.slice(dots).replace(/\./g, path.sep);
  let dir = path.dirname(fromFile);
  for (let i = 1; i < dots; i++) dir = path.dirname(dir);
  const base = path.join(dir, rest);
  for (const cand of [base + '.py', path.join(base, '__init__.py')]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

// 回傳這個檔案 import 到的「專案內」檔案絕對路徑陣列。
export function parseImports(filePath, root) {
  let src;
  try {
    src = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const ext = path.extname(filePath);
  const isPy = ext === '.py';
  const patterns = isPy ? PY_PATTERNS : JS_PATTERNS;
  const specs = new Set();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) specs.add(m[1]);
  }
  const targets = new Set();
  for (const spec of specs) {
    const resolved = isPy ? resolvePy(filePath, spec, root) : resolveJs(filePath, spec, root);
    if (resolved) targets.add(resolved);
  }
  return [...targets];
}
