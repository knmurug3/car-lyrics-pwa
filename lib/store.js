// Lyrics records in Redis, shared by the API endpoints and the library sync job.

const { key, getJson, setJson, pipeline } = require('./redis');

const MAX_LYRICS_CHARS = 60000;

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

// Shared with the library sync job
async function saveEntry(id, entry, { force = false } = {}) {
  const clean = cleanEntry(entry);
  if (!clean) return null;
  const existing = await getJson(key('lyr', id));
  // Never replace lyrics someone tap-synced (or other synced lyrics) with a worse copy
  if (existing && !force) {
    if (existing.source === 'you' && clean.source !== 'you') return existing;
    if (existing.syncedLyrics && !clean.syncedLyrics) return existing;
  }
  // Unsynced fallback lyrics are re-checked after a few days in case synced ones appear
  const ttl = clean.syncedLyrics ? null : 3 * 24 * 3600;
  await setJson(key('lyr', id), clean, ttl);
  await pipeline([['SADD', key('lib', 'found'), id], ['SREM', key('lib', 'missing'), id]]);
  return clean;
}

module.exports = { saveEntry, validId, cleanEntry };
