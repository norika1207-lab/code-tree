#!/usr/bin/env node
// `codetree [專案路徑]`：在終端機任何專案裡打這個，圖像編輯器就開在那個專案上。
// 像 `code .` 一樣。沒給路徑 → 用當前目錄。把目標目錄用 env 帶進 Electron，
// main.js 讀 CODE_TREE_ROOT 就直接開，不彈選擇器。
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 目標專案：第一個非 flag 參數，否則當前工作目錄
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const target = path.resolve(arg || process.cwd());
if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error('找不到資料夾：' + target);
  process.exit(1);
}

let electronBin;
try { electronBin = require('electron'); } // electron 套件 export 出 binary 路徑
catch { console.error('找不到 electron，先在 ' + appRoot + ' 跑 `npm install`'); process.exit(1); }

const child = spawn(electronBin, [appRoot], {
  stdio: 'inherit',
  env: { ...process.env, CODE_TREE_ROOT: target },
});
child.on('close', (code) => process.exit(code ?? 0));
