// Optional server-side integration adapters for RI-SWAP.
// They never expose endpoint credentials to the browser and never substitute fixtures for a failed provider.

const loopback = host => ['127.0.0.1', 'localhost', '::1'].includes(host);
const fail = (code, message = code, statusCode = 503, extra = {}) =>
  Object.assign(new Error(message), { name: 'IntegrationError', code, statusCode, ...extra });

const secretLike = value =>
  /(?:password|passcode|mật khẩu|mat khau|\botp\b|one[- ]time password|api[-_ ]?key|bearer\s+[a-z0-9._~-]+|private[-_ ]?key|card number|\bccv\b|\bcvv\b)/i.test(String(value || ''));

const personalLike = value => {
  const text = String(value || '');
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text) ||
    /(?:\+?\s*61\s*(?:\(\s*0?\d\s*\)|0?\d)|\(\s*0\d\s*\)|0\d)(?:[\s().-]*\d){7,9}/.test(text);
};

function endpointOf(value, missingCode) {
  let endpoint;
  try { endpoint = new URL(String(value || '').trim()); } catch { throw fail(missingCode); }
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback(endpoint.hostname))) {
    throw fail('INTEGRATION_HTTPS_REQUIRED');
  }
  return endpoint;
}

async function jsonFetch(fetchImpl, endpoint, init, timeoutMs, prefix) {
  let response;
  try {
    response = await fetchImpl(endpoint, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw fail(`${prefix}_UNAVAILABLE`, `${prefix} is unavailable`, 503, { cause: error });
  }
  const raw = await response.text();
  let payload = null;
  try { payload = JSON.parse(raw); } catch { /* contract check below */ }
  if (!response.ok) throw fail(`${prefix}_HTTP_${response.status}`, `${prefix} answered ${response.status}`, response.status >= 400 && response.status < 500 ? response.status : 503, {
    upstreamCode: typeof payload?.error === 'string' ? payload.error : null,
  });
  if (!payload || typeof payload !== 'object') throw fail(`${prefix}_CONTRACT_MISMATCH`);
  return payload;
}

function pace({ minIntervalMs, maxRequestsPerMinute, maxRequestsPerDay, now }) {
  let lastRequestAt = null;
  let minute = [];
  let day = [];
  return () => {
    const current = now();
    minute = minute.filter(value => current - value < 60_000);
    day = day.filter(value => current - value < 86_400_000);
    if (day.length >= maxRequestsPerDay) throw fail('INTEGRATION_DAILY_BUDGET_EXHAUSTED', 'integration daily call limit reached', 429);
    if (minute.length >= maxRequestsPerMinute || (lastRequestAt !== null && current - lastRequestAt < minIntervalMs)) {
      throw fail('INTEGRATION_LOCAL_RATE_LIMIT', 'integration calls are being paced locally', 429);
    }
    minute.push(current); day.push(current); lastRequestAt = current;
  };
}

export function createKosClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(env.RI_KOS_TIMEOUT_MS || 8_000),
} = {}) {
  const rawUrl = String(env.RI_KOS_URL || '').trim();
  const rawReadyUrl = String(env.RI_KOS_READY_URL || '').trim();
  const assistantId = String(env.RI_KOS_ASSISTANT_ID || '').trim();
  const assistantCredential = String(env.RI_KOS_ASSISTANT_CREDENTIAL || '').trim();
  const applicationId = String(env.RI_KOS_APPLICATION_ID || '').trim();
  const tenantId = String(env.RI_KOS_TENANT_ID || '').trim();
  const configured = Boolean(rawUrl);
  const assistantAuthConfigured = Boolean(assistantId && assistantCredential && applicationId && tenantId);
  const assistantAuthIncomplete = Boolean(assistantId || assistantCredential || applicationId || tenantId) && !assistantAuthConfigured;
  let liveCallVerified = false;
  let requesterContextLiveVerified = false;
  let readyVerified = false;
  let knowledgeAvailable = null;
  let lastError = null;

  const queryHeaders = () => ({
    'content-type': 'application/json', accept: 'application/json',
    'x-ri-assistant-id': assistantId, authorization: `Bearer ${assistantCredential}`,
  });

  function assistantEndpoint() {
    if (!configured) throw fail('RI_KOS_NOT_CONFIGURED');
    if (!assistantAuthConfigured) throw fail('RI_KOS_ASSISTANT_AUTH_INCOMPLETE');
    const endpoint = endpointOf(rawUrl, 'RI_KOS_NOT_CONFIGURED');
    if (endpoint.pathname !== '/api/v1/registered-assistant/query' || endpoint.search || endpoint.hash) {
      throw fail('RI_KOS_ASSISTANT_ROUTE_REQUIRED');
    }
    return endpoint;
  }

  async function liveCheck() {
    if (!configured) throw fail('RI_KOS_NOT_CONFIGURED');
    const queryEndpoint = assistantEndpoint();
    const endpoint = rawReadyUrl
      ? endpointOf(rawReadyUrl, 'RI_KOS_READY_URL_INVALID')
      : new URL('/api/v1/ready', queryEndpoint);
    try {
      const payload = await jsonFetch(fetchImpl, endpoint, {
        method: 'GET', headers: { accept: 'application/json' },
      }, timeoutMs, 'RI_KOS_READY');
      if (payload.gkiReady !== true) throw fail('RI_KOS_NOT_READY');
      readyVerified = true;
      knowledgeAvailable = typeof payload.knowledgeAvailable === 'boolean' ? payload.knowledgeAvailable : null;
      lastError = null;
      return { ready: true, knowledge_available: knowledgeAvailable };
    } catch (error) {
      readyVerified = false;
      lastError = error?.code ?? 'RI_KOS_READY_UNAVAILABLE';
      throw error;
    }
  }

  const validateRequester = requester => {
    if (!requester || typeof requester !== 'object') return null;
    const normalized = {
      contract: String(requester.contract || ''),
      subject_ref: String(requester.subject_ref || ''),
      identity_provider: String(requester.identity_provider || ''),
      account_type: String(requester.account_type || ''),
      business_authority: String(requester.business_authority || ''),
    };
    if (normalized.contract !== 'ri.swap.requester.v1' ||
        !/^KOS-[a-f0-9]{24}$/.test(normalized.subject_ref) ||
        !['FACEBOOK_LOGIN', 'GOOGLE_LOGIN', 'RI_YELLOW_WHATSAPP_OTP'].includes(normalized.identity_provider) ||
        normalized.account_type !== 'RESIDENT' ||
        !['NONE', 'PENDING', 'VERIFIED'].includes(normalized.business_authority) ||
        secretLike(JSON.stringify(normalized)) || personalLike(JSON.stringify(normalized))) {
      throw fail('RI_KOS_REQUESTER_CONTEXT_INVALID', 'requester context does not satisfy the privacy contract', 400);
    }
    return normalized;
  };

  async function query({ text, requester = null }) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 600) throw fail('RI_KOS_QUERY_INVALID', 'query must be 1 to 600 characters', 400);
    if (secretLike(clean) || personalLike(clean)) throw fail('RI_KOS_SENSITIVE_INPUT_REJECTED', 'remove personal or secret data', 400);
    const requesterContext = validateRequester(requester);
    const endpoint = assistantEndpoint();
    const payload = await jsonFetch(fetchImpl, endpoint, {
      method: 'POST', headers: queryHeaders(),
      body: JSON.stringify(requesterContext ? { query: clean, requester_context: requesterContext } : { query: clean }),
    }, timeoutMs, 'RI_KOS');
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    const source = payload.source;
    if (payload.status !== 'COMPLETED' || payload.operation !== 'QUERY' || !answer ||
        payload.application_id !== applicationId || payload.tenant_id !== tenantId || payload.provider_called !== false ||
        !source || source.type !== 'knowledge-object' || source.status !== 'KO_ACTIVE' ||
        !source.id || !source.version || !source.content_hash ||
        !source.publication_receipt_id || !source.publication_receipt_hash) {
      throw fail('RI_KOS_CONTRACT_MISMATCH');
    }
    if (requesterContext) {
      const receipt = payload.requester_context_receipt;
      if (!receipt || receipt.accepted !== true || receipt.contract !== requesterContext.contract ||
          receipt.subject_ref !== requesterContext.subject_ref ||
          receipt.identity_provider !== requesterContext.identity_provider) {
        throw fail('RI_KOS_REQUESTER_CONTEXT_UNACKNOWLEDGED');
      }
      requesterContextLiveVerified = true;
    }
    liveCallVerified = true;
    lastError = null;
    return { source: 'RI_KOS', answer, ko: {
      id: source.id, version: source.version, content_hash: source.content_hash,
      publication_receipt_id: source.publication_receipt_id,
      publication_receipt_hash: source.publication_receipt_hash,
    }, requester_context_verified: Boolean(requesterContext), verified_outcome: false };
  }

  return {
    isConfigured: () => configured,
    status: () => ({
      configured,
      connection: !configured ? 'NOT_CONNECTED'
        : !assistantAuthConfigured ? 'CREDENTIAL_BINDING_INCOMPLETE'
          : liveCallVerified ? 'QUERY_RESPONSE_CONTRACT_VALIDATED'
            : readyVerified ? 'READY_VERIFIED_QUERY_UNVERIFIED'
            : lastError ? 'CONFIGURED_UNAVAILABLE' : 'CONFIGURED_NOT_LIVE_VERIFIED',
      mode: 'REGISTERED_ASSISTANT_READ_ONLY_QUERY',
      assistant_binding: assistantAuthConfigured ? 'BOUND' : assistantAuthIncomplete ? 'INCOMPLETE' : 'NOT_CONFIGURED',
      ready_verified: readyVerified,
      live_call_verified: liveCallVerified,
      requester_context_contract: 'ri.swap.requester.v1',
      requester_context_live_verified: requesterContextLiveVerified,
      knowledge_available: knowledgeAvailable,
      last_error: lastError,
      fallback: 'NONE',
    }),
    liveCheck, query,
  };
}

export function createBcaClient({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(env.RI_BCA_V1_TIMEOUT_MS || 45_000),
  minIntervalMs = Number(env.RI_BCA_V1_MIN_INTERVAL_MS || 12_000),
  maxRequestsPerMinute = Number(env.RI_BCA_V1_MAX_PER_MINUTE || 2),
  maxRequestsPerDay = Number(env.RI_BCA_V1_MAX_PER_DAY || 30),
  now = () => Date.now(),
} = {}) {
  const rawUrl = String(env.RI_BCA_V1_URL || '').trim();
  const configured = Boolean(rawUrl);
  const charge = pace({ minIntervalMs, maxRequestsPerMinute, maxRequestsPerDay, now });
  let liveCallVerified = false;

  async function explain({ text, requirements = [] }) {
    const clean = String(text || '').trim();
    if (!clean || clean.length > 1_500) throw fail('RI_BCA_QUERY_INVALID', 'query must be 1 to 1500 characters', 400);
    if (secretLike(clean) || personalLike(clean)) throw fail('RI_BCA_SENSITIVE_INPUT_REJECTED', 'remove personal or secret data', 400);
    const endpoint = endpointOf(rawUrl, 'RI_BCA_NOT_CONFIGURED');
    charge();
    const payload = await jsonFetch(fetchImpl, endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: clean, requirements: requirements.map(String).slice(0, 8) }),
    }, timeoutMs, 'RI_BCA');
    const answer = typeof payload.answer === 'string' ? payload.answer.trim() : '';
    if (payload.ok !== true || payload.status !== 'COMPLETED' || !answer) throw fail('RI_BCA_CONTRACT_MISMATCH');
    if (payload.verified_outcome !== false || payload.protected_actions_reachable !== false || payload.fallback_used === true) {
      throw fail('RI_BCA_SAFETY_CONTRACT_DRIFT');
    }
    liveCallVerified = true;
    return {
      source: 'RI_BCA_V1', answer, trace_id: typeof payload.trace_id === 'string' ? payload.trace_id : null,
      lane: payload.selector?.lane_executed ?? 'UNKNOWN', mode: payload.selector?.mode ?? 'UNKNOWN',
      verified_outcome: false, protected_actions_reachable: false,
    };
  }

  return {
    isConfigured: () => configured,
    status: () => ({ configured, live_call_verified: liveCallVerified, mode: 'INFORMATIONAL_ONLY', verified_outcome: false, protected_actions_reachable: false, fallback: 'NONE' }),
    explain,
  };
}

export function createWorkStudioBridge({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(env.RI_WORK_STUDIO_TIMEOUT_MS || 8_000),
} = {}) {
  const publicUrl = String(env.RI_WORK_STUDIO_PUBLIC_URL || '').trim();
  const apiUrl = String(env.RI_WORK_STUDIO_API_URL || '').trim();
  const rawHealthUrl = String(env.RI_WORK_STUDIO_HEALTH_URL || '').trim();
  let publicApiVerified = false;
  let lastError = null;

  async function liveCheck() {
    if (!publicUrl && !rawHealthUrl) throw fail('RI_WORK_STUDIO_NOT_CONFIGURED');
    const endpoint = rawHealthUrl
      ? endpointOf(rawHealthUrl, 'RI_WORK_STUDIO_HEALTH_URL_INVALID')
      : new URL('api/process-model', `${publicUrl.replace(/\/$/, '')}/`);
    try {
      const payload = await jsonFetch(fetchImpl, endpoint, {
        method: 'GET', headers: { accept: 'application/json' },
      }, timeoutMs, 'RI_WORK_STUDIO');
      if (payload.ok !== true || !payload.model || typeof payload.model !== 'object') {
        throw fail('RI_WORK_STUDIO_CONTRACT_MISMATCH');
      }
      publicApiVerified = true;
      lastError = null;
      return { ok: true, endpoint: endpoint.toString(), model_id: payload.model.modelId ?? null };
    } catch (error) {
      publicApiVerified = false;
      lastError = error?.code ?? 'RI_WORK_STUDIO_UNAVAILABLE';
      throw error;
    }
  }

  return {
    status: () => ({
      public_demo: publicUrl || null,
      public_demo_configured: Boolean(publicUrl),
      public_api_live_verified: publicApiVerified,
      api_configured: Boolean(apiUrl),
      connection: apiUrl ? 'IMPORT_API_CONFIGURED_NOT_LIVE_VERIFIED'
        : publicApiVerified ? 'PUBLIC_READ_ONLY_API_VERIFIED_NO_IMPORT' : lastError ? 'PUBLIC_API_UNAVAILABLE' : 'DRAFT_PACKAGE_ONLY',
      import_connection: apiUrl ? 'CONFIGURED_NOT_LIVE_VERIFIED' : 'NOT_CONNECTED',
      last_error: lastError,
      external_execution: false,
    }),
    liveCheck,
    packageAgreement({ agreement, verification }) {
      return {
        schema: 'ri.work-studio.import-candidate.v0.1',
        status: 'DRAFT_NOT_SUBMITTED',
        source_app: 'RI-SWAP',
        artifact_type: 'AGREEMENT_REACHED_RECORD',
        agreement,
        verification,
        boundary: 'Agreement Reached does not prove delivery, payment, quality, tax treatment, or legal enforceability.',
        external_execution_performed: false,
        target_public_demo: publicUrl || null,
      };
    },
  };
}

export function isIntegrationError(error) {
  return error?.name === 'IntegrationError' && typeof error?.code === 'string';
}
