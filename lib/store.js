// Lyrics records, shared by the API endpoints and the library sync job.

const { q, t, LIVE_LYRICS } = require('./db');

const MAX_LYRICS_CHARS = 60000;
const FALLBACK_RECHECK_SEC = 3 * 24 * 3600;

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 300;
}

// Keep only the fields the app uses, with sane sizes
function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = (v) => (typeof v === 'string' && v.length <= MAX_LYRICS_CHARS ? v : null);
  const clean = {
    syncedLyrics: text(entry.syncedLyrics),
    plainLyrics: text(entry.plainLyrics),
    source: typeof entry.source === 'string' ? entry.source.slice(0, 60) : null,
    sourceUrl: typeof entry.sourceUrl === 'string' && /^https:\/\//.test(entry.sourceUrl) ? entry.sourceUrl.slice(0, 300) : null,
    savedAt: Date.now()
  };
  if (!clean.syncedLyrics && !clean.plainLyrics) return null;
  return clean;
}

// Taps that pin unsynced lines to moments in the song: [{ line, time }]
function cleanAnchors(anchors) {
  if (!Array.isArray(anchors)) return null;
  return anchors
    .filter(a => Number.isInteger(a?.line) && a.line >= 0 && a.line < 2000 && Number.isFinite(a.time) && a.time >= 0 && a.time < 3600)
    .slice(0, 60)
    .map(a => ({ line: a.line, time: Math.round(a.time * 100) / 100 }));
}

async function getEntry(id) {
  const { rows } = await q(
    `SELECT l.entry, o.offset_sec, a.anchors
       FROM (SELECT $1::text AS id) k
       LEFT JOIN ${t('lyrics')} l ON l.id = k.id AND ${LIVE_LYRICS}
       LEFT JOIN ${t('offsets')} o ON o.id = k.id
       LEFT JOIN ${t('anchors')} a ON a.id = k.id`,
    [id]
  );
  const row = rows[0] || {};
  return {
    entry: row.entry || null,
    offset: row.offset_sec === null || row.offset_sec === undefined ? null : Number(row.offset_sec),
    anchors: row.anchors || null
  };
}

async function saveEntry(id, entry, { force = false } = {}) {
  const clean = cleanEntry(entry);
  if (!clean) return null;
  const { entry: existing } = await getEntry(id);
  // Never replace lyrics someone tap-synced (or other synced lyrics) with a worse copy
  if (existing && !force) {
    if (existing.source === 'you' && clean.source !== 'you') return existing;
    if (existing.syncedLyrics && !clean.syncedLyrics) return existing;
  }
  // Unsynced fallback lyrics are re-checked after a few days in case synced ones appear
  const expires = clean.syncedLyrics ? null : new Date(Date.now() + FALLBACK_RECHECK_SEC * 1000);
  await q(
    `INSERT INTO ${t('lyrics')} (id, entry, has_synced, source, saved_at, expires_at)
     VALUES ($1, $2, $3, $4, now(), $5)
     ON CONFLICT (id) DO UPDATE SET entry = EXCLUDED.entry, has_synced = EXCLUDED.has_synced,
       source = EXCLUDED.source, saved_at = now(), expires_at = EXCLUDED.expires_at`,
    [id, clean, Boolean(clean.syncedLyrics), clean.source, expires]
  );
  await q(`UPDATE ${t('tracks')} SET status = 'found', updated_at = now() WHERE id = $1`, [id]);
  return clean;
}

async function setOffset(id, offset) {
  const value = Math.max(-10, Math.min(10, Math.round(offset * 10) / 10));
  await q(
    `INSERT INTO ${t('offsets')} (id, offset_sec, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET offset_sec = EXCLUDED.offset_sec, updated_at = now()`,
    [id, value]
  );
  return value;
}

async function setAnchors(id, anchors) {
  const clean = cleanAnchors(anchors);
  if (!clean) return null;
  await q(
    `INSERT INTO ${t('anchors')} (id, anchors, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET anchors = EXCLUDED.anchors, updated_at = now()`,
    [id, JSON.stringify(clean)]
  );
  return clean;
}

module.exports = { saveEntry, getEntry, setOffset, setAnchors, cleanAnchors, validId, cleanEntry };
