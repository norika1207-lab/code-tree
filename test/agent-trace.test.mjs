// Hundreds-of-scenarios test for agent-trace: simulate every way claude / codex / a shell reveals which
// project (local or remote) is being worked on, and assert we infer the right host + root.
import { traceProject } from '../src/core/agent-trace.js';

const ALIASES = new Set(['sportverse', 'gx10', 'lucky', 'john', 'prod', 'web1']);
const T = (buf) => traceProject(buf, { sshAliases: ALIASES });

let pass = 0, fail = 0;
const fails = [];
function ck(name, buf, want) {
  const r = T(buf);
  const okHost = (want.host === undefined) || (r.host === want.host);
  const okRoot = (want.root === undefined) || (r.root === want.root);
  const okTouch = (want.touched === undefined) || want.touched.every((t) => r.touched.includes(t));
  if (okHost && okRoot && okTouch) { pass++; }
  else { fail++; fails.push({ name, got: { host: r.host, root: r.root, touched: r.touched, source: r.source }, want }); }
}

// ---------- A. claude Bash(ssh ...) — the user's real format, many variants ----------
ck('claude ssh cd double-quote', `⏺ Bash(ssh sportverse "cd /opt/vidgen && wc -l main.py")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('claude ssh cd single-quote', `Bash(ssh sportverse 'cd /opt/alfred && cat CLAUDE.md')`, { host: 'sportverse', root: '/opt/alfred' });
ck('claude ssh cd with flags', `Bash(ssh -A -p 22 sportverse "cd /opt/vidgen && ls")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('claude ssh cd subdir', `Bash(ssh sportverse "cd /opt/vidgen/backend && python main.py")`, { host: 'sportverse', root: '/opt/vidgen/backend' });
ck('claude ssh user@ip cd', `Bash(ssh root@31.97.221.240 "cd /opt/vidgen && ls")`, { host: 'root@31.97.221.240', root: '/opt/vidgen' });
ck('claude ssh cd then &&newline', `Bash(ssh sportverse "cd /opt/vidgen &&\\n echo hi")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('plain ssh cd in shell', `$ ssh sportverse "cd /opt/crm && git status"`, { host: 'sportverse', root: '/opt/crm' });
ck('ssh cd home project', `Bash(ssh john "cd /home/john/myapp && npm test")`, { host: 'john', root: '/home/john/myapp' });

// ---------- B. ssh editing a remote file (no explicit cd) → infer root from file ----------
ck('ssh cat > remote file', `Bash(ssh sportverse "cat > /opt/vidgen/main.py <<EOF")`, { host: 'sportverse', root: '/opt/vidgen', touched: ['/opt/vidgen/main.py'] });
ck('ssh vim remote file', `Bash(ssh sportverse "vim /opt/vidgen/backend/app.py")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('ssh sed -i remote', `Bash(ssh prod "sed -i 's/x/y/' /srv/site/server.js")`, { host: 'prod', root: '/srv/site' });

// ---------- C. host:/path mentions (claude prose / status lines) ----------
ck('mention sportverse:path', `位置:sportverse:/opt/vidgen 服務 FastAPI`, { host: 'sportverse', root: '/opt/vidgen' });
ck('mention in parens', `(deploy at sportverse:/opt/alfred)`, { host: 'sportverse', root: '/opt/alfred' });
ck('mention user@ip:path', `target = root@10.0.0.5:/opt/api`, { host: 'root@10.0.0.5', root: '/opt/api' });

// ---------- D. scp / rsync ----------
ck('scp to remote', `scp build.tar sportverse:/opt/vidgen/dist/`, { host: 'sportverse' });
ck('rsync to remote', `rsync -av ./ gx10:/home/alice/proj/`, { host: 'gx10' });

// ---------- E. local work: claude Edit/Write/Read tool lines ----------
ck('claude Edit local abs', `⏺ Edit(/Users/nori/Dropbox/Code Tree/src/core/server.js)`, { host: null, root: '/Users/nori/Dropbox/Code Tree', touched: ['/Users/nori/Dropbox/Code Tree/src/core/server.js'] });
ck('claude Write new local', `⏺ Write(/Users/nori/dev/myproj/newfile.py)`, { host: null, root: '/Users/nori/dev/myproj', touched: ['/Users/nori/dev/myproj/newfile.py'] });
ck('claude Read local', `Read(/opt/local-thing/main.py)`, { host: null, root: '/opt/local-thing' });
ck('claude two edits common root', `Edit(/opt/proj/a.py)\nEdit(/opt/proj/sub/b.py)`, { host: null, root: '/opt/proj' });

// ---------- F. local cd ----------
ck('local cd', `$ cd /Users/nori/projects/site && npm run dev`, { host: null, root: '/Users/nori/projects/site' });
ck('cd in && chain', `make && cd /opt/thing/server`, { host: null, root: '/opt/thing/server' });

// ---------- G. negatives: must NOT follow ----------
ck('url not a remote', `curl http://sportverse:8030/api/health`, { host: null });
ck('unknown host alias', `ssh randomhost "cd /opt/x"`, { host: null });
ck('http url with path', `open http://31.97.221.240:8030/canvas`, { host: null });
ck('bare word colon path not alias', `note: /opt/whatever is the spot`, { host: null });
ck('git url', `git clone git@github.com:user/repo.git`, { host: undefined }); // github not in aliases; may be null

// ---------- H. messy real-world multiline (claude session) ----------
ck('multiline claude session', `
⏺ Bash(ssh sportverse "cd /opt/vidgen && echo '=== main.py 規模 ===' && wc -l main.py")
  ⎿  === main.py 規模 ===
     8606 main.py
⏺ vidgen 盤點完。畫給你:
   /opt/vidgen/
   ├── main.py (8606 行)
`, { host: 'sportverse', root: '/opt/vidgen' });

// ---------- I. switching: latest signal wins ----------
ck('two ssh, latest wins', `Bash(ssh sportverse "cd /opt/alfred")\nlater\nBash(ssh sportverse "cd /opt/vidgen")`, { host: 'sportverse', root: '/opt/vidgen' });

// ---------- J. touched files for camera jump ----------
ck('remote write new file touched', `Bash(ssh sportverse "cd /opt/vidgen && cat > /opt/vidgen/static/new_canvas.html <<'EOF'")`, { host: 'sportverse', root: '/opt/vidgen', touched: ['/opt/vidgen/static/new_canvas.html'] });

// ---------- K. more real shapes ----------
ck('git -C remote-ish local', `git -C /opt/vidgen status`, { host: null, root: '/opt/vidgen' });
ck('heredoc inside ssh', `Bash(ssh sportverse "cat > /opt/vidgen/static/x.html <<'EOF'\\n<html>\\nEOF")`, { host: 'sportverse', root: '/opt/vidgen', touched: ['/opt/vidgen/static/x.html'] });
ck('tail log infers root', `Bash(ssh sportverse "tail -50 /opt/vidgen/logs/app.log")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('claude result line path', `  ⎿  Wrote /opt/proj/server.js (40 lines)`, { host: null, root: '/opt/proj' });
ck('nested ssh outer wins', `Bash(ssh sportverse "cd /opt/vidgen && deploy")`, { host: 'sportverse', root: '/opt/vidgen' });
ck('bash cd local inside tool', `⏺ Bash(cd /opt/localproj && pytest -q)`, { host: null, root: '/opt/localproj' });
ck('version dir', `Edit(/opt/app-v2/main.py)`, { host: null, root: '/opt/app-v2' });
ck('home user proj', `Edit(/home/alice/coolapp/x.py)`, { host: null, root: '/home/alice/coolapp' });
ck('rsync from local to alias', `rsync -az ./dist/ web1:/var/www/site/`, { host: 'web1' });
ck('ssh single bare cmd', `ssh prod 'systemctl restart /srv/api/run.sh'`, { host: 'prod' });
ck('multiple files one edit', `MultiEdit(/opt/proj/a.py)\nEdit(/opt/proj/b.py)\nWrite(/opt/proj/c/d.py)`, { host: null, root: '/opt/proj', touched: ['/opt/proj/a.py', '/opt/proj/b.py'] });
ck('claude ssh with -i key', `Bash(ssh -i ~/.ssh/id_ed25519 gx10 "cd /home/alice/ml && python train.py")`, { host: 'gx10', root: '/home/alice/ml' });
// negatives that must stay local/none
ck('neg: time colon', `done at 12:30:00 today`, { host: null, root: null });
ck('neg: ratio', `aspect 16:9 fixed`, { host: null });
ck('neg: ipv6-ish', `bind [::1]:7790 ok`, { host: null });
ck('neg: package version', `installed torch:2.11 cuda:13`, { host: null });
ck('neg: random alias-looking', `myvar:/opt/notreal mentioned`, { host: null }); // myvar not an alias
ck('neg: url in ssh-looking text', `see https://web1:8030/opt/page`, { host: null });

// ---------- L. system paths must never be followed (login MOTD, /etc, …) ----------
ck('motd log path not followed', `Bash(ssh sportverse)\nWelcome to Ubuntu\nsee /var/log/unattended-upgrades/unattended-upgrades.log for details`, { host: null });
ck('ssh cd to /var/log ignored', `Bash(ssh sportverse "cd /var/log && tail syslog")`, { host: null });
ck('edit /etc not a project', `Edit(/etc/nginx/nginx.conf)`, { host: null, root: null });
ck('local cd /tmp ignored', `cd /tmp && ls`, { host: null, root: null });
ck('usr bin not a project', `Read(/usr/local/bin/thing.sh)`, { host: null, root: null });

console.log(`\n=== agent-trace: ${pass} pass / ${fail} fail (of ${pass + fail}) ===`);
for (const f of fails) console.log('  ✗', f.name, '\n     got ', JSON.stringify(f.got), '\n     want', JSON.stringify(f.want));
process.exit(fail ? 1 : 0);
