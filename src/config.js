// Shared config. Read by CLI, core, and web alike.
export const WS_PORT = 7778; // core WebSocket broadcasts state
export const WEB_PORT = 7790; // visualization web page (7777 gets ghost-occupied by IDE preview on some machines, so move off it)

// Which files become tree nodes. The world-tree should mirror the WHOLE project the way the file tree does —
// not just .py/.js. So this is code + markup + config + docs + scripts. (Binary/asset files — images, db, models,
// archives — are left out so the tree shows structure, not a wall of .png nodes.)
export const CODE_EXT = [
  // code
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.rs', '.java', '.php',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.cs', '.swift', '.kt', '.scala', '.lua', '.r', '.jl', '.dart',
  // markup / web
  '.html', '.htm', '.css', '.scss', '.sass', '.vue', '.svelte', '.svg',
  // config / data
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml', // NOT .env — never preview secrets
  // docs
  '.md', '.mdx', '.rst', '.txt',
  // scripts / db
  '.sh', '.bash', '.zsh', '.sql', '.gradle',
];

// Directory names ignored by default (plain name match, no glob)
export const IGNORE_DIRS = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.cosmos-tree',
  // python / tooling junk — broadened CODE_EXT now matches .txt/.json, which a venv has thousands of
  'venv', '.venv', 'env', '__pycache__', 'site-packages', '.tox', 'vendor',
  '.cache', '.mypy_cache', '.pytest_cache', 'bower_components', '.gradle',
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
