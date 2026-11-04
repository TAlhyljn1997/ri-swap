// Durable RI-SWAP state store. The browser never receives the connection string.
// Production startup requires RI_SWAP_DATABASE_URL and a migrated ri_swap schema.
import { createHash } from 'node:crypto';
import { createExchange, ExchangeError, canonicalJson } from './exchange-core-v0.2.mjs';

export class StorageError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

const hashState = state => createHash('sha256').update(canonicalJson(state)).digest('hex');

export function createPostgresStateStore({ env = process.env, pool: injected, timeoutMs = 5000 } = {}) {
  const url = env.RI_SWAP_DATABASE_URL;
  const configured = Boolean(injected) || (typeof url === 'string' && url.length > 0);
  let pool = injected;
  let revision = null;
  let database = null;
  let loadedHash = null;

  async function getPool() {
    if (!configured) throw new StorageError('RI_SWAP_DATABASE_REQUIRED', 'RI_SWAP_DATABASE_URL is required; no in-memory fallback is allowed');
    if (pool) return pool;
    try {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs, query_timeout: timeoutMs });
      pool.on?.('error', () => {});
      return pool;
    } catch {
      throw new StorageError('RI_SWAP_DATABASE_UNAVAILABLE', 'RI-SWAP PostgreSQL is unavailable');
    }
  }

  async function withClient(fn) {
    let client;
    try {
      client = await (await getPool()).connect();
      return await fn(client);
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw new StorageError('RI_SWAP_DATABASE_UNAVAILABLE', 'RI-SWAP PostgreSQL is unavailable');
    } finally {
      try { client?.release(); } catch { /* no-op */ }
    }
  }

  async function load() {
    return withClient(async client => {
      let result;
      try {
        result = await client.query('SELECT revision, state, state_hash, current_database() AS database FROM ri_swap.runtime_state WHERE singleton = true');
      } catch {
        throw new StorageError('RI_SWAP_SCHEMA_NOT_READY', 'ri_swap migration has not been applied');
      }
      if (result.rows.length !== 1) throw new StorageError('RI_SWAP_STATE_MISSING', 'ri_swap.runtime_state singleton is missing');
      revision = Number(result.rows[0].revision);
      database = result.rows[0].database;
      loadedHash = hashState(result.rows[0].state);
      if (loadedHash !== result.rows[0].state_hash) throw new StorageError('RI_SWAP_STATE_HASH_MISMATCH', 'durable state hash does not match; reconcile before restart');
      return structuredClone(result.rows[0].state);
    });
  }

  async function commit(state) {
    if (!Number.isSafeInteger(revision)) throw new StorageError('RI_SWAP_STATE_NOT_LOADED', 'load the durable state before committing');
    return withClient(async client => {
      const nextRevision = revision + 1;
      const stateHash = hashState(state);
      try {
        await client.query('BEGIN');
        const locked = await client.query('SELECT revision FROM ri_swap.runtime_state WHERE singleton = true FOR UPDATE');
        if (locked.rows.length !== 1) throw new StorageError('RI_SWAP_STATE_MISSING', 'ri_swap.runtime_state singleton is missing');
        if (Number(locked.rows[0].revision) !== revision) throw new StorageError('RI_SWAP_REVISION_CONFLICT', 'durable state changed in another process; restart and reconcile before retry');
        await client.query('UPDATE ri_swap.runtime_state SET revision = $1, state = $2::jsonb, state_hash = $3, updated_at = now() WHERE singleton = true', [nextRevision, JSON.stringify(state), stateHash]);
        await client.query('INSERT INTO ri_swap.state_commits (revision, state_hash, state) VALUES ($1, $2, $3::jsonb)', [nextRevision, stateHash, JSON.stringify(state)]);
        await client.query('COMMIT');
        revision = nextRevision;
        loadedHash = stateHash;
        return { revision, state_hash: stateHash };
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* no-op */ }
        if (error instanceof StorageError) throw error;
        throw new StorageError('RI_SWAP_DATABASE_WRITE_FAILED', 'durable state write failed; the in-process state was not advanced');
      }
    });
  }

  async function selfCheck() {
    const state = await load();
    const probe = await withClient(async client => (await client.query("SELECT current_database() AS database, to_regclass('ri_swap.runtime_state')::text AS state_table, to_regclass('ri_swap.state_commits')::text AS commits_table")).rows[0]);
    return {
      ok: Boolean(probe.state_table && probe.commits_table && Number.isSafeInteger(revision)),
      database: probe.database,
      schema: 'ri_swap',
      revision,
      state_hash: loadedHash,
    };
  }

  const status = () => ({
    configured,
    engine: 'POSTGRESQL',
    mode: 'DURABLE_STATE_SNAPSHOT_V1',
    database_connected: database !== null,
    binding: database !== null ? 'BOUND' : 'NOT_BOUND',
    schema: 'ri_swap',
    revision,
    fallback: 'NONE',
  });

  async function close() {
    if (!injected) await pool?.end?.();
  }

  return { isConfigured: () => configured, load, commit, selfCheck, status, close };
}

export async function createPersistentExchange({ store, now = () => new Date(), hooks = {} } = {}) {
  if (!store) throw new StorageError('RI_SWAP_STORE_REQUIRED', 'a durable store is required');
  const initialState = await store.load();
  return createExchange({
    now,
    initialState,
    hooks: {
      ...hooks,
      persistState: state => store.commit(state),
    },
  });
}

export const storageErrorAsExchangeError = error => {
  if (!(error instanceof StorageError)) return error;
  return new ExchangeError(error.code, error.message);
};
