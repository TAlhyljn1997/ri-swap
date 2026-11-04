import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, createExchange, idempotencyKeyIdentityV2, idempotencySlotV2 } from '../src/exchange-core-v0.2.mjs';

const fixedNow = new Date('2026-11-02T00:00:00.000Z');
const expiresAt = '2026-11-03T00:00:00.000Z';
const operation = 'CREATE_OFFER_DRAFT';
const draftPayload = (key, give = 'repair') => ({
  idempotency_key: key,
  terms: { give, receive: 'meal' },
  packages_total: 1,
  expires_at: expiresAt,
});

async function register(exchange, id) {
  await exchange.registerParticipant({ participant_id: id, account_type: 'RESIDENT', authenticated_subject: `GOOGLE:${id}@example.test` });
}

test('V2 tuple hashing closes the exact cross-actor delimiter collision shape', async () => {
  const actor1 = 'A';
  const key1 = `B|${operation}|K`;
  const actor2 = `A|${operation}|B`;
  const key2 = 'K';
  assert.equal(`${actor1}|${operation}|${key1}`, `${actor2}|${operation}|${key2}`);
  assert.notEqual(idempotencySlotV2(actor1, operation, key1), idempotencySlotV2(actor2, operation, key2));

  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, actor1);
  await register(exchange, actor2);
  const first = await exchange.createOfferDraft({ actor: actor1 }, draftPayload(key1));
  const second = await exchange.createOfferDraft({ actor: actor2 }, draftPayload(key2, 'gardening'));
  assert.notEqual(first.offer_id, second.offer_id);
  assert.equal((await exchange.resolveOfferDraft({ actor: actor1 }, { idempotency_key: key1 })).offer_id, first.offer_id);
  assert.equal((await exchange.resolveOfferDraft({ actor: actor2 }, { idempotency_key: key2 })).offer_id, second.offer_id);
});

test('delimiter and unicode keys remain isolated while overlong components fail closed', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  const keys = ['x|y', 'é', 'e\u0301', '🔐|交換'];
  const ids = [];
  for (const [index, key] of keys.entries()) ids.push((await exchange.createOfferDraft({ actor: 'A' }, draftPayload(key, `service-${index}`))).offer_id);
  assert.equal(new Set(ids).size, keys.length);
  await assert.rejects(
    exchange.createOfferDraft({ actor: 'A' }, draftPayload('x'.repeat(257))),
    error => error.code === 'IDEMPOTENCY_COMPONENT_INVALID',
  );
  assert.equal(Object.keys(exchange.readback().offers).length, keys.length);
});

test('authoritatively bound legacy slot replays once and migrates to V2 without duplicate', async () => {
  const payload = draftPayload('legacy-key');
  const normalizedPayload = { terms: payload.terms, packages_total: 1, expires_at: expiresAt };
  const requestHash = createHash('sha256').update(canonicalJson({ operation, payload: normalizedPayload })).digest('hex');
  const legacyOffer = {
    offer_id: 'legacy-offer', owner_id: 'A', terms: payload.terms, packages_total: 1,
    expires_at: expiresAt, version: 1,
    content_hash: createHash('sha256').update(canonicalJson({ terms: payload.terms, packages_total: 1, expires_at: expiresAt })).digest('hex'),
    status: 'DRAFT', created_at: fixedNow.toISOString(),
  };
  const legacyResult = { ...legacyOffer, packages_remaining: 1 };
  const keyIdentity = idempotencyKeyIdentityV2('A', operation, 'legacy-key');
  const resultHash = createHash('sha256').update(canonicalJson(legacyResult)).digest('hex');
  const bindingEventId = 'legacy-binding-event';
  const exchange = createExchange({
    now: () => fixedNow,
    initialState: {
      participants: { A: { participant_id: 'A', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:a@example.test', ri_yellow_ref: null, status: 'ACTIVE' } },
      offers: { [legacyOffer.offer_id]: legacyOffer },
      idempotency: new Map([[`A|${operation}|legacy-key`, {
        schema: 'RI_SWAP_IDEMPOTENCY_RECORD_V2', binding_event_id: bindingEventId,
        actor: 'A', operation, key_identity: keyIdentity, request_hash: requestHash, request_payload: normalizedPayload,
        target: { kind: 'OFFER', id: legacyOffer.offer_id },
        result_hash: resultHash,
        result: legacyResult,
      }]]),
      audit: [{
        event_id: bindingEventId, timestamp: fixedNow.toISOString(), action: 'IDEMPOTENCY_BOUND',
        aggregate_id: legacyOffer.offer_id, actor: 'A', operation, key_identity: keyIdentity,
        request_hash: requestHash, result_hash: resultHash, target_kind: 'OFFER', target_id: legacyOffer.offer_id,
      }],
    },
  });
  const replay = await exchange.createOfferDraft({ actor: 'A' }, payload);
  assert.equal(replay.offer_id, legacyOffer.offer_id);
  assert.equal(replay.replayed, true);
  assert.equal(Object.keys(exchange.readback().offers).length, 1);
  const state = exchange.readback();
  assert.ok(state.idempotency[idempotencySlotV2('A', operation, 'legacy-key')]);
  assert.equal(Object.hasOwn(state.idempotency, 'undefined'), false);
});

test('schema-less record already occupying a V2 slot is quarantined', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('schema-less'));
  const persisted = first.readback();
  delete persisted.idempotency[idempotencySlotV2('A', operation, 'schema-less')].schema;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'schema-less' }),
    error => error.code === 'IDEMPOTENCY_LEGACY_QUARANTINED',
  );
});

test('wrong-schema structured record is rejected without legacy fallback', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('wrong-schema'));
  const persisted = first.readback();
  persisted.idempotency[idempotencySlotV2('A', operation, 'wrong-schema')].schema = 'RI_SWAP_IDEMPOTENCY_RECORD_V3';
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'wrong-schema' }),
    error => ['IDEMPOTENCY_LEGACY_QUARANTINED', 'IDEMPOTENCY_SCHEMA_UNSUPPORTED'].includes(error.code),
  );
});

test('invalid V2 record takes precedence over a legacy alias and fails closed', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('v2-conflict'));
  const persisted = first.readback();
  const slot = idempotencySlotV2('A', operation, 'v2-conflict');
  persisted.idempotency[`A|${operation}|v2-conflict`] = structuredClone(persisted.idempotency[slot]);
  delete persisted.idempotency[slot].schema;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'v2-conflict' }),
    error => error.code === 'IDEMPOTENCY_LEGACY_QUARANTINED',
  );
});

test('recomputed create result hash cannot disclose actor B draft to actor A', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('cross-owner'));
  const persisted = first.readback();
  const record = persisted.idempotency[idempotencySlotV2('A', operation, 'cross-owner')];
  record.result.owner_id = 'B';
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  const event = persisted.audit.find(item => item.event_id === record.binding_event_id);
  event.result_hash = record.result_hash;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'cross-owner' }),
    error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
  );
});

test('self-consistent record rewrite is rejected when immutable server audit binding stays original', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('audit-anchor'));
  const persisted = first.readback();
  const record = persisted.idempotency[idempotencySlotV2('A', operation, 'audit-anchor')];
  record.target.id = 'forged-offer';
  record.result.offer_id = 'forged-offer';
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'audit-anchor' }),
    error => error.code === 'IDEMPOTENCY_AUDIT_BINDING_MISMATCH',
  );
});

test('swapped actor and V2 slot cannot reuse another actor server binding', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await register(first, 'B');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('swap-binding'));
  const persisted = first.readback();
  const sourceSlot = idempotencySlotV2('A', operation, 'swap-binding');
  const record = persisted.idempotency[sourceSlot];
  record.actor = 'B';
  record.key_identity = idempotencyKeyIdentityV2('B', operation, 'swap-binding');
  record.result.owner_id = 'B';
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  persisted.idempotency[idempotencySlotV2('B', operation, 'swap-binding')] = record;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'B' }, { idempotency_key: 'swap-binding' }),
    error => error.code === 'IDEMPOTENCY_AUDIT_BINDING_MISMATCH',
  );
});

test('swapped operation and target cannot reuse the original server binding', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await register(first, 'B');
  const draft = await first.createOfferDraft({ actor: 'A' }, draftPayload('swap-operation'));
  const persisted = first.readback();
  const sourceSlot = idempotencySlotV2('A', operation, 'swap-operation');
  const record = persisted.idempotency[sourceSlot];
  const submitOperation = 'SUBMIT_PROPOSAL';
  const submitRequest = { offer_id: draft.offer_id, packages: 1, terms: null };
  record.operation = submitOperation;
  record.key_identity = idempotencyKeyIdentityV2('A', submitOperation, 'swap-operation');
  record.request_payload = submitRequest;
  record.request_hash = createHash('sha256').update(canonicalJson({ operation: submitOperation, payload: submitRequest })).digest('hex');
  record.target = { kind: 'PROPOSAL', id: 'forged-proposal' };
  record.result = {
    proposal_id: 'forged-proposal', offer_id: draft.offer_id, packages: 1,
    terms: draft.terms, version: 1,
    content_hash: createHash('sha256').update(canonicalJson({ terms: draft.terms, packages: 1 })).digest('hex'),
    status: 'PROPOSED',
  };
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  persisted.idempotency[idempotencySlotV2('A', submitOperation, 'swap-operation')] = record;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.submitProposal({ actor: 'A' }, { offer_id: draft.offer_id, packages: 1, idempotency_key: 'swap-operation' }),
    error => error.code === 'IDEMPOTENCY_AUDIT_BINDING_MISMATCH',
  );
});

test('ambiguous legacy idempotency records are quarantined instead of replayed', async () => {
  const payload = draftPayload('legacy-key');
  const requestHash = createHash('sha256').update(canonicalJson({ operation, payload: { terms: payload.terms, packages_total: 1, expires_at: expiresAt } })).digest('hex');
  const exchange = createExchange({
    now: () => fixedNow,
    initialState: {
      participants: { A: { participant_id: 'A', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:a@example.test', ri_yellow_ref: null, status: 'ACTIVE' } },
      idempotency: new Map([[`A|${operation}|legacy-key`, { request_hash: requestHash, result: { offer_id: 'unknown' } }]]),
    },
  });
  await assert.rejects(exchange.createOfferDraft({ actor: 'A' }, payload), error => error.code === 'IDEMPOTENCY_LEGACY_QUARANTINED');
  assert.equal(Object.keys(exchange.readback().offers).length, 0);
});

test('proposal and acceptance paths use V2 slots for replay and resolver isolation', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, { offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal|key' });
  const first = await exchange.acceptProposal({ actor: 'A' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept|key' });
  const replay = await exchange.acceptProposal({ actor: 'A' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept|key' });
  assert.equal(first.status, 'WAITING_FOR_OTHER_PARTY');
  assert.equal(replay.replayed, true);
  assert.deepEqual(await exchange.resolveAcceptance({ actor: 'B' }, { proposal_id: proposal.proposal_id, idempotency_key: 'accept|key' }), { status: 'NOT_COMMITTED' });
});

test('acceptance recovery key cannot resolve a different proposal for the same actor', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const first = await exchange.submitProposal({ actor: 'B' }, { offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-one' });
  await exchange.acceptProposal({ actor: 'A' }, { proposal_id: first.proposal_id, version: 1, idempotency_key: 'accept-one' });
  await assert.rejects(
    exchange.resolveAcceptance({ actor: 'A' }, { proposal_id: 'another-proposal', idempotency_key: 'accept-one' }),
    error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
  );
});

test('V2 binding survives state restart, contains no raw key, and resolver returns it unchanged', async () => {
  const secretKey = 'never-store-this-raw-key';
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  const draft = await first.createOfferDraft({ actor: 'A' }, draftPayload(secretKey));
  const persisted = first.readback();
  assert.equal(JSON.stringify(persisted.idempotency).includes(secretKey), false);

  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  const resolved = await restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: secretKey });
  assert.equal(resolved.offer_id, draft.offer_id);
  assert.deepEqual(resolved.binding.target, { kind: 'OFFER', id: draft.offer_id });
  assert.equal(resolved.binding.actor, 'A');
  assert.equal(resolved.binding.operation, operation);
  assert.equal(resolved.binding.key_identity, idempotencyKeyIdentityV2('A', operation, secretKey));
});

test('corrupt stored result hash fails closed during resolver readback', async () => {
  const first = createExchange({ now: () => fixedNow });
  await register(first, 'A');
  await first.createOfferDraft({ actor: 'A' }, draftPayload('hash-corrupt'));
  const persisted = first.readback();
  const slot = idempotencySlotV2('A', operation, 'hash-corrupt');
  persisted.idempotency[slot].result_hash = '0'.repeat(64);
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'hash-corrupt' }),
    error => error.code === 'IDEMPOTENCY_LEGACY_QUARANTINED',
  );
});

test('first acceptance key resolves only its bound proposal after the second party commits', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer-two-party'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, { offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-two-party' });
  await exchange.acceptProposal({ actor: 'A' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-a' });
  const committed = await exchange.acceptProposal({ actor: 'B' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-b' });
  const recovered = await exchange.resolveAcceptance({ actor: 'A' }, { proposal_id: proposal.proposal_id, idempotency_key: 'accept-a' });
  assert.deepEqual(recovered, { status: 'COMMITTED', agreement_id: committed.agreement.agreement_id });
});

test('an old v1 acceptance key cannot resolve a later v2 agreement for the same proposal', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer-version-bound'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, {
    offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-version-bound',
  });

  const oldAcceptance = await exchange.acceptProposal({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-a-v1',
  });
  assert.equal(oldAcceptance.status, 'WAITING_FOR_OTHER_PARTY');

  const revised = await exchange.counterOffer({ actor: 'B' }, {
    proposal_id: proposal.proposal_id,
    packages: 1,
    terms: { give: 'repair plus pickup', receive: 'meal' },
  });
  assert.equal(revised.version, 2);

  const acceptedA = await exchange.acceptProposal({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, version: 2, idempotency_key: 'accept-a-v2',
  });
  const acceptedB = await exchange.acceptProposal({ actor: 'B' }, {
    proposal_id: proposal.proposal_id, version: 2, idempotency_key: 'accept-b-v2',
  });
  assert.equal(acceptedA.status, 'WAITING_FOR_OTHER_PARTY');
  assert.equal(acceptedB.status, 'AGREEMENT_COMMITTED');
  assert.equal(acceptedB.agreement.proposal_version, 2);
  assert.ok(acceptedB.agreement.acceptance_refs.includes(acceptedA.acceptance_ref));
  assert.ok(acceptedB.agreement.acceptance_refs.includes(acceptedB.acceptance_ref));

  assert.deepEqual(
    await exchange.resolveAcceptance({ actor: 'A' }, { proposal_id: proposal.proposal_id, idempotency_key: 'accept-a-v1' }),
    { status: 'NOT_COMMITTED' },
  );
  const recoveredA = await exchange.resolveAcceptance({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, idempotency_key: 'accept-a-v2',
  });
  const recoveredB = await exchange.resolveAcceptance({ actor: 'B' }, {
    proposal_id: proposal.proposal_id, idempotency_key: 'accept-b-v2',
  });
  assert.equal(recoveredA.status, 'COMMITTED');
  assert.equal(recoveredA.agreement_id, acceptedB.agreement.agreement_id);
  assert.equal(recoveredB.status, 'COMMITTED');
  assert.equal(recoveredB.agreement_id, acceptedB.agreement.agreement_id);

  const restarted = createExchange({ now: () => fixedNow, initialState: exchange.readback() });
  assert.deepEqual(
    await restarted.resolveAcceptance({ actor: 'A' }, { proposal_id: proposal.proposal_id, idempotency_key: 'accept-a-v1' }),
    { status: 'NOT_COMMITTED' },
  );
  assert.equal((await restarted.resolveAcceptance({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, idempotency_key: 'accept-a-v2',
  })).agreement_id, acceptedB.agreement.agreement_id);
});

test('acceptance recovery fails closed when acceptance provenance is missing or wrong', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer-provenance'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, {
    offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-provenance',
  });
  await exchange.acceptProposal({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-provenance',
  });

  for (const replacement of [undefined, 'unknown-acceptance-ref']) {
    const persisted = exchange.readback();
    const record = persisted.idempotency[idempotencySlotV2('A', 'ACCEPT_PROPOSAL', 'accept-provenance')];
    if (replacement === undefined) delete record.result.acceptance_ref;
    else record.result.acceptance_ref = replacement;
    record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
    persisted.audit.find(item => item.event_id === record.binding_event_id).result_hash = record.result_hash;
    const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
    await assert.rejects(
      restarted.resolveAcceptance({ actor: 'A' }, {
        proposal_id: proposal.proposal_id, idempotency_key: 'accept-provenance',
      }),
      error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
    );
  }
});

test('concurrent duplicate acceptance converges on one acceptance reference and recovers after commit', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, draftPayload('offer-concurrent-accept'));
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, {
    offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-concurrent-accept',
  });
  const [first, second] = await Promise.all([
    exchange.acceptProposal({ actor: 'A' }, {
      proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-a-concurrent',
    }),
    exchange.acceptProposal({ actor: 'A' }, {
      proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-a-concurrent',
    }),
  ]);
  assert.equal(first.acceptance_ref, second.acceptance_ref);
  assert.equal([first, second].filter(item => item.replayed === true).length, 1);
  assert.equal(exchange.readback().acceptances.filter(item => item.participant_id === 'A').length, 1);

  const committed = await exchange.acceptProposal({ actor: 'B' }, {
    proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-b-concurrent',
  });
  const recovered = await exchange.resolveAcceptance({ actor: 'A' }, {
    proposal_id: proposal.proposal_id, idempotency_key: 'accept-a-concurrent',
  });
  assert.deepEqual(recovered, { status: 'COMMITTED', agreement_id: committed.agreement.agreement_id });
});

async function committedAcceptanceState(key = 'accept-b-adversarial') {
  const exchange = createExchange({ now: () => fixedNow });
  await register(exchange, 'A');
  await register(exchange, 'B');
  const draft = await exchange.createOfferDraft({ actor: 'A' }, { ...draftPayload('offer-adversarial'), packages_total: 2 });
  await exchange.publishOffer({ actor: 'A' }, { offer_id: draft.offer_id });
  const proposal = await exchange.submitProposal({ actor: 'B' }, { offer_id: draft.offer_id, packages: 1, idempotency_key: 'proposal-adversarial' });
  await exchange.acceptProposal({ actor: 'A' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: 'accept-a-adversarial' });
  await exchange.acceptProposal({ actor: 'B' }, { proposal_id: proposal.proposal_id, version: 1, idempotency_key: key });
  return { persisted: exchange.readback(), proposal, key };
}

test('target P2 cannot disclose an agreement committed for P1 even with recomputed hashes', async () => {
  const { persisted, key } = await committedAcceptanceState();
  const acceptOperation = 'ACCEPT_PROPOSAL';
  const slot = idempotencySlotV2('B', acceptOperation, key);
  const record = persisted.idempotency[slot];
  record.target.id = 'proposal-P2';
  record.request_payload = { proposal_id: 'proposal-P2', version: 1 };
  record.request_hash = createHash('sha256').update(canonicalJson({ operation: acceptOperation, payload: record.request_payload })).digest('hex');
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  const event = persisted.audit.find(item => item.event_id === record.binding_event_id);
  Object.assign(event, { aggregate_id: 'proposal-P2', target_id: 'proposal-P2', request_hash: record.request_hash, result_hash: record.result_hash });
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveAcceptance({ actor: 'B' }, { proposal_id: 'proposal-P2', idempotency_key: key }),
    error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
  );
});

test('acceptance agreement must contain the bound actor', async () => {
  const { persisted, proposal, key } = await committedAcceptanceState('accept-parties');
  const record = persisted.idempotency[idempotencySlotV2('B', 'ACCEPT_PROPOSAL', key)];
  record.result.agreement.parties = ['A', 'C'];
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  persisted.audit.find(item => item.event_id === record.binding_event_id).result_hash = record.result_hash;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveAcceptance({ actor: 'B' }, { proposal_id: proposal.proposal_id, idempotency_key: key }),
    error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
  );
});

test('acceptance waiting and committed result shapes fail closed when contradictory', async () => {
  const { persisted, proposal, key } = await committedAcceptanceState('accept-shape');
  const record = persisted.idempotency[idempotencySlotV2('B', 'ACCEPT_PROPOSAL', key)];
  record.result.status = 'WAITING_FOR_OTHER_PARTY';
  record.result_hash = createHash('sha256').update(canonicalJson(record.result)).digest('hex');
  persisted.audit.find(item => item.event_id === record.binding_event_id).result_hash = record.result_hash;
  const restarted = createExchange({ now: () => fixedNow, initialState: persisted });
  await assert.rejects(
    restarted.resolveAcceptance({ actor: 'B' }, { proposal_id: proposal.proposal_id, idempotency_key: key }),
    error => error.code === 'IDEMPOTENCY_TARGET_MISMATCH',
  );
});
