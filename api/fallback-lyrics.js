// Fallback lyrics for songs LRCLIB doesn't have yet (see lib/tamil2lyrics.js).
//
// GET /api/fallback-lyrics?title=...&artists=a,b&album=...
// -> 200 { source, url, title, plainLyrics } | 404 { error }

const { findOnTamil2Lyrics, pageTitle } = require('../lib/tamil2lyrics');

// Basic per-IP limit (per warm instance): the app needs a handful of calls per drive
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const callsByIp = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const recent = (callsByIp.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  callsByIp.set(ip, recent);
  if (callsByIp.size > 5000) callsByIp.clear();
  return recent.length > RATE_LIMIT;
}

function send(res, status, body, cacheControl) {
  res.statusCode = status;
  if (cacheControl) res.setHeader('Cache-Control', cacheControl);
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const title = (url.searchParams.get('title') || '').trim();
  const album = (url.searchParams.get('album') || '').trim().slice(0, 120);
  const artists = (url.searchParams.get('artists') || '')
    .split(',').map(a => a.trim().slice(0, 60)).filter(Boolean).slice(0, 4);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  if (!title || title.length > 120 || !/[a-z]/i.test(title)) {
    send(res, 400, { error: 'a song title (up to 120 characters) is required' });
    return;
  }

  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '600');
    send(res, 429, { error: 'too many requests' }, 'no-store');
    return;
  }

  let found = null;
  try {
    found = await findOnTamil2Lyrics({ title, artists, album });
  } catch (err) {
    console.error('fallback-lyrics failed', err);
  }

  if (!found) {
    // Re-check hourly: new songs get added to the site within days
    res.setHeader('Cache-Control', 'public, s-maxage=3600');
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  // Cache at Vercel's edge for a day so the site is hit at most once per song per day
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
  res.statusCode = 200;
  res.end(JSON.stringify({
    source: 'tamil2lyrics.com',
    url: found.url,
    title: pageTitle(found.html),
    plainLyrics: found.plainLyrics
  }));
};
