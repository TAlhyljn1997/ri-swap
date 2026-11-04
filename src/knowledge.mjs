// Read-only loader for the latest delivered RI-SWAP local app knowledge candidate made by RKB-HOD.
// Status of that file stays APP_LOCAL_CANDIDATE: this module does not make it KO_ACTIVE and is NOT an RI-KOS connection.
// Public text is withheld unless the bound KB, sources, review and publication decision all qualify.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_KB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'ri-swap-app-kb.v0.1.1.json');
const DEFAULT_BINDING = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge', 'runtime-source-binding.v0.2.0.json');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const sha256File = path => sha256(readFileSync(path));
const norm = s => String(s ?? '').toLowerCase().normalize('NFC').trim();
const readJson = path => {
  if (!path) return null;
  try {
    const bytes = readFileSync(path);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) };
  } catch { return null; }
};

export function createKnowledge({ kbPath = DEFAULT_KB, bindingPath = kbPath === DEFAULT_KB ? DEFAULT_BINDING : null } = {}) {
  const base = dirname(kbPath);

  function sourceCheck(kb, bindingMatched, binding) {
    if (!kb) return { state: 'KB_UNAVAILABLE', sources: {} };
    if (!bindingMatched) return { state: 'BINDING_HASH_MISMATCH', sources: {} };
    const refs = binding.source_refs;
    const kbRefs = kb.source_refs;
    if (!refs || typeof refs !== 'object' || Array.isArray(refs) || !kbRefs || typeof kbRefs !== 'object' || Array.isArray(kbRefs)) return { state: 'STALE', sources: {} };
    const names = Object.keys(kbRefs);
    if (names.length === 0 || names.length !== Object.keys(refs).length || names.some(name => refs[name]?.path !== kbRefs[name]?.path || String(refs[name]?.sha256).toUpperCase() !== String(kbRefs[name]?.sha256).toUpperCase())) return { state: 'STALE', sources: {} };
    const sources = {};
    for (const [name, ref] of Object.entries(refs)) {
      let state;
      try { state = sha256File(resolve(base, ref.path)) === String(ref.sha256).toUpperCase() ? 'MATCH' : 'CHANGED'; } catch { state = 'MISSING'; }
      sources[name] = state;
    }
    const stale = Object.values(sources).some(v => v !== 'MATCH');
    return { state: stale ? 'STALE' : 'CURRENT', sources };
  }

  // Re-read both files and every source for each call. A previous eligible result is never cached.
  function snapshot() {
    const kbFile = readJson(kbPath);
    const kb = kbFile?.value && typeof kbFile.value === 'object' && !Array.isArray(kbFile.value) && Array.isArray(kbFile.value.entries) ? kbFile.value : null;
    const bindingFile = readJson(bindingPath);
    const binding = bindingFile?.value && typeof bindingFile.value === 'object' && !Array.isArray(bindingFile.value) ? bindingFile.value : null;
    const bindingMatched = Boolean(kb && binding && sha256(kbFile.bytes) === String(binding.kb_sha256 || '').toUpperCase());
    const check = sourceCheck(kb, bindingMatched, binding);
    const reason = !kb ? 'KB_UNAVAILABLE'
      : !bindingMatched ? 'BINDING_HASH_MISMATCH'
        : check.state !== 'CURRENT' ? 'SOURCE_NOT_CURRENT'
          : kb.review?.independent_semantic_review !== 'PASS' ? 'INDEPENDENT_REVIEW_NOT_PASSED'
            : kb.review?.human_publication_decision !== 'APPROVED' ? 'HUMAN_PUBLICATION_NOT_APPROVED'
              : kb.publication?.public_serving_authorized !== true ? 'PUBLIC_SERVING_NOT_AUTHORIZED' : null;
    return { kb, binding, bindingMatched, check, reason };
  }

  function describeSnapshot({ kb, binding, bindingMatched, check, reason }) {
    return {
      available: Boolean(kb), schema: kb?.schema ?? null, version: kb?.version ?? null, app_id: kb?.app_id ?? null,
      file_status: kb?.status ?? null, tenant_id: kb?.tenant_id ?? null,
      provenance: 'RKB_HOD_LOCAL_JSON_CANDIDATE',
      runtime_binding: bindingMatched ? (binding.status ?? 'MATCH') : (binding ? 'BINDING_HASH_MISMATCH' : 'NOT_PRESENT'),
      ri_kos: 'NOT_CONNECTED', ko_active: false,
      source_check: check.state, sources: check.sources,
      topics: kb ? [...new Set(kb.entries.map(e => e.topic_id))] : [], entries: kb?.entries.length ?? 0,
      public_content_eligible: !reason, withholding_reason: reason,
      note: 'RKB-HOD local candidate read from disk with an additive runtime source binding. Not RI-KOS-served and not KO_ACTIVE.',
    };
  }

  function describe() { return describeSnapshot(snapshot()); }

  function entries({ lang } = {}) {
    const current = snapshot();
    const list = current.reason ? [] : current.kb.entries.filter(e => !lang || e.lang === lang);
    return { ...describeSnapshot(current), entries_list: list.map(e => ({ id: e.id, topic_id: e.topic_id, lang: e.lang, text: e.text, source_refs: e.source_refs })), abstain: current.reason };
  }

  function answer(query, lang) {
    const current = snapshot();
    const { kb, check, reason } = current;
    if (reason) return { answer: null, abstain: reason, source_check: check.state, sources: check.sources };
    lang ??= kb.language_default ?? 'vi';
    const q = norm(query);
    if (!q || q.length > 300) return { answer: null, abstain: 'QUERY_INVALID', source_check: check.state };
    let best = null; let bestScore = 0;
    for (const e of kb.entries.filter(x => x.lang === lang)) {
      const score = e.keywords.reduce((n, k) => n + (q.includes(norm(k)) ? norm(k).length : 0), 0);
      if (score > bestScore) { best = e; bestScore = score; }
    }
    if (!best) return { answer: null, abstain: kb.answer_policy?.on_unknown_commercial_or_legal_terms ?? 'STATE_UNKNOWN_AND_REFER_TO_HUMAN_OWNER', source_check: check.state };
    return { answer: best.text, entry_id: best.id, topic_id: best.topic_id, lang: best.lang, source_refs: best.source_refs, source_check: check.state, ri_kos: 'NOT_CONNECTED', candidate_only: true };
  }

  return { describe, entries, answer };
}
