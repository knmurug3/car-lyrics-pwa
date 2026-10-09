// Live share: passengers follow the driver's song and lyrics without Spotify.
//
// POST /api/session?action=create             (driver, Spotify sign-in) -> { id, expiresAt }
// POST /api/session?action=update { id, state } (driver) publishes song + position
// POST /api/session?action=end    { id }      (driver)
// GET  /api/session?id=<id>&have=<trackKey>   (anyone with the link)
//      -> { ownerName, state, position, lyrics?, offset? }
//
// The share id is a long random token: having the link is what grants access.

const { key, redis, pipeline, getJson, setJson } = require('../lib/redis');
const { send, query, readJson, rateLimited, spotifyUser, randomId, handle } = require('../lib/http');

const SESSION_TTL_SEC = 12 * 3600;

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
    offset: Math.max(-10, Math.min(10, num(s.offset)))
  };
}

async function ownedSession(req, id) {
  const user = await spotifyUser(req);
  if (!user) return { error: [401, 'sign in with Spotify'] };
  if (!validSessionId(id)) return { error: [400, 'invalid share id'] };
  const session = await getJson(key('sess', id));
  if (!session) return { error: [404, 'this share has ended'] };
  if (session.ownerId !== user.id) return { error: [403, 'only the driver can update this share'] };
  return { user, session };
}

module.exports = handle(async (req, res) => {
  const q = query(req);
  const action = q.get('action');

  // ---- Passenger: read the shared state ----
  if (req.method === 'GET') {
    const id = q.get('id');
    if (!validSessionId(id)) return send(res, 400, { error: 'invalid share id' });
    if (await rateLimited(req, 'session-get', 3000, 3600)) return send(res, 429, { error: 'too many requests' });

    const [rawSession, rawState] = await pipeline([['GET', key('sess', id)], ['GET', key('sess-state', id)]]);
    if (!rawSession) return send(res, 404, { error: 'this share has ended' });
    const session = JSON.parse(rawSession);
    const state = rawState ? JSON.parse(rawState) : null;

    const now = Date.now();
    const body = { ownerName: session.ownerName, expiresAt: session.expiresAt, state: null, now };
    if (state) {
      // Where the song is right now, from the driver's last update
      const elapsed = state.isPlaying ? (now - state.at) / 1000 : 0;
      body.state = state;
      body.position = Math.min(state.durationSec || Infinity, state.progressSec + elapsed);

      // Lyrics only when the passenger doesn't have this song's yet
      if (state.key && q.get('have') !== state.key) {
        const [rawEntry, rawOffset] = await pipeline([['GET', key('lyr', state.key)], ['GET', key('off', state.key)]]);
        body.lyrics = rawEntry ? JSON.parse(rawEntry) : null;
        body.offset = rawOffset !== null && rawOffset !== undefined ? Number(rawOffset) : null;
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
    const existingId = await redis('GET', key('owner-sess', user.id));
    if (existingId) {
      const existing = await getJson(key('sess', existingId));
      if (existing) return send(res, 200, { id: existingId, expiresAt: existing.expiresAt });
    }

    const id = randomId(18);
    const expiresAt = Date.now() + SESSION_TTL_SEC * 1000;
    await pipeline([
      ['SET', key('sess', id), JSON.stringify({ ownerId: user.id, ownerName: user.name, createdAt: Date.now(), expiresAt }), 'EX', SESSION_TTL_SEC],
      ['SET', key('owner-sess', user.id), id, 'EX', SESSION_TTL_SEC]
    ]);
    return send(res, 200, { id, expiresAt });
  }

  const body = await readJson(req);
  const { error } = await ownedSession(req, body.id);
  if (error) return send(res, error[0], { error: error[1] });

  if (action === 'update') {
    const state = cleanState(body.state);
    if (!state) return send(res, 400, { error: 'state is required' });
    if (await rateLimited(req, 'session-update', 2000, 3600)) return send(res, 429, { error: 'too many requests' });
    const ttl = Math.max(1, Number(await redis('TTL', key('sess', body.id))));
    await setJson(key('sess-state', body.id), { ...state, at: Date.now() }, ttl);
    return send(res, 200, { ok: true });
  }

  if (action === 'end') {
    const session = await getJson(key('sess', body.id));
    await pipeline([
      ['DEL', key('sess', body.id)],
      ['DEL', key('sess-state', body.id)],
      ['DEL', key('owner-sess', session.ownerId)]
    ]);
    return send(res, 200, { ok: true });
  }

  send(res, 400, { error: 'unknown action' });
});
