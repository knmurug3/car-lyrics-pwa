// The private lyrics database.
//
// GET  /api/lyrics?id=<trackKey>                 (Spotify sign-in, or &session=<shareId>)
//      -> 200 { entry, offset } | 404
// POST /api/lyrics { id, entry?, offset? }       (Spotify sign-in)
//      saves lyrics found on a phone, tap-synced lyrics, or a timing nudge

const { key, redis, pipeline } = require('../lib/redis');
const { saveEntry, validId } = require('../lib/store');
const { send, query, readJson, rateLimited, spotifyUser, handle } = require('../lib/http');

async function canRead(req, q) {
  const session = q.get('session');
  if (session && session.length <= 64) {
    return Boolean(await redis('EXISTS', key('sess', session)));
  }
  return Boolean(await spotifyUser(req));
}

module.exports = handle(async (req, res) => {
  const q = query(req);

  if (req.method === 'GET') {
    const id = q.get('id');
    if (!validId(id)) return send(res, 400, { error: 'id is required' });
    if (await rateLimited(req, 'lyrics-get', 1200, 3600)) return send(res, 429, { error: 'too many requests' });
    if (!(await canRead(req, q))) return send(res, 401, { error: 'sign in with Spotify' });

    const [rawEntry, rawOffset] = await pipeline([['GET', key('lyr', id)], ['GET', key('off', id)]]);
    const entry = rawEntry ? JSON.parse(rawEntry) : null;
    const offset = rawOffset !== null && rawOffset !== undefined ? Number(rawOffset) : null;
    if (!entry) return send(res, 404, { error: 'not found', offset });
    return send(res, 200, { entry, offset });
  }

  if (req.method === 'POST') {
    const user = await spotifyUser(req);
    if (!user) return send(res, 401, { error: 'sign in with Spotify' });
    if (await rateLimited(req, 'lyrics-post', 600, 3600)) return send(res, 429, { error: 'too many requests' });

    const body = await readJson(req);
    if (!validId(body.id)) return send(res, 400, { error: 'id is required' });

    if (typeof body.offset === 'number' && Number.isFinite(body.offset)) {
      const offset = Math.max(-10, Math.min(10, Math.round(body.offset * 10) / 10));
      await redis('SET', key('off', body.id), offset);
    }
    let saved = null;
    if (body.entry) {
      saved = await saveEntry(body.id, body.entry, { force: body.entry.source === 'you' });
      if (!saved) return send(res, 400, { error: 'lyrics are missing or too long' });
    }
    return send(res, 200, { ok: true, entry: saved });
  }

  res.setHeader('Allow', 'GET, POST');
  send(res, 405, { error: 'method not allowed' });
});

