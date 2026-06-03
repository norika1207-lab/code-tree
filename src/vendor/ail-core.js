import fs from "node:fs";

export const SEVERITY = {
  LOW: "low",
  MID: "mid",
  HIGH: "high",
  CRITICAL: "critical"
};

const COMMITMENT_PATTERNS = [
  /(?:我會|我將|會去|馬上|現在|接下來|稍後|之後)\s*([^。！？\n]{2,180})/giu,
  /(?:I will|I'll|I am going to|I’m going to|I can|I'll now)\s+([^.\n]{2,180})/giu,
  /(?:create|write|generate|run|execute|start|deploy|build|save)\s+([^.\n]{2,180})/giu
];

const FILE_PATTERNS = [
  /(?:\/Users\/|\/home\/|\/tmp\/|\/var\/|\/opt\/|\.\/|\.\.\/|~\/)[^\s"'，。；;]+/g,
  /[A-Za-z0-9_.-]+\.(?:md|txt|json|jsonl|csv|html|js|ts|py|sh|log|yaml|yml|pdf|docx|xlsx)\b/g
];

const COMMAND_HINTS = [
  "bash", "shell", "command", "run", "execute", "執行", "命令", "跑", "啟動",
  "npm", "node", "python", "pip", "git", "curl", "ssh", "scp"
];

export function createEmptyState() {
  return {
    sessions: {},
    events: [],
    alerts: []
  };
}

export function ingestEvent(state, event) {
  const normalized = normalizeEvent(event);
  const session = getSession(state, normalized.sessionId);
  session.events.push(normalized);
  state.events.push(normalized);

  if (normalized.role === "user") {
    session.lastUserInstruction = extractInstruction(normalized);
    return [];
  }

  if (normalized.role === "assistant") {
    const promises = extractCommitments(normalized, session.lastUserInstruction);
    session.promises.push(...promises);
    return evaluateSession(state, normalized.sessionId);
  }

  if (normalized.role === "tool" || normalized.role === "file" || normalized.role === "process") {
    session.evidence.push(extractEvidence(normalized));
    markEvidence(session);
    return evaluateSession(state, normalized.sessionId);
  }

  return [];
}

export function evaluateAll(state, options = {}) {
  const alerts = [];
  for (const sessionId of Object.keys(state.sessions)) {
    alerts.push(...evaluateSession(state, sessionId, Date.now(), options));
  }
  return alerts;
}

export function evaluateSession(state, sessionId, now = Date.now(), options = {}) {
  const session = getSession(state, sessionId);
  markEvidence(session);
  const alerts = [];

  for (const promise of session.promises) {
    if (promise.status === "fulfilled") continue;

    const ageMs = now - promise.createdAt;
    const missingEvidence = promise.evidenceRequired.length > 0 && promise.evidence.length === 0;
    const stale = options.force === true || ageMs > session.settings.staleMs;

    if (missingEvidence && stale && !promise.alertedMissing) {
      promise.alertedMissing = true;
      alerts.push(makeAlert("missing_evidence", promise, {
        severity: SEVERITY.HIGH,
        message: "AI promised work, but no matching file/command/process evidence appeared.",
        suggestedReply: buildSuggestedReply(promise)
      }));
    }

    for (const req of promise.evidenceRequired) {
      if (req.type === "file") {
        const check = checkFile(req.path);
        if (check.reason === "uncheckable") continue;
        if (!check.ok && stale && !promise.alertedFiles?.[req.path]) {
          promise.alertedFiles = promise.alertedFiles || {};
          promise.alertedFiles[req.path] = true;
          alerts.push(makeAlert("file_check_failed", promise, {
            severity: check.reason === "empty" ? SEVERITY.HIGH : SEVERITY.MID,
            message: check.reason === "missing"
              ? `Expected file does not exist: ${req.path}`
              : `Expected file is empty: ${req.path}`,
            suggestedReply: `你說會建立 ${req.path}，但目前檢查結果是 ${check.reason}。請貼 raw ls/stat/wc output，或承認沒有完成。`
          }));
        }
      }
    }
  }

  state.alerts.push(...alerts);
  return alerts;
}

export function serializeState(state) {
  return {
    sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, s]) => [id, {
      sessionId: id,
      lastUserInstruction: s.lastUserInstruction,
      promises: s.promises,
      evidence: s.evidence.slice(-100),
      events: s.events.slice(-50)
    }])),
    alerts: state.alerts.slice(-300)
  };
}

export function extractCommitments(event, instruction) {
  const text = event.content || "";
  const commitments = [];

  for (const pat of COMMITMENT_PATTERNS) {
    for (const m of text.matchAll(pat)) {
      const statement = cleanup(m[0]);
      if (isWeakCommitment(statement)) continue;
      commitments.push(makePromise(event, instruction, statement));
    }
  }

  if (commitments.length === 0 && /(完成|已建立|已寫|created|wrote|saved|done)/i.test(text)) {
    commitments.push(makePromise(event, instruction, firstSentence(text)));
  }

  return dedupePromises(commitments).slice(0, 10);
}

export function inferEvidenceRequired(text) {
  const evidence = [];
  for (const file of extractFileRefs(text)) {
    const cleaned = expandHome(stripPunctuation(file));
    if (isBareFileInsideKnownPath(cleaned, text)) continue;
    evidence.push({ type: "file", path: cleaned });
  }

  const lower = text.toLowerCase();
  if (COMMAND_HINTS.some(h => lower.includes(h.toLowerCase()))) {
    evidence.push({ type: "command", commandHint: text.slice(0, 180) });
  }

  if (/(pid|process|daemon|service|server|背景|程序|服務|啟動)/i.test(text)) {
    evidence.push({ type: "process", processHint: text.slice(0, 180) });
  }

  return dedupeEvidence(evidence);
}

export function extractFileRefs(text) {
  const out = [];
  for (const pat of FILE_PATTERNS) {
    for (const m of String(text).matchAll(pat)) out.push(m[0]);
  }
  return [...new Set(out)];
}

function normalizeEvent(event) {
  return {
    id: event.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    surface: event.surface || "unknown",
    sessionId: event.sessionId || event.session_id || "default",
    role: event.role,
    content: event.content || "",
    meta: event.meta || {},
    createdAt: event.createdAt || Date.now()
  };
}

function getSession(state, sessionId) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      sessionId,
      settings: { staleMs: 30_000 },
      lastUserInstruction: null,
      promises: [],
      evidence: [],
      events: []
    };
  }
  return state.sessions[sessionId];
}

function extractInstruction(event) {
  return {
    eventId: event.id,
    text: event.content,
    createdAt: event.createdAt
  };
}

function makePromise(event, instruction, statement) {
  return {
    id: `p_${hash(`${event.id}:${statement}`)}`,
    sessionId: event.sessionId,
    surface: event.surface,
    assistantEventId: event.id,
    userInstruction: instruction,
    statement,
    evidenceRequired: inferEvidenceRequired(statement + "\n" + (instruction?.text || "")),
    evidence: [],
    status: "pending",
    createdAt: event.createdAt
  };
}

function extractEvidence(event) {
  return {
    id: event.id,
    role: event.role,
    surface: event.surface,
    sessionId: event.sessionId,
    content: event.content,
    meta: event.meta,
    files: extractFileRefs(event.content).map(p => expandHome(stripPunctuation(p))),
    createdAt: event.createdAt
  };
}

function markEvidence(session) {
  for (const promise of session.promises) {
    for (const evidence of session.evidence) {
      if (promise.evidence.some(e => e.id === evidence.id)) continue;
      if (matchesEvidence(promise, evidence)) {
        promise.evidence.push(evidence);
      }
    }
    if (promise.evidenceRequired.length > 0 && promise.evidence.length > 0) {
      const fileReqs = promise.evidenceRequired.filter(r => r.type === "file");
      const filesOk = fileReqs.every(req => checkFile(req.path).ok);
      if (fileReqs.length === 0 || filesOk) promise.status = "fulfilled";
    }
  }
}

function matchesEvidence(promise, evidence) {
  for (const req of promise.evidenceRequired) {
    if (req.type === "file" && evidence.files.includes(req.path)) return true;
    if (req.type === "command" && evidence.role === "tool") return true;
    if (req.type === "process" && evidence.role === "process") return true;
  }
  return false;
}

function checkFile(filePath) {
  if (!isLocalPath(filePath)) return { ok: false, reason: "uncheckable" };
  try {
    if (!fs.existsSync(filePath)) return { ok: false, reason: "missing" };
    const stat = fs.statSync(filePath);
    if (stat.isFile() && stat.size === 0) return { ok: false, reason: "empty" };
    return { ok: true, reason: "ok", size: stat.size };
  } catch (err) {
    return { ok: false, reason: err.code || "error" };
  }
}

function makeAlert(type, promise, attrs) {
  return {
    id: `a_${hash(`${type}:${promise.id}:${Date.now()}`)}`,
    type,
    severity: attrs.severity,
    sessionId: promise.sessionId,
    surface: promise.surface,
    promiseId: promise.id,
    statement: promise.statement,
    userInstruction: promise.userInstruction?.text || "",
    message: attrs.message,
    suggestedReply: attrs.suggestedReply,
    createdAt: Date.now()
  };
}

function buildSuggestedReply(promise) {
  const evidence = promise.evidenceRequired.map(req => {
    if (req.type === "file") return `檔案 ${req.path}`;
    if (req.type === "command") return "命令執行紀錄";
    if (req.type === "process") return "PID / process 狀態";
    return req.type;
  }).join("、") || "可驗證 evidence";
  return `你承諾「${promise.statement}」，但目前沒有看到 ${evidence}。請貼 raw evidence；沒有就明說沒做。`;
}

function firstSentence(text) {
  return String(text).split(/(?<=[。！？.!?])\s+|\n/)[0].slice(0, 240);
}

function cleanup(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

function isWeakCommitment(text) {
  return /如果|可以|可能|也許|maybe|could|would|要不要|是否/.test(text);
}

function dedupePromises(promises) {
  const seen = new Set();
  return promises.filter(p => {
    const key = p.statement.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripPunctuation(p) {
  return String(p).replace(/[`"'，。；;:：,)\]}]+$/g, "");
}

function expandHome(p) {
  if (p === "~") return process.env.HOME;
  if (p.startsWith("~/")) return `${process.env.HOME}/${p.slice(2)}`;
  return p;
}

function isLocalPath(p) {
  return p.startsWith("/") || p.startsWith(process.env.HOME || "/Users/");
}

function isBareFileInsideKnownPath(file, text) {
  return !file.startsWith("/") && !file.startsWith("~/") && String(text).includes(`/${file}`);
}

function dedupeEvidence(evidence) {
  const seen = new Set();
  return evidence.filter(req => {
    const key = `${req.type}:${req.path || req.commandHint || req.processHint}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hash(input) {
  let h = 2166136261;
  for (const ch of String(input)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
