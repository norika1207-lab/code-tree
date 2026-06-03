// 軌跡記憶（持續進化的「快迴圈」）：
// 每次 agent 跑完一個任務，把「任務 / 讀過哪些檔 / 改過哪些檔 / 做法摘要 / 有沒有善終」
// 寫成一行 JSONL。下次來相似任務，撈出最像的幾筆塞進 system prompt，
// 讓小模型站在自己過去的經驗上做事，不用重新訓練權重就會「越用越熟這個 codebase」。
//
// 不靠網路、不靠 embedding 服務：用 token 重疊打分（ascii 詞 + 中文單字/bigram），
// 本機就能跑、零相依、可單元測試。語料就是 agent 自己在這個專案走過的軌跡。
import fs from 'node:fs';
import path from 'node:path';

const MEM_DIR = '.cosmos-tree';
const MEM_FILE = 'trajectories.jsonl';

// 把字串切成可比對的 token 集合：英數詞 + 中文單字 + 中文 bigram
export function tokenize(s) {
  const str = String(s || '').toLowerCase();
  const toks = new Set();
  for (const m of str.matchAll(/[a-z0-9_]{2,}/g)) toks.add(m[0]);
  const cjk = str.match(/[一-鿿]/g) || [];
  for (let i = 0; i < cjk.length; i++) {
    toks.add(cjk[i]);
    if (i + 1 < cjk.length) toks.add(cjk[i] + cjk[i + 1]);
  }
  return toks;
}

export function overlapScore(queryToks, text) {
  const t = tokenize(text);
  let s = 0;
  for (const tok of queryToks) if (t.has(tok)) s++;
  return s;
}

export function createMemory({ root, model = 'unknown', topK = 3, maxChars = 1200 } = {}) {
  const dir = path.join(root, MEM_DIR);
  const file = path.join(dir, MEM_FILE);

  function loadAll() {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  // 給新任務，撈出最像的「善終且真的改過檔」的舊軌跡，組成一段提示文字
  function recall(task) {
    const all = loadAll();
    if (!all.length) return '';
    const q = tokenize(task);
    if (!q.size) return '';
    const ranked = all
      .filter((r) => r.endedCleanly && (r.filesModified?.length || 0) > 0)
      .map((r) => ({
        r,
        s: overlapScore(q, r.task) + overlapScore(q, (r.filesModified || []).join(' ')),
      }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, topK);
    if (!ranked.length) return '';
    // 對小模型，措辭要「給它權限照做」而不是「叫它別照抄」。
    // 觀察到舊版寫「僅供參考、不要照抄」會讓弱模型刻意忽略已驗證的修法、另外發明錯的做法。
    let out = '（你過去在這個專案修過幾乎一樣的問題，下面是當時「驗證通過」的修法。請先用 read_file 確認現況；只要問題本質相同，就直接照這個修法用 edit_file/write_file 改在「同一個檔案」上，不要另外發明新做法、不要新增檔案。）\n';
    for (const { r } of ranked) {
      const line =
        `- 任務：${String(r.task).slice(0, 120)}\n` +
        `  當時改過的檔：${(r.filesModified || []).join(', ')}\n` +
        `  做法摘要：${String(r.summary || '').replace(/\s+/g, ' ').slice(0, 160)}\n`;
      if (out.length + line.length > maxChars) break;
      out += line;
    }
    return out.trim();
  }

  // 寫入一筆軌跡（append-only，壞行不會污染其他行）
  function record(traj = {}) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const row = {
        ts: new Date().toISOString(),
        model,
        task: String(traj.task || ''),
        filesRead: [...new Set(traj.filesRead || [])],
        filesModified: [...new Set(traj.filesModified || [])],
        toolCount: traj.toolCount || 0,
        endedCleanly: !!traj.endedCleanly,
        summary: String(traj.summary || '').replace(/\s+/g, ' ').slice(0, 500),
      };
      fs.appendFileSync(file, JSON.stringify(row) + '\n');
      return row;
    } catch {
      return null; // 記憶寫入失敗絕不能拖垮主任務
    }
  }

  return { recall, record, loadAll, file };
}
