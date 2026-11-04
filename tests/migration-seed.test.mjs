import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/exchange-core-v0.2.mjs';

test('fresh database migration seed passes the runtime canonical integrity check', () => {
  const sql = readFileSync(new URL('../migrations/001-durable-state.sql', import.meta.url), 'utf8');
  const match = sql.match(/'({[^']+})'::jsonb,\s*'([a-f0-9]{64})'/);
  assert.ok(match, 'migration must declare JSON seed and hash');
  assert.equal(createHash('sha256').update(canonicalJson(JSON.parse(match[1]))).digest('hex'), match[2]);
});
