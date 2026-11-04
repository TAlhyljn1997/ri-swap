export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function canonicalConfirmedOffer(offer) {
  const terms = Object.fromEntries(Object.entries(offer.terms)
    .map(([key, value]) => [key, String(value).trim()])
    .filter(([, value]) => value !== ''));
  return { terms, packages_total: offer.packages_total, expires_at: new Date(offer.expires_at).toISOString() };
}

function sameCanonicalOffer(record, expected) {
  if (!record || !record.terms) return false;
  return canonicalJson({ terms: record.terms, packages_total: record.packages_total, expires_at: record.expires_at })
    === canonicalJson(expected);
}

function sameDraftRecord(record, { actorId, offerId, expectedHash, expected }) {
  return Boolean(record)
    && record.offer_id === offerId
    && record.owner_id === actorId
    && record.status === 'DRAFT'
    && record.version === 1
    && record.content_hash === expectedHash
    && sameCanonicalOffer(record, expected);
}

export async function idempotencyKeyIdentityV2(actor, operation, key) {
  if (typeof actor !== 'string' || !actor || typeof operation !== 'string' || !operation || typeof key !== 'string' || !key) return null;
  return sha256Hex(canonicalJson({ actor, domain: 'RI_SWAP_IDEMPOTENCY_KEY_V2', key, operation }));
}

export async function idempotencyRequestHash(operation, payload) {
  return sha256Hex(canonicalJson({ operation, payload }));
}

// Check consistency of a successful guest-to-authenticated creation against
// the server-validated resolver packet. This browser check is not authority:
// the server must first validate the persisted record against its own immutable
// IDEMPOTENCY_BOUND audit event before returning this packet.
export async function validateDraftCreationBinding({
  operation,
  idempotencyKey,
  actor,
  postResult,
  resolver,
  readback,
  expected,
}) {
  const keyIdentity = await idempotencyKeyIdentityV2(actor?.participant_id, operation, idempotencyKey);
  const requestHash = await idempotencyRequestHash(operation, expected);
  const binding = resolver?.binding;
  if (operation !== 'CREATE_OFFER_DRAFT'
    || !keyIdentity
    || !actor?.participant_id
    || resolver?.status !== 'COMMITTED'
    || binding?.schema !== 'RI_SWAP_IDEMPOTENCY_BINDING_V2'
    || typeof binding.binding_event_id !== 'string'
    || !binding.binding_event_id
    || binding.actor !== actor.participant_id
    || binding.operation !== operation
    || binding.key_identity !== keyIdentity
    || binding.request_hash !== requestHash
    || binding.target?.kind !== 'OFFER'
    || binding.target.id !== resolver.offer_id
    || typeof binding.result_hash !== 'string'
    || !resolver.offer_id
    || !resolver.receipt
    || !readback) {
    return { ok: false, keyIdentity };
  }

  const expectedHash = await sha256Hex(canonicalJson(expected));
  const context = {
    actorId: actor.participant_id,
    offerId: resolver.offer_id,
    expectedHash,
    expected,
  };
  const records = [resolver.receipt, readback];
  if (postResult !== null && postResult !== undefined) records.push(postResult);

  const ok = resolver.offer_status === 'DRAFT'
    && await sha256Hex(canonicalJson(resolver.receipt)) === binding.result_hash
    && readback.offer_id === resolver.offer_id
    && (postResult === null || postResult === undefined || postResult.offer_id === resolver.offer_id)
    && records.every(record => sameDraftRecord(record, context));
  return { ok, keyIdentity };
}

export async function validateDraftReceipt({ actor, result, readback, expected }) {
  if (!actor?.participant_id || !result || !readback || !Number.isInteger(readback.version)) return false;
  const expectedHash = await sha256Hex(canonicalJson(expected));
  return readback.offer_id === result.offer_id
    && readback.owner_id === actor.participant_id
    && result.owner_id === actor.participant_id
    && readback.status === result.status
    && readback.version === result.version
    && readback.content_hash === result.content_hash
    && readback.content_hash === expectedHash
    && sameCanonicalOffer(result, expected)
    && sameCanonicalOffer(readback, expected);
}
