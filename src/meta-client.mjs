// Meta Model API adapter (Muse Spark 1.3). PROTOTYPE.
// Real calls only: with no MODEL_API_KEY every method throws META_NOT_CONFIGURED. There is no mock fallback.
// Wire format follows dev.meta.ai/docs: POST {base}/responses, Authorization: Bearer <key>, body {model, input}.
// Contract is based on the documented Responses schema. Nothing here counts as Meta integration until a separately
// authorised live call is logged. store:false requests no response storage for this call; it is not a retention claim.
export const META_BASE_URL = 'https://api.meta.ai/v1';
export const META_MODEL = 'muse-spark-1.3';
export const META_WEB_SEARCH_DISABLED = Object.freeze({ enabled: false, reason: 'LIVE_SEARCH_NOT_AUTHORISED' });
import { containsSensitive } from './redact.mjs';

// Search is disabled by default. Callers must supply an explicit, already-sanitised public query after
// separate live authority; no user offer, contract, identifier, or private conversation is forwarded.
export function webSearchTool({ enabled = false, query = '' } = {}) {
  if (!enabled) return META_WEB_SEARCH_DISABLED;
  if (typeof query !== 'string' || !query.trim() || query.length > 240) throw new MetaError('SEARCH_QUERY_INVALID', 'public search query must be 1 to 240 characters');
  if (containsSensitive(query) || /[@]|\b(?:email|phone|address|contract|agreement|token)\b/i.test(query)) throw new MetaError('SEARCH_QUERY_UNSAFE', 'query may contain private data');
  return { enabled: true, tool: { type: 'web_search', search_context_size: 'low' }, query: query.trim() };
}

export class MetaError extends Error {
  constructor(code, message = code, status = undefined, details = undefined) {
    super(message);
    this.name = 'MetaError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const sensitiveLike = containsSensitive;

const SYSTEM_PROMPT = [
  'You help a person write an exchange offer for RI-SWAP.',
  'Reply with ONLY a JSON object with keys: give, receive, location, availability (strings, may be empty),',
  'and questions (array of up to 3 short clarifying questions for anything missing or ambiguous).',
  'If quantities or terms conflict, preserve the stated facts and ask one short question that names the conflict.',
  'Write questions in the same language as the person whenever that language is clear.',
  'Do not invent facts the person did not state. Do not set prices or payment terms.',
].join(' ');

export function cleanExecutionId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  const credentialShaped = /^(?:bearer|token|secret|password|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|sk[_-]|pk_live[_-]|gh[pousr]_|eyJ)[A-Za-z0-9._:-]*/i.test(id)
    || /^[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}$/.test(id);
  return id && id.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(id) && !credentialShaped ? id : null;
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const integer = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
  const usage = {
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    total_tokens: integer('total_tokens'),
  };
  return Object.values(usage).some(item => item !== null) ? usage : null;
}

function safeProviderError(payload) {
  const source = payload?.error && typeof payload.error === 'object' ? payload.error : payload;
  const clean = value => typeof value === 'string' && value.length <= 120 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
  return {
    code: clean(source?.code),
    type: clean(source?.type),
    param: clean(source?.param),
  };
}

// Pulls plain text out of a Responses-style object. Accepts the shapes seen in common Responses APIs.
export function extractText(response) {
  if (response?.error) throw new MetaError('META_RESPONSE_FAILED', 'Meta response included an error object');
  if (response?.status === 'failed') throw new MetaError('META_RESPONSE_FAILED', 'Meta response failed');
  if (response?.status === 'incomplete') throw new MetaError('META_RESPONSE_INCOMPLETE', 'Meta response incomplete');
  if (typeof response?.output_text === 'string') return response.output_text;
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type === 'refusal') throw new MetaError('META_REFUSAL', 'Meta refused this request');
    for (const c of Array.isArray(item?.content) ? item.content : []) {
      if (c?.type === 'output_text' && typeof c?.text === 'string') parts.push(c.text);
      if (c?.type === 'refusal') throw new MetaError('META_REFUSAL', 'Meta refused this request');
    }
  }
  return parts.join('');
}

export function parseSuggestion(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new MetaError('META_BAD_RESPONSE', 'no JSON object in model output');
  let raw;
  try { raw = JSON.parse(text.slice(start, end + 1)); } catch { throw new MetaError('META_BAD_RESPONSE', 'model output is not valid JSON'); }
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const terms = { give: str(raw.give), receive: str(raw.receive), location: str(raw.location), availability: str(raw.availability) };
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).filter(q => typeof q === 'string' && q.trim()).slice(0, 3);
  return { terms, questions };
}

export function createMetaClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(env.META_MODEL_API_TIMEOUT_MS || 20_000),
  minIntervalMs = Number(env.META_MODEL_API_MIN_INTERVAL_MS || 12_000),
  maxRequestsPerMinute = Number(env.META_MODEL_API_MAX_PER_MINUTE || 3),
  maxRequestsPerDay = Number(env.META_MODEL_API_MAX_PER_DAY || 30),
  now = () => Date.now(),
} = {}) {
  const key = String(env.MODEL_API_KEY || '').trim();
  const configured = key.length > 0;
  let lastRequestAt = null;
  let requestTimes = [];
  let dailyRequestTimes = [];
  let liveCallVerified = false;
  let lastSuccessAt = null;
  let lastExecutionId = null;

  async function suggestOffer(userText) {
    if (!configured) throw new MetaError('META_NOT_CONFIGURED', 'MODEL_API_KEY is not set; no Meta call was made');
    if (typeof userText !== 'string' || !userText.trim() || userText.length > 2000) throw new MetaError('INPUT_INVALID', 'text must be 1 to 2000 characters');
    if (sensitiveLike(userText)) throw new MetaError('META_SENSITIVE_INPUT_REJECTED', 'remove contact, credential, identity or payment details before using Muse Spark');
    const current = now();
    requestTimes = requestTimes.filter(value => current - value < 60_000);
    dailyRequestTimes = dailyRequestTimes.filter(value => current - value < 86_400_000);
    if (dailyRequestTimes.length >= maxRequestsPerDay) throw new MetaError('META_DAILY_BUDGET_EXHAUSTED', 'daily Muse Spark call limit reached', 429);
    if (requestTimes.length >= maxRequestsPerMinute || (lastRequestAt !== null && current - lastRequestAt < minIntervalMs)) {
      throw new MetaError('META_LOCAL_RATE_LIMIT', 'Muse Spark calls are being paced locally', 429);
    }
    requestTimes.push(current);
    dailyRequestTimes.push(current);
    lastRequestAt = current;
    let res;
    try {
      res = await fetchImpl(`${META_BASE_URL}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: META_MODEL, store: false, input: `${SYSTEM_PROMPT}\n\nPerson says: ${userText.trim()}`,
          text: { format: { type: 'json_schema', name: 'ri_swap_offer_terms', strict: true, schema: {
            type: 'object', additionalProperties: false,
            properties: { give: { type: 'string' }, receive: { type: 'string' }, location: { type: 'string' }, availability: { type: 'string' }, questions: { type: 'array', items: { type: 'string' } } },
            required: ['give', 'receive', 'location', 'availability', 'questions'],
          } } } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new MetaError('META_UNREACHABLE', `request failed: ${e?.name ?? 'error'}`);
    }
    if (!res.ok) {
      let providerError = { code: null, type: null, param: null };
      try { providerError = safeProviderError(await res.json()); } catch { /* non-JSON error bodies stay undisclosed */ }
      if (res.status === 401) throw new MetaError('META_AUTH_REJECTED', 'Meta rejected the API credential; no retry was attempted', 401, providerError);
      if (res.status === 429) throw new MetaError('META_RATE_LIMITED', 'Meta rate limit reached; no retry was attempted', 429, providerError);
      throw new MetaError('META_HTTP_ERROR', `Meta API answered ${res.status}; no retry was attempted`, res.status, providerError);
    }
    const payload = await res.json();
    if (payload?.status && payload.status !== 'completed') {
      if (payload.status === 'failed') throw new MetaError('META_RESPONSE_FAILED', 'Meta response failed');
      if (payload.status === 'incomplete') throw new MetaError('META_RESPONSE_INCOMPLETE', 'Meta response incomplete');
      throw new MetaError('META_BAD_RESPONSE', 'Meta response did not complete');
    }
    const text = extractText(payload);
    if (!text.trim()) throw new MetaError('META_BAD_RESPONSE', 'Meta response contained no output text');
    const suggestion = parseSuggestion(text);
    liveCallVerified = true;
    lastSuccessAt = new Date(now()).toISOString();
    lastExecutionId = cleanExecutionId(payload?.id);
    return {
      ...suggestion,
      model: META_MODEL,
      source: 'META_MUSE_SPARK_LIVE',
      execution_id: lastExecutionId,
      observed_at: lastSuccessAt,
      route: '/v1/responses',
      http_status: res.status,
      schema_validated: true,
      usage: safeUsage(payload?.usage),
      durable_receipt: false,
      receipt_state: 'PROCESS_LOCAL_ONLY',
    };
  }

  return {
    isConfigured: () => configured,
    status: () => ({
      provider: 'META_MODEL_API',
      model: META_MODEL,
      configured,
      live_call_verified: liveCallVerified,
      verified_this_process: liveCallVerified,
      last_success_at: lastSuccessAt,
      last_execution_id: lastExecutionId,
      durable_receipt: false,
      fallback: 'NONE',
    }),
    suggestOffer,
  };
}
