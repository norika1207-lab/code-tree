import fs from 'node:fs';
import path from 'node:path';

function controlDir() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user';
  const dir = path.join('/tmp', `ctssh-${uid}`);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  return dir;
}

export function sshControlPath() {
  return path.join(controlDir(), '%C');
}

export function sshControlArgs({ batch = false, connectTimeout = 10 } = {}) {
  const args = [
    '-o', 'ControlMaster=auto',
    '-o', 'ControlPersist=20m',
    '-o', `ControlPath=${sshControlPath()}`,
    '-o', `ConnectTimeout=${connectTimeout}`,
  ];
  if (batch) args.unshift('-o', 'BatchMode=yes');
  return args;
}

export function sshControlEnv() {
  return { CODETREE_SSH_CONTROL_PATH: sshControlPath() };
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function injectSshControlIntoCommand(line) {
  const raw = String(line || '');
  const trimmed = raw.trim();
  if (!/^ssh(?:\s|$)/.test(trimmed)) return null;
  if (/\bControlPath=|\bControlMaster=|\bControlPersist=/.test(raw)) return null;
  const opts = sshControlArgs({ batch: false }).map(shellQuote).join(' ');
  return raw.replace(/^(\s*ssh)(\s|$)/, `$1 ${opts}$2`);
}
