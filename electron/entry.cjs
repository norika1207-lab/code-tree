// CommonJS entry point: packaged Electron has flaky support for "ESM as main", so main.js silently fails to run.
// Use a CJS shim to dynamically import the real ESM main, which works in both dev and packaged builds,
// and writes errors to the log on failure (otherwise a packaged main error is completely silent).
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
import('./main.js').catch((e) => {
  const msg = '[' + new Date().toISOString() + '] entry.cjs: import main.js FAILED\n' + (e && e.stack || e) + '\n';
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'codetree.log'), msg); } catch {}
  process.stderr.write(msg);
});
