import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../public/', import.meta.url);
const html = await readFile(new URL('index.html', root), 'utf8');
const js = await readFile(new URL('app.js', root), 'utf8');
const css = await readFile(new URL('visible-ai-utilities.css', root), 'utf8');

test('AI tools are a first-screen section before the real Open Offers surface', () => {
  assert.ok(html.includes('id="ai-tools"'));
  assert.ok(html.indexOf('id="ai-tools"') < html.indexOf('id="open-offers"'));
  assert.match(html, /data-vi="Bắt đầu với Hoa Mai"/);
  assert.match(html, /data-en="Start with Hoa Mai"/);
});

test('Hoa Mai and Ask the system remain distinct entrypoints and routes', () => {
  assert.match(html, /id="b-open-hoa-mai"/);
  assert.match(html, /id="b-open-hoa-mai-actions"/);
  assert.match(html, /id="b-open-system"/);
  assert.match(js, /'\/api\/assist\/offer'/);
  assert.match(js, /'\/api\/assist\/explain'/);
  assert.match(js, /RKB/);
  assert.match(js, /RI-KOS/);
  assert.match(js, /RI-BCA/);
  assert.match(html, /RI SOURCES · META NOT CALLED/);
});

test('primary Hoa Mai CTA opens the real assist input and live details remain evidence-bounded', () => {
  const primaryStart = js.indexOf("$('b-open-hoa-mai').onclick");
  const secondaryStart = js.indexOf("$('b-open-hoa-mai-actions').onclick");
  const primary = js.slice(primaryStart, secondaryStart);
  assert.match(primary, /\$\('a-text'\)\.scrollIntoView/);
  assert.match(primary, /\$\('a-text'\)\.focus/);
  assert.doesNotMatch(primary, /showModal/);
  assert.match(html, /Create an exchange with Hoa Mai/);
  assert.match(html, /id="hoa-mai-ai-details"/);
  assert.match(html, /the execution ID is not yet stored durably/);
  assert.match(html, /id="hoa-mai-ai-execution"/);
  assert.match(html, /id="hoa-mai-ai-route"/);
  assert.match(html, /id="hoa-mai-ai-usage"/);
  assert.match(js, /META_MUSE_SPARK_LIVE/);
  assert.match(js, /Validated · RI-SWAP Offer Assist/);
});

test('additional Meta utilities are visible, server-read, and fail-closed', () => {
  assert.match(html, /id="meta-utilities-more"/);
  assert.match(html, /data-en="Meta utilities"/);
  assert.doesNotMatch(html, /<details id="meta-utilities-more"/);
  assert.match(html, /id="product-image-status"/);
  assert.match(html, /id="voice-status"/);
  assert.match(html, /id="voice-transmission-consent"/);
  assert.match(html, /id="web-search-status"/);
  assert.match(js, /'\/api\/meta-utilities'/);
  assert.match(js, /registry is not proof of provider execution/i);
  assert.match(js, /PRIVATE_MEDIA_READY_PROCESSING_GATED/);
  assert.match(js, /EXIF\/GPS handling and SAM processing are not verified/);
  assert.match(html, /No image is sent/);
  assert.match(html, /no audio bytes are sent\./);
  assert.doesNotMatch(js, /getUserMedia|MediaRecorder|FileReader/);
});

test('Ask the system is an interactive product surface rather than a collapsed Help item', () => {
  assert.match(html, /<section id="knowledge-help" class="card knowledge-panel"/);
  assert.doesNotMatch(html, /<details id="knowledge-help"/);
  const openStart = js.indexOf("$('b-open-system').onclick");
  const openEnd = js.indexOf("$('b-toggle-demo').onclick");
  const handler = js.slice(openStart, openEnd);
  assert.match(handler, /scrollIntoView/);
  assert.match(handler, /\$\('k-question'\)\.focus/);
  assert.doesNotMatch(handler, /\.open\s*=/);
});

test('release identity is visible without making an unverified deployment claim', () => {
  assert.match(html, /id="release-identity"/);
  assert.match(html, /s016 revision 003 · UI correction 001/);
  assert.match(html, /visible-ai-s016-rev003-ui-dialog-001/);
  assert.match(html, /s014 → s015 → correction 001 → correction 002/);
  assert.match(html, /Verify the served build against its release receipt/);
  assert.doesNotMatch(html, /Local candidate · review required · not deployed/);
});

test('Hoa Mai Action Chat is roomy on desktop and viewport-bounded on mobile', () => {
  assert.match(css, /#hoa-mai-action-dialog\s*\{[^}]*width:\s*min\(880px, calc\(100vw - 2rem\)\)/s);
  assert.match(css, /#hoa-mai-action-dialog\s*\{[^}]*max-height:\s*calc\(100dvh - 2rem\)/s);
  assert.match(css, /\.hoa-mai-action-panel\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*#hoa-mai-action-dialog\s*\{[^}]*width:\s*calc\(100vw - 1rem\)/);
});

test('only Hoa Mai is presented as the Meta Model API entrypoint', () => {
  assert.match(html, /Only Hoa Mai Offer Assist can call the Meta Model API in this release/);
  assert.match(html, /AI never saves, opens an Offer, accepts, or creates an Agreement by itself/);
  assert.match(html, /Ask the system uses separate RI sources and does not call Meta/);
});

test('Action Chat binds only bounded existing navigation and draft controls', () => {
  for (const intent of ['offer', 'ri-yellow', 'donghanh', 'jobs', 'help', 'about', 'contact']) {
    assert.match(html, new RegExp(`value="${intent}"`));
  }
  assert.match(js, /No data has been sent to the server/);
  assert.match(js, /sign-in and confirmation are required before any database save/);
  assert.match(js, /navigation only/);
  assert.match(js, /no message was sent/);
  assert.doesNotMatch(js, /autoPublish|autoSend|submitApplication/);
});

test('DEMO examples are separately classified and never inserted into real offer state', () => {
  assert.equal((js.match(/id: 'DEMO-OFFER-/g) || []).length, 3);
  assert.equal((js.match(/id: 'DEMO-EXCHANGE-/g) || []).length, 2);
  assert.match(js, /dataset\.dataClass = 'DEMO'/);
  assert.match(html, /not in the real API\/DB/);
  assert.doesNotMatch(js, /state\.offers\.(push|unshift)\s*\(.*DEMO/s);
  assert.doesNotMatch(js, /api\([^\n]+DEMO-OFFER/);
});

test('DEMO completed exchanges state the Agreement Reached boundary', () => {
  assert.match(js, /Agreement Reached records agreement only/);
  assert.match(js, /does not prove delivery, payment, or fulfilment/);
});

test('initial static copy is English before JavaScript hydration', () => {
  const translatedTextNodes = [...html.matchAll(/<([a-z0-9]+)\b[^>]*\bdata-en="([^"]*)"[^>]*>([^<]*)</gi)];
  assert.ok(translatedTextNodes.length > 30);
  for (const [, tag, english, initial] of translatedTextNodes) {
    if (!initial.trim()) continue;
    assert.equal(initial.trim(), english.trim(), `${tag} initial text must equal data-en`);
  }
});

test('all visible DEMO offer and exchange examples have English source fields', () => {
  for (const phrase of [
    'Nutrition guidance for fresh herbs',
    'Bicycle repair for a weekend meal',
    'Upholstery assessment for product photography',
    'Direct proposal',
    'Revised proposal',
  ]) {
    assert.match(js, new RegExp(phrase));
  }
  assert.match(js, /tr\(record\.vi, record\.en\)/);
  assert.match(js, /`Give: \$\{record\.giveEn\}`/);
  assert.match(js, /`Receive: \$\{record\.receiveEn\}`/);
  assert.match(js, /record\.availabilityEn/);
  assert.match(js, /tr\(record\.pathVi, record\.pathEn\)/);
});

test('candidate includes mobile and keyboard target constraints', () => {
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 720px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\) auto auto/);
  assert.match(css, /overflow-x: hidden/);
  assert.match(js, /\.focus\(\)/);
  assert.match(html, /aria-live="polite"/);
});

test('candidate preserves core workflow and auth IDs', () => {
  for (const id of ['real-only-gate', 'workflow', 'b-draft', 'b-publish', 'b-propose', 'accept-confirm']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});
