import assert from 'node:assert/strict';
import path from 'node:path';
import WebSocket from 'ws';
import { startCore } from '../src/core/server.js';

const wsPort = 7788;
const webPort = 7798;
const core = startCore({ root: process.cwd(), port: wsPort, webPort, noProject: true });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitState(ws, predicate, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for state')), timeoutMs);
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type !== 'state') return;
      if (predicate(msg.payload || {})) {
        clearTimeout(timer);
        resolve(msg.payload);
      }
    });
  });
}

try {
  await wait(200);
  const ws = await connect();

  ws.send(JSON.stringify({
    type: 'gpt_text',
    text: 'file: src/generated-card.js\n```js\nexport const generatedCard = () => \"one box\";\n```',
  }));
  const one = await waitState(ws, (s) => Array.isArray(s.cells) && s.cells.length === 1);
  assert.equal(one.cells[0].path, 'src/generated-card.js');
  console.log(`GPT text -> ${one.cells.length} box`);

  const sampleRoot = path.resolve('sample');
  ws.send(JSON.stringify({ type: 'gpt_prompt', text: `open project ${sampleRoot}` }));
  const project = await waitState(ws, (s) => Array.isArray(s.cells) && s.cells.length >= 4 && !s.scanning);
  console.log(`GPT open project -> ${project.cells.length} boxes, ${project.edges.length} lines`);

  ws.close();
} finally {
  core.close();
}
