// Lie Monitor (照妖鏡) — execution-honesty engine, integrated into Code Tree.
// Ported from norika1207-lab/AI-Lies-Monitor (MIT). Tracks: instruction → commitment → evidence → alert.
// When the agent in the terminal claims it created a file / ran a command / started a service, we check the
// real evidence (file exists + non-empty, locally OR on the followed remote project). No evidence → alert.
//
// The one Code-Tree-specific change vs upstream: checkFile is pluggable, so a path can be verified against
// the remote project's scanned file set (remote-source) instead of the local fs (which would false-positive).
import fs from 'node:fs';

export const SEVERITY = { LOW: 'low', MID: 'mid', HIGH: 'high', CRITICAL: 'critical' };

// Pluggable file resolver: returns { ok, reason, size } | null (null → fall back to local fs).
let _resolve = null;
export function setFileResolver(fn) { _resolve = typeof fn === 'function' ? fn : null; }

const COMMITMENT_PATTERNS = [
  /(?:我會|我將|會去|馬上|現在|接下來|稍後|之後|已建立|已寫|已經建立|已完成|建立了|寫好了)\s*([^。！？\n]{2,180})/giu,
  /(?:I will|I'll|I am going to|I’m going to|I'll now|I have|I've|I just)\s+([^.\n]{2,180})/giu,
  /(?:create[d]?|wrote|written|generate[d]?|ran|run|execute[d]?|start(?:ed)?|deploy(?:ed)?|built|build|saved?)\s+([^.\n]{2,180})/giu,
];
const FILE_PATTERNS = [
  // an absolute/relative path — stop at whitespace, quotes, commas, brackets, or any CJK char (so trailing
  // Chinese prose like "/tmp/x.md,不能是空檔" doesn't get swallowed into the path)
  /(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|\/opt\/|\/srv\/|\.\/|\.\.\/|~\/)[^\s"'`，。；;:,、（）()\[\]{}　-鿿]+/g,
  /[A-Za-z0-9_.\-/]+\.(?:md|txt|json|jsonl|csv|html|js|jsx|ts|tsx|py|sh|yaml|yml|pdf|docx|xlsx|sql|go|rs|java|php|c|cpp|h)\b/g,
];
const COMMAND_HINTS = ['bash', 'shell', 'command', 'run', 'execute', '執行', '命令', '跑', '啟動', 'npm', 'node', 'python', 'pip', 'git', 'curl', 'ssh', 'scp', 'uvicorn', 'systemctl', 'docker'];

export function createEmptyState() { return { sessions: {}, alerts: [] }; }

export function ingestEvent(state, event) {
  const e = normalize(event);
  const s = getSession(state, e.sessionId);
  s.events.push(e); if (s.events.length > 200) s.events.shift();
  if (e.role === 'user') { s.lastUserInstruction = { text: e.content, createdAt: e.createdAt }; return []; }
  if (e.role === 'assistant') { s.promises.push(...extractCommitments(e, s.lastUserInstruction)); if (s.promises.length > 200) s.promises = s.promises.slice(-200); return evaluateSession(state, e.sessionId); }
  if (e.role === 'file' || e.role === 'tool' || e.role === 'process') { s.evidence.push(extractEvidence(e)); if (s.evidence.length > 300) s.evidence.shift(); return evaluateSession(state, e.sessionId); }
  return [];
}

export function evaluateAll(state, options = {}) {
  const alerts = [];
  for (const id of Object.keys(state.sessions)) alerts.push(...evaluateSession(state, id, Date.now(), options));
  return alerts;
}

export function evaluateSession(state, sessionId, now = Date.now(), options = {}) {
  const s = getSession(state, sessionId);
  markEvidence(s);
  const alerts = [];
  for (const p of s.promises) {
    if (p.status === 'fulfilled') continue;
    const age = now - p.createdAt;
    const stale = options.force === true || age > s.settings.staleMs;
    if (!stale) continue;
    // Only raise the generic "no evidence" alert when a concrete FILE was promised but never appeared.
    // Vague prose that merely contains words like "run" / "command" (e.g. a slash-command help line) is not a lie.
    const missing = p.evidenceRequired.some((r) => r.type === 'file') && p.evidence.length === 0;
    if (missing && !p.alertedMissing) {
      p.alertedMissing = true;
      alerts.push(makeAlert('missing_evidence', p, { severity: SEVERITY.HIGH, message: 'AI 說它做了事,但沒看到對應的檔案/命令/程序證據。', suggestedReply: buildReply(p) }));
    }
    for (const req of p.evidenceRequired) {
      if (req.type !== 'file') continue;
      const c = checkFile(req.path);
      if (c.reason === 'uncheckable') continue;
      p.alertedFiles = p.alertedFiles || {};
      if (!c.ok && !p.alertedFiles[req.path]) {
        p.alertedFiles[req.path] = true;
        alerts.push(makeAlert('file_check_failed', p, {
          severity: c.reason === 'empty' ? SEVERITY.HIGH : SEVERITY.MID,
          message: c.reason === 'missing' ? `說會建立的檔案不存在: ${req.path}` : `說會寫入的檔案是空的: ${req.path}`,
          suggestedReply: `你說會建立 ${req.path},但檢查結果是「${c.reason === 'missing' ? '不存在' : '空檔'}」。請貼 raw ls/stat/wc 輸出,或承認沒做完。`,
        }));
      }
    }
  }
  for (const a of alerts) state.alerts.push(a);
  if (state.alerts.length > 300) state.alerts = state.alerts.slice(-300);
  return alerts;
}

function checkFile(p) {
  if (_resolve) { try { const r = _resolve(p); if (r) return r; } catch {} }
  if (!isLocal(p)) return { ok: false, reason: 'uncheckable' };
  try {
    if (!fs.existsSync(p)) return { ok: false, reason: 'missing' };
    const st = fs.statSync(p);
    if (st.isFile() && st.size === 0) return { ok: false, reason: 'empty' };
    return { ok: true, reason: 'ok', size: st.size };
  } catch (e) { return { ok: false, reason: e.code || 'error' }; }
}

export function extractCommitments(event, instruction) {
  const text = event.content || '';
  const out = [];
  for (const pat of COMMITMENT_PATTERNS) { pat.lastIndex = 0; for (const m of text.matchAll(pat)) { const stmt = clean(m[0]); if (weak(stmt)) continue; out.push(makePromise(event, instruction, stmt)); } }
  if (out.length === 0 && /(完成|已建立|已寫|建立了|寫好|created|wrote|saved|done|finished)/i.test(text)) out.push(makePromise(event, instruction, firstSentence(text)));
  return dedupe(out).slice(0, 10);
}

function inferEvidence(text) {
  const ev = [];
  for (const f of fileRefs(text)) { const c = expandHome(stripPunct(f)); if (!c.startsWith('/') && !c.startsWith('~/') && text.includes('/' + c)) continue; ev.push({ type: 'file', path: c }); }
  const lower = text.toLowerCase();
  if (COMMAND_HINTS.some((h) => lower.includes(h))) ev.push({ type: 'command', commandHint: text.slice(0, 180) });
  if (/(pid|process|daemon|service|server|背景|程序|服務|啟動)/i.test(text)) ev.push({ type: 'process', processHint: text.slice(0, 180) });
  const seen = new Set();
  return ev.filter((r) => { const k = r.type + ':' + (r.path || r.commandHint || r.processHint); if (seen.has(k)) return false; seen.add(k); return true; });
}

function fileRefs(text) { const out = []; for (const pat of FILE_PATTERNS) { pat.lastIndex = 0; for (const m of String(text).matchAll(pat)) out.push(m[0]); } return [...new Set(out)]; }
function normalize(ev) { return { id: ev.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`, surface: ev.surface || 'terminal', sessionId: ev.sessionId || 'default', role: ev.role, content: ev.content || '', meta: ev.meta || {}, createdAt: ev.createdAt || Date.now() }; }
function getSession(state, id) { if (!state.sessions[id]) state.sessions[id] = { sessionId: id, settings: { staleMs: 12000 }, lastUserInstruction: null, promises: [], evidence: [], events: [] }; return state.sessions[id]; }
function makePromise(ev, instruction, statement) { return { id: `p_${hash(ev.id + ':' + statement)}`, sessionId: ev.sessionId, statement, userInstruction: instruction || null, evidenceRequired: inferEvidence(statement + '\n' + (instruction?.text || '')), evidence: [], status: 'pending', createdAt: ev.createdAt }; }
function extractEvidence(ev) { return { id: ev.id, role: ev.role, files: fileRefs(ev.content).map((p) => expandHome(stripPunct(p))), content: ev.content, createdAt: ev.createdAt }; }
function markEvidence(s) {
  for (const p of s.promises) {
    for (const ev of s.evidence) { if (p.evidence.some((x) => x.id === ev.id)) continue; if (matches(p, ev)) p.evidence.push(ev); }
    if (p.evidenceRequired.length > 0) {
      const fileReqs = p.evidenceRequired.filter((r) => r.type === 'file');
      // a file req is satisfied if the file checks out (local fs) OR — when it's uncheckable (a remote path) —
      // a file-evidence event for that path arrived (the remote scanner saw it appear).
      const filesOk = fileReqs.every((req) => { const c = checkFile(req.path); return c.ok || (c.reason === 'uncheckable' && p.evidence.some((e) => e.files.includes(req.path))); });
      if ((fileReqs.length === 0 && p.evidence.length > 0) || (fileReqs.length > 0 && filesOk)) p.status = 'fulfilled';
    }
  }
}
function matches(p, ev) { for (const req of p.evidenceRequired) { if (req.type === 'file' && ev.files.includes(req.path)) return true; if (req.type === 'command' && ev.role === 'tool') return true; if (req.type === 'process' && ev.role === 'process') return true; } return false; }
function makeAlert(type, p, a) { return { id: `a_${hash(type + ':' + p.id + ':' + Date.now())}`, type, severity: a.severity, sessionId: p.sessionId, statement: p.statement, userInstruction: p.userInstruction?.text || '', message: a.message, suggestedReply: a.suggestedReply, createdAt: Date.now() }; }
function buildReply(p) { const ev = p.evidenceRequired.map((r) => r.type === 'file' ? `檔案 ${r.path}` : r.type === 'command' ? '命令執行紀錄' : 'PID/程序狀態').join('、') || '可驗證證據'; return `你說「${p.statement}」,但沒看到 ${ev}。請貼 raw evidence;沒做就明說。`; }
function firstSentence(t) { return String(t).split(/(?<=[。！？.!?])\s+|\n/)[0].slice(0, 240); }
function clean(t) { return String(t).replace(/\s+/g, ' ').trim(); }
function weak(t) { return /如果|可以幫|可能|也許|maybe|could|would|要不要|是否|嗎\?/.test(t); }
function dedupe(ps) { const seen = new Set(); return ps.filter((p) => { const k = p.statement.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }); }
function stripPunct(p) { return String(p).replace(/[`"'，。；;:：,)\]}]+$/g, ''); }
function expandHome(p) { if (p === '~') return process.env.HOME; if (p.startsWith('~/')) return `${process.env.HOME}/${p.slice(2)}`; return p; }
function isLocal(p) { return p.startsWith('/') || p.startsWith(process.env.HOME || '/Users/'); }
function hash(input) { let h = 2166136261; for (const ch of String(input)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
