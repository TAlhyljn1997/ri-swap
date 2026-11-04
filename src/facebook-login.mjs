// Canonical server-side Facebook Login adapter for RI-SWAP residents.
// It never exposes the app secret or Facebook access token to browser code.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const FACEBOOK_LOGIN_ADAPTER_ID = 'RI_SWAP_FACEBOOK_LOGIN_SERVER_V1';
export const FACEBOOK_LOGIN_CALLBACK_PATH = '/api/auth/facebook/callback';
export const FACEBOOK_LOGIN_SCOPES = Object.freeze(['public_profile']);

const fail = (code, message = code, statusCode = 503) =>
  Object.assign(new Error(message), { name: 'FacebookLoginError', code, statusCode });

const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const fromB64 = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const mac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');

export function createFacebookLogin({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const appId = String(env.FACEBOOK_APP_ID || '').trim();
  const appSecret = String(env.FACEBOOK_APP_SECRET || '').trim();
  const redirectUri = String(env.FACEBOOK_REDIRECT_URI || '').trim();
  const graphVersion = String(env.FACEBOOK_GRAPH_VERSION || '').trim();
  const stateSecret = String(env.RI_SWAP_SESSION_SECRET || '').trim();
  const returnPath = String(env.FACEBOOK_RETURN_PATH || '/ri-swap/').trim();
  const configured = Boolean(appId && appSecret && redirectUri && graphVersion && stateSecret.length >= 32);
  const consumedStates = new Set();
  let liveLoginVerified = false;
  let lastError = null;

  const assertConfigured = () => {
    if (!configured) throw fail('FACEBOOK_LOGIN_NOT_CONFIGURED', 'Facebook Login is not fully configured');
    let callback;
    try { callback = new URL(redirectUri); } catch { throw fail('FACEBOOK_REDIRECT_URI_INVALID'); }
    if (callback.protocol !== 'https:') throw fail('FACEBOOK_REDIRECT_HTTPS_REQUIRED');
    if (!returnPath.startsWith('/') || returnPath.startsWith('//')) throw fail('FACEBOOK_RETURN_PATH_INVALID');
  };

  function begin() {
    assertConfigured();
    const payload = b64({ nonce: randomBytes(18).toString('hex'), exp: now() + 10 * 60_000 });
    const state = `${payload}.${mac(stateSecret, payload)}`;
    const url = new URL(`https://www.facebook.com/${graphVersion}/dialog/oauth`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', FACEBOOK_LOGIN_SCOPES.join(','));
    url.searchParams.set('response_type', 'code');
    return { authorization_url: url.toString(), state_cookie: state };
  }

  function verifyState(state, browserState) {
    const [payload, signature, extra] = String(state || '').split('.');
    if (!payload || !signature || extra) throw fail('FACEBOOK_STATE_INVALID', 'invalid login state', 400);
    const stateBytes = Buffer.from(String(state));
    const browserBytes = Buffer.from(String(browserState || ''));
    if (stateBytes.length !== browserBytes.length || !timingSafeEqual(stateBytes, browserBytes)) {
      throw fail('FACEBOOK_STATE_BROWSER_MISMATCH', 'login state does not match the initiating browser', 400);
    }
    const expected = mac(stateSecret, payload);
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    if (left.length !== right.length || !timingSafeEqual(left, right)) throw fail('FACEBOOK_STATE_INVALID', 'invalid login state', 400);
    let decoded;
    try { decoded = fromB64(payload); } catch { throw fail('FACEBOOK_STATE_INVALID', 'invalid login state', 400); }
    if (!Number.isFinite(decoded.exp) || decoded.exp < now()) throw fail('FACEBOOK_STATE_EXPIRED', 'login state expired', 400);
    if (consumedStates.has(state)) throw fail('FACEBOOK_STATE_REPLAYED', 'login state was already used', 400);
    consumedStates.add(state);
  }

  async function readJson(url, init, code) {
    let response;
    try { response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(10_000) }); }
    catch { throw fail(`${code}_UNAVAILABLE`); }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') throw fail(`${code}_REJECTED`, `${code} rejected the request`, response.status >= 400 && response.status < 500 ? 400 : 503);
    return payload;
  }

  async function complete({ code, state, browserState }) {
    assertConfigured();
    verifyState(state, browserState);
    if (!String(code || '').trim()) throw fail('FACEBOOK_CODE_MISSING', 'authorization code missing', 400);
    try {
      const tokenUrl = new URL(`https://graph.facebook.com/${graphVersion}/oauth/access_token`);
      tokenUrl.searchParams.set('client_id', appId);
      tokenUrl.searchParams.set('client_secret', appSecret);
      tokenUrl.searchParams.set('redirect_uri', redirectUri);
      tokenUrl.searchParams.set('code', String(code));
      const token = await readJson(tokenUrl, { method: 'GET', headers: { accept: 'application/json' } }, 'FACEBOOK_TOKEN_EXCHANGE');
      if (typeof token.access_token !== 'string' || !token.access_token) throw fail('FACEBOOK_TOKEN_CONTRACT_MISMATCH');
      const meUrl = new URL(`https://graph.facebook.com/${graphVersion}/me`);
      meUrl.searchParams.set('fields', 'id,name');
      const me = await readJson(meUrl, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token.access_token}` } }, 'FACEBOOK_PROFILE');
      if (typeof me.id !== 'string' || !me.id || typeof me.name !== 'string' || !me.name.trim()) throw fail('FACEBOOK_PROFILE_CONTRACT_MISMATCH');
      const opaque = createHmac('sha256', stateSecret).update(`${appId}:${me.id}`).digest('hex').slice(0, 24);
      liveLoginVerified = true;
      lastError = null;
      return {
        participant_id: `FB-RESIDENT-${opaque}`,
        account_type: 'RESIDENT',
        authenticated_subject: `FACEBOOK:${appId}:${me.id}`,
        label: me.name.trim().slice(0, 120),
        return_path: returnPath,
      };
    } catch (error) {
      lastError = error?.code || 'FACEBOOK_LOGIN_FAILED';
      throw error;
    }
  }

  return {
    isConfigured: () => configured,
    begin,
    complete,
    contract: () => ({
      adapter: FACEBOOK_LOGIN_ADAPTER_ID,
      provider: 'FACEBOOK_LOGIN',
      flow: 'OAUTH_2_AUTHORIZATION_CODE_SERVER_SIDE',
      callback_path: FACEBOOK_LOGIN_CALLBACK_PATH,
      redirect_uri: redirectUri || null,
      scopes: [...FACEBOOK_LOGIN_SCOPES],
      session_cookie: 'HTTP_ONLY_SECURE_SAME_SITE_LAX',
      external_account_type: 'RESIDENT',
      business_link_status_after_request: 'OWNERSHIP_PENDING',
      configured,
      secrets_exposed: false,
    }),
    status: () => ({
      adapter: FACEBOOK_LOGIN_ADAPTER_ID,
      configured,
      connection: !configured ? 'NOT_CONFIGURED' : liveLoginVerified ? 'LIVE_LOGIN_VERIFIED' : 'CONFIGURED_NOT_LIVE_VERIFIED',
      live_login_verified: liveLoginVerified,
      app_id: appId || null,
      redirect_uri: redirectUri || null,
      last_error: lastError,
      business_ownership_verified: false,
    }),
  };
}

export function isFacebookLoginError(error) {
  return error?.name === 'FacebookLoginError' && typeof error?.code === 'string';
}
