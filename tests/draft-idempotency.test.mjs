import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExchange } from '../src/exchange-core-v0.2.mjs';
import { createApi } from '../src/api.mjs';

const fixedNow = new Date('2026-11-02T00:00:00.000Z');
const future = '2026-11-03T00:00:00.000Z';
const payload = (key, give = 'bike repair') => ({
  idempotency_key: key,
  terms: { give, receive: 'a meal', location: 'Cabramatta NSW', availability: 'weekend' },
  packages_total: 1,
  expires_at: future,
});

async function registeredExchange() {
  const exchange = createExchange({ now: () => fixedNow });
  await exchange.registerParticipant({ participant_id: 'A', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:a@example.test' });
  await exchange.registerParticipant({ participant_id: 'B', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:b@example.test' });
  return exchange;
}

test('concurrent same actor/key/payload converges to one draft and one audit event', async () => {
  const exchange = await registeredExchange();
  const [first, second] = await Promise.all([
    exchange.createOfferDraft({ actor: 'A' }, payload('stable-key')),
    exchange.createOfferDraft({ actor: 'A' }, payload('stable-key')),
  ]);
  assert.equal(first.offer_id, second.offer_id);
  assert.deepEqual(new Set([first.replayed, second.replayed]), new Set([false, true]));
  const state = exchange.readback();
  assert.equal(Object.keys(state.offers).length, 1);
  assert.equal(state.audit.filter(event => event.action === 'OFFER_DRAFTED').length, 1);
});

test('same key and changed normalized payload fails closed', async () => {
  const exchange = await registeredExchange();
  await exchange.createOfferDraft({ actor: 'A' }, payload('stable-key'));
  await assert.rejects(
    exchange.createOfferDraft({ actor: 'A' }, payload('stable-key', 'different service')),
    error => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  assert.equal(Object.keys(exchange.readback().offers).length, 1);
});

test('resolver is actor-scoped and same key is independent across actors', async () => {
  const exchange = await registeredExchange();
  const a = await exchange.createOfferDraft({ actor: 'A' }, payload('shared-key'));
  assert.deepEqual(await exchange.resolveOfferDraft({ actor: 'B' }, { idempotency_key: 'shared-key' }), { status: 'NOT_COMMITTED' });
  const b = await exchange.createOfferDraft({ actor: 'B' }, payload('shared-key', 'gardening'));
  assert.notEqual(a.offer_id, b.offer_id);
  assert.equal((await exchange.resolveOfferDraft({ actor: 'A' }, { idempotency_key: 'shared-key' })).offer_id, a.offer_id);
  assert.equal((await exchange.resolveOfferDraft({ actor: 'B' }, { idempotency_key: 'shared-key' })).offer_id, b.offer_id);
});

test('missing or invalid idempotency key is rejected before creating a draft', async () => {
  const exchange = await registeredExchange();
  const withoutKey = payload('valid');
  delete withoutKey.idempotency_key;
  await assert.rejects(exchange.createOfferDraft({ actor: 'A' }, withoutKey), error => error.code === 'IDEMPOTENCY_KEY_INVALID');
  assert.equal(Object.keys(exchange.readback().offers).length, 0);
});

test('authenticated resolve then exact GET recovers a committed draft; revoked session cannot resolve', async () => {
  const exchange = createExchange({ now: () => fixedNow });
  const meta = { isConfigured: () => false, status: () => ({ configured: false }), async suggestOffer() { throw new Error('not called'); } };
  const api = await createApi({ exchange, meta, allowDemo: false, now: () => fixedNow.getTime() });
  const session = await api.issueExternalSession({ participant_id: 'A', account_type: 'RESIDENT', authenticated_subject: 'GOOGLE:a@example.test', label: 'A' });
  const headers = { authorization: `Bearer ${session.token}` };
  const created = await api.handle({ method: 'POST', path: '/api/offers', headers, body: payload('recover-key') });
  assert.equal(created.status, 201);
  const resolved = await api.handle({ method: 'POST', path: '/api/offers/resolve-draft', headers, body: { idempotency_key: 'recover-key' } });
  assert.equal(resolved.body.status, 'COMMITTED');
  assert.equal(resolved.body.offer_id, created.body.offer_id);
  const readback = await api.handle({ method: 'GET', path: `/api/offers/${resolved.body.offer_id}`, headers });
  assert.equal(readback.status, 200);
  assert.equal(readback.body.offer_id, created.body.offer_id);
  api.revokeSession(headers);
  const afterLogout = await api.handle({ method: 'POST', path: '/api/offers/resolve-draft', headers, body: { idempotency_key: 'recover-key' } });
  assert.equal(afterLogout.status, 401);
});
