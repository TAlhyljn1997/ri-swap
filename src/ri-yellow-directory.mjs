// RI-YELLOW read-only directory adapter. Server-side only; the browser never sees the connection string.
// Reads ONE narrow view: ri_swap_read.directory_reader_projection. Every query runs in a READ ONLY transaction.
// Variable: RI_YELLOW_DATABASE_URL (a read role). Never WRITE_DATABASE_URL. The URL is never logged or returned.
// A found business proves a PUBLISHED listing exists. It does NOT prove the logged-in user owns it, so
// ownership_verified and eligible_to_transact are always false until account-to-business linking exists.
export const EXPECTED_DATABASE = 'ri_yellow';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DIRECTORY_SQL = `SELECT business_id, trading_name, primary_category, suburb,
       listing_state, record_status, publication_eligible,
       evidence_state, last_human_reviewed_at
FROM ri_swap_read.directory_reader_projection
WHERE business_id = $1
  AND publication_eligible = true
  AND listing_state = 'PUBLISHED'`;

const AU_STATES = new Set(['NSW', 'VIC', 'QLD', 'WA', 'SA', 'ACT', 'TAS', 'NT']);

export class RiYellowError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RiYellowError';
    this.code = code;
  }
}

// `pool` may be injected (tests). Otherwise it is created lazily from the env URL, and `pg` is imported only then.
export function createRiYellowDirectory({ env = process.env, pool: injected, fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  const url = env.RI_YELLOW_DATABASE_URL;
  const publicBaseUrl = String(env.RI_YELLOW_PUBLIC_URL || 'https://ri-ecosys.org/ri-yellow').replace(/\/$/, '');
  const configured = Boolean(injected) || (typeof url === 'string' && url.length > 0);
  let pool = injected;
  let liveVerified = false;

  async function getPool() {
    if (pool) return pool;
    try {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs, query_timeout: timeoutMs });
      pool.on?.('error', () => {}); // idle-client errors must not crash the server or print the URL
      return pool;
    } catch {
      throw new RiYellowError('RI_YELLOW_UNAVAILABLE', 'RI-YELLOW directory is unavailable');
    }
  }

  // Runs fn(client) inside BEGIN READ ONLY ... ROLLBACK. Any driver failure becomes RI_YELLOW_UNAVAILABLE with no detail.
  async function readOnly(fn) {
    if (!configured) throw new RiYellowError('RI_YELLOW_NOT_CONFIGURED', 'RI_YELLOW_DATABASE_URL is not set; no database call was made');
    let client;
    try {
      client = await (await getPool()).connect();
      await client.query('BEGIN READ ONLY');
      const out = await fn(client);
      await client.query('ROLLBACK');
      return out;
    } catch (e) {
      try { await client?.query('ROLLBACK'); } catch { /* ignore */ }
      if (e instanceof RiYellowError) throw e;
      throw new RiYellowError('RI_YELLOW_UNAVAILABLE', 'RI-YELLOW directory is unavailable');
    } finally {
      try { client?.release(); } catch { /* ignore */ }
    }
  }

  async function lookupBusiness(businessId) {
    if (typeof businessId !== 'string' || !UUID.test(businessId)) throw new RiYellowError('BUSINESS_ID_INVALID', 'business_id must be a UUID');
    const rows = await readOnly(async c => (await c.query(DIRECTORY_SQL, [businessId.toLowerCase()])).rows);
    if (rows.length !== 1) throw new RiYellowError('NOT_PUBLISHED_OR_NOT_FOUND', 'no published RI-YELLOW listing for this business_id');
    const r = rows[0];
    return {
      ri_yellow_connected: true, business_found: true,
      business_id: r.business_id, trading_name: r.trading_name, primary_category: r.primary_category, suburb: r.suburb,
      listing_state: r.listing_state, record_status: r.record_status, evidence_state: r.evidence_state,
      last_human_reviewed_at: r.last_human_reviewed_at instanceof Date ? r.last_human_reviewed_at.toISOString() : (r.last_human_reviewed_at ?? null),
      ownership_verified: false, eligible_to_transact: false,
      note: 'A listing exists. It does not prove the signed-in user owns this business.',
    };
  }

  async function listSuburbs(state = 'NSW') {
    const stateCode = String(state).toUpperCase();
    if (!AU_STATES.has(stateCode)) throw new RiYellowError('STATE_INVALID', 'state must be an Australian state or territory code');
    try {
      const response = await fetchImpl(`${publicBaseUrl}/api/suburbs?state=${encodeURIComponent(stateCode)}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error('RI-YELLOW public API rejected the request');
      const payload = await response.json();
      if (!Array.isArray(payload?.suburbs)) throw new Error('RI-YELLOW public API returned an invalid response');
      return {
        ri_yellow_connected: true,
        state: stateCode,
        source: 'RI_YELLOW_PUBLIC_API',
        suburbs: payload.suburbs.map(row => ({ suburb: String(row.suburb), published_count: Number(row.published_count) })),
      };
    } catch (error) {
      if (error instanceof RiYellowError) throw error;
      throw new RiYellowError('RI_YELLOW_UNAVAILABLE', 'RI-YELLOW location API is unavailable');
    }
  }

  // Acceptance probe: right database, read-only transaction. Does not prove the role lacks write grants.
  async function selfCheck() {
    const r = await readOnly(async c => (await c.query("SELECT current_database() AS db, current_setting('transaction_read_only') AS ro")).rows[0]);
    liveVerified = r.db === EXPECTED_DATABASE && r.ro === 'on';
    return { database: r.db, transaction_read_only: r.ro, ok: liveVerified };
  }

  const status = () => ({ configured, source: 'POSTGRES_READ_ONLY', database: EXPECTED_DATABASE, view: 'ri_swap_read.directory_reader_projection', verified: liveVerified, location_source: 'RI_YELLOW_PUBLIC_API' });
  return { isConfigured: () => configured, lookupBusiness, listSuburbs, selfCheck, status };
}
