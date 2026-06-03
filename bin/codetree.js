#!/usr/bin/env node
// `codetree [project-path]`: run this in any project in the terminal and the visual editor opens on that project.
// Works like `code .`. No path given → use the current directory. The target directory is passed into Electron via env,
// and main.js reads CODE_TREE_ROOT to open straight away without showing a picker.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Target project: the first non-flag argument, otherwise the current working directory
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const target = path.resolve(arg || process.cwd());
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error('Folder not found: ' + target);
  process.exit(1);
}

let electronBin;
try { electronBin = require('electron'); } // the electron package exports the binary path
catch { console.error('electron not found; run `npm install` in ' + appRoot + ' first'); process.exit(1); }

const child = spawn(electronBin, [appRoot], {
  stdio: 'inherit',
  env: { ...process.env, CODE_TREE_ROOT: target },
});
child.on('close', (code) => process.exit(code ?? 0));
