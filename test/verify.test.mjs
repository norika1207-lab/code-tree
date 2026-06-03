// Quality floor (verification engine) unit tests: node test/verify.test.mjs
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

// ── Test 1: collectExports across various forms ──
{
  const e = collectExports(`export function a(){} export const b=1; export default x; export { c, d as e };`);
  ok('catch function/const', e.names.has('a') && e.names.has('b'));
  ok('catch default', e.names.has('default'));
  ok('catch the exported names in export{}', e.names.has('c') && e.names.has('e') && !e.names.has('d'));
}

// ── Test 2: a clean repo should pass ──
{
  const root = tmpRepo({
    'src/store.js': `export function getSession(id){return id;}\nexport function setSession(id,v){}`,
    'src/auth.js': `import { getSession } from './store.js';\nexport function f(){ return getSession(1); }`,
  });
  const r = verifyChangedFiles(root, ['src/auth.js']);
  ok('consistent imports pass verification', r.ok && r.problems.length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 3: importing an export that doesn't exist (small models' most common mistake) ──
{
  const root = tmpRepo({
    'src/store.js': `export function getSession(id){return id;}`,
    'src/auth.js': `import { setSession } from './store.js';\nexport function f(){ return setSession(1); }`,
  });
  const r = verifyChangedFiles(root, ['src/auth.js']);
  ok('catch a nonexistent named import', !r.ok && r.problems.some(p => p.kind === 'import' && p.message.includes('setSession')));
  ok('error message lists the actually available exports', r.problems.some(p => p.message.includes('getSession')));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 4: broken syntax must be caught ──
{
  const root = tmpRepo({ 'bad.js': `export function f( { return 1 ` });
  const r = verifyChangedFiles(root, ['bad.js']);
  ok('catch the syntax error', !r.ok && r.problems.some(p => p.kind === 'syntax'));
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 5: export * relaxed, external/node imports not falsely flagged ──
{
  const root = tmpRepo({
    'src/all.js': `export * from './hidden.js';`,
    'src/use.js': `import fs from 'node:fs';\nimport { whatever } from './all.js';\nexport const x = whatever;`,
  });
  const r = verifyChangedFiles(root, ['src/use.js']);
  ok('export * relaxed without false flags, node builtins skipped', r.ok);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 6: formatProblems produces text that can be fed back ──
{
  const txt = formatProblems([{ file: 'a.js', kind: 'import', message: '沒有 export setSession' }]);
  ok('format includes the filename and message', txt.includes('a.js') && txt.includes('setSession'));
}

console.log(`\nAll passed: ${pass}`);
