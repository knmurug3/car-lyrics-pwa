// The private lyrics database.
//
// GET  /api/lyrics?id=<trackKey>                 (Spotify sign-in, or &session=<shareId>)
//      -> 200 { entry, offset } | 404 { offset }
// POST /api/lyrics { id, entry?, offset? }       (Spotify sign-in)
//      saves lyrics found on a phone, tap-synced lyrics, or a timing nudge

const { q, t } = require('../lib/db');
const { saveEntry, getEntry, setOffset, validId } = require('../lib/store');
const { send, query, readJson, rateLimited, spotifyUser, handle } = require('../lib/http');

async function canRead(req, params) {
  const session = params.get('session');
  if (session && session.length <= 64) {
    const { rows } = await q(`SELECT 1 FROM ${t('sessions')} WHERE id = $1 AND expires_at > now()`, [session]);
    return rows.length > 0;
  }
  return Boolean(await spotifyUser(req));
}

module.exports = handle(async (req, res) => {
  const params = query(req);

  if (req.method === 'GET') {
    const id = params.get('id');
    if (!validId(id)) return send(res, 400, { error: 'id is required' });
    if (await rateLimited(req, 'lyrics-get', 1200, 3600)) return send(res, 429, { error: 'too many requests' });
    if (!(await canRead(req, params))) return send(res, 401, { error: 'sign in with Spotify' });

    const { entry, offset } = await getEntry(id);
    if (!entry) return send(res, 404, { error: 'not found', offset });
    return send(res, 200, { entry, offset });
  }

  if (req.method === 'POST') {
    const user = await spotifyUser(req);
    if (!user) return send(res, 401, { error: 'sign in with Spotify' });
    if (await rateLimited(req, 'lyrics-post', 600, 3600)) return send(res, 429, { error: 'too many requests' });

    const body = await readJson(req);
    if (!validId(body.id)) return send(res, 400, { error: 'id is required' });

    if (typeof body.offset === 'number' && Number.isFinite(body.offset)) await setOffset(body.id, body.offset);
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
