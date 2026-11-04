// WhatsApp OTP login for RI-SWAP. PROTOTYPE / OFFLINE.
// Server issues a one-time code, sends it through the WhatsApp Cloud API with a
// Meta-approved authentication template, and verifies what the user types back.
// The code lives in server memory only: the pending store keeps its SHA-256,
// error messages never carry the code or the phone number. WABA credentials
// (token, phone_number_id) come per call from operator custody (ROO); without
// them sendOtp throws WA_OTP_NOT_CONFIGURED and calls nothing. No mock fallback.
import { randomInt, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const WA_GRAPH_VERSION = 'v26.0';
export const WA_GRAPH_HOST = 'https://graph.facebook.com';
export const WA_DEFAULT_LANGUAGE = 'vi';
const E164_RE = /^\+[1-9]\d{7,14}$/;

export class WaOtpError extends Error {
  constructor(code, message = code, status = undefined) {
    super(message);
    this.name = 'WaOtpError';
    this.code = code;
    this.status = status;
  }
}

export function generateOtp({ length = 6 } = {}) {
  if (!Number.isInteger(length) || length < 4 || length > 8) {
    throw new WaOtpError('WA_OTP_INVALID_ARG', 'code length must be 4 to 8 digits');
  }
  let out = '';
  for (let i = 0; i < length; i++) out += String(randomInt(0, 10));
  return out;
}

function checkedPhone(to) {
  if (typeof to !== 'string' || !E164_RE.test(to)) {
    throw new WaOtpError('WA_OTP_INVALID_ARG', 'recipient must be E.164 like +61400000000');
  }
  return to;
}

export function createOtpStore({ ttlSec = 300, maxAttempts = 5, codeLength = 6, now = () => Date.now() } = {}) {
  if (!Number.isInteger(ttlSec) || ttlSec < 60 || ttlSec > 3600) throw new WaOtpError('WA_OTP_INVALID_ARG', 'ttl must be 60 to 3600 seconds');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new WaOtpError('WA_OTP_INVALID_ARG', 'max attempts must be 1 to 10');
  const pending = new Map();
  function issue({ to } = {}) {
    checkedPhone(to);
    const code = generateOtp({ length: codeLength });
    const challenge_id = `ch-${randomBytes(8).toString('hex')}`;
    pending.set(challenge_id, { digest: createHash('sha256').update(code).digest(), expires_at: now() + ttlSec * 1000, attempts: 0 });
    return { challenge_id, code, expires_at: pending.get(challenge_id).expires_at };
  }
  function verify({ challenge_id = '', code = '' } = {}) {
    const rec = pending.get(challenge_id);
    if (!rec) throw new WaOtpError('WA_OTP_UNKNOWN', 'challenge is unknown or already consumed');
    if (now() > rec.expires_at) { pending.delete(challenge_id); throw new WaOtpError('WA_OTP_EXPIRED', 'code has expired'); }
    if (rec.attempts >= maxAttempts) { pending.delete(challenge_id); throw new WaOtpError('WA_OTP_LOCKED', 'too many attempts'); }
    const guess = createHash('sha256').update(String(code)).digest();
    const match = guess.length === rec.digest.length && timingSafeEqual(guess, rec.digest);
    if (!match) {
      rec.attempts += 1;
      if (rec.attempts >= maxAttempts) { pending.delete(challenge_id); throw new WaOtpError('WA_OTP_LOCKED', 'too many attempts'); }
      throw new WaOtpError('WA_OTP_MISMATCH', 'code does not match');
    }
    pending.delete(challenge_id);
    return { ok: true };
  }
  return { issue, verify, pendingCount: () => pending.size };
}

export function createWaOtpSender({ fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  async function sendOtp({ to, code, template, language = WA_DEFAULT_LANGUAGE, phoneNumberId, token, version = WA_GRAPH_VERSION } = {}) {
    if (typeof token !== 'string' || !token || typeof phoneNumberId !== 'string' || !phoneNumberId) {
      throw new WaOtpError('WA_OTP_NOT_CONFIGURED', 'waba credential is not set; nothing was sent');
    }
    checkedPhone(to);
    if (typeof code !== 'string' || !/^\d{4,8}$/.test(code)) throw new WaOtpError('WA_OTP_INVALID_ARG', 'code must be 4 to 8 digits');
    if (typeof template !== 'string' || !/^[a-z0-9_]{1,64}$/.test(template)) {
      throw new WaOtpError('WA_OTP_INVALID_ARG', 'template must be a Meta-approved template name');
    }
    if (!/^v\d+\.\d+$/.test(version || '')) throw new WaOtpError('WA_OTP_INVALID_ARG', 'graph version must look like v26.0');
    const url = `${WA_GRAPH_HOST}/${version}/${phoneNumberId}/messages`;
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
          template: { name: template, language: { code: language },
            components: [
              { type: 'body', parameters: [{ type: 'text', text: code }] },
              { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
            ] } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WaOtpError('WA_OTP_TRANSPORT_ERROR', `whatsapp is unreachable (${e?.name ?? 'error'})`);
    }
    if (!res.ok) {
      let type = null;
      try { type = (await res.json())?.error?.type || null; } catch { /* non-JSON falls through */ }
      if (type) throw new WaOtpError('WA_OTP_SEND_REFUSED', `whatsapp refused the send (${type})`, res.status);
      throw new WaOtpError('WA_OTP_HTTP_ERROR', `whatsapp answered ${res.status}`, res.status);
    }
    const id = (await res.json())?.messages?.[0]?.id;
    if (typeof id !== 'string' || !id) throw new WaOtpError('WA_OTP_BAD_RESPONSE', 'whatsapp returned no message id');
    return { messageId: id };
  }
  return { sendOtp };
}
