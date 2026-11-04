// Thin Node HTTP wrapper around api.mjs plus static files from ../public.
// Run: node src/server.mjs (PORT default 8787, bound to 127.0.0.1).
// Public real-only mode is fail-closed; local synthetic identities require explicit non-real-only mode.
// The RI-YELLOW directory adapter is a separate read-only connection.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMetaClient } from './meta-client.mjs';
import { createApi } from './api.mjs';
import { createRiYellowDirectory } from './ri-yellow-directory.mjs';
import { createBcaClient, createKosClient, createWorkStudioBridge } from './integration-clients.mjs';
import { createFacebookLogin, isFacebookLoginError } from './facebook-login.mjs';
import { createGoogleLogin, isGoogleLoginError } from './google-login.mjs';
import { createRiYellowOtpLogin, isRiYellowOtpError } from './ri-yellow-otp-login.mjs';
import { createPersistentExchange, createPostgresStateStore } from './postgres-state-store.mjs';

const PUBLIC_DIR = resolve(fileURLToPath(new URL('../public', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 64 * 1024;
const cookieValue = (headers, name) => {
  const item = String(headers?.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
};

const readJson = req => new Promise((resolveBody, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (!chunks.length) return resolveBody(undefined);
    try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
  });
  req.on('error', reject);
});

export async function buildServer({ api, riYellowLogin: injectedRiYellowLogin } = {}) {
  let store;
  const facebookLogin = createFacebookLogin();
  const googleLogin = createGoogleLogin();
  const riYellowLogin = injectedRiYellowLogin || createRiYellowOtpLogin();
  const realOnly = String(process.env.RI_SWAP_REAL_ONLY || '').toLowerCase() === 'true';
  if (!api) {
    store = createPostgresStateStore();
    const exchange = await createPersistentExchange({ store });
    const directory = createRiYellowDirectory();
    // When a production directory URL is supplied, fail closed unless the
    // connection proves the expected database and a read-only transaction.
    if (directory.isConfigured()) {
      const check = await directory.selfCheck();
      if (!check.ok) throw new Error('RI-YELLOW directory self-check failed');
    }
    if (riYellowLogin.isConfigured()) {
      const check = await riYellowLogin.selfCheck();
      if (!check.ok) throw new Error('RI-YELLOW OTP identity self-check failed');
    }
    const kos = createKosClient();
    const workStudio = createWorkStudioBridge();
    // Optional integrations are probed at startup so status distinguishes a
    // configured URL from a connection that answered its expected contract.
    // A failed optional probe never substitutes a fixture or fallback.
    await Promise.allSettled([
      kos.isConfigured() ? kos.liveCheck() : Promise.resolve(),
      workStudio.liveCheck(),
    ]);
    api = await createApi({
      exchange,
      meta: createMetaClient(),
      directory,
      storage: store,
      kos,
      bca: createBcaClient(),
      workStudio,
      facebookLogin,
      googleLogin,
      riYellowLogin,
      allowDemo: !realOnly,
      dataMode: realOnly ? 'REAL_ONLY_FAIL_CLOSED' : 'DURABLE_POSTGRESQL_WITH_SYNTHETIC_DEMO_IDENTITIES',
    });
  }
  const server = createServer(async (req, res) => {
    const send = (status, type, data, headers = {}) => { res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers }); res.end(data); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/auth/contract') {
        return send(200, 'application/json; charset=utf-8', JSON.stringify({
          providers: [riYellowLogin.contract(), facebookLogin.contract(), googleLogin.contract()],
          secrets_exposed: false,
        }));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/ri-yellow/start') {
        const body = await readJson(req);
        const challenge = await riYellowLogin.begin({ business_ref: body?.business_ref });
        return send(202, 'application/json; charset=utf-8', JSON.stringify(challenge));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/ri-yellow/verify') {
        const body = await readJson(req);
        const identity = riYellowLogin.verify({ challenge_id: body?.challenge_id, code: body?.code });
        const session = await api.issueRiYellowSession(identity);
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, auth: session.auth, business_link: session.business_link }), {
          'set-cookie': `ri_swap_session=${encodeURIComponent(session.token)}; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/facebook/start') {
        if (!facebookLogin.isConfigured()) return send(503, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'FACEBOOK_LOGIN_NOT_CONFIGURED', message: 'Facebook Login is not fully configured' } }));
        const flow = facebookLogin.begin();
        return send(302, 'text/plain; charset=utf-8', 'redirecting', {
          location: flow.authorization_url,
          'set-cookie': `ri_swap_oauth_state=${encodeURIComponent(flow.state_cookie)}; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/facebook/callback') {
        if (url.searchParams.get('error')) return send(302, 'text/plain; charset=utf-8', 'login cancelled', {
          location: `${process.env.FACEBOOK_RETURN_PATH || '/ri-swap/'}?auth=cancelled`,
          'set-cookie': 'ri_swap_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        });
        const identity = await facebookLogin.complete({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          browserState: cookieValue(req.headers, 'ri_swap_oauth_state'),
        });
        const session = await api.issueExternalSession(identity);
        return send(302, 'text/plain; charset=utf-8', 'login complete', {
          location: `${identity.return_path}?auth=facebook`,
          'set-cookie': [
            `ri_swap_session=${encodeURIComponent(session.token)}; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
            'ri_swap_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          ],
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/google/start') {
        if (!googleLogin.isConfigured()) return send(503, 'application/json; charset=utf-8', JSON.stringify({ error: { code: 'GOOGLE_LOGIN_NOT_CONFIGURED', message: 'Google Login is not fully configured' } }));
        const flow = googleLogin.begin();
        return send(302, 'text/plain; charset=utf-8', 'redirecting', {
          location: flow.authorization_url,
          'set-cookie': `ri_swap_google_oauth_state=${encodeURIComponent(flow.state_cookie)}; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') {
        if (url.searchParams.get('error')) return send(302, 'text/plain; charset=utf-8', 'login cancelled', {
          location: `${process.env.GOOGLE_RETURN_PATH || '/ri-swap/'}?auth=cancelled`,
          'set-cookie': 'ri_swap_google_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
        });
        const identity = await googleLogin.complete({
          code: url.searchParams.get('code'),
          state: url.searchParams.get('state'),
          browserState: cookieValue(req.headers, 'ri_swap_google_oauth_state'),
        });
        const session = await api.issueExternalSession(identity);
        return send(302, 'text/plain; charset=utf-8', 'login complete', {
          location: `${identity.return_path}?auth=google`,
          'set-cookie': [
            `ri_swap_session=${encodeURIComponent(session.token)}; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800`,
            'ri_swap_google_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
          ],
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        api.revokeSession(req.headers);
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }), { 'set-cookie': 'ri_swap_session=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      }
      if (url.pathname.startsWith('/api/')) {
        let body;
        if (req.method !== 'GET' && req.method !== 'HEAD') body = await readJson(req);
        const out = await api.handle({ method: req.method, path: url.pathname, headers: req.headers, body });
        return send(out.status, 'application/json; charset=utf-8', JSON.stringify(out.body));
      }
      if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = resolve(join(PUBLIC_DIR, normalize(rel)));
      if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + sep)) return send(403, 'text/plain', 'forbidden');
      const type = TYPES[extname(file)];
      if (!type) return send(404, 'text/plain', 'not found');
      return send(200, type, await readFile(file));
    } catch (e) {
      if (isFacebookLoginError(e)) return send(e.statusCode ?? 503, 'application/json; charset=utf-8', JSON.stringify({ error: { code: e.code, message: e.message } }), { 'set-cookie': 'ri_swap_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      if (isGoogleLoginError(e)) return send(e.statusCode ?? 503, 'application/json; charset=utf-8', JSON.stringify({ error: { code: e.code, message: e.message } }), { 'set-cookie': 'ri_swap_google_oauth_state=; Path=/ri-swap/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
      if (isRiYellowOtpError(e)) return send(e.statusCode ?? e.status ?? 503, 'application/json; charset=utf-8', JSON.stringify({ error: { code: e.code, message: e.message } }));
      if (e?.status) return send(e.status, 'application/json', JSON.stringify({ error: { code: 'BAD_REQUEST', message: e.message } }));
      if (e?.code === 'ENOENT') return send(404, 'text/plain', 'not found');
      return send(500, 'application/json', JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'unexpected error' } }));
    }
  });
  if (store) server.on('close', () => { void store.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8787);
  const server = await buildServer();
  const runtimeMode = String(process.env.RI_SWAP_REAL_ONLY || '').toLowerCase() === 'true' ? 'REAL_ONLY_FAIL_CLOSED' : 'TEST_MODE';
  server.listen(port, '127.0.0.1', () => console.log(`RI-SWAP on http://127.0.0.1:${port} (${runtimeMode}, PostgreSQL durable state, no storage fallback)`));
}
