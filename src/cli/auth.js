// 借用 Claude Code 已登入的 OAuth session。
// macOS：token 存在 Keychain service "Claude Code-credentials"。
// 我們在「你的機器、執行時」才讀，token 不會離開本機。
import { execFileSync } from 'node:child_process';

// Claude Code 公開 OAuth client（refresh / 重新登入時用）。
// 若哪天端點變了，refresh 會失敗，改回 Claude Code 重新登入即可。
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// 從巢狀物件裡撈出 token 欄位，容忍不同版本的結構
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
    /* 寫不回去不致命，下次 refresh 再換 */
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

// 回傳目前可用的認證。優先借 Claude Code session，其次 ANTHROPIC_API_KEY。
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
        /* refresh 不成就先用舊的，真的過期 API 會回 401，再提示重登 */
      }
    }
    return { mode: 'oauth', token: kc.accessToken };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { mode: 'apikey', token: process.env.ANTHROPIC_API_KEY };
  }
  return null;
}

// 只回報狀態，不吐 token，給 CLI header / login 指令用
export async function authStatus() {
  const a = await getAuth();
  if (!a) return { ok: false, label: 'Not logged in (log in with Claude Code first, or set ANTHROPIC_API_KEY)' };
  return {
    ok: true,
    mode: a.mode,
    label: a.mode === 'oauth' ? 'Borrowed your Claude Code login' : 'Using API key',
  };
}
