// 品質地板：模型改完的程式碼絕不直接相信，先跑真實檢查。
// 小模型最常犯、又最便宜抓到的兩類錯：
//   1. 語法壞掉（node --check）
//   2. import 了某個 named 符號，但目標檔根本沒 export（getSession vs setSession 那種）
// 任何一關失敗，就把確切錯誤回饋給 agent loop，逼模型修到綠燈才准收工。
//
// 純 Node、無第三方相依，regex 解析（夠抓小模型的低級錯，不追求 100% AST 正確）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const JS_EXT = new Set(['.js', '.mjs', '.cjs']);

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// 把相對 import 路徑解析成實際檔案
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 只查專案內相對 import
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + '.js', base + '.mjs', base + '.cjs', path.join(base, 'index.js')];
  for (const t of tries) {
    try { if (fs.statSync(t).isFile()) return t; } catch {}
  }
  return null;
}

// 抓一個檔案 export 了哪些名字（含 default / 是否有 export *）
export function collectExports(src) {
  const names = new Set();
  let hasWildcard = false;
  // export function/const/let/var/class NAME
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // export default
  if (/export\s+default\b/.test(src)) names.add('default');
  // export { a, b as c }  和  export { a } from './x'
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const seg = part.trim();
      if (!seg) continue;
      const as = seg.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim()); // 對外看到的是 as 後面的名字
    }
  }
  // export * from  → 無法靜態展開名字，標記為萬用，後續對該模組放寬
  if (/export\s*\*\s*from/.test(src)) hasWildcard = true;
  return { names, hasWildcard };
}

// 抓一個檔案 import 了哪些 named 符號（含 default），只回相對 import
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
        const orig = seg.split(/\s+as\s+/)[0].trim(); // import { orig as local } → 要 orig 有被 export
        if (orig) entry.names.push(orig);
      }
    }
    // 預設 import：clause 開頭不是 { 也不是 *
    const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[\w$]+/, '').replace(/,/g, '').trim();
    if (head) entry.wantsDefault = true;
    imports.push(entry);
  }
  return imports;
}

// 對改過的 JS 檔做 import/export 一致性檢查
function checkImportConsistency(root, file) {
  const problems = [];
  const src = read(file);
  if (src == null) return problems;
  for (const imp of collectImports(src)) {
    const target = resolveImport(file, imp.spec);
    if (!target) continue; // 非專案內相對 import，跳過
    const tsrc = read(target);
    if (tsrc == null) continue;
    const { names, hasWildcard } = collectExports(tsrc);
    if (hasWildcard) continue; // 目標有 export * ，放寬避免誤報
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

// 語法檢查。node --check 對 .js 會自動猜 CJS/ESM、對 module 語法不可靠，
// 所以含 import/export 的檔一律複製成暫存 .mjs 強制走模組解析再驗。
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

// 行為地板：靜態檢查抓不到「邏輯對不對」（例如 session key 存錯欄位，語法和 import 都合法）。
// 真正逼小模型寫出「能跑」的程式，要跑專案自己的測試。有 package.json scripts.test 就跑它。
// 跑壞了不算專案的錯（環境問題），只在「測試確實執行且失敗」時才回報 problem。
export function runProjectTests(root) {
  const pkgPath = path.join(root, 'package.json');
  const raw = read(pkgPath);
  if (raw == null) return []; // 沒 package.json，沒測試可跑
  let pkg;
  try { pkg = JSON.parse(raw); } catch { return []; }
  const testScript = pkg.scripts && pkg.scripts.test;
  if (!testScript || /no test specified/i.test(testScript)) return []; // 沒有真正的 test script
  try {
    execFileSync('npm', ['test', '--silent'], { cwd: root, stdio: 'pipe', timeout: 60000 });
    return []; // 綠燈
  } catch (e) {
    // 區分「測試失敗」與「根本跑不起來」：兩者都該逼模型回去看，但訊息不同
    const out = ((e.stdout ? e.stdout.toString() : '') + (e.stderr ? e.stderr.toString() : '')).trim();
    const tail = out.split('\n').filter(Boolean).slice(-12).join('\n') || e.message;
    return [{ file: 'npm test', kind: 'test', message: `專案測試沒過（exit ${e.status ?? '非0'}）。輸出尾段：\n${tail}` }];
  }
}

// 對外主函式：給 root + 改過的檔（相對路徑），回 { ok, problems }
// opts.tests=true 時，靜態檢查全過後再跑專案測試（行為地板）。
export function verifyChangedFiles(root, changedRelPaths = [], opts = {}) {
  const problems = [];
  for (const rel of changedRelPaths) {
    const abs = path.resolve(root, rel);
    if (!fs.existsSync(abs)) continue;
    problems.push(...checkSyntax(root, abs));
    if (JS_EXT.has(path.extname(abs))) problems.push(...checkImportConsistency(root, abs));
  }
  // 語法/import 先過再跑測試：壞語法時跑測試只會噴一堆沒用的 stack，先逼模型修低級錯
  if (opts.tests && problems.length === 0) {
    problems.push(...runProjectTests(root));
  }
  return { ok: problems.length === 0, problems };
}

// 把 problems 排成餵回模型的一段文字
export function formatProblems(problems) {
  let out = '（自動驗證沒過，請修正以下問題，改完不要解釋、直接用工具改檔；全部修好再收工）\n';
  for (const p of problems) out += `- [${p.kind}] ${p.file}：${p.message}\n`;
  return out.trim();
}
