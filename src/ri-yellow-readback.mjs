// Validates one already-read RI-YELLOW directory result without converting a
// listing into ownership or transaction authority.
export class RiYellowReadbackError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RiYellowReadbackError'; this.code = code; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildRiYellowReadback(result, { observed_at = new Date().toISOString() } = {}) {
  if (!result || result.ri_yellow_connected !== true || result.business_found !== true) {
    throw new RiYellowReadbackError('RI_YELLOW_READBACK_UNAVAILABLE');
  }
  if (!UUID.test(String(result.business_id || '')) || result.listing_state !== 'PUBLISHED') {
    throw new RiYellowReadbackError('RI_YELLOW_READBACK_INVALID');
  }
  return Object.freeze({
    schema: 'ri.swap.ri-yellow.readback.v1',
    source: 'RI_YELLOW_READ_ONLY_DIRECTORY',
    observed_at,
    business_id: result.business_id,
    trading_name: String(result.trading_name || ''),
    listing_state: result.listing_state,
    record_status: result.record_status ?? null,
    evidence_state: result.evidence_state ?? null,
    source_readback_validated: true,
    ownership_verified: false,
    eligible_to_transact: false,
    authority_note: 'A published listing is not proof that the signed-in person owns or may act for the business.',
  });
}

