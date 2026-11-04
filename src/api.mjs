// RI-SWAP HTTP API logic as a pure function: handle({method, path, headers, body}) -> {status, body}.
// The Node server (server.mjs) is a thin wrapper, so the same code is tested with and without a socket.
// DEMO_AUTH exists only in explicit local test mode. Public real-only runtime fails closed.
// RI-YELLOW is an optional read-only directory; RI-SWAP storage is supplied separately.
// The acting party always comes from the session token, never from the request body.
import { createHash, randomBytes } from 'node:crypto';
import { AUTH_LABEL, ExchangeError } from './exchange-core-v0.2.mjs';
import { MetaError } from './meta-client.mjs';
import { RiYellowError } from './ri-yellow-directory.mjs';
import { createKnowledge } from './knowledge.mjs';
import { StorageError } from './postgres-state-store.mjs';
import { isIntegrationError } from './integration-clients.mjs';
import { createMediaRouteContract, MediaRouteContractError } from './media-route-contract.mjs';
import { MediaError } from './product-media.mjs';
import { createAssistEnvelope } from './assist-envelope.mjs';
import { buildRiYellowReadback, RiYellowReadbackError } from './ri-yellow-readback.mjs';
import { metaUtilityStatus } from './meta-utility-suite.mjs';

const RI_YELLOW_STATUS = { RI_YELLOW_NOT_CONFIGURED: 503, RI_YELLOW_UNAVAILABLE: 503, NOT_PUBLISHED_OR_NOT_FOUND: 404, BUSINESS_ID_INVALID: 400, STATE_INVALID: 400 };
const NO_DIRECTORY = { isConfigured: () => false, status: () => ({ configured: false, source: 'NONE', verified: false }), lookupBusiness: async () => { throw new RiYellowError('RI_YELLOW_NOT_CONFIGURED', 'RI-YELLOW directory is not connected'); }, listSuburbs: async () => { throw new RiYellowError('RI_YELLOW_NOT_CONFIGURED', 'RI-YELLOW directory is not connected'); } };
const IN_MEMORY_STORAGE = { status: () => ({ configured: true, engine: 'MEMORY', mode: 'TEST_ONLY', database_connected: false, fallback: 'NONE' }) };
const NO_KOS = { isConfigured: () => false, status: () => ({ configured: false, connection: 'NOT_CONNECTED', mode: 'READ_ONLY_QUERY', fallback: 'NONE' }) };
const NO_BCA = { isConfigured: () => false, status: () => ({ configured: false, live_call_verified: false, mode: 'INFORMATIONAL_ONLY', verified_outcome: false, protected_actions_reachable: false, fallback: 'NONE' }) };
const NO_RI_YELLOW_LOGIN = Object.freeze({
  configured: false,
  connection: 'IDENTITY_SERVICE_NOT_CONNECTED',
  live_login_verified: false,
  listing_is_login_credential: false,
  fallback: 'NONE',
});
const NO_WORK_STUDIO = {
  status: () => ({ public_demo: null, public_demo_configured: false, api_configured: false, connection: 'DRAFT_PACKAGE_ONLY', external_execution: false }),
  packageAgreement: ({ agreement, verification }) => ({ schema: 'ri.work-studio.import-candidate.v0.1', status: 'DRAFT_NOT_SUBMITTED', agreement, verification, external_execution_performed: false }),
};

export const DEMO_ACCOUNTS = Object.freeze({
  'demo-business': { participant_id: 'SYN-BUSINESS-1', account_type: 'BUSINESS', label: 'Demo Business (synthetic)', ri_yellow_ref: 'SYN-RI-YELLOW-REF-NOT-REAL' },
  'demo-resident-1': { participant_id: 'SYN-RESIDENT-1', account_type: 'RESIDENT', label: 'Demo Resident 1 (synthetic)' },
  'demo-resident-2': { participant_id: 'SYN-RESIDENT-2', account_type: 'RESIDENT', label: 'Demo Resident 2 (synthetic)' },
});

const STATUS = {
  UNAUTHENTICATED: 401, NOT_AUTHORIZED: 403,
  OFFER_NOT_FOUND: 404, PROPOSAL_NOT_FOUND: 404, AGREEMENT_NOT_FOUND: 404,
  STALE_VERSION: 409, ALREADY_AGREED: 409, SLOT_UNAVAILABLE: 409, PROPOSAL_EXISTS: 409, OFFER_NOT_OPEN: 409,
  OFFER_EXPIRED: 409, OFFER_IMMUTABLE: 409, OFFER_NOT_DRAFT: 409, NO_CHANGE: 409, PARTICIPANT_EXISTS: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  BUSINESS_ID_INVALID: 400, BUSINESS_LISTING_NOT_ELIGIBLE: 422, REAL_EXTERNAL_IDENTITY_REQUIRED: 403,
  BUSINESS_LINK_ALREADY_PENDING: 409,
};
const META_STATUS = {
  META_NOT_CONFIGURED: 503, META_UNREACHABLE: 502, META_HTTP_ERROR: 502, META_BAD_RESPONSE: 502,
  META_AUTH_REJECTED: 503, META_RATE_LIMITED: 429, META_LOCAL_RATE_LIMIT: 429, META_DAILY_BUDGET_EXHAUSTED: 429,
  META_RESPONSE_FAILED: 502, META_RESPONSE_INCOMPLETE: 502, META_REFUSAL: 422,
  META_SENSITIVE_INPUT_REJECTED: 400, INPUT_INVALID: 400,
};

const ok = (body, status = 200) => ({ status, body });
const fail = (status, code, message) => ({ status, body: { error: { code, message } } });

export async function createApi({ exchange, meta, directory = NO_DIRECTORY, storage = IN_MEMORY_STORAGE, dataMode = 'SYNTHETIC_TEST_ONLY', knowledge = createKnowledge(), kos = NO_KOS, bca = NO_BCA, workStudio = NO_WORK_STUDIO, mediaRepository = null, facebookLogin = { status: () => ({ configured: false, connection: 'NOT_CONFIGURED', live_login_verified: false, business_ownership_verified: false }) }, googleLogin = { status: () => ({ configured: false, connection: 'NOT_CONFIGURED', live_login_verified: false, business_ownership_verified: false }) }, riYellowLogin = { status: () => NO_RI_YELLOW_LOGIN }, allowDemo = true, now = () => Date.now(), sessionTtlMs = 8 * 60 * 60_000 }) {
  const sessions = new Map();
  for (const a of allowDemo ? Object.values(DEMO_ACCOUNTS) : []) {
    try {
      await exchange.registerParticipant({ participant_id: a.participant_id, account_type: a.account_type, authenticated_subject: `${AUTH_LABEL}:${a.participant_id}`, ri_yellow_ref: a.ri_yellow_ref ?? null });
    } catch (error) {
      if (!(error instanceof ExchangeError) || error.code !== 'PARTICIPANT_EXISTS') throw error;
      const existing = exchange.readback().participants[a.participant_id];
      if (!existing || existing.account_type !== a.account_type || existing.authenticated_subject !== `${AUTH_LABEL}:${a.participant_id}` || (existing.ri_yellow_ref ?? null) !== (a.ri_yellow_ref ?? null)) {
        throw new ExchangeError('PARTICIPANT_BOOTSTRAP_MISMATCH', `stored participant ${a.participant_id} does not match the configured demo identity`);
      }
    }
  }

  const sessionTokenOf = headers => {
    const m = /^Bearer (.+)$/.exec(headers?.authorization ?? '');
    if (m) return m[1];
    const cookies = String(headers?.cookie || '').split(';').map(value => value.trim());
    const session = cookies.find(value => value.startsWith('ri_swap_session='));
    return session ? decodeURIComponent(session.slice('ri_swap_session='.length)) : undefined;
  };
  const actorOf = headers => {
    const token = sessionTokenOf(headers);
    const session = token ? sessions.get(token) : undefined;
    if (!session) return undefined;
    if (session.expires_at <= now()) {
      sessions.delete(token);
      return undefined;
    }
    return session.participant_id;
  };

  async function issueExternalSession({ participant_id, account_type, authenticated_subject, label }) {
    if (account_type !== 'RESIDENT') throw new ExchangeError('NOT_AUTHORIZED', 'external login creates resident accounts only');
    try {
      await exchange.registerParticipant({ participant_id, account_type, authenticated_subject, ri_yellow_ref: null });
    } catch (error) {
      if (!(error instanceof ExchangeError) || error.code !== 'PARTICIPANT_EXISTS') throw error;
      const existing = exchange.readback().participants[participant_id];
      if (!existing || existing.account_type !== account_type || existing.authenticated_subject !== authenticated_subject) {
        throw new ExchangeError('PARTICIPANT_BOOTSTRAP_MISMATCH', 'stored participant does not match the authenticated identity');
      }
    }
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { participant_id, expires_at: now() + sessionTtlMs });
    const auth = authenticated_subject.startsWith('GOOGLE:') ? 'GOOGLE_LOGIN' : authenticated_subject.startsWith('FACEBOOK:') ? 'FACEBOOK_LOGIN' : 'EXTERNAL_LOGIN';
    return { token, participant_id, account_type, label, auth };
  }

  async function issueRiYellowSession(identity) {
    const { participant_id, account_type, authenticated_subject, label, business_id } = identity || {};
    if (account_type !== 'RESIDENT' || !String(authenticated_subject || '').startsWith('RI_YELLOW:') || !business_id || identity.contact_channel_verified !== true) {
      throw new ExchangeError('NOT_AUTHORIZED', 'a verified RI-YELLOW OTP identity is required');
    }
    try {
      await exchange.registerParticipant({ participant_id, account_type, authenticated_subject, ri_yellow_ref: business_id });
    } catch (error) {
      if (!(error instanceof ExchangeError) || error.code !== 'PARTICIPANT_EXISTS') throw error;
      const existing = exchange.readback().participants[participant_id];
      if (!existing || existing.account_type !== account_type || existing.authenticated_subject !== authenticated_subject || existing.ri_yellow_ref !== business_id) {
        throw new ExchangeError('PARTICIPANT_BOOTSTRAP_MISMATCH', 'stored participant does not match the RI-YELLOW identity');
      }
    }
    const listing = await directory.lookupBusiness(business_id);
    const businessLink = await exchange.requestBusinessLink({ actor: participant_id }, { business_id, listing });
    const token = randomBytes(32).toString('base64url');
    sessions.set(token, { participant_id, expires_at: now() + sessionTtlMs });
    return { token, participant_id, account_type, label, auth: 'RI_YELLOW_WHATSAPP_OTP', business_link: businessLink };
  }

  function revokeSession(headers) {
    const token = sessionTokenOf(headers);
    if (token) sessions.delete(token);
  }

  // Proposals are listed from the read-back, filtered to what the actor may see.
  const visibleProposals = (actor, offerId) => {
    const s = exchange.readback();
    const offer = s.offers[offerId];
    if (!offer) throw new ExchangeError('OFFER_NOT_FOUND', 'offer not found');
    return Object.values(s.proposals)
      .filter(p => p.offer_id === offerId && (offer.owner_id === actor || p.counterparty_id === actor))
      .map(p => ({ proposal_id: p.proposal_id, offer_id: p.offer_id, owner_id: offer.owner_id, counterparty_id: p.counterparty_id, packages: p.packages, terms: p.terms, version: p.version, content_hash: p.content_hash, status: p.status }));
  };

  const myAgreements = actor => exchange.readback().agreements.filter(a => a.parties.includes(actor));

  const mediaContract = mediaRepository ? createMediaRouteContract({
    repository: mediaRepository,
    assertOfferParty: async ({ actor, offer_id, action }) => {
      const state = exchange.readback();
      const offer = state.offers[offer_id];
      if (!offer) throw new MediaRouteContractError('MEDIA_NOT_FOUND');
      const isOwner = offer.owner_id === actor;
      const isCounterparty = Object.values(state.proposals).some(p => p.offer_id === offer_id && p.counterparty_id === actor);
      if (!isOwner && (action === 'MEDIA_UPLOAD' || !isCounterparty)) throw new MediaRouteContractError('MEDIA_FORBIDDEN');
    },
  }) : null;

  // Anonymous utility status is a deliberately narrow public projection.
  // It never exposes adapters, owner roles, requirements, infrastructure
  // details, credentials, raw errors, or provider proof claims.
  const publicMetaUtilityStatus = () => {
    const registry = new Map(metaUtilityStatus().utilities.map(item => [item.id, item]));
    const voice = registry.get('voice-transcribe');
    const search = registry.get('web-search');
    return Object.freeze({
      schema: 'ri.swap.public-meta-utilities.v1',
      utilities: Object.freeze([
        Object.freeze({ id: 'product-image', availability: mediaContract ? 'PRIVATE_MEDIA_READY_PROCESSING_GATED' : 'UNAVAILABLE' }),
        Object.freeze({ id: 'voice-transcribe', availability: voice?.state === 'CONNECTED_READY_VERIFIED' ? 'READY' : 'UNAVAILABLE' }),
        Object.freeze({ id: 'web-search', availability: search?.state === 'CONNECTED_READY_VERIFIED' ? 'READY' : 'DISABLED_BY_DEFAULT' }),
      ]),
      registry_is_provider_proof: false,
      mutations_require_authentication: true,
    });
  };

  async function mediaUpload({ headers = {}, offer_id, bytes, filename }) {
    if (!mediaContract) return fail(503, 'MEDIA_NOT_CONNECTED', 'private media repository is not connected');
    const actor = actorOf(headers);
    if (!actor) return fail(401, 'UNAUTHENTICATED', 'log in first');
    try { return ok(await mediaContract.upload({ actor, offer_id, bytes, filename }), 201); }
    catch (e) {
      if (e instanceof MediaRouteContractError || e instanceof MediaError) return fail(e.code === 'MEDIA_FORBIDDEN' ? 403 : e.code === 'MEDIA_NOT_FOUND' ? 404 : 400, e.code, e.message);
      if (e instanceof StorageError) return fail(503, e.code, e.message);
      throw e;
    }
  }

  async function mediaRead({ headers = {}, media_scope_id }) {
    if (!mediaContract) return { status: 503, error: { code: 'MEDIA_NOT_CONNECTED' } };
    const actor = actorOf(headers);
    if (!actor) return { status: 401, error: { code: 'UNAUTHENTICATED' } };
    try {
      const record = await mediaRepository.get(media_scope_id);
      if (!record) return { status: 404, error: { code: 'MEDIA_NOT_FOUND' } };
      const result = await mediaContract.read({ actor, offer_id: record.record.offer_id, media_scope_id });
      return { status: 200, ...result };
    } catch (e) {
      if (e instanceof MediaRouteContractError) return { status: e.code === 'MEDIA_FORBIDDEN' ? 403 : 404, error: { code: e.code } };
      if (e instanceof StorageError) return { status: 503, error: { code: e.code } };
      throw e;
    }
  }

  const kosRequesterContext = async actor => {
    const participant = exchange.readback().participants[actor];
    const subject = String(participant?.authenticated_subject || '');
    const identityProvider = subject.startsWith('FACEBOOK:')
      ? 'FACEBOOK_LOGIN'
      : subject.startsWith('GOOGLE:') ? 'GOOGLE_LOGIN'
        : subject.startsWith('RI_YELLOW:') ? 'RI_YELLOW_WHATSAPP_OTP' : null;
    if (participant?.account_type !== 'RESIDENT' || !identityProvider) {
      throw Object.assign(new Error('RI-KOS requires a verified Facebook or Google login'), {
        name: 'IntegrationError', code: 'RI_KOS_REAL_IDENTITY_REQUIRED', statusCode: 403,
      });
    }
    const businessLink = await exchange.getMyBusinessLink({ actor });
    const businessAuthority = businessLink?.status === 'OWNERSHIP_VERIFIED' && businessLink?.eligible_to_transact_as_business === true
      ? 'VERIFIED'
      : businessLink?.status === 'OWNERSHIP_PENDING' ? 'PENDING' : 'NONE';
    return {
      contract: 'ri.swap.requester.v1',
      subject_ref: `KOS-${createHash('sha256').update(`ri-swap|ri-kos|${actor}`).digest('hex').slice(0, 24)}`,
      identity_provider: identityProvider,
      account_type: 'RESIDENT',
      business_authority: businessAuthority,
    };
  };

  const routes = [
    ['GET', /^\/api\/me$/, async ({ actor }) => {
      const participant = exchange.readback().participants[actor];
      return ok({
        participant_id: actor,
        account_type: participant?.account_type ?? 'UNKNOWN',
        auth: participant?.authenticated_subject?.startsWith('GOOGLE:') ? 'GOOGLE_LOGIN' : participant?.authenticated_subject?.startsWith('FACEBOOK:') ? 'FACEBOOK_LOGIN' : AUTH_LABEL,
        business_link: await exchange.getMyBusinessLink({ actor }),
      });
    }],
    ['GET', /^\/api\/business-links\/me$/, async ({ ctx }) => ok(await exchange.getMyBusinessLink(ctx))],
    ['POST', /^\/api\/business-links$/, async ({ actor, ctx, body }) => {
      const participant = exchange.readback().participants[actor];
      if (participant?.account_type !== 'RESIDENT' || !/^(FACEBOOK|GOOGLE):/.test(participant?.authenticated_subject || '')) {
        throw new ExchangeError('REAL_EXTERNAL_IDENTITY_REQUIRED', 'a real Facebook or Google resident identity is required');
      }
      const listing = await directory.lookupBusiness(body?.business_id);
      return ok(await exchange.requestBusinessLink(ctx, { business_id: body?.business_id, listing }), 201);
    }],
    ['GET', /^\/api\/offers$/, async () => ok({ offers: await exchange.listOpenOffers() })],
    ['POST', /^\/api\/offers$/, async ({ ctx, body }) => ok(await exchange.createOfferDraft(ctx, body), 201)],
    ['POST', /^\/api\/offers\/resolve-draft$/, async ({ ctx, body }) => ok(await exchange.resolveOfferDraft(ctx, { idempotency_key: body?.idempotency_key }))],
    ['GET', /^\/api\/offers\/([^/]+)$/, async ({ ctx, m }) => ok(await exchange.getOffer(ctx, m[1]))],
    ['PUT', /^\/api\/offers\/([^/]+)$/, async ({ ctx, m, body }) => ok(await exchange.editDraft(ctx, { ...body, offer_id: m[1] }))],
    ['POST', /^\/api\/offers\/([^/]+)\/publish$/, async ({ ctx, m }) => ok(await exchange.publishOffer(ctx, { offer_id: m[1] }))],
    ['POST', /^\/api\/offers\/([^/]+)\/close$/, async ({ ctx, m }) => ok(await exchange.closeOffer(ctx, { offer_id: m[1] }))],
    ['GET', /^\/api\/offers\/([^/]+)\/proposals$/, async ({ actor, m }) => ok({ proposals: visibleProposals(actor, m[1]) })],
    ['POST', /^\/api\/offers\/([^/]+)\/proposals$/, async ({ ctx, m, body }) => ok(await exchange.submitProposal(ctx, { ...body, offer_id: m[1] }), 201)],
    ['GET', /^\/api\/proposals\/([^/]+)$/, async ({ ctx, m }) => ok(await exchange.getProposal(ctx, m[1]))],
    ['POST', /^\/api\/proposals\/([^/]+)\/counter$/, async ({ ctx, m, body }) => ok(await exchange.counterOffer(ctx, { ...body, proposal_id: m[1] }))],
    ['POST', /^\/api\/proposals\/([^/]+)\/accept$/, async ({ ctx, m, body }) => ok(await exchange.acceptProposal(ctx, { ...body, proposal_id: m[1] }))],
    ['POST', /^\/api\/proposals\/([^/]+)\/resolve$/, async ({ ctx, m, body }) => ok(await exchange.resolveAcceptance(ctx, { idempotency_key: body?.idempotency_key, proposal_id: m[1] }))],
    ['GET', /^\/api\/agreements$/, async ({ actor }) => ok({ agreements: myAgreements(actor) })],
    ['GET', /^\/api\/agreements\/([^/]+)$/, async ({ ctx, m }) => ok(await exchange.getAgreement(ctx, m[1]))],
    ['GET', /^\/api\/agreements\/([^/]+)\/verify$/, async ({ ctx, m }) => {
      await exchange.getAgreement(ctx, m[1]); // party check first
      return ok(await exchange.verifyAgreement(m[1]));
    }],
    ['POST', /^\/api\/agreements\/([^/]+)\/report$/, async ({ ctx, m, body }) => ok(await exchange.requestCancellation(ctx, { ...body, agreement_id: m[1] }), 201)],
    ['POST', /^\/api\/assist\/offer$/, async ({ body }) => ok(await meta.suggestOffer(body?.text))],
    ['GET', /^\/api\/meta-utilities$/, async () => ok(publicMetaUtilityStatus())],
    ['GET', /^\/api\/ri-yellow\/businesses\/([^/]+)$/, async ({ m }) => {
      const listing = await directory.lookupBusiness(m[1]);
      return ok({ ...listing, source_readback: buildRiYellowReadback(listing) });
    }],
    ['POST', /^\/api\/assist\/explain$/, async ({ actor, body }) => {
      const text = String(body?.text || '').trim();
      const lang = body?.lang === 'en' ? 'en' : 'vi';
      if (!text || text.length > 600) return fail(400, 'QUERY_INVALID', 'text must be 1 to 600 characters');
      const result = {
        mode: 'SOURCE_SEPARATED_INFORMATION_BUNDLE',
        query: text,
        local_knowledge: knowledge.answer(text, lang),
        ri_kos: { status: kos.isConfigured() ? 'CONFIGURED_NOT_CALLED' : 'NOT_CONNECTED' },
        ri_bca: { status: bca.isConfigured() ? 'CONFIGURED_NOT_CALLED' : 'NOT_CONNECTED' },
        verified_outcome: false,
      };
        if (kos.isConfigured()) {
          try {
            const requester = await kosRequesterContext(actor);
            result.ri_kos = { status: 'KO_ACTIVE_RETURNED', ...(await kos.query({ text, requester })) };
          }
          catch (error) {
            result.ri_kos = error?.upstreamCode === 'GOVERNED_KNOWLEDGE_NOT_FOUND'
              ? { status: 'NO_ELIGIBLE_KO', error: 'GOVERNED_KNOWLEDGE_NOT_FOUND' }
              : error?.code === 'RI_KOS_REAL_IDENTITY_REQUIRED'
                ? { status: 'REAL_IDENTITY_REQUIRED', error: error.code }
              : { status: 'UNAVAILABLE', error: error?.code ?? 'RI_KOS_UNAVAILABLE' };
          }
        }
      // A missing governed or current app source must not make RI-BCA invent a
      // definition of this product from its general language-model priors.
      const brandedQuestion = /\bri[\s-]?swap\b/i.test(text);
      const hasProductSource = Boolean(result.ri_kos.ko && result.ri_kos.answer) || Boolean(result.local_knowledge.answer);
      if (brandedQuestion && !hasProductSource) {
        result.ri_bca = { status: 'SKIPPED_PRODUCT_SOURCE_UNAVAILABLE' };
      } else if (bca.isConfigured()) {
        try {
          result.ri_bca = { status: 'RETURNED', ...(await bca.explain({ text, requirements: [
            'Answer as informational assistance only.',
            'Do not imply delivery, payment, quality, tax treatment, legal validity, or authorised execution.',
            'State that a human decides.',
          ] })) };
        } catch (error) { result.ri_bca = { status: 'UNAVAILABLE', error: error?.code ?? 'RI_BCA_UNAVAILABLE' }; }
      }
      result.source_envelope = createAssistEnvelope({
        query: text, language: lang,
        sources: {
          local: { status: result.local_knowledge?.answer ? 'RETURNED' : 'NO_ELIGIBLE_SOURCE', ...(result.local_knowledge?.answer ? { answer: result.local_knowledge.answer } : {}) },
          kos: { status: result.ri_kos?.answer ? 'RETURNED' : result.ri_kos?.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : result.ri_kos?.status === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'NO_ELIGIBLE_SOURCE', ...(result.ri_kos?.answer ? { answer: result.ri_kos.answer } : {}) },
          bca: { status: result.ri_bca?.answer ? 'RETURNED' : result.ri_bca?.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : result.ri_bca?.status === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : 'SKIPPED', ...(result.ri_bca?.answer ? { answer: result.ri_bca.answer } : {}) },
          meta: { status: 'NOT_CALLED' },
        },
      });
      return ok(result);
    }],
    ['GET', /^\/api\/agreements\/([^/]+)\/work-studio-package$/, async ({ ctx, m }) => {
      const agreement = await exchange.getAgreement(ctx, m[1]);
      const verification = await exchange.verifyAgreement(m[1]);
      return ok(workStudio.packageAgreement({ agreement, verification }));
    }],
  ];

  async function handle({ method, path, headers = {}, body }) {
    try {
      const route = path.split('?')[0];
      if (method === 'POST' && route === '/api/demo-login') {
        if (!allowDemo) return fail(503, 'DEMO_AUTH_DISABLED', 'NO MOCK mode requires a verified real identity provider');
        const account = DEMO_ACCOUNTS[body?.account];
        if (!account) return fail(400, 'ACCOUNT_UNKNOWN', 'choose one of the demo accounts');
        const token = randomBytes(24).toString('hex');
        sessions.set(token, { participant_id: account.participant_id, expires_at: now() + sessionTtlMs });
        return ok({ token, participant_id: account.participant_id, account_type: account.account_type, label: account.label, auth: AUTH_LABEL });
      }
      if (method === 'GET' && route === '/api/status') {
        const metaStatus = typeof meta.status === 'function'
          ? meta.status()
          : { provider: 'META_MODEL_API', model: 'muse-spark-1.3', configured: meta.isConfigured(), live_call_verified: false, fallback: 'NONE' };
        const storageStatus = typeof storage.status === 'function' ? storage.status() : { engine: 'UNKNOWN', database_connected: false, fallback: 'NONE' };
        const facebookStatus = facebookLogin.status();
        const googleStatus = googleLogin.status();
        const riYellowStatus = riYellowLogin.status();
        const configuredProviders = [riYellowStatus.configured && 'RI_YELLOW_WHATSAPP_OTP', facebookStatus.configured && 'FACEBOOK_LOGIN', googleStatus.configured && 'GOOGLE_LOGIN'].filter(Boolean);
        return ok({
          real_only: !allowDemo,
          auth: allowDemo ? (configuredProviders.length ? `${AUTH_LABEL} + ${configuredProviders.join(' + ')}` : AUTH_LABEL) : (configuredProviders.length ? configuredProviders.join(' + ') : 'WAIT_REAL_IDENTITY_PROVIDER'),
          demo_auth: allowDemo ? 'ENABLED_TEST_ONLY' : 'DISABLED',
          facebook_login: facebookStatus,
          google_login: googleStatus,
          ri_yellow_login: riYellowStatus,
          identity_contract: {
            providers: [
              typeof riYellowLogin.contract === 'function' ? riYellowLogin.contract() : null,
              typeof facebookLogin.contract === 'function' ? facebookLogin.contract() : null,
              typeof googleLogin.contract === 'function' ? googleLogin.contract() : null,
            ].filter(Boolean),
            secrets_exposed: false,
          },
          identity_entry_policy: {
            existing_ri_yellow_member: 'RI_YELLOW_LOGIN_REQUIRED_WHEN_CONNECTED',
            not_in_ri_yellow: ['GOOGLE_LOGIN', 'FACEBOOK_LOGIN'],
            facebook_or_google_required_for_existing_ri_yellow_member: false,
            public_listing_alone_authenticates_user: false,
          },
          business_linking: {
            request: 'AVAILABLE_AFTER_VERIFIED_EXTERNAL_LOGIN',
            decision: 'HUMAN_VERIFICATION_REQUIRED_NOT_IMPLEMENTED',
            initial_status: 'OWNERSHIP_PENDING',
            listing_alone_grants_business_authority: false,
          },
          ri_yellow_registration: directory.isConfigured() ? 'READ_ONLY_CONFIGURED_NOT_VERIFIED' : 'NOT_CONNECTED',
          ri_yellow_registration_path: {
            url: 'https://ri-ecosys.org/ri-yellow/#register',
            creates_login_session: false,
            requires_human_approval_before_publication: true,
            publication_proves_ownership: false,
          },
          ri_yellow_directory: directory.status(),
          meta_configured: meta.isConfigured(),
          meta: metaStatus,
          storage: storageStatus,
          data: dataMode,
          knowledge: knowledge.describe(),
          ri_kos: kos.status(),
          ri_bca: bca.status(),
          ri_work_studio: workStudio.status(),
          private_media: { connected: Boolean(mediaContract), public_access: false, vision_enabled: false },
        });
      }
      if (method === 'GET' && route.startsWith('/api/knowledge')) {
        const u = new URL(path, 'http://localhost');
        if (route === '/api/knowledge') return ok(knowledge.describe());
        if (route === '/api/knowledge/entries') return ok(knowledge.entries({ lang: u.searchParams.get('lang') ?? undefined }));
        if (route === '/api/knowledge/answer') return ok(knowledge.answer(u.searchParams.get('q'), u.searchParams.get('lang') ?? undefined));
      }
      const suburbRoute = /^\/api\/ri-yellow\/suburbs\/(NSW|VIC|QLD|WA|SA|ACT|TAS|NT)$/.exec(route);
      if (method === 'GET' && suburbRoute) return ok(await directory.listSuburbs(suburbRoute[1]));
      if (method === 'GET' && route === '/api/offers') return ok({ offers: await exchange.listOpenOffers() }); // public list
      const actor = actorOf(headers);
      const ctx = actor ? { actor } : undefined;
      for (const [verb, re, fn] of routes) {
        if (verb !== method) continue;
        const m = re.exec(route);
        if (!m) continue;
        // Public visitors may ask an informational question. This route cannot
        // create or mutate RI-SWAP state; RI-KOS still requires a verified real
        // identity and will fail closed for an anonymous requester. Every other
        // matched route remains session-bound.
        const publicInformationalRoute = (
          method === 'POST' && (route === '/api/assist/explain' || route === '/api/assist/offer')
        ) || (
          method === 'GET' && route === '/api/meta-utilities'
        );
        if (!actor && !publicInformationalRoute) return fail(401, 'UNAUTHENTICATED', 'log in first');
        return await fn({ actor, ctx, m, body });
      }
      return fail(404, 'ROUTE_NOT_FOUND', 'no such route');
    } catch (e) {
      if (e instanceof ExchangeError) return fail(STATUS[e.code] ?? 400, e.code, e.message);
      if (e instanceof StorageError) return fail(e.code === 'RI_SWAP_REVISION_CONFLICT' ? 409 : 503, e.code, e.message);
      if (e instanceof RiYellowError) return fail(RI_YELLOW_STATUS[e.code] ?? 503, e.code, e.message);
      if (e instanceof RiYellowReadbackError) return fail(503, e.code, e.message);
      if (e instanceof MetaError) return fail(META_STATUS[e.code] ?? 502, e.code, e.message);
      if (isIntegrationError(e)) return fail(e.statusCode ?? 503, e.code, e.message);
      return fail(500, 'INTERNAL_ERROR', 'unexpected error');
    }
  }

  return { handle, issueExternalSession, issueRiYellowSession, revokeSession, mediaUpload, mediaRead };
}
