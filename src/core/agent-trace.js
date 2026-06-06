// agent-trace: from a window of terminal output, work out WHICH project (local or remote) the user or an
// in-terminal agent (claude / codex / a plain shell) is working in, and WHICH files it just touched — so the
// world-tree can follow and the camera can fly to each file. The whole point: never make the user work a
// specific way. We read every signal that appears in the terminal and infer intent.
//
// Pure + dependency-free so it can be unit-tested against hundreds of simulated outputs.
//
// traceProject(buf, { sshAliases }) -> { host|null, root|null, touched:[abs paths], cwd|null, source }
//   host  : ssh alias or user@host if the work is remote, else null (local)
//   root  : inferred project root (remote or local absolute path), else null
//   touched: absolute file paths the agent just read/edited/wrote (newest last), for camera fly-to
//   source: which signal won (for debugging/telemetry)

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[=>]|\x1b\][0-9];[^\x07]*\x07/g;

// A host token: ssh alias or user@host (the host after @ may be an IP, so allow a digit there). validHost()
// gates which of these we actually trust (alias in ssh config, or a user@host form).
const HOSTPART = `(?:[a-zA-Z_][\\w.-]{0,40}@)?[\\w][\\w.-]{1,60}`;
// An absolute unix path (also matches ~/...). Stops at quotes, spaces, shell metachars.
const ABSPATH = `(?:~|/)[\\w./@+-]*`;

// Directories we treat as plausible project roots when inferring from file paths.
const ROOT_HINTS = /(?:^|\/)(?:opt|home|srv|root|var\/www|app|apps|workspace|projects|code|repos|Users\/[^/]+\/(?:Documents|Desktop|Dropbox|dev|src|code|projects))(?:\/|$)/;

// System directories that are never a "project" — don't follow login MOTD log paths, /etc, /usr, etc.
const SYS_PREFIX = /^\/(?:var(?!\/www)|etc|usr(?!\/local\/src)|proc|sys|dev|run|tmp|boot|lib|lib64|bin|sbin|snap)(?:\/|$)/;

function stripAnsi(s) { return String(s || '').replace(ANSI, ''); }

function dirOf(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function looksLikeFile(p) { return /\.[A-Za-z0-9_]{1,8}$/.test(p) || /\/(Makefile|Dockerfile|Procfile|README|LICENSE|requirements\.txt|go\.mod|Cargo\.toml|package\.json)$/i.test(p); }

// Longest common directory prefix of a set of absolute paths.
function commonDir(paths) {
  if (!paths.length) return null;
  const split = paths.map((p) => p.split('/'));
  const first = split[0];
  let n = first.length;
  for (const parts of split) { let i = 0; while (i < n && i < parts.length && parts[i] === first[i]) i++; n = i; }
  const dir = first.slice(0, n).join('/');
  return dir || '/';
}

// Trim a file/dir path up to the nearest plausible project-root segment (so /opt/vidgen/static/x.html → /opt/vidgen).
function toProjectRoot(p) {
  if (!p) return null;
  const parts = p.split('/');
  // find a segment matching a root hint, take one level below it (the project folder)
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (['opt', 'srv', 'app', 'apps', 'workspace', 'projects', 'code', 'repos', 'www'].includes(seg)) {
      return parts.slice(0, i + 2).join('/') || '/' + seg + '/' + parts[i + 1];
    }
    if (seg === 'home' && parts[i + 2]) return parts.slice(0, i + 3).join('/'); // /home/<user>/<proj>
    if (seg === 'Users' && parts[i + 2]) {
      // /Users/<u>/<Documents|...>/<proj>
      const base = ['Documents', 'Desktop', 'Dropbox', 'dev', 'src', 'code', 'projects', 'repos'];
      if (base.includes(parts[i + 2]) && parts[i + 3]) return parts.slice(0, i + 4).join('/');
      if (parts[i + 2]) return parts.slice(0, i + 3).join('/');
    }
  }
  // no hint: if it's a file, use its directory; else the path itself
  return looksLikeFile(p) ? dirOf(p) : p;
}

export function traceProject(rawBuf, opts = {}) {
  const sshAliases = opts.sshAliases instanceof Set ? opts.sshAliases : new Set(opts.sshAliases || []);
  const buf = stripAnsi(rawBuf);
  const validHost = (h) => !!h && (h.includes('@') || sshAliases.has(h) || /@[\d.]+$/.test(h));

  const touched = [];
  const pushTouched = (p) => { if (p && looksLikeFile(p)) { const a = p.replace(/^~\//, ''); if (!touched.includes(p)) touched.push(p); } };

  let remoteHost = null, remoteRoot = null, source = null, cwd = null;
  const remoteFiles = []; // abs paths seen inside remote (ssh) contexts

  // ---- 1) ssh commands: ssh <host> [flags] "<cmd>"  /  'cmd'  /  bare ----
  // Capture host + the quoted remote command (if any), then mine the command for cd + file paths.
  // skip ssh flags incl. flag values that are paths/ports (e.g. -i ~/.ssh/key, -p 22) before the host token.
  const SSH_RE = new RegExp(`\\bssh\\s+(?:(?:-\\S+|\\d+|~?/\\S+)\\s+)*(${HOSTPART})(?:\\s+(?:"([^"]*)"|'([^']*)'|(\\S[^\\n]*)))?`, 'g');
  let m;
  while ((m = SSH_RE.exec(buf)) !== null) {
    const host = m[1];
    if (!validHost(host)) continue;
    const cmd = m[2] || m[3] || m[4] || '';
    let root = null;
    const cdm = cmd.match(new RegExp(`\\bcd\\s+(${ABSPATH})`));
    if (cdm) root = cdm[1];
    // file paths inside the remote command (cat > file, vim file, > file, etc.)
    const fileRe = new RegExp(ABSPATH, 'g'); let fm;
    while ((fm = fileRe.exec(cmd)) !== null) { if (looksLikeFile(fm[0])) remoteFiles.push(fm[0]); }
    remoteHost = host;
    remoteRoot = root || remoteRoot;
    source = cdm ? 'ssh-cd' : (remoteFiles.length ? 'ssh-file' : 'ssh');
  }

  // ---- 2) host:/path mentions (e.g. "sportverse:/opt/vidgen") ----
  if (!remoteHost || !remoteRoot) {
    const MEN = new RegExp(`(?:^|[^\\w@.-])(${HOSTPART}):(/(?:opt|home|srv|root|var|app|apps|Users|workspace|data|projects|code|repos)[\\w./-]*)`, 'g');
    while ((m = MEN.exec(buf)) !== null) { if (validHost(m[1])) { remoteHost = remoteHost || m[1]; remoteRoot = remoteRoot || m[2]; source = source || 'host:path'; } }
  }

  // ---- 3) scp / rsync targets: scp x host:/path  /  rsync ... host:/path ----
  if (!remoteHost) {
    const SCP = new RegExp(`\\b(?:scp|rsync)\\s+[^\\n]*?(${HOSTPART}):(${ABSPATH})`, 'g');
    while ((m = SCP.exec(buf)) !== null) { if (validHost(m[1])) { remoteHost = m[1]; remoteRoot = remoteRoot || toProjectRoot(m[2]); source = source || 'scp'; } }
  }

  // ---- 4) agent tool lines: Read/Edit/Write/Update/Create/MultiEdit(<path>) and Bash(cd <path>) ----
  const TOOL = /(?:^|\s)(?:Read|Edit|Write|Update|Create|MultiEdit|NotebookEdit|Δ|⏺\s*\w+)\s*\(\s*([^),\n]+?)\s*[),]/g;
  while ((m = TOOL.exec(buf)) !== null) { const p = m[1].trim().replace(/^["']|["']$/g, ''); if (/^(?:~|\/)/.test(p)) pushTouched(p); }
  // explicit local cd (preceded by start, whitespace, a shell separator, or a tool's opening paren)
  const cdLocal = buf.match(new RegExp(`(?:^|[\\s;&|(])cd\\s+(${ABSPATH})`));
  if (cdLocal) cwd = cdLocal[1];
  // a directory flag: git -C <dir>, make -C <dir>, npm --prefix <dir>
  if (!cwd) { const cf = buf.match(new RegExp(`(?:-C|--cwd|--prefix|--directory)\\s+(${ABSPATH})`)); if (cf) cwd = cf[1]; }

  // ---- 5) bare absolute paths anywhere (weak signal; helps root inference) ----
  const bareFiles = [];
  const BARE = new RegExp(`(?:^|[\\s"'\`(])(${ABSPATH})`, 'g');
  while ((m = BARE.exec(buf)) !== null) { if (looksLikeFile(m[0].trim())) bareFiles.push(m[1]); }

  // ---- decide remote root if we have a host but no explicit root ----
  if (remoteHost && !remoteRoot) {
    const pool = remoteFiles.length ? remoteFiles : bareFiles;
    if (pool.length) {
      const cd = commonDir(pool.map((p) => p.replace(/^~\//, '/')));
      remoteRoot = toProjectRoot(cd);
      source = source || 'ssh-infer';
    }
  }

  // ---- assemble touched (remote-context files first, then tool files) ----
  for (const f of remoteFiles) pushTouched(f);

  // Never treat a system directory (MOTD log paths, /etc, /usr …) as a project to follow.
  if (remoteRoot && SYS_PREFIX.test(remoteRoot)) remoteRoot = null;

  if (remoteHost && remoteRoot) {
    return { host: remoteHost, root: remoteRoot.replace(/\/$/, '') || '/', touched, cwd, source: source || 'ssh' };
  }
  // local: an explicit cd IS the root (use it verbatim); otherwise infer from touched/bare files.
  let localRoot = cwd || null;
  if (!localRoot) {
    const pool = touched.length ? touched : bareFiles;
    if (pool.length) localRoot = toProjectRoot(commonDir(pool));
  }
  if (localRoot && SYS_PREFIX.test(localRoot)) localRoot = null;
  return { host: null, root: localRoot ? localRoot.replace(/\/$/, '') || '/' : null, touched, cwd, source: source || (localRoot ? 'local-infer' : 'none') };
}
