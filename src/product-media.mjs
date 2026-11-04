// Product-media intake for RI-SWAP offers. PROTOTYPE / OFFLINE.
// Bytes in, validated media record out. Camera capture and file upload share
// this intake: the browser only sends bytes, the server validates and stores.
// Node stdlib only. No EXIF handling: phone photos may carry GPS tags, so a
// strip-or-warn decision is REQUIRED before any non-local use (see docs/07).
// Pattern adapted from the MUSE-INPUT-ADAPTER lane (own work, not a copy of
// any governed source).
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;
export const MEDIA_IMAGE_MIMES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MEDIA_DOC_MIMES = Object.freeze(['application/pdf']);

const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' };
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class MediaError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
  }
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function sniffMime(bytes) {
  const b = Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const head = b.subarray(0, 6).toString('ascii');
    if (head === 'GIF89a' || head === 'GIF87a') return 'image/gif';
  }
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (b.length >= 5 && b.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}

export function readPngDims(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 24) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'truncated PNG');
  if (!b.subarray(0, 8).equals(PNG_SIG) || b.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new MediaError('MEDIA_DIMS_UNREADABLE', 'bad PNG signature/IHDR');
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export function readGifDims(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 10) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'truncated GIF');
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

export function readJpegDims(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'not a JPEG stream');
  let pos = 2;
  while (pos + 2 <= b.length) {
    if (b[pos] !== 0xff) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'broken JPEG marker');
    const marker = b[pos + 1];
    if (marker === 0xd9) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (pos + 4 > b.length) break;
    const len = b.readUInt16BE(pos + 2);
    if (len < 2 || pos + 2 + len > b.length) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'broken JPEG segment');
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (len < 7) throw new MediaError('MEDIA_DIMS_UNREADABLE', 'broken JPEG SOF');
      return { width: b.readUInt16BE(pos + 7), height: b.readUInt16BE(pos + 5) };
    }
    pos += 2 + len;
  }
  throw new MediaError('MEDIA_DIMS_UNREADABLE', 'no JPEG SOF segment found');
}

export function sanitizeLabel(name) {
  const base = basename(String(name || '')).trim();
  if (!base || base === '.' || base === '..' || base.length > 128) {
    throw new MediaError('MEDIA_BAD_FILENAME', 'filename is not usable as a label');
  }
  return base;
}

export function createMediaStore(storeDir) {
  if (!storeDir) throw new MediaError('MEDIA_STORE_MISSING', 'storeDir required');
  mkdirSync(storeDir, { recursive: true });
  function put(bytes, mime) {
    const hash = sha256Hex(Buffer.from(bytes));
    const file = `${hash}${MIME_EXT[mime] || '.bin'}`;
    const full = join(storeDir, file);
    if (!existsSync(full)) writeFileSync(full, bytes);
    return { sha256: hash, stored_ref: `media/${file}` };
  }
  function get(storedRef) {
    const rel = String(storedRef || '').replace(/^media\//, '');
    if (!rel || rel.includes('..') || rel.includes('/') || rel.includes('\\')) {
      throw new MediaError('MEDIA_BAD_REF', 'stored_ref is not valid');
    }
    try {
      return readFileSync(join(storeDir, rel));
    } catch {
      throw new MediaError('MEDIA_NOT_FOUND', 'stored bytes are missing');
    }
  }
  return { put, get, dir: storeDir };
}

export function intakeProductMedia(bytes, { filename = '', store = null, maxBytes = MEDIA_MAX_BYTES } = {}) {
  const buf = Buffer.from(bytes || []);
  if (!buf.length) throw new MediaError('MEDIA_EMPTY_INPUT', 'no bytes received');
  if (buf.length > maxBytes) throw new MediaError('MEDIA_TOO_LARGE', `bytes exceed the ${maxBytes} limit`);
  const mime = sniffMime(buf);
  const isImage = MEDIA_IMAGE_MIMES.includes(mime);
  const isDoc = MEDIA_DOC_MIMES.includes(mime);
  if (!isImage && !isDoc) throw new MediaError('MEDIA_TYPE_NOT_SUPPORTED', `detected ${mime}; only product images and PDF are accepted`);
  let width = null;
  let height = null;
  let dims_status = 'DOCUMENT';
  if (isImage) {
    if (mime === 'image/png') ({ width, height } = readPngDims(buf));
    else if (mime === 'image/gif') ({ width, height } = readGifDims(buf));
    else if (mime === 'image/jpeg') ({ width, height } = readJpegDims(buf));
    dims_status = (mime === 'image/webp') ? 'NOT_AVAILABLE' : 'READ';
  }
  const sha256 = sha256Hex(buf);
  let stored_ref = null;
  if (store) stored_ref = store.put(buf, mime).stored_ref;
  return {
    media_id: `med-${sha256.slice(0, 16)}`,
    sha256,
    mime,
    kind: isImage ? 'image' : 'document',
    size_bytes: buf.length,
    width,
    height,
    dims_status,
    filename: sanitizeLabel(filename || `upload${MIME_EXT[mime]}`),
    stored_ref,
  };
}