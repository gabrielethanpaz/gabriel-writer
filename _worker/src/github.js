// GitHub access through a GitHub App installed on this repository only.
// The editor never sees a GitHub key: it gets a session key from /login and sends its GitHub
// requests here, and this service makes them with a short-lived key of the GitHub App.
//
// Secret GITHUB_APP_PRIVATE_KEY: the app's private key (.pem file, as downloaded from GitHub).
// Variables (wrangler.toml): GITHUB_APP_ID, GITHUB_REPO ("owner/name").

const API = 'https://api.github.com';
const USER_AGENT = 'gabriel-cms-login';
const SESSION_HOURS = 12;
const text = new TextEncoder();

const toBase64Url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// --- signing in as the GitHub App -------------------------------------------------------------

// DER length bytes
const derLength = (n) => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255]);

// GitHub gives the key in the older "RSA PRIVATE KEY" (PKCS#1) form; the Workers runtime only
// reads PKCS#8, which is the same key with a short header around it
function pkcs1ToPkcs8(pkcs1) {
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(pkcs1.length)];
  const inner = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  const out = new Uint8Array([0x30, ...derLength(inner.length + pkcs1.length), ...inner, ...pkcs1]);
  return out;
}

let keyCache = { pem: '', key: null };
async function appKey(pem) {
  if (keyCache.pem === pem) return keyCache.key;
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', pem.includes('BEGIN RSA PRIVATE KEY') ? pkcs1ToPkcs8(der) : der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { pem, key };
  return key;
}

export async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const part = (o) => toBase64Url(text.encode(JSON.stringify(o)));
  const data = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(env.GITHUB_APP_ID) })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await appKey(env.GITHUB_APP_PRIVATE_KEY), text.encode(data));
  return `${data}.${toBase64Url(signature)}`;
}

// a key for this repository only, valid 1 hour; kept and reused until 5 minutes before it ends
let tokenCache = { token: '', expires: 0 };
async function repoToken(env) {
  if (tokenCache.expires - Date.now() > 5 * 60 * 1000) return tokenCache.token;
  const headers = { Authorization: `Bearer ${await appJwt(env)}`, Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };
  const found = await fetch(`${API}/repos/${env.GITHUB_REPO}/installation`, { headers });
  if (!found.ok) throw new Error(`The GitHub App is not installed on ${env.GITHUB_REPO} (${found.status})`);
  const { id } = await found.json();
  const r = await fetch(`${API}/app/installations/${id}/access_tokens`, {
    method: 'POST', headers, body: JSON.stringify({ repositories: [env.GITHUB_REPO.split('/')[1]] }),
  });
  if (!r.ok) throw new Error(`GitHub did not give a key for ${env.GITHUB_REPO} (${r.status})`);
  const { token, expires_at } = await r.json();
  tokenCache = { token, expires: Date.parse(expires_at) };
  return token;
}

// --- sessions: "data.signature", signed with a key derived from the app's private key ----------

async function sessionKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', text.encode(`session:${env.GITHUB_APP_PRIVATE_KEY}`));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function createSession(env, user) {
  const data = toBase64Url(text.encode(JSON.stringify({ email: user.email, name: user.name, exp: Date.now() + SESSION_HOURS * 3600 * 1000 })));
  return `${data}.${toBase64Url(await crypto.subtle.sign('HMAC', await sessionKey(env), text.encode(data)))}`;
}

export async function readSession(env, token) {
  const [data, signature, extra] = String(token).split('.');
  if (!data || !signature || extra !== undefined) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await sessionKey(env), fromBase64Url(signature), text.encode(data)))) return null;
    const session = JSON.parse(new TextDecoder().decode(fromBase64Url(data)));
    return session.exp > Date.now() ? session : null;
  } catch {
    return null;
  }
}

// --- the editor's GitHub requests --------------------------------------------------------------

const FORWARD_REQUEST = ['accept', 'content-type', 'if-none-match', 'x-github-api-version'];
const FORWARD_RESPONSE = ['content-type', 'etag', 'link', 'retry-after', 'x-ratelimit-remaining', 'x-ratelimit-reset'];
export const EXPOSED_HEADERS = 'ETag, Link, Retry-After, X-RateLimit-Remaining, X-RateLimit-Reset';

// path is the GitHub API path (e.g. /repos/owner/name/contents/x); returns null if not allowed
export async function forward(request, env, session, path, search) {
  const repoPath = `/repos/${env.GITHUB_REPO}`.toLowerCase();
  const lower = path.toLowerCase();

  // the signed-in person (a GitHub App key has no person of its own)
  if (lower === '/user') {
    return Response.json({
      id: 1, login: session.email.split('@')[0], name: session.name, email: session.email,
      avatar_url: '', html_url: 'https://gabrielethanpaz.com', bot: false,
    });
  }
  if (lower !== '/graphql' && lower !== repoPath && !lower.startsWith(`${repoPath}/`)) return null;

  const headers = new Headers({ Authorization: `token ${await repoToken(env)}`, 'User-Agent': USER_AGENT });
  for (const name of FORWARD_REQUEST) if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const r = await fetch(API + path + search, { method: request.method, headers, body: hasBody ? await request.arrayBuffer() : undefined });

  const out = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of FORWARD_RESPONSE) if (r.headers.has(name)) out.set(name, r.headers.get(name));

  // the repository's details: an app key gets no "permissions", which the editor checks for
  if (lower === repoPath && request.method === 'GET' && r.ok) {
    const repo = await r.json();
    repo.permissions = { admin: false, maintain: false, push: true, triage: false, pull: true };
    return Response.json(repo, { headers: out });
  }
  return new Response(r.body, { status: r.status, headers: out });
}
