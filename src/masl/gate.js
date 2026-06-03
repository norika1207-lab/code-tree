// MASL gate（純邏輯）：agent 要改檔之前，先算出「動這個檔會連累誰」（爆炸範圍），
// 組成一份要給開發者看的報告。攔截 / 核准的 UI 在 CLI，這裡只負責算。
//
// 資料來源：CLI 從 core 收到的 snapshot（cells + edges）。
//   cell  = { id: 絕對路徑, path: 相對路徑, ... }
//   edge  = { from: 絕對路徑, to: 絕對路徑, type:'import' }  // from import 了 to
// 所以「誰會壞」= 反向：誰 import 了我 → importers。沿著反向邊做傳遞閉包就是爆炸範圍。
import path from 'node:path';

// 哪些工具是「動手改東西」→ 要過 gate。Read / list / grep 這種唯讀的放行。
const MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'edit_file']);
const SHELL_TOOLS = new Set(['Bash', 'bash']);

export function isMutation(toolName) {
  return MUTATION_TOOLS.has(toolName) || SHELL_TOOLS.has(toolName);
}

// 從 snapshot 建反向依賴索引。relById 把絕對路徑映回相對路徑。
export function buildDepIndex(cells = [], edges = [], root = '') {
  const relById = new Map();
  for (const c of cells) relById.set(c.id, c.path);
  const relOf = (abs) => relById.get(abs) || (root ? path.relative(root, abs) : abs);

  const importersByRel = new Map(); // rel(被 import 的) -> Set(rel)（import 它的人）
  for (const e of edges) {
    if (e.type && e.type !== 'import') continue;
    const toRel = relOf(e.to);
    const fromRel = relOf(e.from);
    if (!importersByRel.has(toRel)) importersByRel.set(toRel, new Set());
    importersByRel.get(toRel).add(fromRel);
  }
  return { relById, importersByRel };
}

// 傳遞閉包：改 startRel，會連累哪些檔（直接 + 間接 import 它的）。
export function blastRadius(index, startRel) {
  const seen = new Set();
  const q = [startRel];
  while (q.length) {
    const cur = q.shift();
    const importers = index.importersByRel.get(cur);
    if (!importers) continue;
    for (const imp of importers) {
      if (!seen.has(imp) && imp !== startRel) {
        seen.add(imp);
        q.push(imp);
      }
    }
  }
  return [...seen];
}

// 把一次工具呼叫評估成一份報告。input 形狀依工具不同：
//   Write/Edit → file_path；write_file/edit_file → path；Bash → command（無明確檔）
export function assessTool({ index, toolName, input = {}, root = '' }) {
  const shell = SHELL_TOOLS.has(toolName);
  const rawPath = input.file_path ?? input.path ?? null;
  const targetRel = rawPath
    ? (path.isAbsolute(rawPath) && root ? path.relative(root, rawPath) : rawPath)
    : null;

  // Bash 沒有明確的目標檔 → 算不出爆炸範圍，標成「需人工看一眼」。
  if (shell) {
    return {
      tool: toolName,
      kind: 'shell',
      targetRel: null,
      command: (input.command || '').slice(0, 200),
      blast: [],
      blastCount: 0,
      severity: 'review', // 指令可能砍檔/跑遷移，一律要開發者點頭
      reason: "This is a shell command. Its blast radius can't be derived from the dependency graph, so it needs your review.",
    };
  }

  const blast = targetRel ? blastRadius(index, targetRel) : [];
  // 嚴重度：連累越多越紅。0 = 安全，1-2 = 注意，3+ = 高風險。
  const severity = blast.length === 0 ? 'safe' : blast.length <= 2 ? 'caution' : 'high';
  return {
    tool: toolName,
    kind: 'edit',
    targetRel,
    command: null,
    blast,
    blastCount: blast.length,
    severity,
    reason: blast.length === 0
      ? 'Nothing else imports it, relatively safe to change.'
      : `${blast.length} file(s) import it. Breaking it will cascade to them.`,
  };
}

// ── 新判準（v2）：不要「判斷有問題就攔」，那會每次都跳、煩死人。──
// 改成「預設閉嘴，只在這四種真的危險時才出聲」：
//   1. 不可逆        shell 砍檔 / reset / push -f / migration / 覆寫重導
//   2. 動到對外介面  改/刪了別人 import 的 export（不是改內部實作）
//   3. 脫稿          嘴上說改 A，手卻去改 B
//   4. 鬼打牆        同一個檔反覆改 + 同一個錯一直冒（原地打轉）
// 爆炸範圍（blastRadius）不再單獨觸發攔截，降級成「背景燈號」放進 reason 補充。

// 危險 shell pattern：做了救不回來的那種。
const DANGEROUS_SHELL = [
  /\brm\s+-[rf]/i, /\brm\s+-rf?\b/i, /\brm\s+\//i,
  /git\s+reset\s+--hard/i, /git\s+push\s+[^|]*(-f\b|--force)/i,
  /git\s+clean\s+-[a-z]*f/i, /git\s+checkout\s+--\s+\./i,
  /\bdrop\s+table\b/i, /\btruncate\s+table\b/i, /\bmigrate\b/i,
  /\bmkfs\b/i, /\bdd\s+if=/i, /:\s*>\s*\S+/, /\bchmod\s+-R\b/i,
];

// 從原始碼粗略抽出「對外 export」名稱 + 粗略簽名（function 抓參數個數）。
// 不是完整 parser，夠用來判「介面有沒有變」。
export function extractExports(source = '') {
  const map = new Map();
  const add = (name, sig) => { if (name) map.set(name, sig || name); };
  // export function NAME(args) / export async function NAME(args)
  for (const m of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g)) {
    const args = m[2].split(',').map((s) => s.trim()).filter(Boolean).length;
    add(m[1], `fn:${args}`);
  }
  // export class NAME
  for (const m of source.matchAll(/export\s+class\s+([A-Za-z0-9_$]+)/g)) add(m[1], 'class');
  // export const/let/var NAME
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) add(m[1], 'const');
  // export { a, b as c }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) add(name, 'reexport');
    }
  }
  if (/export\s+default\b/.test(source)) add('default', 'default');
  return map;
}

// 比對前後 export：回傳「被刪掉的」「簽名變了的」名單。新增的不算（不會弄壞既有依賴）。
export function diffExports(prevSource, nextSource) {
  const prev = extractExports(prevSource);
  const next = extractExports(nextSource);
  const removed = [];
  const changed = [];
  for (const [name, sig] of prev) {
    if (!next.has(name)) removed.push(name);
    else if (next.get(name) !== sig) changed.push(name);
  }
  return { removed, changed, breaking: removed.length + changed.length > 0 };
}

// 主判準。report = assessTool 的輸出（含爆炸範圍當背景）。ctx 帶這次動作的脈絡：
//   { prevSource, nextSource, declaredTarget, actualTarget, modCount, errorRecurring }
// 回傳 { gate, category, reason, blast }（gate=true 才打斷人）。
export function decideGate(report, ctx = {}) {
  const blast = report.blast || [];
  const blastNote = report.blastCount > 0 ? `(background: ${report.blastCount} file(s) import it)` : '';

  // 1. 不可逆 shell
  if (report.kind === 'shell') {
    const cmd = report.command || '';
    const hit = DANGEROUS_SHELL.some((re) => re.test(cmd));
    if (hit) return { gate: true, category: 'irreversible', reason: `Irreversible command, no undo: ${cmd.slice(0, 120)}`, blast };
    return { gate: false, category: 'shell-safe', reason: 'Ordinary shell command, allowed.', blast };
  }

  // 3. 脫稿：宣稱改 A 卻去改 B
  const declared = ctx.declaredTarget;
  const actual = ctx.actualTarget || report.targetRel;
  if (declared && actual && declared !== actual) {
    return { gate: true, category: 'off-script', reason: `agent said it would edit ${declared} but is touching ${actual} instead, looks off-script.`, blast };
  }

  // 4. 鬼打牆：反覆改 + 同錯一直冒（優先於「只改內部就放行」，因為原地打轉就算只動內部也該停）
  if ((ctx.modCount || 0) >= 4 && ctx.errorRecurring) {
    return { gate: true, category: 'thrashing', reason: `This file was edited ${ctx.modCount}x and the same error keeps recurring, looks like thrashing. Pause and try another approach.`, blast };
  }

  // 2. 動到對外介面（刪/改 export）且真的有人依賴
  if (ctx.prevSource != null && ctx.nextSource != null) {
    const d = diffExports(ctx.prevSource, ctx.nextSource);
    if (d.breaking && report.blastCount > 0) {
      const what = [...d.removed.map((n) => `removed ${n}`), ...d.changed.map((n) => `changed signature of ${n}`)].join(', ');
      return { gate: true, category: 'breaking-api', reason: `Touches the public interface (${what}), ${report.blastCount} dependent file(s) will break.`, blast };
    }
    // 有改但只動內部 / 只新增 export → 閉嘴放行
    return { gate: false, category: 'internal-edit', reason: `Internal change only, public interface untouched, allowed ${blastNote}`, blast };
  }

  // 其餘一律放行（預設閉嘴）
  return { gate: false, category: 'default-pass', reason: `None of the four red lines hit, allowed ${blastNote}`, blast };
}

// 給 CLI 渲染用：把報告壓成幾行文字。
export function reportLines(report, agentSaid = '') {
  const lines = [];
  const head = report.kind === 'shell'
    ? `⛔ MASL intercept: shell command`
    : `⛔ MASL intercept: ${report.tool} → ${report.targetRel || '(unknown file)'}`;
  lines.push(head);
  if (report.command) lines.push(`  Command: ${report.command}`);
  if (agentSaid) lines.push(`  agent said: ${agentSaid.slice(0, 120)}`);
  lines.push(`  Impact: ${report.reason}`);
  if (report.blastCount > 0) {
    lines.push(`  Hits: ${report.blast.slice(0, 6).join(', ')}${report.blastCount > 6 ? ` …+${report.blastCount - 6}` : ''}`);
  }
  return lines;
}
