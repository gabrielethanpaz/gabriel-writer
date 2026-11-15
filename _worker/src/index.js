// Login service for the admin page (/admin/). POST /login with an email and password: if they
// match a user in the USERS secret, it returns the GitHub token the editor uses to save content.
//
// Secrets (npx wrangler secret put NAME):
//   GITHUB_TOKEN  fine-grained token for this repository only, with Contents: Read and write
//   USERS         JSON list of users, each made with hash-password.mjs
// Variable (wrangler.toml): ALLOWED_ORIGINS, the sites allowed to call /login, comma separated.

const encoder = new TextEncoder();

export async function hashPassword(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

// compares without stopping at the first difference, so timing reveals nothing
function sameText(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// used for unknown emails, so they take as long to reject as a wrong password
const DUMMY_USER = { salt: 'dummy-salt-for-unknown-users', hash: '', iterations: 100000 };

async function findUser(env, email, password) {
  let users = [];
  try { users = JSON.parse(env.USERS || '[]'); } catch { throw new Error('USERS secret is not valid JSON'); }
  const user = users.find((u) => String(u.email).toLowerCase() === email);
  const check = user ?? DUMMY_USER;
  const hash = await hashPassword(password, check.salt, check.iterations);
  return user && sameText(hash, user.hash) ? user : null;
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(origin && { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' }),
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin) ? origin : '';

    if (url.pathname !== '/login') return json({ error: 'not_found' }, 404);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: okOrigin ? 204 : 403,
        headers: okOrigin ? {
          'Access-Control-Allow-Origin': okOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        } : {},
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, okOrigin);
    if (!okOrigin) return json({ error: 'origin_not_allowed' }, 403);

    // optional Cloudflare rate limit binding (see wrangler.toml)
    if (env.LOGIN_LIMITER) {
      const { success } = await env.LOGIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
      if (!success) return json({ error: 'too_many_attempts' }, 429, okOrigin);
    }

    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, okOrigin); }
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    if (!email || !password || password.length > 200) return json({ error: 'bad_request' }, 400, okOrigin);

    const user = await findUser(env, email, password);
    if (!user) {
      await new Promise((r) => setTimeout(r, 1000)); // slows down password guessing
      return json({ error: 'invalid_credentials' }, 401, okOrigin);
    }
    if (!env.GITHUB_TOKEN) return json({ error: 'not_configured' }, 500, okOrigin);
    return json({ token: env.GITHUB_TOKEN, name: user.name || '' }, 200, okOrigin);
  },
};
