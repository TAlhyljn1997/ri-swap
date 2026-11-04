import { basename } from 'node:path';
import { cleanExecutionId } from './meta-client.mjs';

export const MEDIA_INTERFACE_VERSION = 'ri.swap.media-interface.v1';
export const VOICE_INTERFACE_VERSION = 'ri.swap.voice-interface.v1';
export const MEDIA_CONSENT_NOTICE = 'ri-swap-media-consent-v1';
export const VOICE_CONSENT_NOTICE = 'ri-swap-voice-consent-v1';
export const MEDIA_INTERFACE_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_INTERFACE_MAX_BYTES = 25 * 1024 * 1024;
export const MEDIA_INTERFACE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const VOICE_INTERFACE_MIMES = Object.freeze(['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg']);
export const MEDIA_PROCESSING_STATES = Object.freeze(['NOT_RUN', 'SAM_PENDING', 'SAM_COMPLETE', 'REVIEW_REQUIRED']);

export class UtilityInterfaceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'UtilityInterfaceError';
    this.code = code;
  }
}

const text = (value, max, code) => {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > max) throw new UtilityInterfaceError(code);
  return out;
};

function consent(value, { purpose, notice }) {
  if (!value || value.granted !== true) throw new UtilityInterfaceError('CONSENT_REQUIRED');
  if (value.purpose !== purpose || value.notice_version !== notice) {
    throw new UtilityInterfaceError('CONSENT_SCOPE_MISMATCH');
  }
  return Object.freeze({ granted: true, purpose, notice_version: notice });
}

function fileMetadata(file, { allowed, maxBytes, prefix }) {
  const name = basename(text(file?.name, 128, `${prefix}_BAD_FILENAME`));
  const mime = text(file?.type, 80, `${prefix}_BAD_TYPE`).toLowerCase();
  const size = Number(file?.size);
  if (!allowed.includes(mime)) throw new UtilityInterfaceError(`${prefix}_TYPE_NOT_SUPPORTED`);
  if (!Number.isSafeInteger(size) || size <= 0) throw new UtilityInterfaceError(`${prefix}_EMPTY_INPUT`);
  if (size > maxBytes) throw new UtilityInterfaceError(`${prefix}_TOO_LARGE`);
  return Object.freeze({ name, mime, size_bytes: size });
}

export function buildMediaUploadContract({ offer_id, file, consent_state } = {}) {
  const offerId = text(offer_id, 160, 'MEDIA_OFFER_REQUIRED');
  const metadata = fileMetadata(file, {
    allowed: MEDIA_INTERFACE_MIMES,
    maxBytes: MEDIA_INTERFACE_MAX_BYTES,
    prefix: 'MEDIA',
  });
  return Object.freeze({
    schema: MEDIA_INTERFACE_VERSION,
    method: 'POST',
    route: `/api/offers/${encodeURIComponent(offerId)}/media`,
    authenticated: true,
    metadata,
    consent: consent(consent_state, { purpose: 'PRODUCT_IMAGE_UPLOAD', notice: MEDIA_CONSENT_NOTICE }),
    privacy: Object.freeze({ exif_gps: 'STRIP_SERVER_SIDE_OR_REJECT', retention: 'UNBOUND_REJECT_UPLOAD' }),
  });
}

export function parseMediaUploadResponse(value, { approved_preview_origins = [] } = {}) {
  if (!value || value.schema !== MEDIA_INTERFACE_VERSION) throw new UtilityInterfaceError('MEDIA_RESPONSE_SCHEMA_INVALID');
  const status = text(value.status, 40, 'MEDIA_RESPONSE_STATUS_INVALID');
  if (!['STORED_PRIVATE', 'PROCESSING', 'REVIEW_REQUIRED'].includes(status)) {
    throw new UtilityInterfaceError('MEDIA_RESPONSE_STATUS_INVALID');
  }
  const previewUrl = value.preview_url == null ? null : privatePreviewUrl(value.preview_url, approved_preview_origins);
  const processing = value.processing == null ? 'NOT_RUN' : text(value.processing, 80, 'MEDIA_PROCESSING_INVALID');
  if (!MEDIA_PROCESSING_STATES.includes(processing)) throw new UtilityInterfaceError('MEDIA_PROCESSING_INVALID');
  return Object.freeze({
    schema: MEDIA_INTERFACE_VERSION,
    status,
    media_scope_id: text(value.media_scope_id, 180, 'MEDIA_RESPONSE_ID_INVALID'),
    preview_url: previewUrl,
    processing,
  });
}

function privatePreviewUrl(value, approvedOrigins = []) {
  const raw = text(value, 500, 'MEDIA_PREVIEW_INVALID');
  if (/[\u0000-\u001F\u007F\\]/.test(raw)) throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID');
  if (raw.startsWith('/')) {
    if (raw.startsWith('//') || /%(?:2e|2f|5c)/i.test(raw)) throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID');
    let relative;
    try { relative = new URL(raw, 'https://private.invalid'); } catch { throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID'); }
    if (relative.origin !== 'https://private.invalid' || relative.hash || !relative.pathname.startsWith('/private/')) {
      throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID');
    }
    return `${relative.pathname}${relative.search}`;
  }
  let parsed;
  try { parsed = new URL(raw); } catch { throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new UtilityInterfaceError('MEDIA_PREVIEW_INVALID');
  }
  const origins = Array.isArray(approvedOrigins)
    ? approvedOrigins.filter(origin => typeof origin === 'string').map(origin => {
      try { return new URL(origin).origin; } catch { return null; }
    }).filter(Boolean)
    : [];
  if (!origins.includes(parsed.origin)) throw new UtilityInterfaceError('MEDIA_PREVIEW_ORIGIN_NOT_APPROVED');
  return parsed.href;
}

export function buildVoiceTranscriptionContract({ audio, language = 'auto', consent_state } = {}) {
  const metadata = fileMetadata(audio, {
    allowed: VOICE_INTERFACE_MIMES,
    maxBytes: VOICE_INTERFACE_MAX_BYTES,
    prefix: 'VOICE',
  });
  const lang = ['auto', 'en', 'vi'].includes(language) ? language : null;
  if (!lang) throw new UtilityInterfaceError('VOICE_LANGUAGE_INVALID');
  return Object.freeze({
    schema: VOICE_INTERFACE_VERSION,
    method: 'POST',
    route: '/api/voice/transcribe',
    authenticated: true,
    metadata,
    language: lang,
    consent: consent(consent_state, { purpose: 'VOICE_TRANSCRIPTION', notice: VOICE_CONSENT_NOTICE }),
    retention: Object.freeze({ audio: 'NO_SERVER_RETENTION_AFTER_TRANSCRIPTION', transcript: 'EDITABLE_UNSAVED' }),
  });
}

export function parseVoiceTranscriptionResponse(value) {
  if (!value || value.schema !== VOICE_INTERFACE_VERSION) throw new UtilityInterfaceError('VOICE_RESPONSE_SCHEMA_INVALID');
  return Object.freeze({
    schema: VOICE_INTERFACE_VERSION,
    status: value.status === 'TRANSCRIBED' ? 'TRANSCRIBED' : (() => { throw new UtilityInterfaceError('VOICE_RESPONSE_STATUS_INVALID'); })(),
    transcript: text(value.transcript, 8000, 'VOICE_TRANSCRIPT_INVALID'),
    language: ['en', 'vi', 'und'].includes(value.language) ? value.language : 'und',
    execution_id: value.execution_id == null ? null : cleanExecutionId(value.execution_id),
  });
}

const SAFE_ERRORS = Object.freeze({
  CONSENT_REQUIRED: 'Review and accept the consent notice before continuing.',
  CONSENT_SCOPE_MISMATCH: 'Consent does not match this action. Review the current notice.',
  MEDIA_TOO_LARGE: 'The selected image is too large.',
  MEDIA_TYPE_NOT_SUPPORTED: 'Choose a supported image format.',
  VOICE_TOO_LARGE: 'The recording is too large.',
  VOICE_TYPE_NOT_SUPPORTED: 'Choose a supported audio format.',
  PROVIDER_UNAVAILABLE: 'The service is unavailable. Nothing was sent again automatically.',
});

export function safeUtilityError(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : 'UTILITY_FAILED';
  return Object.freeze({ code, message: SAFE_ERRORS[code] || 'This utility could not complete. Review the input and try again.' });
}
