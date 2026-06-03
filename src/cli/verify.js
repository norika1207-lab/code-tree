// Quality floor: never just trust code the model finished; run real checks first.
// The two error classes small models commit most often and that are cheapest to catch:
//   1. broken syntax (node --check)
//   2. importing a named symbol the target file never exports (the getSession vs setSession kind)
// On any failure, feed the exact error back to the agent loop, forcing the model to fix to green before it's allowed to finish.
//
// Pure Node, no third-party deps, regex parsing (enough to catch small models' rookie errors, not aiming for 100% AST correctness).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Resolve a relative import path to an actual file
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // only check project-internal relative imports
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + '.js', base + '.mjs', base + '.cjs', path.join(base, 'index.js')];
  for (const t of tries) {
    try { if (fs.statSync(t).isFile()) return t; } catch {}
  }
  return null;
}

// Collect which names a file exports (including default / whether it has export *)
export function collectExports(src) {
  const names = new Set();
  let hasWildcard = false;
  // export function/const/let/var/class NAME
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export default
  if (/export\s+default\b/.test(src)) names.add('default');
  // export { a, b as c }  and  export { a } from './x'
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim()); // the externally visible name is the one after `as`
    }
  }
  // export * from  → names can't be statically expanded; mark as wildcard and relax checks against that module later
  if (/export\s*\*\s*from/.test(src)) hasWildcard = true;
  return { names, hasWildcard };
}

// Collect which named symbols a file imports (including default); only returns relative imports
function collectImports(src) {
  const imports = []; // { spec, names:[], wantsDefault:bool, wildcard:bool }
  const re = /import\s+([^'"]+?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const m of src.matchAll(re)) {
    const clause = m[1].trim();
    const spec = m[2];
    const entry = { spec, names: [], wantsDefault: false, wildcard: false };
    if (/\*\s+as\s+/.test(clause)) { entry.wildcard = true; }
    const braced = clause.match(/\{([^}]*)\}/);
    if (braced) {
      for (const part of braced[1].split(',')) {
        const seg = part.trim();
        if (!seg) continue;
        const orig = seg.split(/\s+as\s+/)[0].trim(); // import { orig as local } → orig must be exported
        if (orig) entry.names.push(orig);
      }
    }
    // default import: the clause doesn't start with { or *
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, '').trim();
    if (head) entry.wantsDefault = true;
    imports.push(entry);
  }
  return imports;
}

// Run an import/export consistency check on a changed JS file
function checkImportConsistency(root, file) {
  const problems = [];
  const src = read(file);
  if (src == null) return problems;
  for (const imp of collectImports(src)) {
    const target = resolveImport(file, imp.spec);
    if (!target) continue; // not a project-internal relative import, skip
    const tsrc = read(target);
    if (tsrc == null) continue;
    const { names, hasWildcard } = collectExports(tsrc);
    if (hasWildcard) continue; // target has export *, relax to avoid false positives
    const rel = path.relative(root, target);
    if (imp.wantsDefault && !names.has('default')) {
      problems.push({ file: path.relative(root, file), kind: 'import', message: `從 ${rel} 預設匯入，但該檔沒有 export default` });
    }
    for (const n of imp.names) {
      if (!names.has(n)) {
        const avail = [...names].filter((x) => x !== 'default').join(', ') || '(無)';
        problems.push({ file: path.relative(root, file), kind: 'import', message: `匯入了 ${rel} 的 { ${n} }，但該檔沒有 export 這個名字。該檔實際 export：${avail}` });
      }
    }
  }
  return problems;
}

// Syntax check. node --check auto-guesses CJS/ESM for .js and is unreliable on module syntax,
// so any file containing import/export is copied to a temp .mjs to force module parsing before checking.
function checkSyntax(root, file) {
  const ext = path.extname(file);
  if (!JS_EXT.has(ext)) return [];
  const src = read(file);
  if (src == null) return [];
  const isModule = ext === '.mjs' || /^\s*(export|import)\s/m.test(src);
  let target = file;
  let tmp = null;
  if (isModule && ext !== '.mjs') {
    tmp = path.join(os.tmpdir(), `vfchk-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
    try { fs.writeFileSync(tmp, src); target = tmp; } catch { target = file; }
  }
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe', timeout: 10000 });
    return [];
  } catch (e) {
    const raw = (e.stderr ? e.stderr.toString() : e.message);
    const msg = raw.replace(tmp || '', path.relative(root, file)).split('\n').filter(Boolean).slice(0, 4).join(' ');
    return [{ file: path.relative(root, file), kind: 'syntax', message: msg }];
  } finally {
    if (tmp) { try { fs.unlinkSync(tmp); } catch {} }
  }
}

// Behavior floor: static checks can't catch "is the logic right" (e.g. a session key stored in the wrong field, where syntax and imports are both valid).
// To really force a small model to write code that "runs", run the project's own tests. If package.json scripts.test exists, run it.
// A run that breaks isn't the project's fault (environment issue); only report a problem when "the tests actually ran and failed".
export function runProjectTests(root) {
  const pkgPath = path.join(root, 'package.json');
  const raw = read(pkgPath);
  if (raw == null) return []; // no package.json, no tests to run
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return []; }
  const testScript = pkg.scripts && pkg.scripts.test;
  if (!testScript || /no test specified/i.test(testScript)) return []; // no real test script
  try {
    execFileSync('npm', ['test', '--silent'], { cwd: root, stdio: 'pipe', timeout: 60000 });
    return []; // green
  } catch (e) {
    // distinguish "tests failed" from "couldn't even run": both should send the model back to look, but the message differs
    const out = ((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')).trim();
    const tail = out.split('\n').filter(Boolean).slice(-12).join('\n') || e.message;
    return [{ file: 'npm test', kind: 'test', message: `專案測試沒過（exit ${e.status ?? '非0'}）。輸出尾段：\n${tail}` }];
  }
}

// Public entry point: given root + changed files (relative paths), returns { ok, problems }
// When opts.tests=true, run the project tests (behavior floor) after all static checks pass.
export function verifyChangedFiles(root, changedRelPaths = [], opts = {}) {
  const problems = [];
  for (const rel of changedRelPaths) {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) continue;
    problems.push(...checkSyntax(root, abs));
    if (JS_EXT.has(path.extname(abs))) problems.push(...checkImportConsistency(root, abs));
  }
  // syntax/import must pass before running tests: running tests on broken syntax just spews a useless stack, so force the model to fix the rookie errors first
  if (opts.tests && problems.length === 0) {
    problems.push(...runProjectTests(root));
  }
  return { ok: problems.length === 0, problems };
}

// Format problems into a block of text to feed back to the model
export function formatProblems(problems) {
  let out = '（自動驗證沒過，請修正以下問題，改完不要解釋、直接用工具改檔；全部修好再收工）\n';
  for (const p of problems) out += `- [${p.kind}] ${p.file}：${p.message}\n`;
  return out.trim();
}
