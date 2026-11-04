// RI-SWAP prototype core v0.2 (successor of exchange-core.mjs; v0.1 is kept unchanged).
// Model: Offer (N identical packages) -> one Bilateral Proposal per counterparty -> two explicit Accepts
// on the same proposal version -> Agreement. Publish is NOT an acceptance. A counteroffer edits only
// its own proposal. Packages are reserved only when the Agreement commits.
// The core is provider-neutral. Runtime identity, storage and RI-YELLOW evidence are injected by the server/API.
import { createHash, randomUUID } from 'node:crypto';

export const VERIFIED_SCOPE = 'AGREEMENT_REACHED';
export const VERIFIER_VERSION = 'POST-PROTOTYPE-0.2';
export const AUTH_LABEL = 'DEMO_AUTH';
export const ACCOUNT_TYPES = Object.freeze(['BUSINESS', 'RESIDENT']);

const TERM_FIELDS = ['give', 'receive', 'location', 'availability'];
const PARTY_FIELDS = ['participant_id', 'owner_id', 'party_id', 'counterparty_id'];

export class ExchangeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ExchangeError';
    this.code = code;
  }
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Content of a proposal version = terms + package count. This is what both parties accept.
export const hashContent = content => sha256(canonicalJson(content));

const IDEMPOTENCY_LIMITS = Object.freeze({ actor: 256, operation: 64, key: 256 });
export const IDEMPOTENCY_RECORD_SCHEMA_V2 = 'RI_SWAP_IDEMPOTENCY_RECORD_V2';
export const IDEMPOTENCY_BINDING_SCHEMA_V2 = 'RI_SWAP_IDEMPOTENCY_BINDING_V2';
const IDEMPOTENCY_KEY_DOMAIN_V2 = 'RI_SWAP_IDEMPOTENCY_KEY_V2';
const assertIdempotencyComponent = (name, value) => {
  const limit = IDEMPOTENCY_LIMITS[name];
  if (typeof value !== 'string' || value.length === 0 || value.length > limit) {
    throw new ExchangeError('IDEMPOTENCY_COMPONENT_INVALID', `${name} must be non-empty text of at most ${limit} characters`);
  }
  return value;
};

export function idempotencySlotV2(actor, operation, key) {
  const tuple = [
    assertIdempotencyComponent('actor', actor),
    assertIdempotencyComponent('operation', operation),
    assertIdempotencyComponent('key', key),
  ];
  return `v2:${sha256(canonicalJson(tuple))}`;
}

export function idempotencyKeyIdentityV2(actor, operation, key) {
  return sha256(canonicalJson({
    actor: assertIdempotencyComponent('actor', actor),
    domain: IDEMPOTENCY_KEY_DOMAIN_V2,
    key: assertIdempotencyComponent('key', key),
    operation: assertIdempotencyComponent('operation', operation),
  }));
}

export function idempotencyRequestHash(operation, payload) {
  return sha256(canonicalJson({ operation, payload }));
}

const idempotencyResultHash = result => sha256(canonicalJson(result));

function idempotencyTarget(operation, payload, result) {
  if (operation === 'CREATE_OFFER_DRAFT' && typeof result?.offer_id === 'string') {
    return { kind: 'OFFER', id: result.offer_id };
  }
  if (operation === 'SUBMIT_PROPOSAL' && typeof result?.proposal_id === 'string') {
    return { kind: 'PROPOSAL', id: result.proposal_id };
  }
  if (operation === 'ACCEPT_PROPOSAL' && typeof payload?.proposal_id === 'string') {
    return { kind: 'PROPOSAL', id: payload.proposal_id };
  }
  throw new ExchangeError('IDEMPOTENCY_TARGET_INVALID', 'the operation result has no authoritative target');
}

function bindingFromRecord(record) {
  return {
    schema: IDEMPOTENCY_BINDING_SCHEMA_V2,
    binding_event_id: record.binding_event_id,
    actor: record.actor,
    operation: record.operation,
    key_identity: record.key_identity,
    request_hash: record.request_hash,
    target: structuredClone(record.target),
    result_hash: record.result_hash,
  };
}

function assertCanonicalRequest(record) {
  if (!record.request_payload || typeof record.request_payload !== 'object' || Array.isArray(record.request_payload)) {
    throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored record has no interpretable normalized request');
  }
  const recomputed = idempotencyRequestHash(record.operation, record.request_payload);
  if (recomputed !== record.request_hash) {
    throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored normalized request does not match its hash');
  }
}

function assertOperationInvariants(record, { acceptances = [] } = {}) {
  const request = record.request_payload;
  const result = record.result;
  if (record.operation === 'CREATE_OFFER_DRAFT') {
    let terms;
    try { terms = normaliseTerms(request.terms); } catch { throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored create request is invalid'); }
    const expectedContentHash = hashContent({ terms, packages_total: request.packages_total, expires_at: request.expires_at });
    const valid = record.target.kind === 'OFFER'
      && record.target.id === result.offer_id
      && result.owner_id === record.actor
      && result.status === 'DRAFT'
      && result.version === 1
      && Number.isInteger(request.packages_total)
      && request.packages_total >= 1
      && result.packages_total === request.packages_total
      && result.packages_remaining === request.packages_total
      && result.expires_at === request.expires_at
      && canonicalJson(result.terms) === canonicalJson(terms)
      && result.content_hash === expectedContentHash;
    if (!valid) throw new ExchangeError('IDEMPOTENCY_TARGET_MISMATCH', 'the stored create result contradicts its actor, request, or target');
    return;
  }
  if (record.operation === 'SUBMIT_PROPOSAL') {
    let resultTerms;
    let requestedTerms = null;
    try {
      resultTerms = normaliseTerms(result.terms);
      if (request.terms !== null) requestedTerms = normaliseTerms(request.terms);
    } catch {
      throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored proposal request or result terms are invalid');
    }
    const validRequest = typeof request.offer_id === 'string'
      && request.offer_id.length > 0
      && Number.isInteger(request.packages)
      && request.packages >= 1
      && (request.terms === null || (typeof request.terms === 'object' && !Array.isArray(request.terms)));
    const valid = validRequest
      && record.target.kind === 'PROPOSAL'
      && record.target.id === result.proposal_id
      && result.offer_id === request.offer_id
      && result.packages === request.packages
      && result.version === 1
      && result.status === 'PROPOSED'
      && canonicalJson(result.terms) === canonicalJson(resultTerms)
      && result.content_hash === hashContent({ terms: resultTerms, packages: result.packages })
      && (request.terms === null || canonicalJson(resultTerms) === canonicalJson(requestedTerms));
    if (!valid) throw new ExchangeError('IDEMPOTENCY_TARGET_MISMATCH', 'the stored proposal result contradicts its normalized request or target');
    return;
  }
  if (record.operation === 'ACCEPT_PROPOSAL') {
    const acceptanceRef = result.acceptance_ref;
    const storedAcceptance = typeof acceptanceRef === 'string' && acceptanceRef.length > 0
      ? acceptances.find(acceptance => acceptance?.acceptance_id === acceptanceRef)
      : null;
    const validRequest = typeof request.proposal_id === 'string'
      && request.proposal_id.length > 0
      && Number.isInteger(request.version)
      && request.version >= 1
      && record.target.kind === 'PROPOSAL'
      && record.target.id === request.proposal_id
      && storedAcceptance
      && storedAcceptance.participant_id === record.actor
      && storedAcceptance.proposal_id === request.proposal_id
      && storedAcceptance.proposal_version === request.version;
    const waiting = result.status === 'WAITING_FOR_OTHER_PARTY'
      && result.agreement === null;
    const agreement = result.agreement;
    const committed = result.status === 'AGREEMENT_COMMITTED'
      && agreement
      && agreement.status === 'COMMITTED'
      && agreement.proposal_id === record.target.id
      && agreement.proposal_version === request.version
      && Array.isArray(agreement.parties)
      && agreement.parties.includes(record.actor)
      && Array.isArray(agreement.acceptance_refs)
      && agreement.acceptance_refs.includes(acceptanceRef);
    if (!validRequest || (!waiting && !committed)) {
      throw new ExchangeError('IDEMPOTENCY_TARGET_MISMATCH', 'the stored acceptance result contradicts its actor, version, or proposal target');
    }
    return;
  }
  throw new ExchangeError('IDEMPOTENCY_OPERATION_UNSUPPORTED', 'the stored idempotency operation is unsupported');
}

function assertAuditBinding(record, auditEvents) {
  if (typeof record.binding_event_id !== 'string' || record.binding_event_id.length === 0 || !Array.isArray(auditEvents)) {
    throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored record has no server audit binding');
  }
  const matches = auditEvents.filter(event => event?.event_id === record.binding_event_id && event.action === 'IDEMPOTENCY_BOUND');
  const event = matches.length === 1 ? matches[0] : null;
  const valid = event
    && event.actor === record.actor
    && event.aggregate_id === record.target.id
    && event.operation === record.operation
    && event.key_identity === record.key_identity
    && event.request_hash === record.request_hash
    && event.result_hash === record.result_hash
    && event.target_kind === record.target.kind
    && event.target_id === record.target.id;
  if (!valid) throw new ExchangeError('IDEMPOTENCY_AUDIT_BINDING_MISMATCH', 'the stored record is not bound to the immutable server audit event');
}

function validateIdempotencyRecord(record, { actor, operation, key, requestHash = null, auditEvents = [], acceptances = [] }) {
  const expectedKeyIdentity = idempotencyKeyIdentityV2(actor, operation, key);
  if (!record || typeof record !== 'object' || Array.isArray(record) || record.schema === undefined) {
    throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored idempotency record has no supported schema');
  }
  if (record.schema !== IDEMPOTENCY_RECORD_SCHEMA_V2) {
    throw new ExchangeError('IDEMPOTENCY_SCHEMA_UNSUPPORTED', 'the stored idempotency record schema is unsupported');
  }
  const structured = record
    && record.actor === actor
    && record.operation === operation
    && record.key_identity === expectedKeyIdentity
    && typeof record.request_hash === 'string'
    && record.target
    && ['OFFER', 'PROPOSAL'].includes(record.target.kind)
    && typeof record.target.id === 'string'
    && record.target.id.length > 0
    && typeof record.result_hash === 'string'
    && record.result
    && idempotencyResultHash(record.result) === record.result_hash;
  if (!structured) {
    throw new ExchangeError('IDEMPOTENCY_LEGACY_QUARANTINED', 'the stored idempotency record cannot be safely bound to this action');
  }
  assertCanonicalRequest(record);
  if (requestHash !== null && record.request_hash !== requestHash) {
    throw new ExchangeError('IDEMPOTENCY_KEY_REUSED', 'this key was used for a different request');
  }
  assertOperationInvariants(record, { acceptances });
  assertAuditBinding(record, auditEvents);
  return structuredClone(record);
}

function legacyIdempotencySlot(actor, operation, key) {
  const tuple = [actor, operation, key];
  return tuple.every(value => !/[|\u0000-\u001F\u007F]/u.test(value)) ? tuple.join('|') : null;
}

function findIdempotencyRecord(map, actor, operation, key) {
  const v2Slot = idempotencySlotV2(actor, operation, key);
  const current = map.get(v2Slot);
  if (current) return { record: current, slot: v2Slot, v2Slot, legacy: false };
  const legacySlot = legacyIdempotencySlot(actor, operation, key);
  const legacy = legacySlot ? map.get(legacySlot) : null;
  return legacy ? { record: legacy, slot: legacySlot, v2Slot, legacy: true } : { record: null, slot: v2Slot, v2Slot, legacy: false };
}

export function normaliseTerms(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new ExchangeError('TERMS_INVALID', 'terms must be an object');
  const unknown = Object.keys(input).filter(k => !TERM_FIELDS.includes(k));
  if (unknown.length) throw new ExchangeError('TERMS_INVALID', `unknown term fields: ${unknown.join(', ')}`);
  const terms = {};
  for (const f of TERM_FIELDS) {
    if (input[f] === undefined) continue;
    if (typeof input[f] !== 'string') throw new ExchangeError('TERMS_INVALID', `${f} must be text`);
    if (input[f].trim() !== '') terms[f] = input[f].trim();
  }
  for (const f of ['give', 'receive']) if (!terms[f]) throw new ExchangeError('TERMS_INVALID', `${f} is required`);
  return terms;
}

const assertContext = ctx => {
  if (!ctx || typeof ctx.actor !== 'string' || ctx.actor === '') throw new ExchangeError('UNAUTHENTICATED', 'a session actor is required');
  return ctx.actor;
};

function checkPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new ExchangeError('PAYLOAD_INVALID', 'request body must be an object');
  const forged = PARTY_FIELDS.filter(f => Object.hasOwn(payload, f));
  if (forged.length) throw new ExchangeError('FORGED_PARTY_FIELD', `${forged.join(', ')} must come from the session, not the request`);
}

const assertPackages = n => {
  if (!Number.isInteger(n) || n < 1) throw new ExchangeError('PACKAGES_INVALID', 'packages must be an integer of at least 1');
};

export function createExchange({ now = () => new Date(), hooks = {}, initialState } = {}) {
  const mapOf = value => value instanceof Map ? structuredClone(value) : new Map(Object.entries(value ?? {}));
  const arrayOf = value => Array.isArray(value) ? structuredClone(value) : [];
  let state = {
    participants: mapOf(initialState?.participants),
    business_links: mapOf(initialState?.business_links),
    offers: mapOf(initialState?.offers),
    proposals: mapOf(initialState?.proposals),
    acceptances: arrayOf(initialState?.acceptances),
    agreements: arrayOf(initialState?.agreements),
    cancellations: arrayOf(initialState?.cancellations),
    audit: arrayOf(initialState?.audit),
    idempotency: mapOf(initialState?.idempotency),
  };
  let tail = Promise.resolve();
  const copy = v => structuredClone(v);
  const clock = () => now().toISOString();
  const nowMs = () => now().getTime();
  const plain = m => copy(Object.fromEntries(m));

  // Serialised and all-or-nothing: the draft replaces state only if fn returns normally.
  function transact(fn) {
    const run = tail.then(async () => {
      const draft = copy(state);
      const result = await fn(draft);
      if (typeof hooks.persistState === 'function') await hooks.persistState(toPlainState(draft));
      state = draft;
      return copy(result);
    });
    tail = run.catch(() => {});
    return run;
  }

  const audit = (d, e) => {
    const event = { event_id: randomUUID(), timestamp: clock(), previous_version: null, current_version: null, ...e };
    d.audit.push(event);
    return event;
  };

  function requireActive(d, id) {
    const p = d.participants.get(id);
    if (!p) throw new ExchangeError('PARTICIPANT_UNKNOWN', 'participant is not registered');
    if (p.status !== 'ACTIVE') throw new ExchangeError('PARTICIPANT_INACTIVE', 'participant is not active');
    return p;
  }
  const requireOffer = (d, id) => d.offers.get(id) ?? (() => { throw new ExchangeError('OFFER_NOT_FOUND', 'offer not found'); })();
  const requireProposal = (d, id) => d.proposals.get(id) ?? (() => { throw new ExchangeError('PROPOSAL_NOT_FOUND', 'proposal not found'); })();

  const committed = (d, offerId) => d.agreements.filter(a => a.offer_id === offerId && a.status === 'COMMITTED');
  const packagesUsed = (d, offerId) => committed(d, offerId).reduce((n, a) => n + a.packages, 0);
  const remaining = (d, offer) => offer.packages_total - packagesUsed(d, offer.offer_id);

  function assertOfferOpen(offer) {
    if (offer.status !== 'OPEN') throw new ExchangeError('OFFER_NOT_OPEN', `offer status is ${offer.status}`);
    if (Date.parse(offer.expires_at) <= nowMs()) throw new ExchangeError('OFFER_EXPIRED', 'offer has expired');
  }

  const publicOffer = (d, o) => ({
    offer_id: o.offer_id, terms: copy(o.terms), packages_total: o.packages_total,
    packages_remaining: remaining(d, o), status: o.status, expires_at: o.expires_at,
    version: o.version, content_hash: o.content_hash,
  });
  const publicProposal = p => ({
    proposal_id: p.proposal_id, offer_id: p.offer_id, packages: p.packages, terms: copy(p.terms),
    version: p.version, content_hash: p.content_hash, status: p.status,
  });

  function recordAcceptance(d, proposal, participantId, correlationId) {
    const existing = d.acceptances.find(a => a.proposal_id === proposal.proposal_id && a.participant_id === participantId && a.proposal_version === proposal.version);
    if (existing) return existing;
    const acceptance = {
      acceptance_id: randomUUID(), offer_id: proposal.offer_id, proposal_id: proposal.proposal_id,
      participant_id: participantId, proposal_version: proposal.version, content_hash: proposal.content_hash,
      timestamp: clock(), auth_context: AUTH_LABEL, correlation_id: correlationId,
    };
    d.acceptances.push(acceptance);
    audit(d, { aggregate_id: proposal.proposal_id, actor: participantId, action: 'ACCEPTANCE_RECORDED', current_version: proposal.version, correlation_id: correlationId });
    return acceptance;
  }

  // Exactly two explicit acceptances on the same proposal version, then capacity check, then commit.
  function formAgreementIfBothAccepted(d, offer, proposal, correlationId) {
    const find = id => d.acceptances.find(a => a.proposal_id === proposal.proposal_id && a.participant_id === id && a.proposal_version === proposal.version);
    const ownerAcc = find(offer.owner_id);
    const cpAcc = find(proposal.counterparty_id);
    if (!ownerAcc || !cpAcc) return null;
    if (proposal.status === 'AGREED') return null;
    if (proposal.packages > remaining(d, offer)) throw new ExchangeError('SLOT_UNAVAILABLE', 'not enough packages remaining');
    const agreement = {
      agreement_id: randomUUID(), offer_id: offer.offer_id, proposal_id: proposal.proposal_id,
      parties: [offer.owner_id, proposal.counterparty_id], counterparty_id: proposal.counterparty_id,
      agreed_terms: copy(proposal.terms), packages: proposal.packages, proposal_version: proposal.version,
      content_hash: proposal.content_hash, acceptance_refs: [ownerAcc.acceptance_id, cpAcc.acceptance_id],
      status: 'COMMITTED', created_at: clock(), correlation_id: correlationId,
    };
    hooks.beforeCommit?.('AGREEMENT_COMMIT', d);
    d.agreements.push(agreement);
    proposal.status = 'AGREED';
    audit(d, { aggregate_id: agreement.agreement_id, actor: proposal.counterparty_id, action: 'AGREEMENT_COMMITTED', current_version: proposal.version, correlation_id: correlationId });
    if (remaining(d, offer) === 0) offer.status = 'FULL';
    return agreement;
  }

  function withIdempotency(d, { actor, operation, key, payload }, fn) {
    if (key === undefined) return fn();
    const found = findIdempotencyRecord(d.idempotency, actor, operation, key);
    const hash = idempotencyRequestHash(operation, payload);
    const prev = found.record;
    if (prev) {
      const validated = validateIdempotencyRecord(prev, { actor, operation, key, requestHash: hash, auditEvents: d.audit, acceptances: d.acceptances });
      if (found.legacy) {
        if (typeof found.v2Slot !== 'string' || found.v2Slot.length === 0) {
          throw new ExchangeError('IDEMPOTENCY_MIGRATION_TARGET_INVALID', 'the validated legacy record has no safe V2 migration target');
        }
        d.idempotency.set(found.v2Slot, copy(validated));
      }
      return { ...copy(validated.result), replayed: true };
    }
    const result = fn();
    const target = idempotencyTarget(operation, payload, result);
    const keyIdentity = idempotencyKeyIdentityV2(actor, operation, key);
    const resultHash = idempotencyResultHash(result);
    const bindingEvent = audit(d, {
      aggregate_id: target.id,
      actor,
      action: 'IDEMPOTENCY_BOUND',
      operation,
      key_identity: keyIdentity,
      request_hash: hash,
      result_hash: resultHash,
      target_kind: target.kind,
      target_id: target.id,
      correlation_id: randomUUID(),
    });
    d.idempotency.set(found.slot, {
      schema: IDEMPOTENCY_RECORD_SCHEMA_V2,
      binding_event_id: bindingEvent.event_id,
      actor,
      operation,
      key_identity: keyIdentity,
      request_hash: hash,
      request_payload: copy(payload),
      target,
      result_hash: resultHash,
      result: copy(result),
    });
    return { ...result, replayed: false };
  }

  async function registerParticipant({ participant_id = randomUUID(), account_type, authenticated_subject, ri_yellow_ref = null } = {}) {
    if (!ACCOUNT_TYPES.includes(account_type)) throw new ExchangeError('ACCOUNT_TYPE_INVALID', 'account_type must be BUSINESS or RESIDENT');
    if (typeof authenticated_subject !== 'string' || !authenticated_subject) throw new ExchangeError('SUBJECT_REQUIRED', 'authenticated_subject is required');
    if (account_type === 'BUSINESS' && !ri_yellow_ref) throw new ExchangeError('REGISTRATION_REQUIRED', 'business accounts must reference a RI-YELLOW registration');
    return transact(d => {
      if (d.participants.has(participant_id)) throw new ExchangeError('PARTICIPANT_EXISTS', 'participant already registered');
      const p = { participant_id, account_type, authenticated_subject, ri_yellow_ref, status: 'ACTIVE' };
      d.participants.set(participant_id, p);
      return p;
    });
  }

  // A published RI-YELLOW listing is discovery evidence only. This records a
  // durable request to link it to the authenticated external resident; it does
  // not verify ownership, change the account type, or grant transaction rights.
  async function requestBusinessLink(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    const businessId = String(payload.business_id || '').toLowerCase();
    const listing = payload.listing;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(businessId)) {
      throw new ExchangeError('BUSINESS_ID_INVALID', 'business_id must be a UUID');
    }
    if (!listing || listing.business_found !== true || String(listing.business_id).toLowerCase() !== businessId || listing.listing_state !== 'PUBLISHED') {
      throw new ExchangeError('BUSINESS_LISTING_NOT_ELIGIBLE', 'a matching published RI-YELLOW listing is required');
    }
    return transact(d => {
      const participant = requireActive(d, actor);
      if (participant.account_type !== 'RESIDENT' || !/^(FACEBOOK|GOOGLE|RI_YELLOW):/.test(participant.authenticated_subject)) {
        throw new ExchangeError('REAL_EXTERNAL_IDENTITY_REQUIRED', 'a real Facebook, Google, or RI-YELLOW identity is required');
      }
      const existing = d.business_links.get(actor);
      if (existing) {
        if (existing.business_id === businessId && existing.status === 'OWNERSHIP_PENDING') return existing;
        throw new ExchangeError('BUSINESS_LINK_ALREADY_PENDING', 'this identity already has a business link request');
      }
      const link = {
        participant_id: actor,
        business_id: businessId,
        trading_name: String(listing.trading_name || '').slice(0, 200),
        listing_state: listing.listing_state,
        record_status: listing.record_status || null,
        status: 'OWNERSHIP_PENDING',
        ownership_verified: false,
        eligible_to_transact_as_business: false,
        requested_at: clock(),
      };
      d.business_links.set(actor, link);
      audit(d, { aggregate_id: businessId, actor, action: 'BUSINESS_LINK_REQUESTED', correlation_id: randomUUID() });
      return link;
    });
  }

  async function getMyBusinessLink(ctx) {
    const actor = assertContext(ctx);
    requireActive(state, actor);
    return copy(state.business_links.get(actor) ?? {
      participant_id: actor,
      status: 'NOT_REQUESTED',
      ownership_verified: false,
      eligible_to_transact_as_business: false,
    });
  }

  // DRAFT offer: terms editable until published. Publishing creates no acceptance.
  async function createOfferDraft(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    if (typeof payload.idempotency_key !== 'string' || payload.idempotency_key === '') {
      throw new ExchangeError('IDEMPOTENCY_KEY_INVALID', 'idempotency_key must be a non-empty string');
    }
    const terms = normaliseTerms(payload.terms);
    assertPackages(payload.packages_total);
    if (!(Date.parse(payload.expires_at) > nowMs())) throw new ExchangeError('EXPIRY_INVALID', 'expires_at must be a future ISO time');
    const expires = new Date(payload.expires_at).toISOString();
    return transact(d => withIdempotency(d, {
      actor,
      operation: 'CREATE_OFFER_DRAFT',
      key: payload.idempotency_key,
      payload: { terms, packages_total: payload.packages_total, expires_at: expires },
    }, () => {
        requireActive(d, actor);
        const offer = {
          offer_id: randomUUID(), owner_id: actor, terms, packages_total: payload.packages_total,
          expires_at: expires, version: 1,
          content_hash: hashContent({ terms, packages_total: payload.packages_total, expires_at: expires }),
          status: 'DRAFT', created_at: clock(),
        };
        d.offers.set(offer.offer_id, offer);
        audit(d, { aggregate_id: offer.offer_id, actor, action: 'OFFER_DRAFTED', correlation_id: randomUUID() });
        return { ...publicOffer(d, offer), owner_id: actor };
      }));
  }

  async function resolveOfferDraft(ctx, { idempotency_key } = {}) {
    const actor = assertContext(ctx);
    if (typeof idempotency_key !== 'string' || idempotency_key === '') {
      throw new ExchangeError('IDEMPOTENCY_KEY_INVALID', 'idempotency_key must be a non-empty string');
    }
    const previous = findIdempotencyRecord(state.idempotency, actor, 'CREATE_OFFER_DRAFT', idempotency_key).record;
    if (!previous) return { status: 'NOT_COMMITTED' };
    const validated = validateIdempotencyRecord(previous, { actor, operation: 'CREATE_OFFER_DRAFT', key: idempotency_key, auditEvents: state.audit, acceptances: state.acceptances });
    return {
      status: 'COMMITTED',
      offer_id: validated.result.offer_id,
      offer_status: validated.result.status,
      receipt: copy(validated.result),
      binding: bindingFromRecord(validated),
      replayed: true,
    };
  }

  async function editDraft(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    const terms = normaliseTerms(payload.terms);
    return transact(d => {
      const offer = requireOffer(d, payload.offer_id);
      if (offer.owner_id !== actor) throw new ExchangeError('NOT_AUTHORIZED', 'only the offer owner can edit it');
      if (offer.status !== 'DRAFT') throw new ExchangeError('OFFER_IMMUTABLE', 'published offer terms cannot change');
      const previous = offer.version;
      offer.terms = terms;
      offer.version += 1;
      offer.content_hash = hashContent({ terms, packages_total: offer.packages_total, expires_at: offer.expires_at });
      audit(d, { aggregate_id: offer.offer_id, actor, action: 'DRAFT_EDITED', previous_version: previous, current_version: offer.version, correlation_id: randomUUID() });
      return { ...publicOffer(d, offer), owner_id: actor };
    });
  }

  async function publishOffer(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    return transact(d => {
      const offer = requireOffer(d, payload.offer_id);
      if (offer.owner_id !== actor) throw new ExchangeError('NOT_AUTHORIZED', 'only the offer owner can publish it');
      if (offer.status !== 'DRAFT') throw new ExchangeError('OFFER_NOT_DRAFT', `offer status is ${offer.status}`);
      offer.status = 'OPEN';
      audit(d, { aggregate_id: offer.offer_id, actor, action: 'OFFER_PUBLISHED', correlation_id: randomUUID() });
      return { ...publicOffer(d, offer), owner_id: actor };
    });
  }

  // One live proposal per (offer, counterparty). Starts from the offer terms unless the counterparty supplies others.
  async function submitProposal(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    assertPackages(payload.packages);
    const terms = payload.terms === undefined ? undefined : normaliseTerms(payload.terms);
    return transact(d => withIdempotency(d, { actor, operation: 'SUBMIT_PROPOSAL', key: payload.idempotency_key, payload: { offer_id: payload.offer_id, packages: payload.packages, terms: terms ?? null } }, () => {
      requireActive(d, actor);
      const offer = requireOffer(d, payload.offer_id);
      assertOfferOpen(offer);
      if (actor === offer.owner_id) throw new ExchangeError('OWNER_CANNOT_PROPOSE', 'the owner cannot propose to their own offer');
      if ([...d.proposals.values()].some(p => p.offer_id === offer.offer_id && p.counterparty_id === actor)) {
        throw new ExchangeError('PROPOSAL_EXISTS', 'this counterparty already has a proposal on the offer');
      }
      if (payload.packages > remaining(d, offer)) throw new ExchangeError('SLOT_UNAVAILABLE', 'not enough packages remaining');
      const finalTerms = terms ?? copy(offer.terms);
      const proposal = {
        proposal_id: randomUUID(), offer_id: offer.offer_id, counterparty_id: actor, packages: payload.packages,
        terms: finalTerms, version: 1, content_hash: hashContent({ terms: finalTerms, packages: payload.packages }), status: 'PROPOSED',
      };
      d.proposals.set(proposal.proposal_id, proposal);
      audit(d, { aggregate_id: proposal.proposal_id, actor, action: 'PROPOSAL_SUBMITTED', current_version: 1, correlation_id: randomUUID() });
      return publicProposal(proposal);
    }));
  }

  // Counteroffer by either party of THIS proposal. New version; no acceptance is carried over or auto-recorded.
  async function counterOffer(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    const terms = normaliseTerms(payload.terms);
    assertPackages(payload.packages);
    return transact(d => {
      requireActive(d, actor);
      const proposal = requireProposal(d, payload.proposal_id);
      const offer = requireOffer(d, proposal.offer_id);
      if (actor !== offer.owner_id && actor !== proposal.counterparty_id) throw new ExchangeError('NOT_AUTHORIZED', 'not a party to this proposal');
      assertOfferOpen(offer);
      if (proposal.status === 'AGREED') throw new ExchangeError('ALREADY_AGREED', 'proposal already became an agreement');
      const hash = hashContent({ terms, packages: payload.packages });
      if (hash === proposal.content_hash) throw new ExchangeError('NO_CHANGE', 'content is identical to the current version');
      if (payload.packages > remaining(d, offer)) throw new ExchangeError('SLOT_UNAVAILABLE', 'not enough packages remaining');
      const previous = proposal.version;
      proposal.version += 1;
      proposal.terms = terms;
      proposal.packages = payload.packages;
      proposal.content_hash = hash;
      audit(d, { aggregate_id: proposal.proposal_id, actor, action: 'COUNTEROFFER', previous_version: previous, current_version: proposal.version, correlation_id: randomUUID() });
      return publicProposal(proposal);
    });
  }

  async function acceptProposal(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    if (!Number.isInteger(payload.version)) throw new ExchangeError('VERSION_REQUIRED', 'version must be given');
    return transact(d => withIdempotency(d, { actor, operation: 'ACCEPT_PROPOSAL', key: payload.idempotency_key, payload: { proposal_id: payload.proposal_id, version: payload.version } }, () => {
      requireActive(d, actor);
      const proposal = requireProposal(d, payload.proposal_id);
      const offer = requireOffer(d, proposal.offer_id);
      if (actor !== offer.owner_id && actor !== proposal.counterparty_id) throw new ExchangeError('NOT_AUTHORIZED', 'not a party to this proposal');
      if (proposal.status === 'AGREED') throw new ExchangeError('ALREADY_AGREED', 'an agreement already exists for this proposal');
      assertOfferOpen(offer);
      if (payload.version !== proposal.version) throw new ExchangeError('STALE_VERSION', `current version is ${proposal.version}`);
      const correlationId = randomUUID();
      const acceptance = recordAcceptance(d, proposal, actor, correlationId);
      const agreement = formAgreementIfBothAccepted(d, offer, proposal, correlationId);
      return agreement
        ? { status: 'AGREEMENT_COMMITTED', agreement, acceptance_ref: acceptance.acceptance_id }
        : { status: 'WAITING_FOR_OTHER_PARTY', agreement: null, acceptance_ref: acceptance.acceptance_id };
    }));
  }

  // Recovery after a lost response: look the outcome up by key; never create a new one.
  async function resolveAcceptance(ctx, { idempotency_key, proposal_id }) {
    const actor = assertContext(ctx);
    if (typeof idempotency_key !== 'string' || idempotency_key === '') {
      throw new ExchangeError('IDEMPOTENCY_KEY_INVALID', 'idempotency_key must be a non-empty string');
    }
    if (typeof proposal_id !== 'string' || proposal_id === '') {
      throw new ExchangeError('PROPOSAL_ID_INVALID', 'proposal_id must be a non-empty string');
    }
    const prev = findIdempotencyRecord(state.idempotency, actor, 'ACCEPT_PROPOSAL', idempotency_key).record;
    if (!prev) return { status: 'NOT_COMMITTED' };
    const validated = validateIdempotencyRecord(prev, { actor, operation: 'ACCEPT_PROPOSAL', key: idempotency_key, auditEvents: state.audit, acceptances: state.acceptances });
    if (validated.target.kind !== 'PROPOSAL' || validated.target.id !== proposal_id) {
      throw new ExchangeError('IDEMPOTENCY_TARGET_MISMATCH', 'the recovery key is not bound to this proposal');
    }
    if (validated.result.agreement) return { status: 'COMMITTED', agreement_id: validated.result.agreement.agreement_id };
    const agreement = state.agreements.find(a => a.proposal_id === proposal_id
      && a.proposal_version === validated.request_payload.version
      && a.parties.includes(actor)
      && Array.isArray(a.acceptance_refs)
      && a.acceptance_refs.includes(validated.result.acceptance_ref));
    if (agreement) return { status: 'COMMITTED', agreement_id: agreement.agreement_id };
    return { status: 'NOT_COMMITTED' }; // safe to retry with the same key; this is not a failure verdict
  }

  async function closeOffer(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    return transact(d => {
      const offer = requireOffer(d, payload.offer_id);
      if (offer.owner_id !== actor) throw new ExchangeError('NOT_AUTHORIZED', 'only the offer owner can close it');
      if (offer.status !== 'CLOSED') {
        offer.status = 'CLOSED';
        audit(d, { aggregate_id: offer.offer_id, actor, action: 'OFFER_CLOSED', correlation_id: randomUUID() });
      }
      return { offer_id: offer.offer_id, status: 'CLOSED', committed_agreements: committed(d, offer.offer_id).length };
    });
  }

  // Cancellation Request / Report Issue: recorded only. No penalty, no fault finding, agreement untouched.
  async function requestCancellation(ctx, payload) {
    const actor = assertContext(ctx);
    checkPayload(payload);
    if (!['CANCELLATION_REQUEST', 'REPORT_ISSUE'].includes(payload.kind)) throw new ExchangeError('KIND_INVALID', 'kind must be CANCELLATION_REQUEST or REPORT_ISSUE');
    if (typeof payload.reason !== 'string' || !payload.reason.trim()) throw new ExchangeError('REASON_REQUIRED', 'reason is required');
    return transact(d => {
      const agreement = d.agreements.find(a => a.agreement_id === payload.agreement_id);
      if (!agreement) throw new ExchangeError('AGREEMENT_NOT_FOUND', 'agreement not found');
      if (!agreement.parties.includes(actor)) throw new ExchangeError('NOT_AUTHORIZED', 'only the agreement parties can file this');
      const record = { request_id: randomUUID(), agreement_id: agreement.agreement_id, kind: payload.kind, filed_by: actor, reason: payload.reason.trim(), status: 'OPEN', filed_at: clock() };
      d.cancellations.push(record);
      audit(d, { aggregate_id: agreement.agreement_id, actor, action: payload.kind, correlation_id: randomUUID() });
      return record;
    });
  }

  async function listOpenOffers() {
    return [...state.offers.values()].filter(o => o.status === 'OPEN' && Date.parse(o.expires_at) > nowMs()).map(o => publicOffer(state, o));
  }

  async function getOffer(ctx, offerId) {
    const actor = assertContext(ctx);
    const o = requireOffer(state, offerId);
    if (o.status === 'DRAFT' && o.owner_id !== actor) throw new ExchangeError('NOT_AUTHORIZED', 'draft is private to the owner');
    return copy(actor === o.owner_id ? { ...publicOffer(state, o), owner_id: o.owner_id } : publicOffer(state, o));
  }

  async function getProposal(ctx, proposalId) {
    const actor = assertContext(ctx);
    const p = requireProposal(state, proposalId);
    const o = requireOffer(state, p.offer_id);
    if (actor !== o.owner_id && actor !== p.counterparty_id) throw new ExchangeError('NOT_AUTHORIZED', 'not a party to this proposal');
    return publicProposal(p);
  }

  async function getAgreement(ctx, agreementId) {
    const actor = assertContext(ctx);
    const a = state.agreements.find(x => x.agreement_id === agreementId);
    if (!a) throw new ExchangeError('AGREEMENT_NOT_FOUND', 'agreement not found');
    if (!a.parties.includes(actor)) throw new ExchangeError('NOT_AUTHORIZED', 'only the agreement parties can read it');
    return copy(a);
  }

  const toPlainState = source => ({
    participants: plain(source.participants), business_links: plain(source.business_links), offers: plain(source.offers), proposals: plain(source.proposals),
    acceptances: copy(source.acceptances), agreements: copy(source.agreements), cancellations: copy(source.cancellations),
    audit: copy(source.audit), idempotency: plain(source.idempotency),
  });
  const readback = () => toPlainState(state);

  async function verifyAgreement(agreementId) {
    const s = readback();
    const agreement = s.agreements.find(a => a.agreement_id === agreementId);
    const offer = agreement ? s.offers[agreement.offer_id] : undefined;
    const proposal = agreement ? s.proposals[agreement.proposal_id] : undefined;
    return verifyAgreementRecord({ agreement, offer, proposal, acceptances: s.acceptances, agreements: s.agreements, audit: s.audit });
  }

  return {
    registerParticipant, requestBusinessLink, getMyBusinessLink, createOfferDraft, resolveOfferDraft, editDraft, publishOffer, submitProposal, counterOffer, acceptProposal,
    resolveAcceptance, closeOffer, requestCancellation, listOpenOffers, getOffer, getProposal, getAgreement, verifyAgreement, readback,
  };
}

// POST: VO true only when exactly the two parties accepted the same proposal version, the content hash matches,
// the record is committed, capacity holds, and the audit event exists.
export function verifyAgreementRecord({ agreement, offer, proposal, acceptances = [], agreements = [], audit = [], verifiedAt = new Date().toISOString() } = {}) {
  const reasons = [];
  const event = agreement ? audit.find(e => e.aggregate_id === agreement.agreement_id && e.action === 'AGREEMENT_COMMITTED') : undefined;
  const refs = Array.isArray(agreement?.acceptance_refs) ? agreement.acceptance_refs : [];
  if (!agreement) {
    reasons.push('AGREEMENT_NOT_FOUND');
  } else {
    const parties = Array.isArray(agreement.parties) ? agreement.parties : [];
    if (agreement.status !== 'COMMITTED') reasons.push('AGREEMENT_NOT_COMMITTED');
    if (parties.length !== 2 || new Set(parties).size !== 2) reasons.push('PARTIES_INVALID');
    if (hashContent({ terms: agreement.agreed_terms ?? null, packages: agreement.packages }) !== agreement.content_hash) reasons.push('CONTENT_HASH_MISMATCH');
    if (!offer || offer.offer_id !== agreement.offer_id) reasons.push('OFFER_MISMATCH');
    else if (offer.owner_id !== parties[0]) reasons.push('OWNER_MISMATCH');
    if (!proposal || proposal.proposal_id !== agreement.proposal_id || proposal.counterparty_id !== parties[1]) reasons.push('PROPOSAL_MISMATCH');
    const accepted = parties.map(p => acceptances.filter(a => a.proposal_id === agreement.proposal_id && a.participant_id === p && a.proposal_version === agreement.proposal_version));
    parties.forEach((p, i) => {
      if (accepted[i].length === 0) reasons.push(`ACCEPTANCE_MISSING:${p}`);
      else if (accepted[i].some(a => a.content_hash !== agreement.content_hash)) reasons.push(`ACCEPTANCE_HASH_MISMATCH:${p}`);
    });
    const expected = accepted.flat().map(a => a.acceptance_id).sort();
    if (refs.length !== 2 || JSON.stringify([...refs].sort()) !== JSON.stringify(expected)) reasons.push('ACCEPTANCE_REFS_MISMATCH');
    if (offer) {
      const used = agreements.filter(a => a.offer_id === offer.offer_id && a.status === 'COMMITTED').reduce((n, a) => n + a.packages, 0);
      if (used > offer.packages_total) reasons.push('CAPACITY_EXCEEDED');
    }
    if (!event) reasons.push('AUDIT_EVENT_MISSING');
  }
  const vo = reasons.length === 0;
  return {
    vo, verified_outcome: vo ? VERIFIED_SCOPE : null, scope: VERIFIED_SCOPE, reasons,
    evidence_refs: agreement ? [...refs, ...(event ? [event.event_id] : [])] : [],
    verifier_version: VERIFIER_VERSION, verified_at: verifiedAt,
  };
}
