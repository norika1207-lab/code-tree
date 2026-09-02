// Lightweight import parsing. The MVP skips tree-sitter (to avoid native builds stalling install),
// using regex to pull out import / require / from-import, which is enough to draw the dependency links between files.
// Phase 2 swaps in tree-sitter for function-level granularity.
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

// Resolve an import specifier to a real in-project file path (absolute). Returns null when unresolvable (external package).
function resolveJs(fromFile, spec, root) {
  if (!isRelative(spec)) return null; // node_modules / built-in module, don't draw
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of RESOLVE_EXT) {
    const cand = base + ext;
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}

function resolvePy(fromFile, spec, root) {
  const tryBase = (base) => {
    for (const cand of [base + '.py', path.join(base, '__init__.py')]) {
      if (fs.existsSync(cand)) return cand;
    }
    return null;
  };
  if (spec.startsWith('.')) {
    const dots = spec.match(/^\.+/)[0].length;
    const rest = spec.slice(dots).replace(/\./g, path.sep);
    let dir = path.dirname(fromFile);
    for (let i = 1; i < dots; i++) dir = path.dirname(dir);
    return tryBase(path.join(dir, rest));
  }
  // Python projects often run with a package directory on PYTHONPATH, so imports like
  // `import gcal_service` or `from alfred_core import ...` should still draw local links.
  const rel = spec.replace(/\./g, path.sep);
  const seen = new Set();
  const bases = [];
  const push = (base) => { if (!seen.has(base)) { seen.add(base); bases.push(base); } };
  for (let dir = path.dirname(fromFile); dir && dir.startsWith(root); dir = path.dirname(dir)) {
    push(path.join(dir, rel));
    if (dir === root) break;
  }
  push(path.join(root, rel));
  for (const d of ['src', 'lib', 'app', 'backend', 'server', 'core']) push(path.join(root, d, rel));
  for (const base of bases) {
    const resolved = tryBase(base);
    if (resolved) return resolved;
  }
  return null;
}

// Return the array of absolute paths to the in-project files this file imports.
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
