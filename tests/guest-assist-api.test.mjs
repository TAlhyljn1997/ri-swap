import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi } from '../src/api.mjs';
import { createExchange } from '../src/exchange-core-v0.2.mjs';
import { MetaError } from '../src/meta-client.mjs';

function fakeMeta({ error } = {}) {
  let calls = 0;
  return {
    isConfigured: () => true,
    status: () => ({ configured: true, live_call_verified: false }),
    get calls() { return calls; },
    async suggestOffer(text) {
      calls += 1;
      if (error) throw new MetaError(error, 'bounded fake error');
      return {
        model: 'fake-meta-no-network',
        terms: { give: `structured:${text}`, receive: 'review required', location: '', availability: '' },
        questions: [],
      };
    },
  };
}

test('anonymous assist/offer is informational and invokes the injected fake Meta client once', async () => {
  const meta = fakeMeta();
  const api = await createApi({ exchange: createExchange(), meta, allowDemo: false, dataMode: 'REAL_ONLY_FAIL_CLOSED' });
  const before = api.handle({ method: 'GET', path: '/api/offers', headers: {} });
  const response = await api.handle({ method: 'POST', path: '/api/assist/offer', headers: {}, body: { text: 'bike repair for a meal' } });
  const after = api.handle({ method: 'GET', path: '/api/offers', headers: {} });
  assert.equal(response.status, 200);
  assert.equal(meta.calls, 1);
  assert.deepEqual((await before).body, { offers: [] });
  assert.deepEqual((await after).body, { offers: [] });
});

test('anonymous visitors can read the bounded Meta utility registry without gaining mutation access', async () => {
  const api = await createApi({ exchange: createExchange(), meta: fakeMeta(), allowDemo: false, dataMode: 'REAL_ONLY_FAIL_CLOSED' });
  const response = await api.handle({ method: 'GET', path: '/api/meta-utilities', headers: {} });
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.utilities));
  assert.equal(response.body.registry_is_provider_proof, false);
  assert.equal(response.body.mutations_require_authentication, true);
  assert.deepEqual(response.body.utilities.map(item => Object.keys(item).sort()), [
    ['availability', 'id'],
    ['availability', 'id'],
    ['availability', 'id'],
  ]);
  const serialised = JSON.stringify(response.body);
  for (const forbidden of ['adapter', 'requirements', 'owner', 'team', 'project', 'private_media_repository', 'error', 'token', 'secret']) {
    assert.doesNotMatch(serialised, new RegExp(forbidden, 'i'));
  }

  const mutation = await api.handle({ method: 'POST', path: '/api/offers', headers: {}, body: {} });
  assert.equal(mutation.status, 401);
  assert.equal(mutation.body.error.code, 'UNAUTHENTICATED');
});

test('all anonymous RI-SWAP mutations remain fail-closed', async () => {
  const api = await createApi({ exchange: createExchange(), meta: fakeMeta(), allowDemo: false, dataMode: 'REAL_ONLY_FAIL_CLOSED' });
  for (const [method, path, body] of [
    ['POST', '/api/offers', {}],
    ['PUT', '/api/offers/example', {}],
    ['POST', '/api/offers/example/publish'],
    ['POST', '/api/offers/example/proposals', {}],
    ['POST', '/api/proposals/example/accept', {}],
  ]) {
    const response = await api.handle({ method, path, headers: {}, body });
    assert.equal(response.status, 401, `${method} ${path}`);
    assert.equal(response.body.error.code, 'UNAUTHENTICATED');
  }
});

for (const [code, expectedStatus] of [
  ['META_NOT_CONFIGURED', 503],
  ['META_LOCAL_RATE_LIMIT', 429],
  ['META_DAILY_BUDGET_EXHAUSTED', 429],
  ['META_SENSITIVE_INPUT_REJECTED', 400],
]) {
  test(`anonymous assist/offer preserves typed ${code}`, async () => {
    const api = await createApi({ exchange: createExchange(), meta: fakeMeta({ error: code }), allowDemo: false, dataMode: 'REAL_ONLY_FAIL_CLOSED' });
    const response = await api.handle({ method: 'POST', path: '/api/assist/offer', headers: {}, body: { text: 'bounded request' } });
    assert.equal(response.status, expectedStatus);
    assert.equal(response.body.error.code, code);
  });
}
