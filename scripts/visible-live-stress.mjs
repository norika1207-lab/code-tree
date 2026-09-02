#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import WebSocket from 'ws';

const WS_URL = process.env.CODETREE_WS_URL || 'ws://localhost:7778';
const WEB_URL = process.env.CODETREE_WEB_URL || 'http://localhost:7790';
const TOTAL = Number(process.env.CODETREE_STRESS_RUNS || 1000);
const ROOT = process.env.CODETREE_DEMO_ROOT || path.join(os.homedir(), 'Desktop', 'CodeTreeLiveDemo');
const RUN_ID = process.env.CODETREE_STRESS_ID || `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const sid = `visible-${Date.now()}`;

const candidates = [
  ROOT,
  '/Users/norikaoda/Dropbox/Code Tree',
  '/Users/norikaoda/Dropbox/Mac (2)/Documents/Neuron Mecury',
  '/Users/norikaoda/Dropbox/Mac (2)/Documents/Neuron-Mercury-sync',
  '/Users/norikaoda/Dropbox/采妍國際/CRM Dashboard/crm-clean',
  '/Users/norikaoda/Dropbox/采妍國際/CRM Dashboard/crm-insight-dashboard',
].filter((p) => {
  try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch { return false; }
});

function realDir(p) {
  try { return fs.realpathSync(p); }
  catch { return path.resolve(p); }
}

function ensureDemoProject() {
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.rmSync(path.join(ROOT, 'src', 'live'), { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, 'src', 'live', RUN_ID), { recursive: true });
  const files = {
    'package.json': JSON.stringify({ name: 'codetree-live-demo', version: '1.0.0', type: 'module', scripts: { demo: 'node src/app.js' } }, null, 2) + '\n',
    'src/app.js': `import { createState } from './state.js';\nimport { renderFrame } from './render.js';\nimport { fetchProject } from './api.js';\n\nexport async function runDemo(projectName = 'CodeTreeLiveDemo') {\n  const state = createState(projectName);\n  const project = await fetchProject(projectName);\n  return renderFrame(state, project);\n}\n\nif (import.meta.url === \`file://\${process.argv[1]}\`) {\n  console.log(await runDemo());\n}\n`,
    'src/state.js': `export function createState(projectName) {\n  return {\n    projectName,\n    activeFile: 'src/app.js',\n    updatedAt: new Date().toISOString(),\n  };\n}\n`,
    'src/render.js': `import { summarizeProject } from './summary.js';\n\nexport function renderFrame(state, project) {\n  return {\n    title: state.projectName,\n    activeFile: state.activeFile,\n    summary: summarizeProject(project),\n  };\n}\n`,
    'src/api.js': `export async function fetchProject(projectName) {\n  return {\n    name: projectName,\n    files: ['src/app.js', 'src/state.js', 'src/render.js', 'src/api.js'],\n  };\n}\n`,
    'src/summary.js': `export function summarizeProject(project) {\n  return \`\${project.name}: \${project.files.length} files\`;\n}\n`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) fs.writeFileSync(abs, body);
  }
}

async function headOk(url) {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
}

function connect() {
  const ws = new WebSocket(WS_URL);
  const events = [];
  ws.on('message', (buf) => {
    try { events.push(JSON.parse(buf.toString())); }
    catch {}
    if (events.length > 12000) events.splice(0, events.length - 12000);
  });
  const opened = new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WebSocket open timeout')), 7000);
  });
  return { ws, events, opened };
}

function send(ws, type, payload = {}) {
  ws.send(JSON.stringify({ type, ...payload }));
}

async function waitFor(events, label, pred, timeout = 12000, after = 0) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (let i = after; i < events.length; i++) {
      if (pred(events[i], i)) return { event: events[i], index: i };
    }
    await new Promise((r) => setTimeout(r, 35));
  }
  throw new Error(`timeout waiting for ${label}; recent=${events.slice(-8).map((e) => e.type).join(',')}`);
}

async function openProjectAndWait(ws, events, root, label, timeout = 35000) {
  const before = events.length;
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const target = realDir(root);
  send(ws, 'project_open', { root, requestId });
  const ack = await waitFor(events, `${label} ack`, (e, idx) => (
    idx >= before && e.type === 'project_open_ack' && e.payload?.requestId === requestId
  ), 9000, before);
  if (!ack.event.payload?.ok) throw new Error(`${label} failed: ${ack.event.payload?.message || 'project open rejected'}`);
  return await waitFor(events, `${label} state`, (e, idx) => {
    if (idx < before || e.type !== 'state' || !e.payload || !Array.isArray(e.payload.cells)) return false;
    return realDir(e.payload.root || '') === target && e.payload.cells.length > 0;
  }, timeout, before);
}

function visible(ws, payload) {
  send(ws, 'visible_test', { payload: { total: TOTAL, ...payload } });
  const p = { total: TOTAL, ...payload };
  const shouldWriteTerminal = p.fail || p.status === 'complete' || p.status === 'failed' || p.status === 'starting' || p.status === 'tree-ready' || p.status === 'checkpoint' || p.status === 'project-ok' || p.iteration % 25 === 0;
  if (!shouldWriteTerminal) return;
  const line = [
    `\r\n\x1b[36m[VISIBLE TEST ${p.iteration ?? 0}/${p.total}]\x1b[0m ${p.status || 'running'}`,
    p.input ? `你輸入: ${p.input}` : '',
    p.output ? `回應: ${p.output}` : '',
    p.file ? `檔案反應: ${p.file}` : (p.root ? `專案: ${p.root}` : ''),
  ].filter(Boolean).join('\r\n') + '\r\n';
  send(ws, 'visible_terminal_output', { sessionId: '1', data: line });
}

function mutateDemoFile(iteration) {
  const rel = `src/live/${RUN_ID}/visible-${String(iteration).padStart(4, '0')}.js`;
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `import { summarizeProject } from '../../summary.js';\n\nexport function visibleBlock${iteration}(project) {\n  return summarizeProject(project) + ' / visible ${iteration}';\n}\n`);
  return rel;
}

async function main() {
  ensureDemoProject();
  await headOk(`${WEB_URL}/`);
  await headOk(`${WEB_URL}/viz`);

  const { ws, events, opened } = connect();
  await opened;

  visible(ws, { iteration: 0, status: 'starting', input: 'open Code Tree live stress', output: 'HTTP and WS connected', root: ROOT });
  send(ws, 'pty_start', { sessionId: sid, cols: 120, rows: 30 });
  await waitFor(events, 'pty output', (e) => e.type === 'pty_output' && e.sessionId === sid, 10000);

  const demoState = await openProjectAndWait(ws, events, ROOT, 'demo project tree', 35000);
  visible(ws, {
    iteration: 0,
    status: 'tree-ready',
    input: `open project ${ROOT}`,
    output: `${demoState.event.payload.cells.length} file boxes, ${demoState.event.payload.edges.length} dependency lines`,
    root: ROOT,
  });

  const failures = [];
  for (let i = 1; i <= TOTAL; i++) {
    const file = mutateDemoFile(i);
    visible(ws, {
      iteration: i,
      status: 'running',
      input: `GPT> visible test ${i}: update ${file}`,
      output: 'waiting for file watcher and terminal echo',
      file,
      root: ROOT,
    });

    const before = events.length;
    send(ws, 'agent_prompt_submit', {
      sessionId: sid,
      text: `printf "__CT_VISIBLE_${i}__\\n"`,
      options: { mode: 'auto', model: 'auto', effort: 'medium' },
      attachments: [],
      deferRender: true,
    });

    try {
      const pass = await waitFor(events, `command passthrough ${i}`, (e, idx) => (
        idx >= before && e.type === 'agent_prompt_passthrough' && e.sessionId === sid && e.payload?.kind === 'command'
      ), 7000, before);
      await waitFor(events, `terminal marker ${i}`, (e, idx) => (
        idx >= pass.index && e.type === 'pty_output' && e.sessionId === sid && String(e.data || '').includes(`__CT_VISIBLE_${i}__`)
      ), 9000, pass.index);
      await waitFor(events, `tree update ${i}`, (e, idx) => (
        idx >= before && e.type === 'state' && e.payload && realDir(e.payload.root || '') === realDir(ROOT)
      ), 9000, before).catch(() => null);

      if (i % 25 === 0) {
        const project = candidates[Math.floor(i / 25) % candidates.length];
        visible(ws, {
          iteration: i,
          status: 'switch-project',
          input: `open project ${project}`,
          output: 'checking that arbitrary project draws boxes',
          root: project,
        });
        const st = await openProjectAndWait(ws, events, project, `project tree ${project}`, 40000);
        visible(ws, {
          iteration: i,
          status: 'project-ok',
          input: `open project ${project}`,
          output: `${st.event.payload.cells.length} boxes, ${st.event.payload.edges.length} lines`,
          root: project,
        });
        await openProjectAndWait(ws, events, ROOT, 'return demo tree', 40000);
      }

      if (i % 50 === 0) {
        visible(ws, {
          iteration: i,
          status: 'checkpoint',
          input: `checkpoint ${i}`,
          output: `${i}/${TOTAL} passed, 0 failures so far`,
          file,
          root: ROOT,
        });
      }
    } catch (err) {
      const fail = { iteration: i, message: err?.message || String(err), file };
      failures.push(fail);
      visible(ws, {
        iteration: i,
        status: 'failed',
        fail: true,
        input: `visible test ${i}`,
        output: fail.message,
        file,
        root: ROOT,
      });
      break;
    }
  }

  const ok = failures.length === 0;
  visible(ws, {
    iteration: ok ? TOTAL : failures[0].iteration,
    status: ok ? 'complete' : 'failed',
    fail: !ok,
    input: ok ? `${TOTAL}/${TOTAL} complete` : `failed at ${failures[0].iteration}`,
    output: ok ? 'No failures in visible live stress.' : failures[0].message,
    root: ROOT,
  });
  ws.close();
  console.log(JSON.stringify({
    ok,
    total: TOTAL,
    failures,
    demoRoot: ROOT,
    runId: RUN_ID,
    projects: candidates,
  }, null, 2));
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});
