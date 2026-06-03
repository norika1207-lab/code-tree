// Trajectory memory unit tests (no GPU, no network):
//   node test/memory.test.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemory, tokenize, overlapScore } from '../src/cli/memory.js';

let pass = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  ✓ ' + name);
  pass++;
}

// ── Test 1: tokenize mixed Chinese/English ──
{
  const t = tokenize('修 session 失效 bug');
  ok('alphanumeric words split out', t.has('session') && t.has('bug'));
  ok('single Chinese chars split out', t.has('修') && t.has('效'));
  ok('Chinese bigram split out', t.has('失效'));
}

// ── Test 2: overlap scoring ──
{
  const q = tokenize('session 失效');
  ok('relevant text scores higher', overlapScore(q, 'session 失效 修好了') >= overlapScore(q, '完全無關的內容'));
  ok('unrelated text scores 0', overlapScore(tokenize('xyz123'), '毫不相干') === 0);
}

// ── Test 3: after record writes, recall can fetch it back ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const mem = createMemory({ root, model: 'test-model' });

  ok('empty memory recall returns empty string', mem.recall('任何任務') === '');

  mem.record({
    task: '登入後 session 偶發失效，修掉根因',
    filesRead: ['src/auth.js', 'src/middleware.js'],
    filesModified: ['src/auth.js'],
    toolCount: 7,
    endedCleanly: true,
    summary: '把 setSession 的 key 從 user.id 改成 sessionId',
  });

  const all = mem.loadAll();
  ok('one entry written', all.length === 1 && all[0].model === 'test-model');
  ok('filesModified deduplicated', all[0].filesModified.length === 1);

  const r = mem.recall('session 失效要怎麼修');
  ok('similar task is fetched back', r.includes('session') && r.includes('src/auth.js'));
  ok('recall carries the approach summary', r.includes('sessionId'));

  // An unrelated task should fetch nothing
  ok('unrelated task recall is empty', mem.recall('幫我畫一個圓形按鈕的 CSS 動畫顏色漸層') === '');

  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 4: only fetch trajectories that "ended cleanly and modified files" ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const mem = createMemory({ root });
  // Didn't end cleanly: doesn't count
  mem.record({ task: 'fix 登入 timeout', filesModified: ['a.js'], endedCleanly: false, summary: '中途放棄' });
  // Ended cleanly but modified no files: doesn't count
  mem.record({ task: 'fix 登入 timeout', filesModified: [], endedCleanly: true, summary: '只看沒改' });
  // Ended cleanly and modified files: counts
  mem.record({ task: 'fix 登入 timeout 問題', filesModified: ['login.js'], endedCleanly: true, summary: '加上 timeout 重試' });

  const r = mem.recall('登入 timeout');
  ok('only fetch cleanly-ended, file-modifying ones', r.includes('login.js') && !r.includes('中途放棄') && !r.includes('只看沒改'));

  fs.rmSync(root, { recursive: true, force: true });
}

// ── Test 5: a broken JSONL line doesn't blow up loadAll ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const dir = path.join(root, '.cosmos-tree');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trajectories.jsonl'),
    '{"task":"好行","filesModified":["x.js"],"endedCleanly":true,"summary":"ok"}\n壞掉不是 json\n\n');
  const mem = createMemory({ root });
  ok('bad lines skipped, good lines kept', mem.loadAll().length === 1);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nAll passed: ${pass}`);
