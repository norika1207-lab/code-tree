// Shared config. Read by CLI, core, and web alike.
export const WS_PORT = 7778; // core WebSocket broadcasts state
export const WEB_PORT = 7790; // visualization web page (7777 gets ghost-occupied by IDE preview on some machines, so move off it)

// Which extensions count as "code nodes" (includes UI files; open a UI file to preview its rendered output)
export const CODE_EXT = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go',
  '.html', '.htm', '.svg', '.css', '.vue', '.svelte'];

// Directory names ignored by default (plain name match, no glob)
export const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cosmos-tree',
];

// chokidar v4 dropped glob support; ignored only accepts a function/regex.
// This predicate: skip the path if any segment matches an ignored directory name.
const IGNORE_RE = new RegExp(`(^|[\\\\/])(${IGNORE_DIRS.join('|')})([\\\\/]|$)`);
export function isIgnored(p) {
  return IGNORE_RE.test(p);
}

// Anomaly detection thresholds (matching the spec's MVP rules)
export const ANOMALY = {
  REPEAT_MODIFY: 3, // same file modified >= 3 times → flash red
  STALL_MS: 10 * 60 * 1000, // same node active for over 10 minutes with no change → stalled
};
