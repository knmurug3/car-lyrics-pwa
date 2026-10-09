// Lyrics search shared by the browser app and the Vercel functions:
// LRCLIB lookups, scoring by song length / title / artist / language.
// In the browser it defines globals; in Node it is a CommonJS module.
(function (root) {
'use strict';

// Unicode blocks -> Sanscript scheme names
const INDIC_SCRIPTS = [
  { name: 'devanagari', from: 0x0900, to: 0x097F },
  { name: 'bengali', from: 0x0980, to: 0x09FF },
  { name: 'gurmukhi', from: 0x0A00, to: 0x0A7F },
  { name: 'gujarati', from: 0x0A80, to: 0x0AFF },
  { name: 'oriya', from: 0x0B00, to: 0x0B7F },
  { name: 'tamil', from: 0x0B80, to: 0x0BFF },
  { name: 'telugu', from: 0x0C00, to: 0x0C7F },
  { name: 'kannada', from: 0x0C80, to: 0x0CFF },
  { name: 'malayalam', from: 0x0D00, to: 0x0D7F }
];

function scriptOfChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x0900 || code > 0x0D7F) return null;
  return INDIC_SCRIPTS.find(s => code >= s.from && code <= s.to)?.name || null;
}


// -------------------------------------------------------------
// LRCLIB Synced Lyrics Search Engine
// -------------------------------------------------------------

const LRCLIB_API = 'https://lrclib.net/api';
const LRCLIB_HEADERS = { 'Lrclib-Client': 'CarLyricsPWA/1.1 (https://github.com/knmurug3/car-lyrics-pwa)' };
const LYRICS_REQUEST_TIMEOUT_MS = 6000;
const DURATION_TOLERANCE_SEC = 4;

function cleanSongTitle(title) {
  if (!title) return '';
  return title
    .replace(/[\(\[\{](?:from|feat|ft|ost|soundtrack|original|tamil|telugu|hindi|malayalam|kannada|remastered|lyric).*?[\)\]\}]/gi, '')
    .replace(/[\(\[\{](?:with|version|reprise).*?[\)\]\}]/gi, '')
    .replace(/\s-\s*(?:from|ost|soundtrack|original|reprise|version|remastered).*$/gi, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForMatch(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const VARIANT_WORDS = /\b(reloaded|remix|reprise|karaoke|instrumental|cover|lofi|lo fi|slowed|reverb|unplugged|sad|female|male|tamil|telugu|hindi|kannada|malayalam|version|live)\b/;

// Big films release Tamil, Telugu and Hindi versions with the same title, artist
// and length, so the lyrics' script is what tells the versions apart.
const DEFAULT_SONG_LANGUAGE = 'tamil';
const LANGUAGE_NAMES = {
  tamil: 'tamil',
  telugu: 'telugu',
  devanagari: 'hindi',
  kannada: 'kannada',
  malayalam: 'malayalam'
};

function detectSongLanguage(rawTitle, album) {
  const text = normalizeForMatch(`${rawTitle} ${album}`);
  for (const [script, name] of Object.entries(LANGUAGE_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return script;
  }
  return DEFAULT_SONG_LANGUAGE;
}

function dominantIndicScript(text) {
  const counts = {};
  for (const ch of text || '') {
    const script = scriptOfChar(ch);
    if (script) counts[script] = (counts[script] || 0) + 1;
  }
  let best = null;
  for (const script in counts) {
    if (counts[script] >= 10 && (!best || counts[script] > counts[best])) best = script;
  }
  return best;
}

const ENGLISH_STOPWORDS = new Set(('the you i my me your is are and to of in it will be with for on that this ' +
  'we our not all when what can do just like am was have been from they she he her his there').split(' '));

// English translations read like English prose; Tanglish lines rarely contain these words
function looksLikeEnglishTranslation(text) {
  const words = (text || '').replace(/\[[^\]]*\]/g, ' ').toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 20) return false;
  const hits = words.filter(w => ENGLISH_STOPWORDS.has(w)).length;
  return hits / words.length >= 0.3;
}

function scoreCandidate(result, query, context = {}) {
  if (!result || (!result.syncedLyrics && !result.plainLyrics)) return -Infinity;

  // Duration is the strongest signal: different edits and language versions differ here
  let score = 0;
  if (query.durationSec > 0 && result.duration) {
    const diff = Math.abs(result.duration - query.durationSec);
    if (diff > DURATION_TOLERANCE_SEC) return -Infinity;
    score += 20 - diff * 3;
  }

  const wantTitle = normalizeForMatch(query.cleanTitle);
  const wantShort = normalizeForMatch(query.shortTitle);
  const gotTitle = normalizeForMatch(result.trackName);
  let titleMatched = true;
  if (gotTitle === wantTitle || gotTitle === wantShort) score += 30;
  else if (gotTitle.includes(wantShort) || wantShort.includes(gotTitle)) score += 15;
  else titleMatched = false;

  // Penalize remix/language variants unless Spotify's title asks for them
  const gotVariant = gotTitle.match(VARIANT_WORDS)?.[0];
  if (gotVariant && !normalizeForMatch(query.rawTitle).includes(gotVariant)) score -= 25;

  const gotArtist = normalizeForMatch(result.artistName);
  const artistMatched = query.artists.some(a => {
    const want = normalizeForMatch(a);
    return want && (gotArtist.includes(want) || want.includes(gotArtist));
  });
  if (artistMatched) score += 20;

  if (!titleMatched && !artistMatched) return -Infinity;

  if (result.syncedLyrics) score += 40;
  else score += 10;

  // Prefer the version sung in the song's language (Tamil unless Spotify says otherwise)
  const lyricText = result.syncedLyrics || result.plainLyrics || '';
  const script = dominantIndicScript(lyricText);
  if (script) {
    score += script === query.language ? 15 : -15;
  } else if (context.hasIndicVersion && looksLikeEnglishTranslation(lyricText)) {
    // An English translation uploaded in place of the real lyrics
    score -= 60;
  }

  return score;
}

function pickBestLyrics(results, query) {
  let best = null;
  let bestScore = -Infinity;
  const seen = new Set();
  const context = {
    hasIndicVersion: results.some(r => r && dominantIndicScript(r.syncedLyrics || r.plainLyrics))
  };
  for (const r of results) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    const s = scoreCandidate(r, query, context);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best ? { result: best, score: bestScore } : null;
}

async function lrclibFetch(path, params, signal, stats = null) {
  const url = new URL(`${LRCLIB_API}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LYRICS_REQUEST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal.addEventListener('abort', onParentAbort);

  if (stats) stats.sent++;
  try {
    const res = await fetch(url.toString(), { headers: LRCLIB_HEADERS, signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [data];
  } catch (err) {
    // No signal (or a request that timed out): not the same as "not found"
    if (stats && !signal.aborted) stats.failed++;
    return [];
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onParentAbort);
  }
}

async function gatherResults(requests) {
  const settled = await Promise.all(requests);
  return settled.flat();
}

// Resolves to { result, offline }: offline when every request failed for lack of signal
async function findLyrics(query, signal) {
  const stats = { sent: 0, failed: 0 };
  const fetchLr = (path, params) => lrclibFetch(path, params, signal, stats);
  const artists = query.artists.slice(0, 3);
  const primaryArtist = artists[0] || '';
  const duration = query.durationSec > 0 ? Math.round(query.durationSec) : undefined;

  // Stage 1: exact match by title + artist + album + duration, plus a targeted search
  const stage1 = await gatherResults([
    ...artists.map(artist => fetchLr('get', {
      track_name: query.cleanTitle,
      artist_name: artist,
      album_name: query.album,
      duration
    })),
    fetchLr('search', { track_name: query.cleanTitle, artist_name: primaryArtist })
  ]);
  let best = pickBestLyrics(stage1, query);
  if (best && best.result.syncedLyrics && best.score >= 70) {
    // Only stop early when we already have the right language version
    const script = dominantIndicScript(best.result.syncedLyrics);
    const anyIndic = stage1.some(r => r && dominantIndicScript(r.syncedLyrics || r.plainLyrics));
    if (script === query.language || (!script && !anyIndic)) return { result: best.result, offline: false };
  }
  if (signal.aborted) return { result: null, offline: false };
  if (stats.sent > 0 && stats.failed === stats.sent) return { result: null, offline: true };

  // Stage 2: broader keyword searches (other artists, shortened title)
  const stage2 = await gatherResults([
    ...artists.slice(1).map(artist => fetchLr('search', { track_name: query.cleanTitle, artist_name: artist })),
    fetchLr('search', { q: `${query.shortTitle} ${primaryArtist}` }),
    fetchLr('search', { q: query.shortTitle }),
    fetchLr('search', { q: `${query.shortTitle} ${LANGUAGE_NAMES[query.language] || ''}` })
  ]);
  best = pickBestLyrics([...stage1, ...stage2], query);
  const offline = !best && stats.sent > 0 && stats.failed === stats.sent;
  return { result: best ? best.result : null, offline };
}

const api = { INDIC_SCRIPTS, scriptOfChar, LRCLIB_API, cleanSongTitle, normalizeForMatch, DEFAULT_SONG_LANGUAGE, LANGUAGE_NAMES, detectSongLanguage, dominantIndicScript, looksLikeEnglishTranslation, scoreCandidate, pickBestLyrics, lrclibFetch, findLyrics };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
