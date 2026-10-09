// Playlist sync: fills the lyrics database for every song in your playlists.
//
// The phone lists the playlists (it has the Spotify token and no time limit) and
// sends the songs here; the server then finds lyrics a few songs at a time.
//
// POST /api/library?action=enqueue  { tracks: [{ id, title, artists, album, durationSec }] }
// POST /api/library?action=process  -> { processed, found, missing, remaining }
// GET  /api/library?action=status   -> { total, withLyrics, queued, missing, lastSync }
// GET  /api/library?action=cron     (Vercel Cron, CRON_SECRET) keeps going once a day

const { findLyrics, dominantIndicScript, detectSongLanguage, cleanSongTitle } = require('../lib/lyrics-engine');
const { findOnTamil2Lyrics } = require('../lib/tamil2lyrics');
const { q, t, LIVE_LYRICS } = require('../lib/db');
const { saveEntry, validId } = require('../lib/store');
const { send, query, readJson, spotifyUser, handle } = require('../lib/http');

const MAX_TRACKS_PER_ENQUEUE = 500;
const PROCESS_BUDGET_MS = 40000; // stay well inside the function time limit
const CONCURRENCY = 3; // be gentle with LRCLIB and tamil2lyrics
const MISS_RETRY = '3 days';
const LOCK_KEY = 'library_sync_lock';

function cleanTrack(tr) {
  if (!tr || !validId(tr.id)) return null;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const track = {
    id: tr.id,
    title: str(tr.title, 200),
    artists: Array.isArray(tr.artists) ? tr.artists.map(a => str(a, 100)).filter(Boolean).slice(0, 6) : [],
    album: str(tr.album, 200),
    durationSec: Number(tr.durationSec) > 0 ? Number(tr.durationSec) : 0
  };
  return track.title ? track : null;
}

async function enqueue(tracks) {
  const clean = [...new Map(tracks.map(cleanTrack).filter(Boolean).map(tr => [tr.id, tr])).values()]
    .slice(0, MAX_TRACKS_PER_ENQUEUE);
  if (!clean.length) return { added: 0, alreadyKnown: 0 };

  // New songs only; ones that already have lyrics (e.g. found on a phone) start as found
  const { rows } = await q(
    `INSERT INTO ${t('tracks')} (id, info, status)
     SELECT u.id, u.info,
            CASE WHEN EXISTS (SELECT 1 FROM ${t('lyrics')} l WHERE l.id = u.id AND ${LIVE_LYRICS})
                 THEN 'found' ELSE 'queued' END
       FROM unnest($1::text[], $2::jsonb[]) AS u(id, info)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [clean.map(tr => tr.id), clean.map(tr => JSON.stringify(tr))]
  );
  await q(
    `INSERT INTO ${t('meta')} (key, value) VALUES ('last_sync', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [String(Date.now())]
  );
  return { added: rows.length, alreadyKnown: clean.length - rows.length };
}

function buildQuery(track) {
  const cleanTitle = cleanSongTitle(track.title) || track.title;
  return {
    rawTitle: track.title,
    cleanTitle,
    shortTitle: cleanTitle.split(' - ')[0].trim(),
    artists: track.artists.flatMap(a => a.split(/[,;&]/)).map(a => a.trim()).filter(Boolean),
    album: track.album,
    durationSec: track.durationSec,
    language: detectSongLanguage(track.title, track.album)
  };
}

// Same order as the phone: LRCLIB, then tamil2lyrics when LRCLIB has nothing
// or only another language's version
async function lookUp(track) {
  const query = buildQuery(track);
  const { result, busy } = await findLyrics(query, new AbortController().signal);
  // LRCLIB busy: synced lyrics may exist, so retry later instead of settling for less
  if (busy) throw Object.assign(new Error('LRCLIB is busy'), { lrclibBusy: true });
  let entry = result
    ? { syncedLyrics: result.syncedLyrics || null, plainLyrics: result.plainLyrics || null, source: 'LRCLIB', sourceUrl: 'https://lrclib.net' }
    : null;

  const script = entry && dominantIndicScript(entry.syncedLyrics || entry.plainLyrics);
  const wrongLanguage = script && script !== query.language && query.language === 'tamil';
  if (!entry || wrongLanguage) {
    const page = await findOnTamil2Lyrics({ title: track.title, artists: track.artists, album: track.album }).catch(() => null);
    if (page?.plainLyrics) {
      entry = { syncedLyrics: null, plainLyrics: page.plainLyrics, source: 'tamil2lyrics.com', sourceUrl: page.url };
    }
  }
  return entry;
}

async function processOne(row, totals) {
  const entry = await lookUp(row.info);
  if (entry && (await saveEntry(row.id, entry))) {
    totals.found++;
  } else {
    totals.missing++;
    await q(
      `UPDATE ${t('tracks')} SET status = 'missing', retry_at = now() + interval '${MISS_RETRY}', updated_at = now() WHERE id = $1`,
      [row.id]
    );
  }
}

async function processQueue(maxTracks) {
  const started = Date.now();
  const totals = { processed: 0, found: 0, missing: 0 };

  while (totals.processed < maxTracks && Date.now() - started < PROCESS_BUDGET_MS) {
    // Claim a few queued songs; SKIP LOCKED keeps two runs from taking the same ones
    const { rows } = await q(
      `UPDATE ${t('tracks')} SET status = 'processing', updated_at = now()
        WHERE id IN (SELECT id FROM ${t('tracks')} WHERE status = 'queued'
                      ORDER BY added_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, info`,
      [Math.min(CONCURRENCY, maxTracks - totals.processed)]
    );
    if (!rows.length) break;
    await Promise.all(rows.map(row => processOne(row, totals).catch(async (err) => {
      if (err.lrclibBusy) totals.lrclibBusy = true;
      else console.warn('lookup failed', row.id, err.message);
      await q(`UPDATE ${t('tracks')} SET status = 'queued', updated_at = now() WHERE id = $1`, [row.id]);
    })));
    totals.processed += rows.length;
    if (totals.lrclibBusy) break; // give LRCLIB a break; the phone or the daily job carries on
  }

  const { rows } = await q(`SELECT count(*)::int AS n FROM ${t('tracks')} WHERE status IN ('queued', 'processing')`);
  totals.remaining = rows[0].n;
  return totals;
}

// Daily housekeeping: retry songs that had no lyrics, re-check expired unsynced lyrics,
// un-stick interrupted work, and clear expired sessions / caches / rate-limit rows
async function housekeeping() {
  const retried = await q(
    `UPDATE ${t('tracks')} SET status = 'queued', updated_at = now()
      WHERE (status = 'missing' AND retry_at < now())
         OR (status = 'processing' AND updated_at < now() - interval '5 minutes')
         OR (status = 'found' AND NOT EXISTS (SELECT 1 FROM ${t('lyrics')} l WHERE l.id = ${t('tracks')}.id AND ${LIVE_LYRICS}))`
  );
  await q(`DELETE FROM ${t('lyrics')} WHERE expires_at < now() - interval '30 days'`);
  await q(`DELETE FROM ${t('sessions')} WHERE expires_at < now()`);
  await q(`DELETE FROM ${t('auth_cache')} WHERE expires_at < now()`);
  await q(`DELETE FROM ${t('rate_limits')} WHERE expires_at < now()`);
  return retried.rowCount;
}

async function status() {
  const { rows } = await q(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM ${t('lyrics')} l WHERE l.id = tr.id AND ${LIVE_LYRICS}))::int AS with_lyrics,
            count(*) FILTER (WHERE tr.status IN ('queued', 'processing'))::int AS queued,
            count(*) FILTER (WHERE tr.status = 'missing')::int AS missing,
            (SELECT value FROM ${t('meta')} WHERE key = 'last_sync') AS last_sync
       FROM ${t('tracks')} tr`
  );
  const r = rows[0];
  return { total: r.total, withLyrics: r.with_lyrics, queued: r.queued, missing: r.missing, lastSync: r.last_sync ? Number(r.last_sync) : null };
}

// One sync run at a time across all devices (expires on its own if a run dies)
async function acquireLock(owner) {
  const { rows } = await q(
    `INSERT INTO ${t('meta')} (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
       WHERE split_part(${t('meta')}.value, '|', 2)::bigint < $3
     RETURNING key`,
    [LOCK_KEY, `${owner}|${Date.now() + 55000}`, Date.now()]
  );
  return rows.length > 0;
}

async function releaseLock() {
  await q(`DELETE FROM ${t('meta')} WHERE key = $1`, [LOCK_KEY]);
}

module.exports = handle(async (req, res) => {
  const action = query(req).get('action');

  if (action === 'cron') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers?.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorized' });
    const requeued = await housekeeping();
    if (!(await acquireLock('cron'))) return send(res, 200, { requeued, busy: true });
    try {
      return send(res, 200, { requeued, ...(await processQueue(40)) });
    } finally {
      await releaseLock();
    }
  }

  const user = await spotifyUser(req);
  if (!user) return send(res, 401, { error: 'sign in with Spotify' });

  if (action === 'status' && req.method === 'GET') return send(res, 200, await status());

  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

  if (action === 'enqueue') {
    const body = await readJson(req, 2 * 1024 * 1024);
    if (!Array.isArray(body.tracks)) return send(res, 400, { error: 'tracks must be a list' });
    return send(res, 200, await enqueue(body.tracks));
  }

  if (action === 'process') {
    // One sync at a time: two phones syncing would just double the work
    if (!(await acquireLock(user.id))) return send(res, 200, { busy: true, ...(await status()) });
    try {
      return send(res, 200, await processQueue(30));
    } finally {
      await releaseLock();
    }
  }

  send(res, 400, { error: 'unknown action' });
});
