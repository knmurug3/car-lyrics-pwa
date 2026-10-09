// Playlist sync: fills the lyrics database for every song in your playlists.
//
// The phone lists the playlists (it has the Spotify token and no time limit) and
// sends the songs here; the server then finds lyrics a few songs at a time.
//
// POST /api/library?action=enqueue  { tracks: [{ id, title, artists, album, durationSec }] }
// POST /api/library?action=process  -> { processed, found, missing, remaining }
// GET  /api/library?action=status   -> { total, withLyrics, queued, missing }
// GET  /api/library?action=cron     (Vercel Cron, CRON_SECRET) keeps going once a day

const { findLyrics, dominantIndicScript, detectSongLanguage, cleanSongTitle } = require('../lib/lyrics-engine');
const { findOnTamil2Lyrics } = require('../lib/tamil2lyrics');
const { key, redis, pipeline, getJson, setJson } = require('../lib/redis');
const { saveEntry, validId } = require('../lib/store');
const { send, query, readJson, spotifyUser, handle } = require('../lib/http');

const MAX_TRACKS_PER_ENQUEUE = 500;
const PROCESS_BUDGET_MS = 40000; // stay well inside the function time limit
const CONCURRENCY = 3; // be gentle with LRCLIB and tamil2lyrics
const MISS_RETRY_SEC = 3 * 24 * 3600;

function cleanTrack(t) {
  if (!t || !validId(t.id)) return null;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const track = {
    id: t.id,
    title: str(t.title, 200),
    artists: Array.isArray(t.artists) ? t.artists.map(a => str(a, 100)).filter(Boolean).slice(0, 6) : [],
    album: str(t.album, 200),
    durationSec: Number(t.durationSec) > 0 ? Number(t.durationSec) : 0
  };
  return track.title ? track : null;
}

async function enqueue(tracks) {
  const clean = tracks.map(cleanTrack).filter(Boolean).slice(0, MAX_TRACKS_PER_ENQUEUE);
  if (!clean.length) return { added: 0 };

  // Skip songs we already know about (with lyrics, missing, or already queued)
  const known = await pipeline(clean.map(t => ['SISMEMBER', key('lib', 'tracks'), t.id]));
  const fresh = clean.filter((_, i) => !known[i]);
  if (fresh.length) {
    const cmds = [];
    fresh.forEach((t) => {
      cmds.push(['SET', key('trk', t.id), JSON.stringify(t)]);
      cmds.push(['SADD', key('lib', 'tracks'), t.id]);
      cmds.push(['RPUSH', key('lib', 'queue'), t.id]);
    });
    await pipeline(cmds);
  }
  await redis('SET', key('lib', 'lastSync'), Date.now());
  return { added: fresh.length, alreadyKnown: clean.length - fresh.length };
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
  const { result } = await findLyrics(query, new AbortController().signal);
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

async function processOne(id, totals) {
  const [hasLyrics, track] = await Promise.all([redis('EXISTS', key('lyr', id)), getJson(key('trk', id))]);
  if (hasLyrics || !track) return;
  const entry = await lookUp(track);
  if (entry && (await saveEntry(id, entry))) {
    totals.found++;
  } else {
    totals.missing++;
    await pipeline([['SADD', key('lib', 'missing'), id], ['SET', key('miss', id), 1, 'EX', MISS_RETRY_SEC]]);
  }
}

async function processQueue(maxTracks) {
  const started = Date.now();
  const totals = { processed: 0, found: 0, missing: 0 };

  while (totals.processed < maxTracks && Date.now() - started < PROCESS_BUDGET_MS) {
    const batchSize = Math.min(CONCURRENCY, maxTracks - totals.processed);
    const ids = await redis('LPOP', key('lib', 'queue'), batchSize);
    if (!ids || !ids.length) break;
    await Promise.all(ids.map(id => processOne(id, totals).catch(async (err) => {
      console.warn('lookup failed', id, err.message);
      await redis('RPUSH', key('lib', 'queue'), id); // try again later
    })));
    totals.processed += ids.length;
  }

  totals.remaining = await redis('LLEN', key('lib', 'queue'));
  return totals;
}

// Songs that had no lyrics anywhere get another look once their retry timer runs out
async function requeueExpiredMisses() {
  const missing = await redis('SMEMBERS', key('lib', 'missing'));
  if (!missing?.length) return 0;
  const waiting = await pipeline(missing.map(id => ['EXISTS', key('miss', id)]));
  const ready = missing.filter((_, i) => !waiting[i]);
  if (ready.length) await pipeline(ready.flatMap(id => [['SREM', key('lib', 'missing'), id], ['RPUSH', key('lib', 'queue'), id]]));
  return ready.length;
}

async function status() {
  const [total, withLyrics, queued, missing, lastSync] = await pipeline([
    ['SCARD', key('lib', 'tracks')],
    ['SCARD', key('lib', 'found')],
    ['LLEN', key('lib', 'queue')],
    ['SCARD', key('lib', 'missing')],
    ['GET', key('lib', 'lastSync')]
  ]);
  return { total, withLyrics, queued, missing, lastSync: lastSync ? Number(lastSync) : null };
}

module.exports = handle(async (req, res) => {
  const action = query(req).get('action');

  if (action === 'cron') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers?.authorization !== `Bearer ${secret}`) return send(res, 401, { error: 'unauthorized' });
    const requeued = await requeueExpiredMisses();
    return send(res, 200, { requeued, ...(await processQueue(40)) });
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
    const lock = await redis('SET', key('lib', 'processing'), user.id, 'NX', 'EX', 55);
    if (!lock) return send(res, 200, { busy: true, ...(await status()) });
    try {
      return send(res, 200, await processQueue(30));
    } finally {
      await redis('DEL', key('lib', 'processing'));
    }
  }

  send(res, 400, { error: 'unknown action' });
});
