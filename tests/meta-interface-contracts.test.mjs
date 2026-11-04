import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MEDIA_CONSENT_NOTICE,
  MEDIA_INTERFACE_MAX_BYTES,
  MEDIA_INTERFACE_VERSION,
  MEDIA_PROCESSING_STATES,
  UtilityInterfaceError,
  VOICE_CONSENT_NOTICE,
  VOICE_INTERFACE_MAX_BYTES,
  VOICE_INTERFACE_VERSION,
  buildMediaUploadContract,
  buildVoiceTranscriptionContract,
  parseMediaUploadResponse,
  parseVoiceTranscriptionResponse,
  safeUtilityError,
} from '../src/meta-interface-contracts.mjs';
import { imageUiState, voiceUiState } from '../public/meta-utility-ui-state.js';

const mediaConsent = { granted: true, purpose: 'PRODUCT_IMAGE_UPLOAD', notice_version: MEDIA_CONSENT_NOTICE };
const voiceConsent = { granted: true, purpose: 'VOICE_TRANSCRIPTION', notice_version: VOICE_CONSENT_NOTICE };

test('media contract is authenticated, bounded and retention-fail-closed', () => {
  const out = buildMediaUploadContract({ offer_id: 'offer-1', file: { name: '../photo.jpg', type: 'image/jpeg', size: 1234 }, consent_state: mediaConsent });
  assert.equal(out.schema, MEDIA_INTERFACE_VERSION);
  assert.equal(out.route, '/api/offers/offer-1/media');
  assert.equal(out.authenticated, true);
  assert.equal(out.metadata.name, 'photo.jpg');
  assert.equal(out.privacy.exif_gps, 'STRIP_SERVER_SIDE_OR_REJECT');
  assert.equal(out.privacy.retention, 'UNBOUND_REJECT_UPLOAD');
});

test('media contract rejects missing consent, unsupported type and oversize metadata before bytes send', () => {
  assert.throws(() => buildMediaUploadContract({ offer_id: 'o', file: { name: 'x.jpg', type: 'image/jpeg', size: 1 } }), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => buildMediaUploadContract({ offer_id: 'o', file: { name: 'x.svg', type: 'image/svg+xml', size: 1 }, consent_state: mediaConsent }), { code: 'MEDIA_TYPE_NOT_SUPPORTED' });
  assert.throws(() => buildMediaUploadContract({ offer_id: 'o', file: { name: 'x.jpg', type: 'image/jpeg', size: MEDIA_INTERFACE_MAX_BYTES + 1 }, consent_state: mediaConsent }), { code: 'MEDIA_TOO_LARGE' });
});

test('media response parser accepts only the frozen safe projection', () => {
  const out = parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/preview/1', processing: 'NOT_RUN' });
  assert.deepEqual(out, { schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/preview/1', processing: 'NOT_RUN' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'PUBLIC', media_scope_id: 'scope-1' }), { code: 'MEDIA_RESPONSE_STATUS_INVALID' });
  assert.ok(Object.isFrozen(MEDIA_PROCESSING_STATES));
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: 'javascript:alert(1)' }), { code: 'MEDIA_PREVIEW_INVALID' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: 'https://user:pass@media.example/private/1' }, { approved_preview_origins: ['https://media.example'] }), { code: 'MEDIA_PREVIEW_INVALID' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: 'https://media.example/private/1' }, { approved_preview_origins: ['https://other.example'] }), { code: 'MEDIA_PREVIEW_ORIGIN_NOT_APPROVED' });
  assert.equal(parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: 'https://media.example/private/1' }, { approved_preview_origins: ['https://media.example/path-is-ignored'] }).preview_url, 'https://media.example/private/1');
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: 'https://media.example/private/1', approved_preview_origins: ['https://media.example'] }), { code: 'MEDIA_PREVIEW_ORIGIN_NOT_APPROVED' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/one\u0000two' }), { code: 'MEDIA_PREVIEW_INVALID' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/../secret' }), { code: 'MEDIA_PREVIEW_INVALID' });
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/%2e%2e/secret' }), { code: 'MEDIA_PREVIEW_INVALID' });
  assert.equal(parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', preview_url: '/private/a/./b?size=small' }).preview_url, '/private/a/b?size=small');
  assert.throws(() => parseMediaUploadResponse({ schema: MEDIA_INTERFACE_VERSION, status: 'REVIEW_REQUIRED', media_scope_id: 'scope-1', processing: 'ARBITRARY' }), { code: 'MEDIA_PROCESSING_INVALID' });
});

test('voice contract is authenticated, bounded, consent-scoped and edit-before-send', () => {
  const out = buildVoiceTranscriptionContract({ audio: { name: 'note.webm', type: 'audio/webm', size: 2048 }, language: 'vi', consent_state: voiceConsent });
  assert.equal(out.schema, VOICE_INTERFACE_VERSION);
  assert.equal(out.route, '/api/voice/transcribe');
  assert.equal(out.authenticated, true);
  assert.equal(out.retention.audio, 'NO_SERVER_RETENTION_AFTER_TRANSCRIPTION');
  assert.equal(out.retention.transcript, 'EDITABLE_UNSAVED');
});

test('voice contract rejects no consent, unsupported audio and oversize metadata', () => {
  assert.throws(() => buildVoiceTranscriptionContract({ audio: { name: 'x.webm', type: 'audio/webm', size: 1 } }), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => buildVoiceTranscriptionContract({ audio: { name: 'x.bin', type: 'application/octet-stream', size: 1 }, consent_state: voiceConsent }), { code: 'VOICE_TYPE_NOT_SUPPORTED' });
  assert.throws(() => buildVoiceTranscriptionContract({ audio: { name: 'x.webm', type: 'audio/webm', size: VOICE_INTERFACE_MAX_BYTES + 1 }, consent_state: voiceConsent }), { code: 'VOICE_TOO_LARGE' });
});

test('voice parser yields editable text and rejects non-transcribed states', () => {
  const out = parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'TRANSCRIBED', transcript: 'Tôi cần sửa xe.', language: 'vi', execution_id: 'exec-1' });
  assert.equal(out.transcript, 'Tôi cần sửa xe.');
  assert.equal(out.execution_id, 'exec-1');
  assert.throws(() => parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'QUEUED', transcript: 'x' }), { code: 'VOICE_RESPONSE_STATUS_INVALID' });
  assert.equal(parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'TRANSCRIBED', transcript: 'Safe', language: 'en', execution_id: 'bad id with spaces' }).execution_id, null);
  assert.equal(parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'TRANSCRIBED', transcript: 'Safe', language: 'en', execution_id: 'Bearer:secret/value' }).execution_id, null);
  assert.equal(parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'TRANSCRIBED', transcript: 'Safe', language: 'en', execution_id: 'token_ABC123' }).execution_id, null);
  assert.equal(parseVoiceTranscriptionResponse({ schema: VOICE_INTERFACE_VERSION, status: 'TRANSCRIBED', transcript: 'Safe', language: 'en', execution_id: 'sk_live_ABC123' }).execution_id, null);
});

test('unavailable UI states cannot select, record or send', () => {
  assert.equal(imageUiState({ selected: true, consent: true }), 'UNAVAILABLE');
  assert.equal(voiceUiState({ permission: true, recording: true, transcript: 'x' }), 'UNAVAILABLE');
  assert.equal(imageUiState({ available: true, selected: true, previewed: false, consent: false }), 'LOCAL_PREVIEW');
  assert.equal(imageUiState({ available: true, selected: true, previewed: true, consent: false }), 'CONSENT_REQUIRED');
  assert.equal(voiceUiState({ available: true, permission: true, transcript: '' }), 'EDIT_TRANSCRIPT');
  assert.equal(voiceUiState({ available: true, permission: true, transcript: 'editable' }), 'CONSENT_REQUIRED');
  assert.equal(voiceUiState({ available: true, permission: true, transcript: 'editable', transmissionConsent: true }), 'READY_TO_SEND');
  assert.equal(voiceUiState({ available: true, permission: true, transcript: '\u0000unsafe', transmissionConsent: true }), 'ERROR');
});

test('safe errors never echo raw provider messages or secrets', () => {
  const error = new UtilityInterfaceError('PROVIDER_UNAVAILABLE', 'Bearer secret-token upstream stack');
  assert.deepEqual(safeUtilityError(error), { code: 'PROVIDER_UNAVAILABLE', message: 'The service is unavailable. Nothing was sent again automatically.' });
  assert.doesNotMatch(safeUtilityError(error).message, /secret-token|Bearer|stack/);
});
