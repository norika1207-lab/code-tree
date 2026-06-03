// Replayable script for scenario one: the agent edits session-store three times in a row over a session bug (flashing red)
// before realizing the root cause is in middleware. For the scripted LLM, and also the material for the 30-second demo video.
import fs from 'node:fs';
import path from 'node:path';

const ORIGINAL = {
  'src/auth.js':
    "import { getSession } from './session-store.js';\nimport { withAuth } from './middleware.js';\nexport function login(user) { return getSession(user.id); }\n",
  'src/middleware.js':
    "import { findUser } from './user-service.js';\nexport function withAuth(req) { return findUser(req.userId); }\n",
  'src/session-store.js':
    'const store = new Map();\nexport function getSession(id) { return store.get(id); }\nexport function setSession(id, v) { store.set(id, v); }\n',
  'src/user-service.js': "export function findUser(id) { return { id, name: 'demo' }; }\n",
};

// Reset the sample to its initial state so the demo can be re-run every time
export function resetSample(root) {
  for (const [rel, content] of Object.entries(ORIGINAL)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

export const demoScript = [
  { text: 'First let me see how the auth flow is wired.', tools: [{ name: 'read_file', input: { path: 'src/auth.js' } }] },
  { text: 'Session comes from session-store. Let me look at the store.', tools: [{ name: 'read_file', input: { path: 'src/session-store.js' } }] },
  {
    text: "The store doesn't handle a miss. Let me add a null fallback.",
    tools: [{ name: 'edit_file', input: { path: 'src/session-store.js', old_str: 'return store.get(id); }', new_str: 'return store.get(id) || null; }' } }],
  },
  {
    text: 'Still off. Let me tweak getSession again.',
    tools: [{ name: 'edit_file', input: { path: 'src/session-store.js', old_str: 'return store.get(id) || null; }', new_str: 'const s = store.get(id); return s || null; }' } }],
  },
  {
    text: 'One more safety net, give it a default.',
    tools: [{ name: 'edit_file', input: { path: 'src/session-store.js', old_str: 'const s = store.get(id); return s || null; }', new_str: 'const s = store.get(id); return s ?? {}; }' } }],
  },
  {
    text: "Three edits all circling session-store, not converging. Step back to middleware: it never passes userId at all.",
    tools: [{ name: 'read_file', input: { path: 'src/middleware.js' } }],
  },
  {
    text: "Here's the root cause. Fix middleware; the store was never the problem.",
    tools: [{ name: 'edit_file', input: { path: 'src/middleware.js', old_str: 'return findUser(req.userId); }', new_str: 'return req.userId ? findUser(req.userId) : null; }' } }],
  },
  { text: "Fixed. The bug wasn't in session-store, it was middleware not passing userId through.", stop_reason: 'end_turn' },
];
