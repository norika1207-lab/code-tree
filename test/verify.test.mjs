// 品質地板（驗證引擎）單元測試：node test/verify.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyChangedFiles, collectExports, formatProblems } from '../src/cli/verify.js';

let pass = 0;
function ok(name, cond) { assert.ok(cond, name); console.log('  ✓ ' + name); pass++; }

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

// ── 測 1：collectExports 各種寫法 ──
{
  const e = collectExports(`export function a(){} export const b=1; export default x; export { c, d as e };`);
  ok('抓 function/const', e.names.has('a') && e.names.has('b'));
  ok('抓 default', e.names.has('default'));
  ok('抓 export{} 的對外名', e.names.has('c') && e.names.has('e') && !e.names.has('d'));
}

// ── 測 2：乾淨的 repo 應該過 ──
{
  const root = tmpRepo({
    'src/store.js': `export function getSession(id){return id;}\nexport function setSession(id,v){}`,
    'src/auth.js': `import { getSession } from './store.js';\nexport function f(){ return getSession(1); }`,
  });
  const r = verifyChangedFiles(root, ['src/auth.js']);
  ok('一致的 import 過驗證', r.ok && r.problems.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 3：import 了不存在的 export（小模型最常犯）──
{
  const root = tmpRepo({
    'src/store.js': `export function getSession(id){return id;}`,
    'src/auth.js': `import { setSession } from './store.js';\nexport function f(){ return setSession(1); }`,
  });
  const r = verifyChangedFiles(root, ['src/auth.js']);
  ok('抓到不存在的 named import', !r.ok && r.problems.some(p => p.kind === 'import' && p.message.includes('setSession')));
  ok('錯誤訊息列出實際可用 export', r.problems.some(p => p.message.includes('getSession')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 4：語法壞掉要抓到 ──
{
  const root = tmpRepo({ 'bad.js': `export function f( { return 1 ` });
  const r = verifyChangedFiles(root, ['bad.js']);
  ok('抓到語法錯誤', !r.ok && r.problems.some(p => p.kind === 'syntax'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 5：export * 放寬、外部/node import 不誤報 ──
{
  const root = tmpRepo({
    'src/all.js': `export * from './hidden.js';`,
    'src/use.js': `import fs from 'node:fs';\nimport { whatever } from './all.js';\nexport const x = whatever;`,
  });
  const r = verifyChangedFiles(root, ['src/use.js']);
  ok('export * 放寬不誤報、node 內建跳過', r.ok);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 6：formatProblems 產出可餵回的文字 ──
{
  const txt = formatProblems([{ file: 'a.js', kind: 'import', message: '沒有 export setSession' }]);
  ok('format 帶檔名與訊息', txt.includes('a.js') && txt.includes('setSession'));
}

console.log(`\n全部通過：${pass} 項`);
