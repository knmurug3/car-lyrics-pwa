// Minimal Upstash Redis REST client (no dependencies).
// Uses the env vars the Vercel Upstash integration creates.
// Preview deployments use their own key prefix so they never touch live data.

const URL_ENV = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN_ENV = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PREFIX = `carlyrics:${process.env.VERCEL_ENV === 'production' ? 'prod' : (process.env.VERCEL_ENV || 'dev')}:`;

function configured() {
  return Boolean(URL_ENV && TOKEN_ENV);
}

function key(...parts) {
  return PREFIX + parts.join(':');
}

async function call(path, body) {
  if (!configured()) throw new Error('Redis is not configured (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const res = await fetch(`${URL_ENV.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_ENV}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Redis error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

// redis('GET', key) -> result
async function redis(...command) {
  const data = await call('', command.map(String));
  if (data.error) throw new Error(`Redis: ${data.error}`);
  return data.result;
}

// pipeline([['GET', k], ['SET', k, v]]) -> [result, result]
async function pipeline(commands) {
  if (!commands.length) return [];
  const data = await call('/pipeline', commands.map(c => c.map(String)));
  return data.map((r) => {
    if (r.error) throw new Error(`Redis: ${r.error}`);
    return r.result;
  });
}

async function getJson(k) {
  const raw = await redis('GET', k);
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

async function setJson(k, value, ttlSec) {
  return ttlSec
    ? redis('SET', k, JSON.stringify(value), 'EX', ttlSec)
    : redis('SET', k, JSON.stringify(value));
}

module.exports = { configured, key, redis, pipeline, getJson, setJson };
