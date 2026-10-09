// Live share: passengers follow the driver's song and lyrics without Spotify.
//
// POST /api/session?action=create             (driver, Spotify sign-in) -> { id, expiresAt }
// POST /api/session?action=update { id, state } (driver) publishes song + position
// POST /api/session?action=end    { id }      (driver)
// GET  /api/session?id=<id>&have=<trackKey>   (anyone with the link)
//      -> { ownerName, state, position, lyrics?, offset? }
//
// The share id is a long random token: having the link is what grants access.

const { q, t, LIVE_LYRICS } = require('../lib/db');
const { send, query, readJson, rateLimited, spotifyUser, randomId, handle } = require('../lib/http');
const { cleanAnchors } = require('../lib/store');

const SESSION_HOURS = 12;

function validSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{20,40}$/.test(id);
}

function cleanState(s) {
  if (!s || typeof s !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    key: str(s.key, 300),
    title: str(s.title, 200),
    artists: Array.isArray(s.artists) ? s.artists.map(a => str(a, 100)).slice(0, 6) : [],
    album: str(s.album, 200),
    artUrl: /^https:\/\/i\.scdn\.co\//.test(s.artUrl || '') ? str(s.artUrl, 300) : '',
    durationSec: num(s.durationSec),
    progressSec: num(s.progressSec),
    isPlaying: Boolean(s.isPlaying),
    offset: Math.max(-10, Math.min(10, num(s.offset))),
    anchors: cleanAnchors(s.anchors) || []
  };
}

async function ownedSession(req, id) {
  const user = await spotifyUser(req);
  if (!user) return { error: [401, 'sign in with Spotify'] };
  if (!validSessionId(id)) return { error: [400, 'invalid share id'] };
  const { rows } = await q(`SELECT owner_id FROM ${t('sessions')} WHERE id = $1 AND expires_at > now()`, [id]);
  if (!rows.length) return { error: [404, 'this share has ended'] };
  if (rows[0].owner_id !== user.id) return { error: [403, 'only the driver can update this share'] };
  return { user };
}

module.exports = handle(async (req, res) => {
  const params = query(req);
  const action = params.get('action');

  // ---- Passenger: read the shared state ----
  if (req.method === 'GET') {
    const id = params.get('id');
    if (!validSessionId(id)) return send(res, 400, { error: 'invalid share id' });
    if (await rateLimited(req, 'session-get', 3000, 3600)) return send(res, 429, { error: 'too many requests' });

    const { rows } = await q(
      `SELECT owner_name, expires_at, state, state_at FROM ${t('sessions')} WHERE id = $1 AND expires_at > now()`,
      [id]
    );
    if (!rows.length) return send(res, 404, { error: 'this share has ended' });
    const session = rows[0];

    const now = Date.now();
    const body = { ownerName: session.owner_name, expiresAt: new Date(session.expires_at).getTime(), state: null, now };
    const state = session.state;
    if (state) {
      // Where the song is right now, from the driver's last update
      const at = new Date(session.state_at).getTime();
      const elapsed = state.isPlaying ? (now - at) / 1000 : 0;
      body.state = state;
      body.position = Math.min(state.durationSec || Infinity, state.progressSec + elapsed);

      // Lyrics only when the passenger doesn't have this song's yet
      if (state.key && params.get('have') !== state.key) {
        const lyr = await q(
          `SELECT l.entry, o.offset_sec
             FROM (SELECT $1::text AS id) k
             LEFT JOIN ${t('lyrics')} l ON l.id = k.id AND ${LIVE_LYRICS}
             LEFT JOIN ${t('offsets')} o ON o.id = k.id`,
          [state.key]
        );
        body.lyrics = lyr.rows[0]?.entry || null;
        const off = lyr.rows[0]?.offset_sec;
        body.offset = off === null || off === undefined ? null : Number(off);
      }
    }
    return send(res, 200, body);
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  // ---- Driver ----
  if (action === 'create') {
    const user = await spotifyUser(req);
    if (!user) return send(res, 401, { error: 'sign in with Spotify' });
    if (await rateLimited(req, 'session-create', 30, 3600)) return send(res, 429, { error: 'too many requests' });

    // Reuse the driver's current share if it is still running
    const existing = await q(
      `SELECT id, expires_at FROM ${t('sessions')} WHERE owner_id = $1 AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
      [user.id]
    );
    if (existing.rows.length) {
      return send(res, 200, { id: existing.rows[0].id, expiresAt: new Date(existing.rows[0].expires_at).getTime() });
    }

    const id = randomId(18);
    const { rows } = await q(
      `INSERT INTO ${t('sessions')} (id, owner_id, owner_name, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(hours => $4)) RETURNING expires_at`,
      [id, user.id, user.name, SESSION_HOURS]
    );
    return send(res, 200, { id, expiresAt: new Date(rows[0].expires_at).getTime() });
  }

  const body = await readJson(req);
  const { error } = await ownedSession(req, body.id);
  if (error) return send(res, error[0], { error: error[1] });

  if (action === 'update') {
    const state = cleanState(body.state);
    if (!state) return send(res, 400, { error: 'state is required' });
    if (await rateLimited(req, 'session-update', 2000, 3600)) return send(res, 429, { error: 'too many requests' });
    await q(`UPDATE ${t('sessions')} SET state = $2, state_at = now() WHERE id = $1`, [body.id, state]);
    return send(res, 200, { ok: true });
  }

  if (action === 'end') {
    await q(`DELETE FROM ${t('sessions')} WHERE id = $1`, [body.id]);
    return send(res, 200, { ok: true });
  }

  send(res, 400, { error: 'unknown action' });
});
