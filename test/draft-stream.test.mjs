// Prove the draft stream turns "code being typed in the CLI" into open→code→bind→close events, the way
// norika described it: unnamed code box first, then it gets a filename on save.
import { createDraftStream } from '../src/core/draft-stream.js';

let pass = 0, fail = 0; const fails = [];
function run(name, chunks, check) {
  const ev = [];
  const ds = createDraftStream((e) => ev.push(e));
  for (const c of chunks) ds.feed(c);
  try { check(ev); pass++; } catch (e) { fail++; fails.push({ name, msg: e.message, ev }); }
}
const ops = (ev) => ev.map((e) => e.op);
const has = (ev, op, pred) => ev.some((e) => e.op === op && (!pred || pred(e)));

// A) fenced code block then a Write(path) names it — the core scenario.
run('fence then Write binds', [
  'Sure, here is the helper:\n',
  '```python\n', 'def add(a, b):\n', '    return a + b\n', '```\n',
  '⏺ Write(src/util/math.py)\n',
], (ev) => {
  if (!has(ev, 'open')) throw new Error('no open');
  if (!has(ev, 'code', (e) => /return a \+ b/.test(e.code))) throw new Error('code missing');
  if (!has(ev, 'bind', (e) => e.path === 'src/util/math.py')) throw new Error('bind missing: ' + JSON.stringify(ev));
});

// B) the draft is anonymous until the bind (open+code happen with no path first).
run('anonymous before bind', [
  '```js\n', 'export const x=1\n', '```\n', '  ⏺  Wrote 1 line to /opt/app/x.js\n',
], (ev) => {
  const firstBind = ev.findIndex((e) => e.op === 'bind');
  const firstCode = ev.findIndex((e) => e.op === 'code');
  if (firstCode < 0) throw new Error('no code');
  if (firstBind < 0) throw new Error('no bind');
  if (!(firstCode < firstBind)) throw new Error('code should precede bind');
  if (ev.find((e) => e.op === 'bind').path !== '/opt/app/x.js') throw new Error('wrong path');
});

// C) heredoc names the draft from the start and captures body.
run('heredoc named + body', [
  "cat > /opt/vidgen/static/new.html <<'EOF'\n", '<html>\n', '<body>hi</body>\n', 'EOF\n',
], (ev) => {
  if (!has(ev, 'bind', (e) => e.path === '/opt/vidgen/static/new.html')) throw new Error('no bind');
  if (!has(ev, 'code', (e) => /body>hi/.test(e.code))) throw new Error('no body');
  if (!has(ev, 'close')) throw new Error('no close');
});

// D) chunk splitting mid-line must not break parsing.
run('split mid-line', [
  '```py', 'thon\n', 'x =', ' 42\n', '`', '``\n', 'Write(a/b/c.py)\n',
], (ev) => {
  if (!has(ev, 'code', (e) => /x = 42/.test(e.code))) throw new Error('code lost across chunks: ' + JSON.stringify(ev));
  if (!has(ev, 'bind', (e) => e.path === 'a/b/c.py')) throw new Error('bind lost');
});

// E) Write tool with no preceding code still makes a named draft (cell shows up immediately).
run('bind with no code makes named draft', [
  '⏺ Edit(/Users/n/proj/app.py)\n',
], (ev) => {
  if (!has(ev, 'open')) throw new Error('no open');
  if (!has(ev, 'bind', (e) => e.path === '/Users/n/proj/app.py')) throw new Error('no bind');
});

// F) prose with backticks-inline must NOT open a fence (only a fence line on its own).
run('inline backticks ignored', [
  'use the `print()` function and `os.path` here\n',
], (ev) => { if (ev.length) throw new Error('should emit nothing: ' + JSON.stringify(ev)); });

// G) two files in sequence get two distinct draft ids.
run('two files two ids', [
  '```py\n', 'a=1\n', '```\n', 'Write(one.py)\n',
  '```py\n', 'b=2\n', '```\n', 'Write(two.py)\n',
], (ev) => {
  const binds = ev.filter((e) => e.op === 'bind');
  if (binds.length !== 2) throw new Error('want 2 binds, got ' + binds.length);
  if (binds[0].id === binds[1].id) throw new Error('ids not distinct');
  if (binds[0].path !== 'one.py' || binds[1].path !== 'two.py') throw new Error('paths wrong');
});

console.log(`\n=== draft-stream: ${pass} pass / ${fail} fail (of ${pass + fail}) ===`);
for (const f of fails) console.log('  ✗', f.name, '\n     ', f.msg, '\n     ', JSON.stringify(f.ev));
process.exit(fail ? 1 : 0);
