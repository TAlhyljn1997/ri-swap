import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

test('English is the default on each navigation while Vietnamese remains explicit', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(app, /const requestedLanguage = new URLSearchParams\(window\.location\.search\)\.get\('lang'\)/);
  assert.match(app, /language: requestedLanguage === 'vi' \? 'vi' : 'en'/);
  assert.doesNotMatch(app, /language:[^\n]*localStorage\.getItem\('ri-swap-language'\)/);
  assert.match(app, /state\.language = state\.language === 'vi' \? 'en' : 'vi'/);
});

test('guest draft is tab-scoped and never persisted as draft in localStorage', () => {
  assert.match(app, /sessionStorage\.setItem\(GUEST_DRAFT_KEY/);
  assert.match(app, /sessionStorage\.getItem\(GUEST_DRAFT_KEY/);
  assert.doesNotMatch(app, /localStorage\.(?:setItem|getItem)\(GUEST_DRAFT_KEY/);
  assert.match(html, /may be lost when the tab closes/);
});

test('guest save and open stage a preview without calling an offer mutation', () => {
  assert.match(app, /if \(!state\.me\) \{\s*persistGuestDraft\('save'\)/);
  assert.match(app, /if \(!state\.me\) \{\s*persistGuestDraft\('open'\)/);
  assert.match(app, /No data has been sent to the server/);
  assert.match(html, /PREVIEW · NOT SAVED TO DATABASE/);
});

test('login restore never auto-saves and explicit confirmation owns the write', () => {
  assert.match(app, /const restoredGuestDraft = restoreGuestDraft\(\)/);
  assert.match(app, /nothing was submitted automatically/);
  assert.match(app, /\$\('confirm-draft-save'\)\.onclick/);
  assert.match(app, /async function saveDraftToServer\(\)/);
  const initialize = app.slice(app.indexOf('async function initialize()'));
  assert.doesNotMatch(initialize, /saveDraftToServer\(\)/);
});

test('confirmed save blocks double-click and requires exact authenticated readback', () => {
  assert.match(app, /if \(draftSavePending\) return/);
  assert.match(app, /pendingGuestDraft\?\.idempotency_key \|\| state\.keys\.get\(slot\) \|\| crypto\.randomUUID\(\)/);
  assert.match(app, /await api\('POST', '\/api\/offers'/);
  assert.match(app, /resolver = await api\('POST', '\/api\/offers\/resolve-draft', \{ idempotency_key: idempotencyKey \}\)/);
  assert.doesNotMatch(app, /idempotency_key_fingerprint:/);
  assert.doesNotMatch(app, /resolver\s*=\s*\{\s*\.\.\.resolved,\s*operation/);
  assert.match(app, /await api\('GET', `\/api\/offers\/\$\{resolver\.offer_id\}`\)/);
  assert.match(app, /validateDraftCreationBinding\(\{/);
  assert.match(app, /RECEIPT_ACTION_BINDING_MISMATCH/);
  assert.match(app, /state\.draftId = resolver\.offer_id/);
});

test('creation resolver is mandatory after both successful and ambiguous POST', () => {
  const start = app.indexOf("const operation = 'CREATE_OFFER_DRAFT'");
  const end = app.indexOf("$('b-draft').onclick", start);
  const createFlow = app.slice(start, end);
  const post = createFlow.indexOf("postResult = await api('POST', '/api/offers', offer)");
  const resolver = createFlow.indexOf("resolver = await api('POST', '/api/offers/resolve-draft'");
  assert.ok(post >= 0 && resolver > post);
  assert.doesNotMatch(createFlow.slice(0, resolver), /return;/);
  assert.match(createFlow, /postResult \|\| resolver\.receipt/);
});

test('a restored guest confirmation cannot overwrite a stale previously selected draft', () => {
  assert.match(app, /if \(draftId && pendingGuestDraft\)/);
  assert.match(app, /guest confirmation cannot target a previously selected draft/);
  assert.match(app, /code: 'RECEIPT_ACTION_BINDING_MISMATCH'/);
});

test('guest preview excludes business, knowledge, auth and sensitive fields', () => {
  const snapshot = app.slice(app.indexOf('function guestDraftSnapshot'), app.indexOf('function persistGuestDraft'));
  assert.match(snapshot, /\['a-text', \.\.\.OFFER_FIELD_IDS\]/);
  for (const forbidden of ['business-id', 'k-question', 'otp', 'password', 'card']) assert.doesNotMatch(snapshot, new RegExp(forbidden, 'i'));
});

test('Hoa Mai result status is derived from the returned source and never hard-coded as test-only', () => {
  assert.match(html, /id="hoa-mai-utility-status"[^>]*>CHECKING_RUNTIME</);
  assert.match(app, /result\.source === 'META_MUSE_SPARK_LIVE'/);
  assert.match(app, /badge\.dataset\.lastSource === 'META_MUSE_SPARK_LIVE'/);
  assert.doesNotMatch(app, /TEST_ONLY_ASSIST_RESULT/);
  assert.doesNotMatch(app, /CONSUMER_CALL_SUCCEEDED/);
});

test('discard preview is visible, keyboard-native and makes no API call', () => {
  assert.match(html, /id="discard-guest-draft"[^>]*type="button"/);
  const start = app.indexOf("$('discard-guest-draft').onclick");
  const end = app.indexOf("$('b-propose').onclick", start);
  const handler = app.slice(start, end);
  assert.match(handler, /clearGuestDraft\(\)/);
  assert.match(handler, /\$\('b-draft'\)\.focus\(\)/);
  assert.doesNotMatch(handler, /api\(/);
  assert.doesNotMatch(handler, /receipt/i);
});

test('database evidence limitation is visible in preview and success receipt', () => {
  assert.match(html, /DATABASE_RECEIPT_NOT_VERIFIED · LOCAL\/API_READBACK_ONLY/);
  assert.match(app, /LOCAL\/API_READBACK_ONLY · DATABASE_RECEIPT_NOT_VERIFIED/);
});
