// Stable, source-separated informational envelope for Hoa Mai / RI-SWAP.
// Sources cannot create transactions or collapse into one unsupported answer.
export class AssistEnvelopeError extends Error {
  constructor(code, message = code) { super(message); this.name = 'AssistEnvelopeError'; this.code = code; }
}

const VALID_SOURCE_STATUS = new Set(['RETURNED', 'NOT_CONNECTED', 'NOT_CALLED', 'UNAVAILABLE', 'NO_ELIGIBLE_SOURCE', 'SKIPPED']);
const freezeSource = (name, source = {}) => {
  if (!VALID_SOURCE_STATUS.has(source.status)) throw new AssistEnvelopeError('ASSIST_SOURCE_STATUS_INVALID', `${name} status invalid`);
  return Object.freeze({ name, status: source.status, ...(source.answer === undefined ? {} : { answer: String(source.answer) }), ...(source.citations === undefined ? {} : { citations: Object.freeze([...source.citations]) }) });
};

export function createAssistEnvelope({ query, language = 'en', sources = {}, observed_at = new Date().toISOString() } = {}) {
  const text = String(query || '').trim();
  if (!text || text.length > 600) throw new AssistEnvelopeError('ASSIST_QUERY_INVALID');
  const envelope = {
    schema: 'ri.swap.assist.source-separated.v1',
    mode: 'INFORMATION_ONLY',
    query: text,
    language: language === 'vi' ? 'vi' : 'en',
    sources: Object.freeze([
      freezeSource('RI_SWAP_LOCAL_KB', sources.local ?? { status: 'NOT_CALLED' }),
      freezeSource('RI_KOS', sources.kos ?? { status: 'NOT_CONNECTED' }),
      freezeSource('RI_BCA', sources.bca ?? { status: 'NOT_CONNECTED' }),
      freezeSource('META_MUSE_SPARK', sources.meta ?? { status: 'NOT_CONNECTED' }),
    ]),
    observed_at,
    may_create_transaction: false,
    human_decides: true,
    verified_outcome: false,
  };
  return Object.freeze(envelope);
}

