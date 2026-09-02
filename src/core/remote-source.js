// Remote project source: map a project that lives on another machine over plain ssh.
// Why: many people (and Code Tree's author) do their real work on a remote box, editing over `ssh host`.
// The local file watcher can't see those files, so the world-tree stays empty. This polls the remote
// project over ssh, builds the same { cells, edges, root } snapshot the local Graph produces, and
// flags files whose mtime moved since the last poll as "modified" so the tree lights up as you work.
//
// Zero install on either side: just ssh + find + cat. Uses the user's own ~/.ssh/config (aliases, keys).
import { spawn, spawnSync } from 'node:child_process';
import { sshControlArgs, sshControlEnv } from './ssh-control.js';

// When the app is launched from Finder, this process's env is the stripped launchd env: no SSH_AUTH_SOCK
// (ssh-agent), often a minimal PATH. So a background `spawn('ssh', …)` with BatchMode fails auth even though
// the user's interactive terminal (a login shell with full env) connects fine — "terminal connects, tree
// never grows". Fix: pull the login shell's real env once and reuse it for every ssh we spawn.
let _loginEnv = null;
function loginEnv() {
  if (_loginEnv) return _loginEnv;
  _loginEnv = { ...process.env };
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const r = spawnSync(shell, ['-lc', 'env'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.split('\n')) {
        const i = line.indexOf('=');
        if (i <= 0) continue;
        const k = line.slice(0, i);
        if (/^(SSH_AUTH_SOCK|SSH_AGENT_PID|PATH|HOME)$/.test(k)) _loginEnv[k] = line.slice(i + 1);
      }
    }
  } catch {}
  return _loginEnv;
}

// Mirror the WHOLE project, not just code — same philosophy as config.js CODE_EXT (code + markup + config +
// docs + scripts). Binary/asset files stay out so the tree shows structure, not a wall of .png nodes.
const CODE_EXT = [
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rb', 'rs', 'java', 'php', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'kt', 'scala', 'lua', 'r', 'jl', 'dart',
  'html', 'htm', 'css', 'scss', 'sass', 'vue', 'svelte', 'svg',
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', // NOT env — never preview .env secrets
  'md', 'mdx', 'rst', 'txt',
  'sh', 'bash', 'zsh', 'sql', 'gradle',
];
const LANG = { js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js', ts: 'ts', tsx: 'tsx', py: 'py', go: 'go', rb: 'rb', rs: 'rs', java: 'java', php: 'php' };
const MARK = '@@CT_FILE@@';
const MAX_FILES = 4000;

const JS_PATTERNS = [
  /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /import\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
];
const PY_PATTERNS = [/^\s*from\s+([.\w]+)\s+import\s+/gm, /^\s*import\s+([.\w]+)/gm];

// POSIX path join/normalize for remote (always forward slashes), no local fs involved.
function normalize(p) {
  const parts = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}
function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function ext(p) { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1); }

// Resolve an import spec against the known set of remote relative paths (string-based, no disk access).
function resolveRel(fromRel, spec, known, isPy) {
  if (isPy) {
    const tryBase = (base) => {
      for (const cand of [base + '.py', base + '/__init__.py']) if (known.has(cand)) return cand;
      return null;
    };
    if (spec.startsWith('.')) {
      const dots = spec.match(/^\.+/)[0].length;
      const rest = spec.slice(dots).replace(/\./g, '/');
      let dir = dirname(fromRel);
      for (let i = 1; i < dots; i++) dir = dirname(dir);
      return tryBase(normalize(dir + '/' + rest));
    }
    // Many deployed Python apps put a package dir such as backend/ on PYTHONPATH. Resolve bare/package
    // imports from the current folder upward, then common source folders, so the remote tree has lines.
    const rel = spec.replace(/\./g, '/');
    const bases = [];
    const seen = new Set();
    const push = (base) => { base = normalize(base); if (!seen.has(base)) { seen.add(base); bases.push(base); } };
    for (let dir = dirname(fromRel); ; dir = dirname(dir)) {
      push(dir ? `${dir}/${rel}` : rel);
      if (!dir) break;
    }
    push(rel);
    for (const d of ['src', 'lib', 'app', 'backend', 'server', 'core']) push(`${d}/${rel}`);
    for (const base of bases) {
      const resolved = tryBase(base);
      if (resolved) return resolved;
    }
    return null;
  }
  if (!(spec.startsWith('.') || spec.startsWith('/'))) return null;
  const base = normalize(dirname(fromRel) + '/' + spec);
  for (const e of ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.ts']) {
    if (known.has(base + e)) return base + e;
  }
  return null;
}

function importsOf(rel, content, known) {
  const isPy = ext(rel) === 'py';
  const patterns = isPy ? PY_PATTERNS : JS_PATTERNS;
  const specs = new Set();
  for (const re of patterns) { re.lastIndex = 0; let m; while ((m = re.exec(content)) !== null) specs.add(m[1]); }
  const out = new Set();
  for (const s of specs) { const r = resolveRel(rel, s, known, isPy); if (r) out.add(r); }
  return [...out];
}

function sh(host, remoteCmd, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn('ssh', [...sshControlArgs({ batch: true }), host, remoteCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...loginEnv(), ...sshControlEnv() },
    });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: e.message }); });
  });
}

const LIST_MARK = '@@CT_L@@'; // a file-list line: rel\tmtime
const CONTENT_CAP = 1200;     // read content for at most this many files (imports + previews); bounds the payload on huge repos
// Dirs that are dependency/build junk, never the user's project. A Python venv alone holds ~10k site-package
// files — scanning those used to stat+cat thousands of files over ssh and effectively hang (no tree ever).
const PRUNE = ['node_modules', '.git', '.venv', 'venv', 'env', '.env', 'site-packages', 'dist', 'build', '.tox', 'vendor', '__pycache__', '.next', '.cache', 'bower_components', '.mypy_cache', '.pytest_cache'];

function findExpr() {
  const exprs = CODE_EXT.map((e) => `-name '*.${e}'`).join(' -o ');
  const prune = PRUNE.map((d) => `-path './${d}' -o -path '*/${d}'`).join(' -o ');
  return `find . \\( ${prune} \\) -prune -o -type f \\( ${exprs} \\)`;
}
// Phase 1 — LIST only: every code file + mtime in ONE find (-printf), no per-file stat fork. Fast even on big
// repos, so the tree paints in ~2s. mtime drives the camera-jump diff.
function buildListCmd(root) {
  return `cd ${JSON.stringify(root)} 2>/dev/null && ${findExpr()} -printf '${LIST_MARK}%p\\t%T@\\n' 2>/dev/null | head -${MAX_FILES}`;
}
// Phase 2 — CONTENT of the first CONTENT_CAP files (for import edges + card previews). Runs after the tree is
// already on screen, so a slow/huge repo never blocks the first paint.
function buildContentCmd(root) {
  return `cd ${JSON.stringify(root)} 2>/dev/null && ${findExpr()} -print 2>/dev/null | head -${CONTENT_CAP} | ` +
    `while IFS= read -r f; do printf '%s%s\\n' '${MARK}' "$f"; head -c 4096 "$f" 2>/dev/null; printf '\\n'; done`;
}

// Phase 1 output: LIST_MARK<rel>\t<mtime> lines → [{ rel, mtime }]
function parseList(raw) {
  const files = [];
  for (const line of raw.split('\n')) {
    if (!line.startsWith(LIST_MARK)) continue;
    const head = line.slice(LIST_MARK.length);
    const tab = head.lastIndexOf('\t');
    const rel = (tab < 0 ? head : head.slice(0, tab)).replace(/^\.\//, '');
    const mtime = tab < 0 ? 0 : Number(head.slice(tab + 1)) || 0;
    if (rel) files.push({ rel, mtime });
  }
  return files;
}
// Phase 2 output: MARK<rel> followed by the file's lines → Map(rel → content)
function parseContent(raw) {
  const byRel = new Map();
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(MARK)) { cur = line.slice(MARK.length).replace(/^\.\//, ''); byRel.set(cur, []); }
    else if (cur != null) byRel.get(cur).push(line);
  }
  const out = new Map();
  for (const [rel, body] of byRel) out.set(rel, body.join('\n'));
  return out;
}

function previewOfContent(content) {
  return String(content || '').replace(/\t/g, '  ').split('\n').slice(0, 10).join('\n');
}

export async function findRemoteProject(host, name) {
  const clean = String(name || '').trim().replace(/['"]/g, '');
  if (!host || !clean) return null;
  const q = clean.toLowerCase();
  const cmd = `for base in /opt /home /var/www /srv /root; do [ -d "$base" ] || continue; find "$base" -maxdepth 5 \\( -name .git -o -name node_modules -o -name .venv -o -name venv -o -name __pycache__ \\) -prune -o -type d \\( -iname "*${q}*" \\) -print 2>/dev/null; done | head -80`;
  const res = await sh(host, cmd, { timeoutMs: 15000 });
  if (!res.ok) return null;
  const dirs = res.out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!dirs.length) return null;
  const score = (d) => {
    const b = d.split('/').filter(Boolean).pop()?.toLowerCase() || '';
    let n = 0;
    if (b === q) n += 1000;
    if (d.toLowerCase().includes(`/opt/${q}`)) n += 300;
    n -= d.split('/').length * 5;
    return n;
  };
  dirs.sort((a, b) => score(b) - score(a));
  return dirs[0] || null;
}

export function createRemoteSource({ host, root, intervalMs = 5000, onSnapshot, onStatus }) {
  let timer = null, lastMtime = new Map(), firstOk = false, stopped = false;
  let scanning = false;
  let content = new Map(); // rel → file content from the latest scan, so the web server can serve card previews
  let baseline = new Map(); // rel → content at the FIRST scan, for remote "revert to session start"

  // Diff the file list against last scan ONCE per round (updates lastMtime), returns the set of changed rels so
  // both the fast list-paint and the later content-paint show the same camera jumps (no double-flagging).
  function diffChanges(files) {
    const changedPaths = [];
    for (const f of files) {
      const prev = lastMtime.get(f.rel);
      const isNew = prev === undefined && lastMtime.size > 0; // appeared after we'd already scanned = agent created it
      if (isNew || (prev !== undefined && f.mtime > prev)) changedPaths.push({ path: f.rel, mtime: f.mtime });
    }
    for (const f of files) lastMtime.set(f.rel, f.mtime);
    changedPaths.sort((a, b) => b.mtime - a.mtime); // newest first → camera flies to the most recently edited
    return changedPaths;
  }

  function buildSnapshot(files, changedSet) {
    const known = new Set(files.map((f) => f.rel));
    const cells = files.map((f) => {
      const changed = changedSet.has(f.rel);
      const c = content.get(f.rel);
      const slash = f.rel.indexOf('/');
      return {
        id: f.rel, path: f.rel,
        language: LANG[ext(f.rel)] || ext(f.rel) || 'txt',
        size_lines: c ? c.split('\n').length : 0,
        preview: previewOfContent(c),
        category: slash > 0 ? f.rel.slice(0, slash) : 'root',
        status: changed ? 'modified' : 'idle',
        modification_count: changed ? 1 : 0,
        anomaly: null,
        lastModified: f.mtime * 1000,
      };
    });
    const edges = [];
    for (const f of files) { const c = content.get(f.rel); if (c) for (const to of importsOf(f.rel, c, known)) edges.push({ from: f.rel, to }); }
    return { cells, edges, root: `${host}:${root}`, remote: true, scannedAt: Date.now(), changed: [...changedSet] };
  }

  async function scan() {
    if (stopped || scanning) return;
    scanning = true;
    try {
      // ---- Phase 1: list (fast) → paint the tree immediately, even on a huge repo ----
      const listRes = await sh(host, buildListCmd(root), { timeoutMs: 20000 });
      if (stopped) return;
      if (!listRes.ok) { onStatus?.({ ok: false, error: listRes.err || 'ssh failed', host, root }); return; }
      const files = parseList(listRes.out);
      if (!files.length) { if (!firstOk) onStatus?.({ ok: false, error: 'no code files found (check the path)', host, root }); return; }
      const changedPaths = diffChanges(files);
      const changedSet = new Set(changedPaths.map((c) => c.path));
      onStatus?.({ ok: true, host, root, files: files.length });
      onSnapshot?.(buildSnapshot(files, changedSet)); // tree on screen now (no content yet)
      firstOk = true;
      // ---- Phase 2: content of the first CONTENT_CAP files → import edges + previews, then repaint ----
      const cRes = await sh(host, buildContentCmd(root), { timeoutMs: 45000 });
      if (stopped || !cRes.ok) return; // tree already shown; a content failure just means no edges this round
      content = parseContent(cRes.out);
      if (!baseline.size) baseline = new Map(content); // first content scan = "session start" for revert
      onSnapshot?.(buildSnapshot(files, changedSet)); // same files+changes, now enriched with content/edges
    } finally {
      scanning = false;
    }
  }

  return {
    start() { if (timer) return; scan(); timer = setInterval(scan, intervalMs); },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = null; },
    scanNow: scan,
    getContent: (rel) => content.get(rel),
    hasBaseline: (rel) => baseline.has(rel),
    // Restore a remote file to its session-start content by piping it back over ssh (cat > file).
    revert(rel) {
      return new Promise((resolve) => {
        if (!baseline.has(rel)) return resolve({ ok: false, err: 'no session-start snapshot' });
        const abs = `${root.replace(/\/$/, '')}/${rel}`;
        const p = spawn('ssh', [...sshControlArgs({ batch: true }), host, `cat > ${JSON.stringify(abs)}`], {
          stdio: ['pipe', 'ignore', 'pipe'],
          env: { ...loginEnv(), ...sshControlEnv() },
        });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('error', (e) => resolve({ ok: false, err: e.message }));
        p.on('close', (code) => {
          if (code === 0) { content.set(rel, baseline.get(rel)); lastMtime.delete(rel); scan(); resolve({ ok: true }); }
          else resolve({ ok: false, err: err || ('exit ' + code) });
        });
        try { p.stdin.write(baseline.get(rel)); p.stdin.end(); } catch (e) { resolve({ ok: false, err: e.message }); }
      });
    },
  };
}
