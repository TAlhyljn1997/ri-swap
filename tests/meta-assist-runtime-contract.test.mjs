import assert from 'node:assert/strict';
import test from 'node:test';

import { createMetaClient } from '../src/meta-client.mjs';

function response({ id = 'resp_test_001', shape = 'blocks' } = {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        id,
        status: 'completed',
        ...(shape === 'shortcut' ? { output_text: JSON.stringify({
          give: 'website design',
          receive: 'catering for 40 guests',
          location: 'Cabramatta NSW',
          availability: '',
          questions: ['Is the catering offer for 30 or 40 guests?'],
        }) } : { output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          give: 'website design',
          receive: 'catering for 40 guests',
          location: 'Cabramatta NSW',
          availability: '',
          questions: ['Is the catering offer for 30 or 40 guests?'],
        }) }] }] }),
        usage: { input_tokens: 81, output_tokens: 36, total_tokens: 117 },
      };
    },
  };
}

test('live Meta result carries a sanitised execution id and process-local verification metadata', async () => {
  let requestBody;
  const client = createMetaClient({
    env: { MODEL_API_KEY: 'not-a-real-key' },
    minIntervalMs: 0,
    now: () => Date.parse('2026-11-02T02:30:00.000Z'),
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return response();
    },
  });

  const result = await client.suggestOffer('I can build a website for catering. The offer says 30 guests but I need 40.');
  assert.equal(result.source, 'META_MUSE_SPARK_LIVE');
  assert.equal(result.execution_id, 'resp_test_001');
  assert.equal(result.observed_at, '2026-11-02T02:30:00.000Z');
  assert.equal(result.durable_receipt, false);
  assert.equal(result.receipt_state, 'PROCESS_LOCAL_ONLY');
  assert.equal(result.route, '/v1/responses');
  assert.equal(result.http_status, 200);
  assert.equal(result.schema_validated, true);
  assert.deepEqual(result.usage, { input_tokens: 81, output_tokens: 36, total_tokens: 117 });
  assert.deepEqual(result.questions, ['Is the catering offer for 30 or 40 guests?']);
  assert.match(requestBody.input, /quantities or terms conflict/i);
  assert.match(requestBody.input, /same language as the person/i);
  assert.equal(requestBody.text.format.type, 'json_schema');
  assert.equal(requestBody.text.format.strict, true);
  assert.equal('response_format' in requestBody, false);

  const status = client.status();
  assert.equal(status.verified_this_process, true);
  assert.equal(status.last_success_at, result.observed_at);
  assert.equal(status.last_execution_id, result.execution_id);
  assert.equal(status.durable_receipt, false);
});

test('Responses output_text convenience shape remains accepted without assuming the first output item', async () => {
  const client = createMetaClient({
    env: { MODEL_API_KEY: 'not-a-real-key' },
    minIntervalMs: 0,
    fetchImpl: async () => response({ shape: 'shortcut' }),
  });
  const result = await client.suggestOffer('I exchange bicycle repair for a family meal.');
  assert.equal(result.terms.give, 'website design');
});

test('HTTP 200 without usable output fails closed', async () => {
  const client = createMetaClient({
    env: { MODEL_API_KEY: 'not-a-real-key' },
    minIntervalMs: 0,
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { id: 'resp_empty', status: 'completed', output: [{ type: 'reasoning' }] }; } }),
  });
  await assert.rejects(() => client.suggestOffer('I exchange bicycle repair for a family meal.'), error => error.code === 'META_BAD_RESPONSE');
  assert.equal(client.status().live_call_verified, false);
});

test('provider 400 is not retried and only bounded error metadata is retained', async () => {
  let calls = 0;
  const client = createMetaClient({
    env: { MODEL_API_KEY: 'not-a-real-key' },
    minIntervalMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 400, async json() { return { error: { code: 'invalid_parameter', type: 'invalid_request_error', param: 'text.format', message: 'do not disclose this body' } }; } };
    },
  });
  await assert.rejects(() => client.suggestOffer('I exchange bicycle repair for a family meal.'), error => {
    assert.equal(error.code, 'META_HTTP_ERROR');
    assert.deepEqual(error.details, { code: 'invalid_parameter', type: 'invalid_request_error', param: 'text.format' });
    assert.doesNotMatch(error.message, /do not disclose/);
    return true;
  });
  assert.equal(calls, 1);
});

test('unsafe upstream identifiers are not exposed as execution ids', async () => {
  const client = createMetaClient({
    env: { MODEL_API_KEY: 'not-a-real-key' },
    minIntervalMs: 0,
    fetchImpl: async () => response({ id: 'bad id with spaces' }),
  });

  const result = await client.suggestOffer('I exchange bicycle repair for a family meal.');
  assert.equal(result.execution_id, null);
  assert.equal(client.status().last_execution_id, null);
});

test('allowed-character credential-shaped upstream identifiers are not exposed', async () => {
  for (const id of ['Bearer:secret.value', 'token_ABC123', 'sk_live_ABC123', 'eyJabc123456789.eyJdef123456789.eyJghi123456789']) {
    const client = createMetaClient({
      env: { MODEL_API_KEY: 'not-a-real-key' },
      minIntervalMs: 0,
      fetchImpl: async () => response({ id }),
    });
    const result = await client.suggestOffer('I exchange bicycle repair for a family meal.');
    assert.equal(result.execution_id, null, id);
  }
});
