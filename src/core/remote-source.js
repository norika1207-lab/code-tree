// Remote project source: map a project that lives on another machine over plain ssh.
// Why: many people (and Code Tree's author) do their real work on a remote box, editing over `ssh host`.
// The local file watcher can't see those files, so the world-tree stays empty. This polls the remote
// project over ssh, builds the same { cells, edges, root } snapshot the local Graph produces, and
// flags files whose mtime moved since the last poll as "modified" so the tree lights up as you work.
//
// Zero install on either side: just ssh + find + cat. Uses the user's own ~/.ssh/config (aliases, keys).
import { spawn } from 'node:child_process';

const CODE_EXT = ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rb', 'rs', 'java', 'php', 'c', 'h', 'cpp', 'hpp'];
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
    if (!spec.startsWith('.')) return null;
    const dots = spec.match(/^\.+/)[0].length;
    const rest = spec.slice(dots).replace(/\./g, '/');
    let dir = dirname(fromRel);
    for (let i = 1; i < dots; i++) dir = dirname(dir);
    const base = normalize(dir + '/' + rest);
    for (const cand of [base + '.py', base + '/__init__.py']) if (known.has(cand)) return cand;
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
    const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill(); } catch {} resolve({ ok: false, out, err: 'timeout' }); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { clearTimeout(t); resolve({ ok: code === 0, out, err }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ ok: false, out, err: e.message }); });
  });
}

// One round-trip: list code files (path + mtime) and stream their contents, delimited by MARK.
function buildScanCmd(root) {
  const exprs = CODE_EXT.map((e) => `-name '*.${e}'`).join(' -o ');
  const find = `find . -type f \\( ${exprs} \\) -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' -not -path '*/__pycache__/*' -not -path '*/dist/*' -not -path '*/build/*' 2>/dev/null | head -${MAX_FILES}`;
  // emit "MARK<rel>\t<mtime>" then the file body, for each file
  return `cd ${JSON.stringify(root)} 2>/dev/null && ${find} | while IFS= read -r f; do m=$(stat -c %Y "$f" 2>/dev/null || echo 0); printf '%s%s\\t%s\\n' '${MARK}' "$f" "$m"; cat "$f" 2>/dev/null; done`;
}

function parseScan(raw) {
  // split on lines beginning with MARK; each chunk = header line + body
  const files = [];
  const lines = raw.split('\n');
  let cur = null;
  for (const line of lines) {
    if (line.startsWith(MARK)) {
      if (cur) files.push(cur);
      const head = line.slice(MARK.length);
      const tab = head.lastIndexOf('\t');
      const rel = (tab < 0 ? head : head.slice(0, tab)).replace(/^\.\//, '');
      const mtime = tab < 0 ? 0 : Number(head.slice(tab + 1)) || 0;
      cur = { rel, mtime, body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) files.push(cur);
  for (const f of files) f.content = f.body.join('\n');
  return files;
}

export function createRemoteSource({ host, root, intervalMs = 5000, onSnapshot, onStatus }) {
  let timer = null, lastMtime = new Map(), firstOk = false, stopped = false;
  let content = new Map(); // rel → file content from the latest scan, so the web server can serve card previews
  let baseline = new Map(); // rel → content at the FIRST scan, for remote "revert to session start"

  function snapshotFrom(files) {
    const known = new Set(files.map((f) => f.rel));
    const now = Date.now();
    const changedPaths = [];
    const cells = files.map((f) => {
      const prev = lastMtime.get(f.rel);
      const changed = prev !== undefined && f.mtime > prev;
      if (changed) changedPaths.push({ path: f.rel, mtime: f.mtime });
      const slash = f.rel.indexOf('/');
      return {
        id: f.rel,
        path: f.rel,
        language: LANG[ext(f.rel)] || ext(f.rel) || 'txt',
        size_lines: f.content ? f.content.split('\n').length : 0,
        category: slash > 0 ? f.rel.slice(0, slash) : 'root', // first dir → functional layer, matches the local Graph
        status: changed ? 'modified' : 'idle',
        modification_count: changed ? 1 : 0,
        anomaly: null,
        lastModified: f.mtime * 1000,
      };
    });
    const edges = [];
    for (const f of files) for (const to of importsOf(f.rel, f.content, known)) edges.push({ from: f.rel, to });
    for (const f of files) lastMtime.set(f.rel, f.mtime);
    // newest-changed first, so the camera flies to the file most recently edited
    changedPaths.sort((a, b) => b.mtime - a.mtime);
    return { cells, edges, root: `${host}:${root}`, remote: true, scannedAt: now, changed: changedPaths.map((c) => c.path) };
  }

  async function scan() {
    if (stopped) return;
    const res = await sh(host, buildScanCmd(root));
    if (!res.ok) { onStatus?.({ ok: false, error: res.err || 'ssh failed', host, root }); return; }
    const files = parseScan(res.out);
    if (!files.length && !firstOk) { onStatus?.({ ok: false, error: 'no code files found (check the path)', host, root }); return; }
    content = new Map(files.map((f) => [f.rel, f.content]));
    if (!firstOk) baseline = new Map(content); // first scan = the "session start" snapshot for revert
    firstOk = true;
    onStatus?.({ ok: true, host, root, files: files.length });
    onSnapshot?.(snapshotFrom(files));
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
        const p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, `cat > ${JSON.stringify(abs)}`], { stdio: ['pipe', 'ignore', 'pipe'] });
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
