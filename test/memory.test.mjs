// 軌跡記憶單元測試（無 GPU、無網路）：
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

// ── 測 1：tokenize 中英混合 ──
{
  const t = tokenize('修 session 失效 bug');
  ok('英數詞切出', t.has('session') && t.has('bug'));
  ok('中文單字切出', t.has('修') && t.has('效'));
  ok('中文 bigram 切出', t.has('失效'));
}

// ── 測 2：overlap 打分 ──
{
  const q = tokenize('session 失效');
  ok('相關文字分數高', overlapScore(q, 'session 失效 修好了') >= overlapScore(q, '完全無關的內容'));
  ok('無關文字 0 分', overlapScore(tokenize('xyz123'), '毫不相干') === 0);
}

// ── 測 3：record 寫入後 recall 撈得回來 ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const mem = createMemory({ root, model: 'test-model' });

  ok('空記憶 recall 回空字串', mem.recall('任何任務') === '');

  mem.record({
    task: '登入後 session 偶發失效，修掉根因',
    filesRead: ['src/auth.js', 'src/middleware.js'],
    filesModified: ['src/auth.js'],
    toolCount: 7,
    endedCleanly: true,
    summary: '把 setSession 的 key 從 user.id 改成 sessionId',
  });

  const all = mem.loadAll();
  ok('寫入一筆', all.length === 1 && all[0].model === 'test-model');
  ok('filesModified 去重保留', all[0].filesModified.length === 1);

  const r = mem.recall('session 失效要怎麼修');
  ok('相似任務撈得回', r.includes('session') && r.includes('src/auth.js'));
  ok('recall 帶做法摘要', r.includes('sessionId'));

  // 不相關任務不該撈到東西
  ok('不相關任務 recall 空', mem.recall('幫我畫一個圓形按鈕的 CSS 動畫顏色漸層') === '');

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 4：只撈「善終且改過檔」的軌跡 ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const mem = createMemory({ root });
  // 沒善終的不算
  mem.record({ task: 'fix 登入 timeout', filesModified: ['a.js'], endedCleanly: false, summary: '中途放棄' });
  // 善終但沒改檔的不算
  mem.record({ task: 'fix 登入 timeout', filesModified: [], endedCleanly: true, summary: '只看沒改' });
  // 善終且改過檔的才算
  mem.record({ task: 'fix 登入 timeout 問題', filesModified: ['login.js'], endedCleanly: true, summary: '加上 timeout 重試' });

  const r = mem.recall('登入 timeout');
  ok('只撈善終且改過檔的', r.includes('login.js') && !r.includes('中途放棄') && !r.includes('只看沒改'));

  fs.rmSync(root, { recursive: true, force: true });
}

// ── 測 5：壞掉的 JSONL 行不會炸掉 loadAll ──
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const dir = path.join(root, '.cosmos-tree');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'trajectories.jsonl'),
    '{"task":"好行","filesModified":["x.js"],"endedCleanly":true,"summary":"ok"}\n壞掉不是 json\n\n');
  const mem = createMemory({ root });
  ok('壞行被跳過、好行保留', mem.loadAll().length === 1);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n全部通過：${pass} 項`);
