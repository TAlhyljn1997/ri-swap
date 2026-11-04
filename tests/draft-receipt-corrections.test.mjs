import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExchange, hashContent } from '../src/exchange-core-v0.2.mjs';
import { canonicalConfirmedOffer, idempotencyKeyIdentityV2, idempotencyRequestHash, sha256Hex, canonicalJson, validateDraftCreationBinding, validateDraftReceipt } from '../public/draft-receipt.js';

const fixedNow = new Date('2026-11-02T00:00:00.000Z');
const expiresAt = '2026-11-03T00:00:00.000Z';

async function exchangeWithActor() {
  const exchange = createExchange({ now: () => fixedNow });
  await exchange.registerParticipant({ participant_id: 'A', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:a@example.test' });
  return exchange;
}

test('draft creation emits immutable version one and canonical content hash', async () => {
  const exchange = await exchangeWithActor();
  const result = await exchange.createOfferDraft({ actor: 'A' }, {
    idempotency_key: 'create-v1',
    terms: { give: ' repair ', receive: ' meal ', location: '', availability: ' weekend ' },
    packages_total: 2,
    expires_at: expiresAt,
  });
  assert.equal(result.version, 1);
  assert.equal(result.content_hash, hashContent({ terms: { give: 'repair', receive: 'meal', availability: 'weekend' }, packages_total: 2, expires_at: expiresAt }));
  const resolved = await exchange.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'create-v1' });
  assert.equal(resolved.receipt.offer_id, result.offer_id);
  assert.equal(resolved.receipt.content_hash, result.content_hash);
});

test('editing a draft increments version and recomputes content hash', async () => {
  const exchange = await exchangeWithActor();
  const created = await exchange.createOfferDraft({ actor: 'A' }, {
    idempotency_key: 'edit-v1', terms: { give: 'repair', receive: 'meal' }, packages_total: 1, expires_at: expiresAt,
  });
  const edited = await exchange.editDraft({ actor: 'A' }, { offer_id: created.offer_id, terms: { give: 'gardening', receive: 'meal' } });
  assert.equal(edited.version, 2);
  assert.notEqual(edited.content_hash, created.content_hash);
  assert.equal(edited.content_hash, hashContent({ terms: edited.terms, packages_total: 1, expires_at: expiresAt }));
});

test('receipt validator rejects tampered actor, hash, version and canonical field', async () => {
  const expected = canonicalConfirmedOffer({ terms: { give: 'repair', receive: 'meal', location: '', availability: '' }, packages_total: 1, expires_at: expiresAt });
  const content_hash = hashContent(expected);
  const base = { offer_id: 'offer-1', owner_id: 'A', status: 'DRAFT', version: 1, content_hash, ...expected };
  const valid = { actor: { participant_id: 'A' }, result: structuredClone(base), readback: structuredClone(base), expected };
  assert.equal(await validateDraftReceipt(valid), true);
  for (const mutate of [
    packet => { packet.actor.participant_id = 'B'; },
    packet => { packet.readback.content_hash = '0'.repeat(64); },
    packet => { packet.readback.version = 2; },
    packet => { packet.readback.terms.give = 'tampered'; },
  ]) {
    const packet = structuredClone(valid);
    mutate(packet);
    assert.equal(await validateDraftReceipt(packet), false);
  }
});

async function creationPacket() {
  const expected = canonicalConfirmedOffer({ terms: { give: 'repair', receive: 'meal', location: '', availability: '' }, packages_total: 1, expires_at: expiresAt });
  const content_hash = hashContent(expected);
  const record = { offer_id: 'offer-1', owner_id: 'A', status: 'DRAFT', version: 1, content_hash, ...expected };
  const operation = 'CREATE_OFFER_DRAFT';
  const key = 'create-key-1';
  return {
    operation,
    idempotencyKey: key,
    actor: { participant_id: 'A' },
    postResult: structuredClone(record),
    resolver: {
      status: 'COMMITTED',
      offer_id: 'offer-1',
      offer_status: 'DRAFT',
      receipt: structuredClone(record),
      binding: {
        schema: 'RI_SWAP_IDEMPOTENCY_BINDING_V2',
        binding_event_id: 'binding-event-1',
        actor: 'A',
        operation,
        key_identity: await idempotencyKeyIdentityV2('A', operation, key),
        request_hash: await idempotencyRequestHash(operation, expected),
        target: { kind: 'OFFER', id: 'offer-1' },
        result_hash: await sha256Hex(canonicalJson(record)),
      },
    },
    readback: structuredClone(record),
    expected,
  };
}

test('creation binding accepts the exact resolver target and supports a lost POST response', async () => {
  const packet = await creationPacket();
  const direct = await validateDraftCreationBinding(packet);
  assert.equal(direct.ok, true);
  assert.match(direct.keyIdentity, /^[0-9a-f]{64}$/);

  const lostPost = structuredClone(packet);
  lostPost.postResult = null;
  assert.equal((await validateDraftCreationBinding(lostPost)).ok, true);
});

test('creation binding rejects a self-consistent but wrong Offer target', async () => {
  const packet = await creationPacket();
  const wrong = structuredClone(packet.postResult);
  wrong.offer_id = 'offer-previous';
  wrong.status = 'OPEN';
  wrong.version = 99;
  packet.postResult = structuredClone(wrong);
  packet.readback = structuredClone(wrong);
  assert.equal((await validateDraftCreationBinding(packet)).ok, false);
});

test('creation binding rejects wrong operation, key, actor, version, status, hash, field and missing resolver', async () => {
  const mutations = [
    packet => { packet.operation = 'EDIT_OFFER_DRAFT'; },
    packet => { packet.idempotencyKey = ''; },
    packet => { packet.actor.participant_id = 'B'; },
    packet => { packet.resolver.receipt.version = 2; },
    packet => { packet.resolver.offer_status = 'OPEN'; packet.resolver.receipt.status = 'OPEN'; },
    packet => { packet.readback.content_hash = 'f'.repeat(64); },
    packet => { packet.postResult.terms.give = 'different'; },
    packet => { packet.resolver = null; },
  ];
  for (const mutate of mutations) {
    const packet = await creationPacket();
    mutate(packet);
    assert.equal((await validateDraftCreationBinding(packet)).ok, false);
  }
});

test('creation binding rejects disagreement among POST, resolver receipt and authenticated GET', async () => {
  for (const mutate of [
    packet => { packet.postResult.offer_id = 'offer-2'; },
    packet => { packet.resolver.receipt.offer_id = 'offer-2'; },
    packet => { packet.readback.offer_id = 'offer-2'; },
    packet => { packet.resolver.receipt.owner_id = 'B'; },
  ]) {
    const packet = await creationPacket();
    mutate(packet);
    assert.equal((await validateDraftCreationBinding(packet)).ok, false);
  }
});

test('creation binding rejects self-consistent wrong resolver binding, key, operation and target', async () => {
  for (const mutate of [
    packet => { packet.resolver.binding.key_identity = '0'.repeat(64); },
    packet => { packet.resolver.binding.operation = 'EDIT_OFFER_DRAFT'; },
    packet => { packet.resolver.binding.target.id = 'offer-previous'; packet.resolver.offer_id = 'offer-previous'; packet.resolver.receipt.offer_id = 'offer-previous'; packet.readback.offer_id = 'offer-previous'; packet.postResult = null; },
    packet => { packet.resolver.binding.request_hash = '1'.repeat(64); },
    packet => { packet.resolver.binding.result_hash = '2'.repeat(64); },
  ]) {
    const packet = await creationPacket();
    mutate(packet);
    assert.equal((await validateDraftCreationBinding(packet)).ok, false);
  }
});
