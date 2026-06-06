// draft-stream: watch the CLI text the way a human does and turn "code being written" into a live cell —
// BEFORE the file is saved. The moment code starts streaming (a ``` block, a heredoc, an agent writing a
// file), we open a DRAFT cell that shows that code live. When a filename appears (Write(x), "Wrote … to x",
// cat > x <<EOF), the draft binds to that name and becomes a real, titled cell. This is the thing the tree is
// for: you watch code get typed into an unnamed box, then watch it crystallize into a named file and grow on.
//
// Pure + incremental + dependency-free, so it can be unit-tested against simulated agent output. Feed it raw
// (already ANSI-stripped) terminal text in any chunk sizes; it emits events via the callback you pass in:
//   { op:'open',  id, lang }            a new unnamed draft cell appeared (code is about to stream in)
//   { op:'code',  id, code }            the draft's accumulated code so far (idempotent — full text each time)
//   { op:'bind',  id, path }            the draft just got a filename (save) → becomes a titled cell
//   { op:'close', id }                  the code block ended (if never bound, it stays an unnamed draft)

const CODE_LANG = { py: 'py', js: 'js', jsx: 'jsx', ts: 'ts', tsx: 'tsx', mjs: 'js', cjs: 'js', go: 'go', rb: 'rb', rs: 'rs', java: 'java', php: 'php', c: 'c', h: 'c', cpp: 'cpp', css: 'css', html: 'html', json: 'json', sh: 'sh', md: 'md', yml: 'yaml', yaml: 'yaml' };
const MAX_CODE = 8000; // cap the code payload we ship per draft (a huge file would otherwise flood the socket)

function extLang(p) { const b = String(p).split('/').pop(); const i = b.lastIndexOf('.'); return i < 0 ? '' : (CODE_LANG[b.slice(i + 1).toLowerCase()] || b.slice(i + 1).toLowerCase()); }
function looksPathish(p) { return /\.[A-Za-z0-9]{1,8}$/.test(p) || /\//.test(p); }

export function createDraftStream(emit) {
  let buf = '';
  let counter = 0;
  let inFence = false, curId = null, codeLines = [], lastClosedId = null;
  let inHeredoc = false, hereTerm = '';

  function openDraft(lang, path) {
    counter++; curId = counter; codeLines = [];
    emit({ op: 'open', id: curId, lang: lang || (path ? extLang(path) : '') });
    if (path) emit({ op: 'bind', id: curId, path });
  }
  function pushCode() {
    let code = codeLines.join('\n');
    if (code.length > MAX_CODE) code = code.slice(-MAX_CODE);
    emit({ op: 'code', id: curId, code });
  }
  function closeDraft() {
    if (curId != null) { lastClosedId = curId; emit({ op: 'close', id: curId }); }
    curId = null; inFence = false; codeLines = [];
  }
  // Attach a filename to the draft we're filling, or the one we just closed; if there is none, create a named
  // draft on the spot so a titled cell shows up the instant the agent says it's writing a file.
  function bind(path) {
    path = path.trim().replace(/[)"',]+$/, '');
    if (!looksPathish(path)) return;
    const tid = curId != null ? curId : lastClosedId;
    if (tid != null) emit({ op: 'bind', id: tid, path });
    else openDraft(extLang(path), path);
  }

  function feedLine(line) {
    // Inside a heredoc: capture until the terminator line.
    if (inHeredoc) {
      if (line.trim() === hereTerm) { inHeredoc = false; closeDraft(); return; }
      codeLines.push(line); pushCode(); return;
    }
    // A fenced code block toggles a draft open/closed.
    const f = line.match(/^\s*(?:```|~~~)([A-Za-z0-9_+\-]*)\s*$/);
    if (f) { if (!inFence) { inFence = true; openDraft(f[1]); } else { closeDraft(); } return; }
    if (inFence) { codeLines.push(line); pushCode(); return; }
    // Heredoc start: cat > path <<'EOF' / tee path <<EOF / <<-EOF  → a draft that's named from the start.
    const h = line.match(/(?:^|[\s|;&(])(?:cat|tee)\s+(?:-a\s+)?>{1,2}?\s*([^\s<>|]+)\s*<<-?\s*['"]?([A-Za-z_]\w*)['"]?/);
    if (h) { hereTerm = h[2]; inHeredoc = true; openDraft(extLang(h[1]), h[1]); return; }
    // Filename signals from an agent's tool lines / result lines → name the current or just-closed draft.
    let m = line.match(/\b(?:Write|Edit|Update|Create|MultiEdit|NotebookEdit)\(\s*["']?([^)"'\n,]+)/);
    if (m) { bind(m[1]); return; }
    m = line.match(/\b(?:Wrote|Created|Updated|Saved|Writing|Creating)\b[^\n]*?\s((?:~|\.{0,2}\/)?[\w./@+-]*\.[A-Za-z0-9]{1,8})/);
    if (m) { bind(m[1]); return; }
  }

  return {
    feed(text) {
      buf += String(text);
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        try { feedLine(line); } catch {}
      }
      if (buf.length > 8000) buf = buf.slice(-8000);
    },
    // flush a trailing partial line (e.g. agent paused mid-line) so live code isn't a line behind.
    tick() { if (inFence && buf && !buf.includes('\n')) { codeLines.push(buf); pushCode(); codeLines.pop(); } },
  };
}
