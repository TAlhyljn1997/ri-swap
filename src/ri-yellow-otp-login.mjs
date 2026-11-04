// RI-YELLOW account entry for RI-SWAP using a server-side WhatsApp OTP.
// No browser receives the destination phone, database credential, WABA token,
// or OTP digest. An OTP proves control of an enrolled contact channel only;
// it does not by itself grant verified business authority.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateOtp, createWaOtpSender, WaOtpError } from './wa-otp.mjs';

export const RI_YELLOW_OTP_ADAPTER_ID = 'RI_YELLOW_WHATSAPP_OTP_V1';
export const RI_YELLOW_OTP_START_PATH = '/api/auth/ri-yellow/start';
export const RI_YELLOW_OTP_VERIFY_PATH = '/api/auth/ri-yellow/verify';
const BUSINESS_REF = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|RI-BIZ-\d{6})$/i;

export const OTP_IDENTITY_SQL = `SELECT identity_id, business_id, public_business_code, trading_name,
       destination_e164, contact_state, ownership_state
FROM ri_swap_auth.otp_login_projection
WHERE (business_id::text = $1 OR public_business_code = upper($1))
  AND identity_state = 'ACTIVE'`;

export class RiYellowOtpError extends Error {
  constructor(code, message = code, statusCode = 400) {
    super(message);
    this.name = 'RiYellowOtpError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function isRiYellowOtpError(error) {
  return error instanceof RiYellowOtpError || error instanceof WaOtpError;
}

export function createRiYellowOtpLogin({ env = process.env, pool: injectedPool, sender: injectedSender, now = () => Date.now(), ttlSec = 300, maxAttempts = 5, minIntervalMs = 60_000 } = {}) {
  const databaseUrl = env.RI_YELLOW_AUTH_DATABASE_URL;
  const expectedDatabase = env.RI_YELLOW_AUTH_EXPECTED_DATABASE;
  const phoneNumberId = env.RI_YELLOW_WA_PHONE_NUMBER_ID;
  const token = env.RI_YELLOW_WA_ACCESS_TOKEN;
  const template = env.RI_YELLOW_WA_OTP_TEMPLATE;
  const language = env.RI_YELLOW_WA_OTP_LANGUAGE || 'en_US';
  const graphVersion = env.RI_YELLOW_WA_GRAPH_VERSION || 'v26.0';
  const configured = Boolean(injectedPool || databaseUrl) && Boolean(expectedDatabase) && Boolean(injectedSender || (phoneNumberId && token && template));
  const sender = injectedSender || createWaOtpSender();
  const pending = new Map();
  const lastSent = new Map();
  let pool = injectedPool;
  let databaseVerified = false;
  let liveLoginVerified = false;

  async function getPool() {
    if (pool) return pool;
    try {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000 });
      pool.on?.('error', () => {});
      return pool;
    } catch {
      throw new RiYellowOtpError('RI_YELLOW_OTP_UNAVAILABLE', 'RI-YELLOW account service is unavailable', 503);
    }
  }

  async function readOnly(fn) {
    if (!configured) throw new RiYellowOtpError('RI_YELLOW_OTP_NOT_CONFIGURED', 'RI-YELLOW OTP is not fully configured', 503);
    let client;
    try {
      client = await (await getPool()).connect();
      await client.query('BEGIN READ ONLY');
      const result = await fn(client);
      await client.query('ROLLBACK');
      return result;
    } catch (error) {
      try { await client?.query('ROLLBACK'); } catch { /* no effect */ }
      if (error instanceof RiYellowOtpError) throw error;
      throw new RiYellowOtpError('RI_YELLOW_OTP_UNAVAILABLE', 'RI-YELLOW account service is unavailable', 503);
    } finally {
      try { client?.release(); } catch { /* no effect */ }
    }
  }

  async function selfCheck() {
    const row = await readOnly(async client => (await client.query("SELECT current_database() db, current_setting('transaction_read_only') ro")).rows[0]);
    databaseVerified = row?.db === expectedDatabase && row?.ro === 'on';
    return { database: row?.db, transaction_read_only: row?.ro, ok: databaseVerified };
  }

  function digest(code, salt) {
    return createHash('sha256').update(salt).update(String(code)).digest('hex');
  }

  async function begin({ business_ref } = {}) {
    const ref = String(business_ref || '').trim();
    if (!BUSINESS_REF.test(ref)) throw new RiYellowOtpError('RI_YELLOW_BUSINESS_REF_INVALID', 'Enter a RI-YELLOW Business ID or RI-BIZ code', 400);
    const rows = await readOnly(async client => (await client.query(OTP_IDENTITY_SQL, [ref.toLowerCase()])).rows);
    if (rows.length !== 1) throw new RiYellowOtpError('RI_YELLOW_ACCOUNT_NOT_ENROLLED', 'This RI-YELLOW account is not enrolled for OTP login', 404);
    const identity = rows[0];
    if (identity.contact_state !== 'ENROLLED') throw new RiYellowOtpError('RI_YELLOW_ACCOUNT_NOT_ENROLLED', 'This RI-YELLOW account is not enrolled for OTP login', 403);
    const previous = lastSent.get(String(identity.identity_id));
    if (previous && now() - previous < minIntervalMs) throw new RiYellowOtpError('RI_YELLOW_OTP_RATE_LIMITED', 'Please wait before requesting another code', 429);
    const code = generateOtp({ length: 6 });
    const challengeId = `riy-${randomBytes(16).toString('hex')}`;
    const salt = randomBytes(16);
    pending.set(challengeId, { digest: digest(code, salt), salt, attempts: 0, expiresAt: now() + ttlSec * 1000, identity: {
      identity_id: String(identity.identity_id), business_id: String(identity.business_id), public_business_code: String(identity.public_business_code),
      trading_name: String(identity.trading_name || 'RI-YELLOW member'), ownership_state: String(identity.ownership_state || 'CONTACT_ONLY'),
    } });
    const sentAt = now();
    lastSent.set(String(identity.identity_id), sentAt);
    try {
      await sender.sendOtp({ to: String(identity.destination_e164), code, template, language, phoneNumberId, token, version: graphVersion });
    } catch (error) {
      pending.delete(challengeId);
      if (lastSent.get(String(identity.identity_id)) === sentAt) lastSent.delete(String(identity.identity_id));
      if (error instanceof WaOtpError) throw new RiYellowOtpError(error.code, error.message, error.status || 503);
      throw new RiYellowOtpError('RI_YELLOW_OTP_UNAVAILABLE', 'RI-YELLOW OTP delivery is unavailable', 503);
    }
    return { challenge_id: challengeId, expires_in_seconds: ttlSec, delivery_channel: 'WHATSAPP', destination_hint: `•••${String(identity.destination_e164).slice(-3)}` };
  }

  function verify({ challenge_id, code } = {}) {
    const challenge = pending.get(String(challenge_id || ''));
    if (!challenge) throw new RiYellowOtpError('RI_YELLOW_OTP_UNKNOWN', 'The code request is unknown or already used', 401);
    if (now() > challenge.expiresAt) {
      pending.delete(challenge_id);
      throw new RiYellowOtpError('RI_YELLOW_OTP_EXPIRED', 'The code has expired', 401);
    }
    if (!/^\d{6}$/.test(String(code || ''))) throw new RiYellowOtpError('RI_YELLOW_OTP_INVALID', 'Enter the six-digit code', 400);
    const candidate = Buffer.from(digest(code, challenge.salt), 'hex');
    const expected = Buffer.from(challenge.digest, 'hex');
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
      challenge.attempts += 1;
      if (challenge.attempts >= maxAttempts) {
        pending.delete(challenge_id);
        throw new RiYellowOtpError('RI_YELLOW_OTP_LOCKED', 'Too many incorrect attempts', 429);
      }
      throw new RiYellowOtpError('RI_YELLOW_OTP_MISMATCH', 'The code does not match', 401);
    }
    pending.delete(challenge_id);
    liveLoginVerified = true;
    const item = challenge.identity;
    return {
      participant_id: `RIY-${createHash('sha256').update(item.identity_id).digest('hex').slice(0, 24)}`,
      account_type: 'RESIDENT',
      authenticated_subject: `RI_YELLOW:${item.identity_id}`,
      label: item.trading_name,
      business_id: item.business_id,
      public_business_code: item.public_business_code,
      ownership_state: item.ownership_state,
      contact_channel_verified: true,
    };
  }

  const contract = () => ({
    adapter: RI_YELLOW_OTP_ADAPTER_ID,
    provider: 'RI_YELLOW',
    channel: 'WHATSAPP_OTP',
    start_path: RI_YELLOW_OTP_START_PATH,
    verify_path: RI_YELLOW_OTP_VERIFY_PATH,
    configured,
    login_grants_business_authority: false,
    public_listing_is_login_credential: false,
    secrets_exposed: false,
  });
  const status = () => ({ configured, connection: configured ? (databaseVerified ? 'CONFIGURED_DATABASE_VERIFIED' : 'CONFIGURED_NOT_LIVE_VERIFIED') : 'NOT_CONFIGURED', expected_database: expectedDatabase || null, live_login_verified: liveLoginVerified, listing_is_login_credential: false, login_grants_business_authority: false, fallback: 'NONE', ...contract() });
  return { isConfigured: () => configured, selfCheck, begin, verify, contract, status };
}
