// Postgres (Supabase) access for the Vercel functions.
// Tables live in their own schema per environment (carlyrics_prod / _preview / _dev),
// outside "public", so Supabase's public API keys can't reach them.

const { Pool } = require('pg');

const CONNECTION_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
const ENV = process.env.VERCEL_ENV === 'production' ? 'prod' : (process.env.VERCEL_ENV || process.env.CARLYRICS_ENV || 'dev');
const SCHEMA = `carlyrics_${ENV.replace(/[^a-z0-9_]/gi, '')}`;

let pool = null;
let schemaReady = null;

function configured() {
  return Boolean(CONNECTION_URL);
}

// Build the config by hand: Supabase's URL carries pooler-only query parameters,
// and its certificate chain needs rejectUnauthorized: false with node-postgres
function poolConfig() {
  const url = new URL(CONNECTION_URL);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.slice(1) || 'postgres',
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000
  };
}

function getPool() {
  if (!pool) pool = new Pool(poolConfig());
  return pool;
}

const t = (name) => `${SCHEMA}.${name}`;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
      CREATE TABLE IF NOT EXISTS ${t('lyrics')} (
        id text PRIMARY KEY,
        entry jsonb NOT NULL,
        has_synced boolean NOT NULL DEFAULT false,
        source text,
        saved_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz
      );
      CREATE TABLE IF NOT EXISTS ${t('offsets')} (
        id text PRIMARY KEY,
        offset_sec real NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${t('anchors')} (
        id text PRIMARY KEY,
        anchors jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${t('tracks')} (
        id text PRIMARY KEY,
        info jsonb NOT NULL,
        status text NOT NULL DEFAULT 'queued',
        retry_at timestamptz,
        added_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS tracks_status_idx ON ${t('tracks')} (status, added_at);
      CREATE TABLE IF NOT EXISTS ${t('sessions')} (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        owner_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        state jsonb,
        state_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS sessions_owner_idx ON ${t('sessions')} (owner_id);
      CREATE TABLE IF NOT EXISTS ${t('auth_cache')} (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL,
        user_name text NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${t('rate_limits')} (
        key text PRIMARY KEY,
        count integer NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ${t('meta')} (
        key text PRIMARY KEY,
        value text NOT NULL
      );
    `).catch((err) => {
      schemaReady = null; // try again on the next request
      throw err;
    });
  }
  return schemaReady;
}

async function q(sql, params = []) {
  await ensureSchema();
  return getPool().query(sql, params);
}

// A lyrics row that hasn't expired (unsynced fallback lyrics expire for a re-check)
const LIVE_LYRICS = `(l.expires_at IS NULL OR l.expires_at > now())`;

module.exports = { configured, q, t, SCHEMA, LIVE_LYRICS };
