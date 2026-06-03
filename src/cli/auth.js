// Borrow the OAuth session Claude Code is already logged into.
// macOS: the token lives in the Keychain service "Claude Code-credentials".
// We only read it "on your machine, at runtime"; the token never leaves the local machine.
import { execFileSync } from 'node:child_process';

// Claude Code's public OAuth client (used for refresh / re-login).
// If the endpoint ever changes, refresh will fail; just log in again through Claude Code.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Pull the token fields out of the nested object, tolerating different version structures
function pluck(obj) {
  const o = obj?.claudeAiOauth || obj?.oauth || obj || {};
  const accessToken = o.accessToken || o.access_token || obj.accessToken;
  const refreshToken = o.refreshToken || o.refresh_token || obj.refreshToken;
  const expiresAt = o.expiresAt || o.expires_at || obj.expiresAt; // epoch ms
  if (!accessToken) return null;
  return { accessToken, refreshToken, expiresAt };
}

function readKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return pluck(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeKeychain(tokens) {
  if (process.platform !== 'darwin') return;
  try {
    const payload = JSON.stringify({ claudeAiOauth: tokens });
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', process.env.USER || 'user', '-w', payload],
      { stdio: 'ignore' }
    );
  } catch {
    /* failing to write back isn't fatal; it'll be replaced on the next refresh */
  }
}

async function refresh(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`refresh 失敗 ${res.status}`);
  const j = await res.json();
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || refreshToken,
    expiresAt: Date.now() + (j.expires_in || 3600) * 1000,
  };
}

// Return the currently usable auth. Prefer borrowing the Claude Code session, then ANTHROPIC_API_KEY.
// { mode:'oauth', token } | { mode:'apikey', token } | null
export async function getAuth() {
  let kc = readKeychain();
  if (kc) {
    const expired = kc.expiresAt && Date.now() > kc.expiresAt - 60_000;
    if (expired && kc.refreshToken) {
      try {
        kc = await refresh(kc.refreshToken);
        writeKeychain(kc);
      } catch {
        /* if refresh fails, use the old one for now; if it's truly expired the API returns 401 and we prompt for re-login */
      }
    }
    return { mode: 'oauth', token: kc.accessToken };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: 'apikey', token: process.env.ANTHROPIC_API_KEY };
  }
  return null;
}

// Report status only, never the token; used by the CLI header / login command
export async function authStatus() {
  const a = await getAuth();
  if (!a) return { ok: false, label: 'Not logged in (log in with Claude Code first, or set ANTHROPIC_API_KEY)' };
  return {
    ok: true,
    mode: a.mode,
    label: a.mode === 'oauth' ? 'Borrowed your Claude Code login' : 'Using API key',
  };
}
