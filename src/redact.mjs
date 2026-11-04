// Bounded PII/secret redaction used before Meta-bound input, logs, and receipts.
// This is a safety filter, not a claim that arbitrary free text is anonymised.

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const AU_PHONE = /(?<!\w)(?:\+?61\s*(?:\(?0?\d\)?|\d)|0\d)(?:[\s().-]*\d){7,9}(?!\w)/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const ASSIGNMENT_SECRET = /\b(api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|private[-_ ]?key|password|passcode|otp)\s*[:=]\s*([^\s,;]+)/gi;

const SECRET_KEYS = /^(?:api[-_]?key|access[-_]?token|authorization|client[-_]?secret|private[-_]?key|password|passcode|otp|code)$/i;

export function redactText(value) {
  return String(value ?? '')
    .replace(BEARER, 'Bearer [REDACTED_SECRET]')
    .replace(ASSIGNMENT_SECRET, (_all, key) => `${key}=[REDACTED_SECRET]`)
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(AU_PHONE, '[REDACTED_PHONE]');
}

export function containsSensitive(value) {
  const source = String(value ?? '');
  return redactText(source) !== source || /\b(?:card number|cvv?|mật khẩu|mat khau|one[- ]time password)\b/i.test(source);
}

export function redactNested(value, { maxDepth = 8 } = {}) {
  const seen = new WeakSet();
  const visit = (item, depth, key = '') => {
    if (SECRET_KEYS.test(key)) return '[REDACTED_SECRET]';
    if (typeof item === 'string') return redactText(item);
    if (item === null || typeof item !== 'object') return item;
    if (depth >= maxDepth) return '[REDACTED_MAX_DEPTH]';
    if (seen.has(item)) return '[REDACTED_CYCLE]';
    seen.add(item);
    if (Array.isArray(item)) return item.map(entry => visit(entry, depth + 1));
    return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, depth + 1, childKey)]));
  };
  return visit(value, 0);
}

