// Spotify App Configuration
const SPOTIFY_CLIENT_ID = 'f81df8eb9f39460fa7bc321b650279ba';
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state';

// State
let accessToken = localStorage.getItem('spotify_access_token');
let refreshToken = localStorage.getItem('spotify_refresh_token');
let tokenExpiresAt = parseInt(localStorage.getItem('spotify_token_expires_at') || '0', 10);

let isPlaying = false;
let currentPositionSec = 0;
let currentDurationSec = 0;
let currentTrackId = null;
let currentTrackTitle = '';
let currentArtist = '';

let lyrics = []; // Array of { id, timestamp, text }
let activeLyricId = null;
let isDemoMode = false;
let wakeLock = null;

let pollInterval = null;
let interpolateInterval = null;

// UI Elements
const dom = {
  ambientBg: document.getElementById('ambient-bg'),
  albumArt: document.getElementById('album-art'),
  trackTitle: document.getElementById('track-title'),
  artistName: document.getElementById('artist-name'),
  lyricsContainer: document.getElementById('lyrics-container'),
  statusBadge: document.getElementById('status-badge'),
  statusDot: document.getElementById('status-dot'),
  statusText: document.getElementById('status-text'),
  loginBtn: document.getElementById('login-btn'),
  demoBtn: document.getElementById('demo-btn'),
  qrBtn: document.getElementById('qr-btn'),
  qrModal: document.getElementById('qr-modal'),
  closeQrBtn: document.getElementById('close-qr-btn'),
  qrCodeImg: document.getElementById('qr-code-img'),
  progressFill: document.getElementById('progress-fill'),
  timeCurrent: document.getElementById('time-current'),
  timeTotal: document.getElementById('time-total')
};

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  requestWakeLock();
  registerServiceWorker();
  setupEventListeners();

  // Check for OAuth redirect callback
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (code) {
    window.history.replaceState({}, document.title, window.location.pathname);
    await handleOAuthCallback(code);
  }

  if (accessToken && Date.now() < tokenExpiresAt) {
    onSpotifyAuthenticated();
  } else if (refreshToken) {
    await refreshAccessToken();
    if (accessToken) onSpotifyAuthenticated();
  }
});

// -------------------------------------------------------------
// Screen Wake Lock (Keep Screen Awake on Dashboard Mount)
// -------------------------------------------------------------
async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (wakeLock !== null && document.visibilityState === 'visible') {
          wakeLock = await navigator.wakeLock.request('screen');
        }
      });
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
    }
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.log('SW failed', err));
  }
}

// -------------------------------------------------------------
// Spotify PKCE Authentication (No backend needed)
// -------------------------------------------------------------
function getRedirectUri() {
  // Always normalize to origin with trailing slash, regardless of /index.html
  return window.location.origin.replace(/\/+$/, '') + '/';
}

async function loginWithSpotify() {
  const codeVerifier = generateRandomString(64);
  const codeChallenge = await generateCodeChallenge(codeVerifier);

  localStorage.setItem('spotify_code_verifier', codeVerifier);

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    redirect_uri: getRedirectUri()
  }).toString();

  window.location.href = authUrl.toString();
}

async function handleOAuthCallback(code) {
  const codeVerifier = localStorage.getItem('spotify_code_verifier');
  if (!codeVerifier) return;

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: getRedirectUri(),
        code_verifier: codeVerifier
      })
    });

    const data = await response.json();
    if (data.access_token) {
      accessToken = data.access_token;
      refreshToken = data.refresh_token || refreshToken;
      tokenExpiresAt = Date.now() + (data.expires_in * 1000);

      localStorage.setItem('spotify_access_token', accessToken);
      if (refreshToken) localStorage.setItem('spotify_refresh_token', refreshToken);
      localStorage.setItem('spotify_token_expires_at', tokenExpiresAt.toString());

      onSpotifyAuthenticated();
    }
  } catch (err) {
    console.error('Failed to exchange Spotify token:', err);
  }
}

async function refreshAccessToken() {
  if (!refreshToken) return;
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
      })
    });

    const data = await response.json();
    if (data.access_token) {
      accessToken = data.access_token;
      tokenExpiresAt = Date.now() + (data.expires_in * 1000);
      localStorage.setItem('spotify_access_token', accessToken);
      localStorage.setItem('spotify_token_expires_at', tokenExpiresAt.toString());
    }
  } catch (err) {
    console.error('Token refresh failed', err);
  }
}

function onSpotifyAuthenticated() {
  dom.loginBtn.style.display = 'none';
  dom.statusBadge.style.display = 'flex';
  dom.statusText.textContent = 'Connected';
  startSpotifyPolling();
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const bytes = new Uint8Array(length);
  window.crypto.getRandomValues(bytes);
  for (let i = 0; i < length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
}

async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await window.crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

// -------------------------------------------------------------
// Spotify Real-time Playback Tracking & Local Interpolation
// -------------------------------------------------------------
function startSpotifyPolling() {
  pollCurrentlyPlaying();
  clearInterval(pollInterval);
  pollInterval = setInterval(pollCurrentlyPlaying, 2500);

  // Local 100ms clock for smooth 60fps lyric scrolling
  clearInterval(interpolateInterval);
  interpolateInterval = setInterval(() => {
    if (isPlaying && currentDurationSec > 0) {
      currentPositionSec += 0.1;
      if (currentPositionSec > currentDurationSec) currentPositionSec = currentDurationSec;
      updateProgressBar();
      highlightActiveLyric(currentPositionSec);
    }
  }, 100);
}

function fetchCurrentlyPlaying() {
  return fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
}

async function pollCurrentlyPlaying() {
  if (isDemoMode) return;
  if (!accessToken) return;

  if (Date.now() > tokenExpiresAt - 60000) {
    await refreshAccessToken();
  }

  try {
    let res = await fetchCurrentlyPlaying();
    if (res.status === 401) {
      await refreshAccessToken();
      res = await fetchCurrentlyPlaying();
    }

    if (res.status === 204 || res.status >= 400) return;

    const data = await res.json();
    if (!data || !data.item) return;

    const track = data.item;
    isPlaying = data.is_playing;
    currentPositionSec = data.progress_ms / 1000;
    currentDurationSec = track.duration_ms / 1000;

    dom.statusDot.classList.toggle('playing', isPlaying);
    dom.statusText.textContent = isPlaying ? 'Playing' : 'Paused';

    const trackChanged = (track.id !== currentTrackId);
    if (trackChanged) {
      currentTrackId = track.id;
      currentTrackTitle = track.name;
      currentArtist = track.artists.map(a => a.name).join(', ');

      dom.trackTitle.textContent = currentTrackTitle;
      dom.artistName.textContent = currentArtist;

      const artUrl = track.album?.images?.[0]?.url || '';
      if (artUrl) {
        dom.albumArt.src = artUrl;
        dom.ambientBg.style.backgroundImage = `url('${artUrl}')`;
      }

      fetchLyrics({
        title: track.name,
        artists: track.artists.map(a => a.name),
        album: track.album?.name || '',
        durationSec: currentDurationSec
      });
    }

    updateProgressBar();
    highlightActiveLyric(currentPositionSec);
  } catch (err) {
    console.error('Playback poll error:', err);
  }
}

// -------------------------------------------------------------
// Script Detection & Romanization (Tanglish + other Indic languages)
// -------------------------------------------------------------

const SCRIPT_PREF_KEY = 'carlyrics_prefer_english_script';
let preferEnglishScript = loadScriptPreference();
let currentLyricsScript = null; // dominant Indic script of the lyrics on screen

function loadScriptPreference() {
  try {
    return localStorage.getItem(SCRIPT_PREF_KEY) !== 'false';
  } catch (err) {
    return true;
  }
}

function saveScriptPreference() {
  try {
    localStorage.setItem(SCRIPT_PREF_KEY, String(preferEnglishScript));
  } catch (err) {}
}

// Unicode blocks -> Sanscript scheme names
const INDIC_SCRIPTS = [
  { name: 'devanagari', from: 0x0900, to: 0x097F, label: 'हिन्दी' },
  { name: 'bengali', from: 0x0980, to: 0x09FF, label: 'বাংলা' },
  { name: 'gurmukhi', from: 0x0A00, to: 0x0A7F, label: 'ਪੰਜਾਬੀ' },
  { name: 'gujarati', from: 0x0A80, to: 0x0AFF, label: 'ગુજરાતી' },
  { name: 'oriya', from: 0x0B00, to: 0x0B7F, label: 'ଓଡ଼ିଆ' },
  { name: 'tamil', from: 0x0B80, to: 0x0BFF, label: 'தமிழ்' },
  { name: 'telugu', from: 0x0C00, to: 0x0C7F, label: 'తెలుగు' },
  { name: 'kannada', from: 0x0C80, to: 0x0CFF, label: 'ಕನ್ನಡ' },
  { name: 'malayalam', from: 0x0D00, to: 0x0D7F, label: 'മലയാളം' }
];

function scriptOfChar(ch) {
  const code = ch.codePointAt(0);
  if (code < 0x0900 || code > 0x0D7F) return null;
  return INDIC_SCRIPTS.find(s => code >= s.from && code <= s.to)?.name || null;
}

function hasIndicScript(text) {
  return /[ऀ-ൿ]/.test(text || '');
}

function detectDominantScript(text) {
  const counts = {};
  for (const ch of text || '') {
    const s = scriptOfChar(ch);
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  let best = null;
  for (const s in counts) {
    if (!best || counts[s] > counts[best]) best = s;
  }
  return best;
}

// Romanize any mix of Latin + Indic text, run by run
function romanize(text) {
  if (!text || !hasIndicScript(text)) return text;
  const normalized = text.normalize('NFC');
  let out = '';
  let run = '';
  let runScript = null;

  const flush = () => {
    if (!run) return;
    out += runScript ? romanizeRun(run, runScript) : run;
    run = '';
  };

  for (const ch of normalized) {
    const s = scriptOfChar(ch);
    // Spaces and punctuation stay attached to the current run
    if (s !== runScript && (s || /\p{L}/u.test(ch))) {
      flush();
      runScript = s;
    }
    run += ch;
  }
  flush();

  return out.charAt(0).toUpperCase() + out.slice(1);
}

function romanizeRun(text, script) {
  if (script === 'tamil') return transliterateTamil(text);
  if (typeof Sanscript === 'undefined') return text;
  try {
    return simplifyIast(Sanscript.t(text, script, 'iast'), script);
  } catch (err) {
    return text;
  }
}

// IAST -> casual "WhatsApp-style" English letters people actually read
function simplifyIast(text, script) {
  let s = text;

  // Hindi-style schwa deletion: "tuma" -> "tum", "dila" -> "dil"
  if (script === 'devanagari' || script === 'gurmukhi' || script === 'gujarati') {
    s = s.replace(/(?<=\p{L}[^aāiīuūeēoōṛ\s\p{P}])a(?![\p{L}\p{M}])/gu, '');
  }

  s = s
    .replace(/ch/g, '\u0001')
    .replace(/c/g, 'ch')
    .replace(/\u0001/g, 'chh');

  const map = {
    'ā': 'aa', 'ī': 'ee', 'ū': 'oo', 'ē': 'e', 'ō': 'o', 'è': 'e', 'ò': 'o',
    'ṛ': script === 'devanagari' ? 'ri' : 'ru', 'ṝ': 'roo', 'ḷ': 'l', 'ḻ': 'zh',
    'ṭ': 't', 'ḍ': 'd', 'ṇ': 'n', 'ṉ': 'n', 'ṅ': 'ng', 'ñ': 'nj',
    'ś': 'sh', 'ṣ': 'sh', 'ṃ': 'm', 'ṁ': 'n', 'ḥ': 'h', 'ṟ': 'r'
  };
  s = s.replace(/[āīūēōèòṛṝḷḻṭḍṇṉṅñśṣṃṁḥṟ]/g, ch => map[ch]);

  // Drop any remaining diacritics
  return s.normalize('NFD').replace(/\p{M}/gu, '');
}

// ---- Tamil -> Tanglish with context-aware sounds ----

const TAMIL_VOWELS = {
  'அ': 'a', 'ஆ': 'aa', 'இ': 'i', 'ஈ': 'ee', 'உ': 'u', 'ஊ': 'oo',
  'எ': 'e', 'ஏ': 'e', 'ஐ': 'ai', 'ஒ': 'o', 'ஓ': 'o', 'ஔ': 'au', 'ஃ': 'h'
};

const TAMIL_CONSONANTS = {
  'க': 'k', 'ங': 'ng', 'ச': 's', 'ஞ': 'nj', 'ட': 't', 'ண': 'n',
  'த': 'th', 'ந': 'n', 'ப': 'p', 'ம': 'm', 'ய': 'y', 'ர': 'r',
  'ல': 'l', 'வ': 'v', 'ழ': 'zh', 'ள': 'l', 'ற': 'r', 'ன': 'n',
  'ஜ': 'j', 'ஷ': 'sh', 'ஸ': 's', 'ஹ': 'h', 'ஶ': 'sh'
};

// Long vowels are doubled; short/long e and o are written the same way in Tanglish
const TAMIL_VOWEL_SIGNS = {
  'ா': 'aa', 'ி': 'i', 'ீ': 'ee', 'ு': 'u', 'ூ': 'oo',
  'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au',
  '்': ''
};

const TAMIL_NASALS = new Set(['ங', 'ஞ', 'ண', 'ந', 'ம', 'ன']);

function transliterateTamil(text) {
  const prepared = text
    .normalize('NFC')
    .replace(/ஸ்ரீ/g, 'sri')
    .replace(/க்ஷ/g, 'kஷ');

  // Split into units: vowel | consonant(+sign) | other
  const units = [];
  const chars = Array.from(prepared);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (TAMIL_VOWELS[c] !== undefined) {
      units.push({ type: 'v', text: TAMIL_VOWELS[c] });
    } else if (TAMIL_CONSONANTS[c] !== undefined) {
      let sign = null; // null = inherent 'a'
      if (i + 1 < chars.length && TAMIL_VOWEL_SIGNS[chars[i + 1]] !== undefined) {
        sign = TAMIL_VOWEL_SIGNS[chars[i + 1]];
        i++;
      }
      units.push({ type: 'c', ch: c, sign });
    } else {
      units.push({ type: 'o', text: c });
    }
  }

  const endsInVowel = (u) => u && (u.type === 'v' || (u.type === 'c' && u.sign !== ''));
  const isDeadConsonant = (u) => u && u.type === 'c' && u.sign === '';

  let out = '';
  units.forEach((u, idx) => {
    if (u.type !== 'c') {
      out += u.text;
      return;
    }

    const prev = units[idx - 1];
    const next = units[idx + 1];
    const wordStart = !prev || prev.type === 'o';
    const geminate = isDeadConsonant(prev) && prev.ch === u.ch;
    const afterNasal = isDeadConsonant(prev) && TAMIL_NASALS.has(prev.ch);
    const intervocalic = endsInVowel(prev);
    // First half of a doubled consonant stays hard: உனக்கு -> unakku
    const doubledNext = u.sign === '' && next?.type === 'c' && next.ch === u.ch;

    let base = TAMIL_CONSONANTS[u.ch];
    switch (u.ch) {
      case 'க':
        if (!wordStart && !geminate && !doubledNext && (afterNasal || intervocalic)) base = 'g';
        break;
      case 'ச':
        if (geminate) base = 'ch';
        else if (afterNasal) base = 'j';
        else if (isDeadConsonant(prev) && (prev.ch === 'ட' || prev.ch === 'ற')) base = 'ch';
        else if (u.sign === '' && next?.type === 'c' && next.ch === 'ச') base = 'c';
        break;
      case 'ட':
        if (!wordStart && !geminate && !doubledNext && (afterNasal || intervocalic)) base = 'd';
        break;
      case 'த':
        if (!wordStart && !geminate && !doubledNext && (afterNasal || intervocalic)) base = 'dh';
        break;
      case 'ப':
        if (afterNasal) base = 'b';
        break;
      case 'ற':
        if (u.sign === '' && next?.type === 'c' && next.ch === 'ற') base = 't';
        else if (isDeadConsonant(prev) && prev.ch === 'ன') base = 'dr';
        else if (geminate) base = 'r';
        break;
      case 'ஞ':
        if (u.sign === '' && next?.type === 'c' && next.ch === 'ச') base = 'n';
        break;
      case 'ங':
        if (u.sign === '' && next?.type === 'c' && next.ch === 'க') base = 'n';
        break;
    }

    out += base + (u.sign === null ? 'a' : u.sign);
  });

  return out;
}

// -------------------------------------------------------------
// LRCLIB Synced Lyrics Search Engine
// -------------------------------------------------------------

const LRCLIB_API = 'https://lrclib.net/api';
const LRCLIB_HEADERS = { 'Lrclib-Client': 'CarLyricsPWA/1.1 (https://github.com/knmurug3/car-lyrics-pwa)' };
const LYRICS_REQUEST_TIMEOUT_MS = 6000;
const DURATION_TOLERANCE_SEC = 4;

let lyricsRequestId = 0;
let lyricsAbortController = null;
let renderedLines = []; // { id, originalText, romanText } for whatever is on screen

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

function scoreCandidate(result, query) {
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

  // Tie-breaker only: prefer lyrics already in English letters
  const lyricText = result.syncedLyrics || result.plainLyrics || '';
  if (preferEnglishScript && !hasIndicScript(lyricText)) score += 3;

  return score;
}

function pickBestLyrics(results, query) {
  let best = null;
  let bestScore = -Infinity;
  const seen = new Set();
  for (const r of results) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    const s = scoreCandidate(r, query);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best ? { result: best, score: bestScore } : null;
}

async function lrclibFetch(path, params, signal) {
  const url = new URL(`${LRCLIB_API}/${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LYRICS_REQUEST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal.addEventListener('abort', onParentAbort);

  try {
    const res = await fetch(url.toString(), { headers: LRCLIB_HEADERS, signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [data];
  } catch (err) {
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

async function findLyrics(query, signal) {
  const artists = query.artists.slice(0, 3);
  const primaryArtist = artists[0] || '';
  const duration = query.durationSec > 0 ? Math.round(query.durationSec) : undefined;

  // Stage 1: exact match by title + artist + album + duration, plus a targeted search
  const stage1 = await gatherResults([
    ...artists.map(artist => lrclibFetch('get', {
      track_name: query.cleanTitle,
      artist_name: artist,
      album_name: query.album,
      duration
    }, signal)),
    lrclibFetch('search', { track_name: query.cleanTitle, artist_name: primaryArtist }, signal)
  ]);
  let best = pickBestLyrics(stage1, query);
  if (best && best.result.syncedLyrics && best.score >= 70) return best.result;
  if (signal.aborted) return null;

  // Stage 2: broader keyword searches (other artists, shortened title)
  const stage2 = await gatherResults([
    ...artists.slice(1).map(artist => lrclibFetch('search', { track_name: query.cleanTitle, artist_name: artist }, signal)),
    lrclibFetch('search', { q: `${query.shortTitle} ${primaryArtist}` }, signal),
    lrclibFetch('search', { q: query.shortTitle }, signal)
  ]);
  best = pickBestLyrics([...stage1, ...stage2], query);
  return best ? best.result : null;
}

function resetLyricsState() {
  lyrics = [];
  renderedLines = [];
  activeLyricId = null;
  currentLyricsScript = null;
  updateScriptToggleLabels();
}

async function fetchLyrics({ title, artists, album, durationSec }) {
  const requestId = ++lyricsRequestId;
  if (lyricsAbortController) lyricsAbortController.abort();
  lyricsAbortController = new AbortController();
  const { signal } = lyricsAbortController;

  resetLyricsState();
  renderStateMessage('Fetching Lyrics', `Searching synchronized database for ${title}...`, true);

  const cleanTitle = cleanSongTitle(title) || title;
  const query = {
    rawTitle: title,
    cleanTitle,
    shortTitle: cleanTitle.split(' - ')[0].trim(),
    artists: artists.flatMap(a => a.split(/[,;&]/)).map(a => a.trim()).filter(Boolean),
    album,
    durationSec
  };

  let lyricsData = null;
  try {
    lyricsData = await findLyrics(query, signal);
  } catch (err) {
    console.warn('Lyrics search failed:', err);
  }

  // A newer track started while we were searching: drop this stale result
  if (requestId !== lyricsRequestId) return;

  if (lyricsData?.syncedLyrics) {
    lyrics = parseLRC(lyricsData.syncedLyrics, requestId);
    renderLyrics(lyrics);
    highlightActiveLyric(currentPositionSec);
  } else if (lyricsData?.plainLyrics) {
    renderPlainLyrics(lyricsData.plainLyrics, requestId);
  } else {
    renderStateMessage('🎵 Instrumental or Unsynced', 'Lyrics not found for this song in the open database.');
  }
}

function makeLine(id, originalText) {
  return {
    id,
    originalText,
    romanText: romanize(originalText)
  };
}

function displayText(line) {
  return preferEnglishScript ? line.romanText : line.originalText;
}

function noteScript(lines) {
  currentLyricsScript = detectDominantScript(lines.map(l => l.originalText).join(' '));
  updateScriptToggleLabels();
}

function parseLRC(lrcText, requestId) {
  const lines = lrcText.split('\n');
  const result = [];
  const timeTag = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const stamps = [...trimmed.matchAll(timeTag)];
    if (!stamps.length) return;

    const rawText = trimmed.replace(timeTag, '').trim();
    if (!rawText) return;

    // A line can carry several timestamps when it repeats (e.g. a chorus)
    stamps.forEach((m, n) => {
      const fractionStr = m[3] || '0';
      const fraction = parseFloat(fractionStr) / Math.pow(10, fractionStr.length);
      result.push({
        ...makeLine(`lyric-${requestId}-${index}-${n}`, rawText),
        timestamp: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fraction
      });
    });
  });

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

function renderStateMessage(title, message, withSpinner = false) {
  const wrapper = document.createElement('div');
  wrapper.className = 'state-message';
  if (withSpinner) {
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    wrapper.appendChild(spinner);
  }
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  wrapper.append(h2, p);
  dom.lyricsContainer.replaceChildren(wrapper);
}

function renderPlainLyrics(plainText, requestId) {
  dom.lyricsContainer.innerHTML = '';
  renderedLines = plainText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map((text, index) => makeLine(`plain-${requestId}-${index}`, text));
  noteScript(renderedLines);

  const badge = document.createElement('div');
  badge.style.fontSize = '0.8rem';
  badge.style.color = 'var(--text-sub)';
  badge.style.marginBottom = '24px';
  badge.style.background = 'rgba(255, 255, 255, 0.08)';
  badge.style.padding = '6px 14px';
  badge.style.borderRadius = '20px';
  badge.textContent = '📄 Plain Lyrics Mode (not synced)';
  dom.lyricsContainer.appendChild(badge);

  renderedLines.forEach((line) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = line.id;
    div.style.color = 'rgba(255, 255, 255, 0.85)';
    div.style.fontSize = '1.35rem';
    div.textContent = displayText(line);
    dom.lyricsContainer.appendChild(div);
  });
}

function renderLyrics(lyricItems) {
  dom.lyricsContainer.innerHTML = '';
  renderedLines = lyricItems;
  noteScript(renderedLines);

  lyricItems.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = item.id;
    div.textContent = displayText(item);
    div.addEventListener('click', () => {
      // Manual click line preview
      currentPositionSec = item.timestamp;
      highlightActiveLyric(currentPositionSec);
    });
    dom.lyricsContainer.appendChild(div);
  });
}

function highlightActiveLyric(seconds) {
  if (!lyrics.length) return;

  let active = null;
  for (const l of lyrics) {
    if (l.timestamp > seconds) break;
    active = l;
  }
  if (!active) return;

  if (activeLyricId !== active.id) {
    if (activeLyricId) {
      const prev = document.getElementById(activeLyricId);
      if (prev) prev.classList.remove('active');
    }

    activeLyricId = active.id;
    const currentElem = document.getElementById(active.id);
    if (currentElem) {
      currentElem.classList.add('active');
      currentElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
}

function scriptToggleLabel() {
  const native = INDIC_SCRIPTS.find(s => s.name === currentLyricsScript);
  if (preferEnglishScript) {
    return currentLyricsScript === 'tamil' || !native ? '🔤 Tanglish' : '🔤 English';
  }
  return `🔤 ${native ? native.label : 'Original'}`;
}

function updateScriptToggleLabels() {
  const label = scriptToggleLabel();
  ['script-toggle-btn', 'bottom-script-btn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = label;
  });
}

function toggleScript() {
  preferEnglishScript = !preferEnglishScript;
  saveScriptPreference();
  updateScriptToggleLabels();

  // Update currently rendered lyrics (synced or plain) on screen immediately
  renderedLines.forEach((line) => {
    const el = document.getElementById(line.id);
    if (el) el.textContent = displayText(line);
  });
}

function updateProgressBar() {
  if (currentDurationSec <= 0) return;
  const pct = Math.min(100, (currentPositionSec / currentDurationSec) * 100);
  dom.progressFill.style.width = `${pct}%`;
  dom.timeCurrent.textContent = formatTime(currentPositionSec);
  dom.timeTotal.textContent = formatTime(currentDurationSec);
}

function formatTime(secs) {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// -------------------------------------------------------------
// In-Car Demo Mode (Instant Test without Spotify Login)
// -------------------------------------------------------------
function startDemoMode() {
  isDemoMode = true;
  isPlaying = true;
  currentPositionSec = 0;
  currentDurationSec = 200;

  // Cancel any in-flight Spotify lyrics search so it can't overwrite the demo
  const requestId = ++lyricsRequestId;
  if (lyricsAbortController) lyricsAbortController.abort();
  resetLyricsState();

  dom.trackTitle.textContent = 'Blinding Lights';
  dom.artistName.textContent = 'The Weeknd';
  dom.statusBadge.style.display = 'flex';
  dom.statusDot.classList.add('playing');
  dom.statusText.textContent = 'Demo Mode';

  const demoAlbumArt = 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36';
  dom.albumArt.src = demoAlbumArt;
  dom.ambientBg.style.backgroundImage = `url('${demoAlbumArt}')`;

  const demoLRC = `
[00:00.00] (Synth Intro 🎵)
[00:12.45] Yeah
[00:15.80] I've been tryna call
[00:19.45] I've been on my own for long enough
[00:23.70] Maybe you can show me how to love, maybe
[00:31.00] I'm going through withdrawals
[00:34.60] You don't even have to do too much
[00:38.90] You can turn me on with just a touch, baby
[00:46.20] I look around and Sin City's cold and empty
[00:51.50] No one's around to judge me
[00:55.20] I can see clearly when you're gone
[01:00.00] I said, ooh, I'm blinded by the lights
[01:06.50] No, I can't sleep until I feel your touch
[01:15.20] I said, ooh, I'm drowning in the night
[01:21.80] Oh, when I'm like this, you're the one I trust
[01:29.00] Hey, hey, hey
[01:34.20] I'm running out of time
[01:38.50] 'Cause I can see the sun light up the sky
[01:43.00] So I hit the road in overdrive, baby
[01:50.00] The city's cold and empty
[01:55.00] No one's around to judge me
[01:58.50] I can see clearly when you're gone
[02:03.00] I said, ooh, I'm blinded by the lights
  `;

  lyrics = parseLRC(demoLRC, requestId);
  renderLyrics(lyrics);

  clearInterval(interpolateInterval);
  interpolateInterval = setInterval(() => {
    currentPositionSec += 0.1;
    if (currentPositionSec > currentDurationSec) currentPositionSec = 0;
    updateProgressBar();
    highlightActiveLyric(currentPositionSec);
  }, 100);
}

// -------------------------------------------------------------
// Passenger QR Code Sharing
// -------------------------------------------------------------
function showQrCodeModal() {
  const currentUrl = encodeURIComponent(window.location.href);
  dom.qrCodeImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${currentUrl}`;
  dom.qrModal.classList.add('open');
}

function hideQrCodeModal() {
  dom.qrModal.classList.remove('open');
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------
function setupEventListeners() {
  updateScriptToggleLabels();
  ['script-toggle-btn', 'bottom-script-btn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', toggleScript);
  });

  const copyUriBtn = document.getElementById('copy-uri-btn');
  if (copyUriBtn) {
    copyUriBtn.addEventListener('click', () => {
      const uri = getRedirectUri();
      navigator.clipboard.writeText(uri).then(() => {
        const originalText = copyUriBtn.textContent;
        copyUriBtn.textContent = '✓ Copied!';
        setTimeout(() => { copyUriBtn.textContent = originalText; }, 2500);
      });
    });
  }

  dom.loginBtn.addEventListener('click', loginWithSpotify);
  dom.demoBtn.addEventListener('click', startDemoMode);
  dom.qrBtn.addEventListener('click', showQrCodeModal);
  dom.closeQrBtn.addEventListener('click', hideQrCodeModal);
  dom.qrModal.addEventListener('click', (e) => {
    if (e.target === dom.qrModal) hideQrCodeModal();
  });
}
