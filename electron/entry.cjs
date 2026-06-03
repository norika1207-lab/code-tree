// CommonJS 進入點：打包後的 Electron 對「ESM 當 main」支援不穩，main.js 會靜默不執行。
// 用一個 CJS shim 動態 import 真正的 ESM main，dev / 打包兩邊都吃得到，
// 失敗時也把錯誤寫進 log（不然打包後 main 出錯是完全沒聲音的）。
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
import('./main.js').catch((e) => {
  const msg = '[' + new Date().toISOString() + '] entry.cjs: import main.js FAILED\n' + (e && e.stack || e) + '\n';
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'codetree.log'), msg); } catch {}
  process.stderr.write(msg);
});
