// Login service for the admin page (/admin/). Users live in the D1 (SQLite) database bound as DB.
//   POST /login     { email, password }                      -> { token, name }   (session key, 12 hours)
//   POST /password  { email, password, newPassword }         -> { ok: true }
//   /github/api/v3/..., /github/api/graphql                  -> GitHub, for the editor (see github.js)
//
// Secret (npx wrangler secret put GITHUB_APP_PRIVATE_KEY): the GitHub App's private key.
// Variables (wrangler.toml): ALLOWED_ORIGINS (comma separated), GITHUB_APP_ID, GITHUB_REPO.

import { hashPassword, ITERATIONS } from './password.js';
import { createSession, readSession, forward, EXPOSED_HEADERS } from './github.js';

// compares without stopping at the first difference, so timing reveals nothing
function sameText(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// used for unknown emails, so they take as long to reject as a wrong password
const DUMMY_USER = { salt: 'dummy-salt-for-unknown-users', hash: '', iterations: ITERATIONS };

async function checkUser(env, email, password) {
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const check = user ?? DUMMY_USER;
  const hash = await hashPassword(password, check.salt, check.iterations);
  return user && sameText(hash, user.hash) ? user : null;
}

function withCors(response, origin) {
  if (!origin) return response;
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS);
  r.headers.append('Vary', 'Origin');
  return r;
}

const json = (body, status, origin) => withCors(Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } }), origin);
const configured = (env) => !!(env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_ID && env.GITHUB_REPO);

// the editor's GitHub requests: /github/api/v3/<path> and /github/api/graphql
async function github(request, env, url, origin) {
  if (!configured(env)) return json({ message: 'not_configured' }, 500, origin);
  const auth = request.headers.get('Authorization') || '';
  const session = await readSession(env, auth.replace(/^(token|bearer)\s+/i, ''));
  if (!session) return json({ message: 'Bad credentials' }, 401, origin);
  const path = url.pathname === '/github/api/graphql' ? '/graphql' : url.pathname.slice('/github/api/v3'.length) || '/';
  try {
    const response = await forward(request, env, session, path, url.search);
    return response ? withCors(response, origin) : json({ message: 'Not Found' }, 404, origin);
  } catch (e) {
    return json({ message: String(e.message || e) }, 502, origin);
  }
}

async function account(request, env, url, origin) {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);

  if (env.LOGIN_LIMITER) {
    const { success } = await env.LOGIN_LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json({ error: 'too_many_attempts' }, 429, origin);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, origin); }
  const email = String(body?.email ?? '').trim().toLowerCase();
  const password = String(body?.password ?? '');
  if (!email || !password || password.length > 200) return json({ error: 'bad_request' }, 400, origin);

  const user = await checkUser(env, email, password);
  if (!user) {
    await new Promise((r) => setTimeout(r, 1000)); // slows down password guessing
    return json({ error: 'invalid_credentials' }, 401, origin);
  }

  if (url.pathname === '/password') {
    const newPassword = String(body?.newPassword ?? '');
    if (newPassword.length < 10 || newPassword.length > 200) return json({ error: 'weak_password' }, 400, origin);
    const salt = crypto.randomUUID();
    await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, iterations = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?')
      .bind(salt, await hashPassword(newPassword, salt), ITERATIONS, email).run();
    return json({ ok: true }, 200, origin);
  }

  if (!configured(env)) return json({ error: 'not_configured' }, 500, origin);
  return json({ token: await createSession(env, user), name: user.name }, 200, origin);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin) ? origin : '';

    const isAccount = ['/login', '/password'].includes(url.pathname);
    const isGitHub = url.pathname === '/github/api/graphql' || url.pathname.startsWith('/github/api/v3/');
    if (!isAccount && !isGitHub) return json({ error: 'not_found' }, 404);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: okOrigin ? 204 : 403,
        headers: okOrigin ? {
          'Access-Control-Allow-Origin': okOrigin,
          'Access-Control-Allow-Methods': isAccount ? 'POST, OPTIONS' : 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': request.headers.get('Access-Control-Request-Headers') || 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        } : {},
      });
    }
    if (!okOrigin) return json({ error: 'origin_not_allowed' }, 403);

    return isAccount ? account(request, env, url, okOrigin) : github(request, env, url, okOrigin);
  },
};
