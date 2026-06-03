// 讀 Claude Code 自己寫的 session JSONL,把「你在終端機跑 claude」這段真實 token 用量
// 撈出來給上面那條 token 列。不是讀 Code Tree 內建 agent(那是另一條),是讀你真的在用的那個。
//
// Claude Code 把每個專案的對話存在 ~/.claude/projects/<cwd 轉碼>/<session>.jsonl,
// 每行一個事件,assistant 那種帶 message.usage:
//   input_tokens / output_tokens / cache_read_input_tokens / cache_creation_input_tokens
// 同一筆 message.id 會在檔裡重複出現(串流快照),所以用 id 去重,不然會重複加。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// cwd → Claude Code 的資料夾名:非英數一律換成 '-'（/Users/x/Code Tree → -Users-x-Code-Tree）
export function encodeCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

function projectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

// 找這個 cwd 對應資料夾裡「最近改的」session 檔（= 目前這場對話）
export function newestSession(cwd) {
  const dir = path.join(projectsDir(), encodeCwd(cwd));
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch { return null; }
  if (!files.length) return null;
  let best = null, bestMs = -1;
  for (const f of files) {
    try { const ms = fs.statSync(f).mtimeMs; if (ms > bestMs) { bestMs = ms; best = f; } } catch {}
  }
  return best;
}

// 把一個 session 檔的 token 用量加總（用 message.id 去重）
export function sumSession(file) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, file };
  if (!file) return out;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  const seen = new Set();
  for (const line of text.split('\n')) {
    if (!line || line[0] !== '{') continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const msg = d.message;
    const u = msg && msg.usage;
    if (!u) continue;
    const id = msg.id || d.uuid || line.length; // 沒 id 的退而用行內容當鍵
    if (seen.has(id)) continue;
    seen.add(id);
    out.input += u.input_tokens || 0;
    out.output += u.output_tokens || 0;
    out.cacheRead += u.cache_read_input_tokens || 0;
    out.cacheWrite += u.cache_creation_input_tokens || 0;
  }
  return out;
}

// 給定 cwd,直接回目前 session 的累計用量
export function readUsage(cwd) {
  return sumSession(newestSession(cwd));
}
