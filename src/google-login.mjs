// Canonical server-side Google Login adapter for RI-SWAP residents.
// Client secrets and Google tokens never leave the server.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const GOOGLE_LOGIN_ADAPTER_ID = 'RI_SWAP_GOOGLE_LOGIN_SERVER_V1';
export const GOOGLE_LOGIN_CALLBACK_PATH = '/api/auth/google/callback';
export const GOOGLE_LOGIN_SCOPES = Object.freeze(['openid', 'email', 'profile']);

const fail = (code, message = code, statusCode = 503) =>
  Object.assign(new Error(message), { name: 'GoogleLoginError', code, statusCode });
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fromB64 = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');

export function createGoogleLogin({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const clientId = String(env.GOOGLE_CLIENT_ID || '').trim();
  const clientSecret = String(env.GOOGLE_CLIENT_SECRET || '').trim();
  const redirectUri = String(env.GOOGLE_REDIRECT_URI || '').trim();
  const stateSecret = String(env.RI_SWAP_SESSION_SECRET || '').trim();
  const returnPath = String(env.GOOGLE_RETURN_PATH || '/ri-swap/').trim();
  const configured = Boolean(clientId && clientSecret && redirectUri && stateSecret.length >= 32);
  const consumedStates = new Set();
  let liveLoginVerified = false;
  let lastError = null;

  const assertConfigured = () => {
    if (!configured) throw fail('GOOGLE_LOGIN_NOT_CONFIGURED', 'Google Login is not fully configured');
    let callback;
    try { callback = new URL(redirectUri); } catch { throw fail('GOOGLE_REDIRECT_URI_INVALID'); }
    if (callback.protocol !== 'https:') throw fail('GOOGLE_REDIRECT_HTTPS_REQUIRED');
    if (!returnPath.startsWith('/') || returnPath.startsWith('//')) throw fail('GOOGLE_RETURN_PATH_INVALID');
  };

  function begin() {
    assertConfigured();
    const payload = b64({ nonce: randomBytes(18).toString('hex'), exp: now() + 10 * 60_000 });
    const state = `${payload}.${mac(stateSecret, payload)}`;
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', GOOGLE_LOGIN_SCOPES.join(' '));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('include_granted_scopes', 'true');
    return { authorization_url: url.toString(), state_cookie: state };
  }

  function verifyState(state, browserState) {
    const [payload, signature, extra] = String(state || '').split('.');
    if (!payload || !signature || extra) throw fail('GOOGLE_STATE_INVALID', 'invalid login state', 400);
    const stateBytes = Buffer.from(String(state));
    const browserBytes = Buffer.from(String(browserState || ''));
    if (stateBytes.length !== browserBytes.length || !timingSafeEqual(stateBytes, browserBytes)) {
      throw fail('GOOGLE_STATE_BROWSER_MISMATCH', 'login state does not match the initiating browser', 400);
    }
    const expected = mac(stateSecret, payload);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw fail('GOOGLE_STATE_INVALID', 'invalid login state', 400);
    let decoded;
    try { decoded = fromB64(payload); } catch { throw fail('GOOGLE_STATE_INVALID', 'invalid login state', 400); }
    if (!Number.isFinite(decoded.exp) || decoded.exp < now()) throw fail('GOOGLE_STATE_EXPIRED', 'login state expired', 400);
    if (consumedStates.has(state)) throw fail('GOOGLE_STATE_REPLAYED', 'login state was already used', 400);
    consumedStates.add(state);
  }

  async function readJson(url, init, code) {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
    catch { throw fail(`${code}_UNAVAILABLE`); }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw fail(`${code}_REJECTED`, `${code} rejected the request`, response.status >= 400 && response.status < 500 ? 400 : 503);
    }
    return payload;
  }

  async function complete({ code, state, browserState }) {
    assertConfigured();
    verifyState(state, browserState);
    if (!String(code || '').trim()) throw fail('GOOGLE_CODE_MISSING', 'authorization code missing', 400);
    try {
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code: String(code),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      const token = await readJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }, 'GOOGLE_TOKEN_EXCHANGE');
      if (typeof token.access_token !== 'string' || !token.access_token) throw fail('GOOGLE_TOKEN_CONTRACT_MISMATCH');
      const profile = await readJson('https://openidconnect.googleapis.com/v1/userinfo', {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token.access_token}` },
      }, 'GOOGLE_PROFILE');
      if (typeof profile.sub !== 'string' || !profile.sub || typeof profile.name !== 'string' || !profile.name.trim()) {
        throw fail('GOOGLE_PROFILE_CONTRACT_MISMATCH');
      }
      const opaque = createHmac('sha256', stateSecret).update(`${clientId}:${profile.sub}`).digest('hex').slice(0, 24);
      liveLoginVerified = true;
      lastError = null;
      return {
        participant_id: `GOOGLE-RESIDENT-${opaque}`,
        account_type: 'RESIDENT',
        authenticated_subject: `GOOGLE:${clientId}:${profile.sub}`,
        label: profile.name.trim().slice(0, 120),
        return_path: returnPath,
      };
    } catch (error) {
      lastError = error?.code || 'GOOGLE_LOGIN_FAILED';
      throw error;
    }
  }

  return {
    isConfigured: () => configured,
    begin,
    complete,
    contract: () => ({
      adapter: GOOGLE_LOGIN_ADAPTER_ID,
      provider: 'GOOGLE_LOGIN',
      flow: 'OAUTH_2_AUTHORIZATION_CODE_SERVER_SIDE',
      callback_path: GOOGLE_LOGIN_CALLBACK_PATH,
      redirect_uri: redirectUri || null,
      scopes: [...GOOGLE_LOGIN_SCOPES],
      session_cookie: 'HTTP_ONLY_SECURE_SAME_SITE_LAX',
      external_account_type: 'RESIDENT',
      business_link_status_after_request: 'OWNERSHIP_PENDING',
      configured,
      secrets_exposed: false,
    }),
    status: () => ({
      adapter: GOOGLE_LOGIN_ADAPTER_ID,
      configured,
      connection: !configured ? 'NOT_CONFIGURED' : liveLoginVerified ? 'LIVE_LOGIN_VERIFIED' : 'CONFIGURED_NOT_LIVE_VERIFIED',
      live_login_verified: liveLoginVerified,
      client_id: clientId || null,
      redirect_uri: redirectUri || null,
      last_error: lastError,
      business_ownership_verified: false,
    }),
  };
}

export function isGoogleLoginError(error) {
  return error?.name === 'GoogleLoginError' && typeof error?.code === 'string';
}
