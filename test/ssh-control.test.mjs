import assert from 'node:assert/strict';
import { injectSshControlIntoCommand, sshControlArgs, sshControlEnv, sshControlPath } from '../src/core/ssh-control.js';

const path = sshControlPath();
assert.match(path, /%C$/);
assert.equal(sshControlEnv().CODETREE_SSH_CONTROL_PATH, path);

const args = sshControlArgs({ batch: true });
assert.deepEqual(args.slice(0, 2), ['-o', 'BatchMode=yes']);
assert.ok(args.includes('ControlMaster=auto'));
assert.ok(args.includes('ControlPersist=20m'));
assert.ok(args.some((a) => a === `ControlPath=${path}`));

const rewritten = injectSshControlIntoCommand('ssh sportverse');
assert.ok(rewritten.startsWith('ssh '));
assert.ok(rewritten.includes('ControlMaster=auto'));
assert.ok(rewritten.includes('ControlPath='));
assert.ok(rewritten.endsWith(' sportverse'));

assert.equal(injectSshControlIntoCommand('echo ssh sportverse'), null);
assert.equal(injectSshControlIntoCommand('ssh -o ControlPath=/tmp/x sportverse'), null);

console.log('ssh-control: ok');
