// Bragi local-LLM launcher (Demeter integration).
// On app start, spin up the bundled on-device coding model so Code Tree works fully offline, zero API:
//   llama-server (:8081, loads the GGUF)  ←  bragi-server.js proxy (:8080, OpenAI-compatible + intercept router)
// Code Tree's src/cli/local-detect.js already auto-detects the Bragi proxy on :8080 and prefers it.
//
// Everything is optional/non-fatal: if the model or binary is missing, we log and skip — Code Tree still
// runs with a cloud login or any other local model. The bundle is what makes it a single 1 GB offline app.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let llama = null;
let proxy = null;

// Where the bragi runtime lives: packaged → <app>/Contents/Resources/bragi ; dev → <repo>/runtime/bragi
function bragiDir(resourcesPath) {
  const packaged = resourcesPath ? path.join(resourcesPath, 'bragi') : null;
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'runtime', 'bragi');
}

// Find the GGUF model: env override → inside the bundle → the user's Bragi-LLM folder → any *.gguf in the bundle.
function findModel(dir) {
  const candidates = [
    process.env.MODEL_PATH,
    path.join(dir, 'c15v-q3km-imat.gguf'),
    path.join(os.homedir(), 'Documents', 'Bragi-LLM', 'c15v-q3km-imat.gguf'),
  ].filter(Boolean);
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.gguf')) candidates.push(path.join(dir, f)); } catch {}
  return candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

export function startBragi({ resourcesPath, execPath, logln = () => {} } = {}) {
  try {
    const dir = bragiDir(resourcesPath);
    const llamaBin = path.join(dir, 'llama-server');
    const proxyJs = path.join(dir, 'bragi-server.js');
    // Tell core where engine_lib.py lives so it can drop it into projects for Bragi's intercepted code to run.
    const enginePy = path.join(dir, 'engine_lib.py');
    if (fs.existsSync(enginePy)) process.env.BRAGI_ENGINE_LIB = enginePy;
    if (!fs.existsSync(llamaBin)) { logln('[bragi] llama-server not found at', llamaBin, '— skipping local model'); return; }
    if (!fs.existsSync(proxyJs)) { logln('[bragi] bragi-server.js not found — skipping local model'); return; }
    const model = findModel(dir);
    if (!model) {
      logln('[bragi] no GGUF model found (looked in bundle + ~/Documents/Bragi-LLM). Local model OFF;',
        'Code Tree still works with a cloud login or another local model. Drop c15v-q3km-imat.gguf into', dir);
      return;
    }
    try { fs.chmodSync(llamaBin, 0o755); } catch {}

    // -ngl 99 offloads to Apple Metal; harmless on CPU-only machines (llama.cpp falls back).
    logln('[bragi] starting llama-server', model);
    llama = spawn(llamaBin, ['-m', model, '--host', '127.0.0.1', '--port', '8081',
      '-c', '16384', '--parallel', '4', '-ngl', '99'], { cwd: dir, stdio: 'ignore' });
    llama.on('error', (e) => logln('[bragi] llama-server spawn error', e && e.message));
    llama.on('exit', (code) => logln('[bragi] llama-server exited', code));

    // Run the proxy with Electron-as-Node (no separate node binary needed in the packaged app).
    proxy = spawn(execPath, [proxyJs], {
      cwd: dir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BRAGI_PORT: '8080',
        BRAGI_LLAMA_URL: 'http://127.0.0.1:8081/v1/chat/completions' },
      stdio: 'ignore',
    });
    proxy.on('error', (e) => logln('[bragi] proxy spawn error', e && e.message));
    proxy.on('exit', (code) => logln('[bragi] proxy exited', code));
    logln('[bragi] launched — proxy :8080 → llama :8081 (model', path.basename(model) + ')');
  } catch (e) {
    logln('[bragi] startBragi failed', e && (e.stack || e.message));
  }
}

export function stopBragi() {
  for (const p of [proxy, llama]) { if (p) { try { p.kill(); } catch {} } }
  proxy = null; llama = null;
}
