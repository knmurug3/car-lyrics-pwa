// Small helpers shared by the Vercel functions.

const crypto = require('crypto');
const { configured, q, t } = require('./db');

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!('Cache-Control' in headers)) res.setHeader('Cache-Control', 'no-store');
  Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(body));
}

function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

// Vercel parses JSON bodies into req.body; fall back to reading the stream
async function readJson(req, maxBytes = 512 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

// Fixed-window rate limit: true when the caller is over the limit
async function rateLimited(req, name, limit, windowSec) {
  if (!configured()) return false;
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const { rows } = await q(
    `INSERT INTO ${t('rate_limits')} (key, count, expires_at)
     VALUES ($1, 1, now() + make_interval(secs => $2))
     ON CONFLICT (key) DO UPDATE SET count = ${t('rate_limits')}.count + 1
     RETURNING count`,
    [`${name}:${clientIp(req)}:${bucket}`, windowSec + 5]
  );
  return rows[0].count > limit;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Who is calling: verified with Spotify (cached for 30 minutes per token).
// Anyone who can sign in to this app's Spotify developer app may use it;
// ALLOWED_SPOTIFY_USERS (comma-separated ids) narrows that further.
async function spotifyUser(req) {
  const header = req.headers?.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || token.length > 2048) return null;

  const tokenHash = sha256(token);
  const cached = await q(
    `SELECT user_id, user_name FROM ${t('auth_cache')} WHERE token_hash = $1 AND expires_at > now()`,
    [tokenHash]
  );
  let user = cached.rows[0] ? { id: cached.rows[0].user_id, name: cached.rows[0].user_name } : null;
  if (!user) {
    const res = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const me = await res.json();
    user = { id: me.id, name: me.display_name || me.id };
    await q(
      `INSERT INTO ${t('auth_cache')} (token_hash, user_id, user_name, expires_at)
       VALUES ($1, $2, $3, now() + interval '30 minutes')
       ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, expires_at = EXCLUDED.expires_at`,
      [tokenHash, user.id, user.name]
    );
  }

  // This Paadu is private: only the listed Spotify accounts may use its database
  const allowed = (process.env.ALLOWED_SPOTIFY_USERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.id).toLowerCase())) {
    throw Object.assign(
      new Error(`This Paadu is private. Your Spotify account (${user.id}) isn't on its allowed list.`),
      { status: 403 }
    );
  }
  return user;
}

function randomId(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Wraps a handler: JSON errors, and a clear message when the database isn't connected
function handle(fn) {
  return async (req, res) => {
    try {
      if (!configured()) return send(res, 503, { error: 'The lyrics database is not connected yet.' });
      await fn(req, res);
    } catch (err) {
      // 28P01: the database rejected our password (credentials rotated since the last
      // deploy). Redeploying picks up the current ones.
      if (err.code === '28P01' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.error('DATABASE UNAVAILABLE', err.code, err.message);
        return send(res, 503, { error: 'The lyrics database is temporarily unavailable. Lyrics still work; sharing and sync will be back shortly.' });
      }
      console.error(err);
      send(res, err.status || 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  };
}

module.exports = { send, query, readJson, clientIp, rateLimited, spotifyUser, randomId, handle, sha256 };
