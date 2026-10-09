// Spotify App Configuration
const SPOTIFY_CLIENT_ID = 'f81df8eb9f39460fa7bc321b650279ba';
const SPOTIFY_SCOPES = 'user-read-currently-playing user-read-playback-state user-modify-playback-state';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const POLL_INTERVAL_MS = 2500;
const USER_SCROLL_PAUSE_MS = 5000;
const OFFLINE_RETRY_MS = 15000;

const TOKEN_KEYS = {
  access: 'spotify_access_token',
  refresh: 'spotify_refresh_token',
  expires: 'spotify_token_expires_at',
  scope: 'spotify_scope'
};

// State
let accessToken = localStorage.getItem(TOKEN_KEYS.access);
let refreshToken = localStorage.getItem(TOKEN_KEYS.refresh);
let tokenExpiresAt = parseInt(localStorage.getItem(TOKEN_KEYS.expires) || '0', 10);
let grantedScopes = localStorage.getItem(TOKEN_KEYS.scope) || '';
let isAuthenticated = false;
let refreshPromise = null;
let isOffline = false;

let isPlaying = false;
let currentPositionSec = 0;
let currentDurationSec = 0;
let currentTrackKey = null;
let currentTrackInfo = null;
let hasSeenTrack = false;

let lyrics = []; // Array of { id, timestamp, text }
let lyricsRequestId = 0; // bumps on every track change so stale results are dropped
let activeLyricId = null;
let isDemoMode = false;
let wakeLock = null;
let noSleep = null;

let pollInterval = null;
let pollInFlight = false;
let pollBlockedUntil = 0;
let lastClockTick = performance.now();
let userScrollUntil = 0;
let needsRecenter = false;
let toastTimer = null;
let plainMode = false; // unsynced lyrics on screen: scroll with song progress instead
let plainLines = []; // text of the unsynced lyrics on screen (for tap-to-sync)
let lyricsRetryTimer = null;
let syncState = null; // tap-to-sync session: { lines, times, index, meta, trackKey }
let plainMeta = {}; // source of the unsynced lyrics on screen

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
  textSizeBtn: document.getElementById('text-size-btn'),
  fullscreenBtn: document.getElementById('fullscreen-btn'),
  qrModal: document.getElementById('qr-modal'),
  closeQrBtn: document.getElementById('close-qr-btn'),
  qrCode: document.getElementById('qr-code'),
  progressFill: document.getElementById('progress-fill'),
  timeCurrent: document.getElementById('time-current'),
  timeTotal: document.getElementById('time-total'),
  timing: document.getElementById('timing'),
  timingValue: document.getElementById('timing-value'),
  timingEarlier: document.getElementById('timing-earlier'),
  timingLater: document.getElementById('timing-later'),
  syncBar: document.getElementById('sync-bar'),
  syncStart: document.getElementById('sync-start'),
  syncProgress: document.getElementById('sync-progress'),
  syncTap: document.getElementById('sync-tap'),
  syncUndo: document.getElementById('sync-undo'),
  syncCancel: document.getElementById('sync-cancel'),
  toast: document.getElementById('toast')
};

// -------------------------------------------------------------
// Initialization
// -------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  setupWakeLock();
  registerServiceWorker();
  setupEventListeners();
  applyTextSize();
  startClock();
  loadOffsets();

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const authError = params.get('error');

  if (code || authError) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  if (authError) {
    showToast(authError === 'access_denied'
      ? 'Spotify connection was cancelled.'
      : 'Spotify could not connect. Please try again.');
  } else if (code) {
    await handleOAuthCallback(code, params.get('state'));
  }

  // A saved login is enough to start: if there is no signal right now,
  // polling renews the token as soon as the network comes back
  if (refreshToken || (accessToken && Date.now() < tokenExpiresAt)) {
    onSpotifyAuthenticated();
  }
});

// -------------------------------------------------------------
// Screen Wake Lock (keep the screen on for the whole drive)
// -------------------------------------------------------------
async function requestWakeLock() {
  if (document.visibilityState !== 'visible') return;

  if ('wakeLock' in navigator) {
    if (wakeLock && !wakeLock.released) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      return;
    } catch (err) {
      console.warn('Wake Lock request failed:', err);
    }
  }

  // Older car browsers / iOS without the Wake Lock API: NoSleep plays a tiny
  // silent video, which must start from a tap
  if (typeof NoSleep === 'function') {
    if (!noSleep) noSleep = new NoSleep();
    if (!noSleep.isEnabled) noSleep.enable().catch(() => {});
  }
}

function setupWakeLock() {
  requestWakeLock();
  // The lock drops whenever the page is hidden, and some browsers only grant it
  // after a tap, so ask again on both
  document.addEventListener('visibilitychange', requestWakeLock);
  document.addEventListener('click', requestWakeLock);
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
  // Ties the redirect back to this login attempt (CSRF protection)
  const state = generateRandomString(24);

  localStorage.setItem('spotify_code_verifier', codeVerifier);
  localStorage.setItem('spotify_auth_state', state);

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    redirect_uri: getRedirectUri(),
    state
  }).toString();

  window.location.href = authUrl.toString();
}

function saveTokens(data) {
  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  // Spotify may rotate the refresh token: always keep the newest one
  if (data.refresh_token) refreshToken = data.refresh_token;
  if (data.scope) grantedScopes = data.scope;

  localStorage.setItem(TOKEN_KEYS.access, accessToken);
  localStorage.setItem(TOKEN_KEYS.expires, tokenExpiresAt.toString());
  if (refreshToken) localStorage.setItem(TOKEN_KEYS.refresh, refreshToken);
  if (grantedScopes) localStorage.setItem(TOKEN_KEYS.scope, grantedScopes);
}

// Another open copy of the app (installed app + browser tab) may have renewed the login
function adoptStoredTokens() {
  accessToken = localStorage.getItem(TOKEN_KEYS.access);
  refreshToken = localStorage.getItem(TOKEN_KEYS.refresh);
  tokenExpiresAt = parseInt(localStorage.getItem(TOKEN_KEYS.expires) || '0', 10);
  grantedScopes = localStorage.getItem(TOKEN_KEYS.scope) || grantedScopes;
}

async function handleOAuthCallback(code, returnedState) {
  const codeVerifier = localStorage.getItem('spotify_code_verifier');
  const expectedState = localStorage.getItem('spotify_auth_state');
  localStorage.removeItem('spotify_auth_state');
  if (!codeVerifier) return;
  if (!expectedState || returnedState !== expectedState) {
    showToast('That Spotify sign-in link did not come from this app, so it was ignored.');
    return;
  }

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
    if (data.access_token) saveTokens(data);
    localStorage.removeItem('spotify_code_verifier');
  } catch (err) {
    console.error('Failed to exchange Spotify token:', err);
    showToast('No signal to finish connecting Spotify. Try again in a moment.');
  }
}

// Only one refresh at a time, across every open copy of the app:
// a rotated refresh token can only be used once
function refreshAccessToken() {
  if (!refreshToken && !localStorage.getItem(TOKEN_KEYS.refresh)) return Promise.resolve(false);
  if (!refreshPromise) {
    const run = () => doRefreshAccessToken();
    const locked = navigator.locks?.request
      ? navigator.locks.request('carlyrics-spotify-refresh', run)
      : run();
    refreshPromise = Promise.resolve(locked).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function doRefreshAccessToken() {
  // Another copy may have refreshed while we waited for the lock
  adoptStoredTokens();
  if (accessToken && Date.now() < tokenExpiresAt - 60000) return true;
  if (!refreshToken) return false;

  const usedRefreshToken = refreshToken;
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: usedRefreshToken
      })
    });

    const data = await response.json();
    if (data.access_token) {
      saveTokens(data);
      setOffline(false);
      return true;
    }
    // Revoked or expired for good: ask the user to connect again, unless another
    // copy of the app already swapped in a newer refresh token
    if (data.error === 'invalid_grant' || response.status === 400 || response.status === 401) {
      if (localStorage.getItem(TOKEN_KEYS.refresh) !== usedRefreshToken) {
        adoptStoredTokens();
        return !!accessToken;
      }
      signOut('Your Spotify sign-in expired. Tap Connect to sign in again.');
    }
    return false;
  } catch (err) {
    // No signal: keep the tokens and try again on the next poll
    setOffline(true);
    return false;
  }
}

function signOut(message) {
  Object.values(TOKEN_KEYS).forEach(k => localStorage.removeItem(k));
  accessToken = null;
  refreshToken = null;
  tokenExpiresAt = 0;
  grantedScopes = '';
  isAuthenticated = false;
  isPlaying = false;
  clearInterval(pollInterval);

  dom.loginBtn.hidden = false;
  dom.statusBadge.hidden = true;
  if (message) renderStateMessage('Signed out of Spotify', message);
}

function onSpotifyAuthenticated() {
  if (isAuthenticated) return;
  isAuthenticated = true;

  dom.loginBtn.hidden = true;
  dom.statusBadge.hidden = false;
  dom.statusText.textContent = 'Connected';
  if (!isDemoMode) {
    renderStateMessage('Play something on Spotify', 'Lyrics show up here as soon as a song starts.');
  }
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
// Spotify Real-time Playback Tracking & Local Clock
// -------------------------------------------------------------

// One local clock for both Spotify and demo playback. It advances by real
// elapsed time, so throttled timers never make the lyrics drift. It keeps
// running without signal: the song keeps playing in the car.
function startClock() {
  lastClockTick = performance.now();
  setInterval(() => {
    const now = performance.now();
    const elapsed = (now - lastClockTick) / 1000;
    lastClockTick = now;

    if (isPlaying && currentDurationSec > 0) {
      currentPositionSec += elapsed;
      if (currentPositionSec > currentDurationSec) {
        currentPositionSec = isDemoMode ? 0 : currentDurationSec;
      }
      updateProgressBar();
      highlightActiveLyric(currentPositionSec);
      scrollPlainLyrics();
    }

    // Passenger stopped scrolling: bring the current line back into view
    if (needsRecenter && Date.now() >= userScrollUntil) {
      needsRecenter = false;
      scrollToActiveLine();
    }
  }, 100);
}

function startSpotifyPolling() {
  clearInterval(pollInterval);
  pollInterval = setInterval(pollCurrentlyPlaying, POLL_INTERVAL_MS);
  pollCurrentlyPlaying();
}

function makeTrackKey(track) {
  // Local files have no Spotify id
  if (track.id) return track.id;
  return `local:${track.name}|${(track.artists || []).map(a => a.name).join(',')}|${track.duration_ms}`;
}

function trackInfo(track) {
  return {
    key: makeTrackKey(track),
    title: track.name,
    artists: (track.artists || []).map(a => a.name),
    album: track.album?.name || '',
    durationSec: track.duration_ms / 1000
  };
}

function isNetworkError(err) {
  return err instanceof TypeError || err?.name === 'TypeError';
}

function setOffline(offline) {
  if (isOffline === offline) return;
  isOffline = offline;
  dom.statusBadge.classList.toggle('offline', offline);
  if (offline) {
    dom.statusText.textContent = 'No signal';
  } else if (isAuthenticated && !isDemoMode) {
    dom.statusText.textContent = isPlaying ? 'Playing' : 'Connected';
  }
}

async function spotifyFetch(path, options = {}) {
  if (Date.now() > tokenExpiresAt - 60000) await refreshAccessToken();
  if (!accessToken) return null;

  const send = () => fetch(`${SPOTIFY_API}${path}`, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` }
  });

  let res = await send();
  if (res.status === 401 && await refreshAccessToken()) {
    res = await send();
  }
  if (res.status === 429) {
    // Rate limited: wait as long as Spotify asks before polling again
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
    pollBlockedUntil = Date.now() + Math.max(retryAfter, 1) * 1000;
  }
  return res;
}

function setPlaybackStatus(playing, label) {
  isPlaying = playing;
  dom.statusDot.classList.toggle('playing', playing);
  if (!isOffline) dom.statusText.textContent = label;
}

async function pollCurrentlyPlaying() {
  if (isDemoMode || !isAuthenticated) return;
  if (document.hidden || pollInFlight || Date.now() < pollBlockedUntil) return;

  pollInFlight = true;
  try {
    const sentAt = performance.now();
    const res = await spotifyFetch('/me/player/currently-playing');
    if (!res || isDemoMode) return;
    setOffline(false);

    if (res.status === 204) {
      // Nothing is playing any more: stop the local clock
      setPlaybackStatus(false, 'Nothing playing');
      if (!hasSeenTrack) {
        renderStateMessage('Play something on Spotify', 'Lyrics show up here as soon as a song starts.');
      }
      return;
    }
    if (!res.ok) return;

    const data = await res.json();
    if (!data || !data.item || data.currently_playing_type !== 'track') {
      setPlaybackStatus(false, data?.currently_playing_type === 'ad' ? 'Ad' : 'Paused');
      return;
    }

    const track = data.item;
    // progress_ms is already stale by the time it reaches us: add half the round trip
    const latencySec = data.is_playing ? (performance.now() - sentAt) / 2000 : 0;
    currentPositionSec = data.progress_ms / 1000 + latencySec;
    currentDurationSec = track.duration_ms / 1000;
    lastClockTick = performance.now();
    setPlaybackStatus(data.is_playing, data.is_playing ? 'Playing' : 'Paused');

    const info = trackInfo(track);
    if (info.key !== currentTrackKey) {
      currentTrackKey = info.key;
      currentTrackInfo = info;
      hasSeenTrack = true;

      dom.trackTitle.textContent = info.title;
      dom.artistName.textContent = info.artists.join(', ');

      const artUrl = track.album?.images?.[0]?.url || '';
      if (artUrl) {
        dom.albumArt.src = artUrl;
        dom.ambientBg.style.backgroundImage = `url('${artUrl}')`;
        applyAccentFromArt(track.album.images[track.album.images.length - 1]?.url || artUrl);
      }

      fetchLyrics(info);
      prefetchNextTrack();
    }

    updateProgressBar();
    highlightActiveLyric(currentPositionSec);
  } catch (err) {
    if (isNetworkError(err)) setOffline(true);
    else console.error('Playback poll error:', err);
  } finally {
    pollInFlight = false;
  }
}

// Fetch the next song's lyrics now so they appear the moment it starts
async function prefetchNextTrack() {
  try {
    const res = await spotifyFetch('/me/player/queue');
    if (!res || !res.ok) return;
    const data = await res.json();
    const next = (data.queue || []).find(item => item && item.type === 'track');
    if (!next) return;
    const info = trackInfo(next);
    if (info.key !== currentTrackKey) await resolveLyrics(info);
  } catch (err) {
    console.warn('Prefetch failed:', err);
  }
}

// Tap a line to jump the song there (Spotify Premium only)
async function seekTo(seconds) {
  const target = Math.max(0, seconds - getTimingOffset());

  if (isDemoMode || !isAuthenticated) {
    currentPositionSec = target;
    highlightActiveLyric(currentPositionSec);
    return;
  }

  if (!grantedScopes.split(' ').includes('user-modify-playback-state')) {
    showToast('Reconnect Spotify once to jump by tapping a line.', { label: 'Reconnect', onClick: loginWithSpotify });
    return;
  }

  try {
    const res = await spotifyFetch(`/me/player/seek?position_ms=${Math.round(target * 1000)}`, { method: 'PUT' });
    if (res && res.ok) {
      currentPositionSec = target;
      lastClockTick = performance.now();
      userScrollUntil = 0;
      highlightActiveLyric(currentPositionSec);
    } else if (res && res.status === 403) {
      showToast('Jumping to a line needs Spotify Premium.');
    } else if (res && res.status === 404) {
      showToast('No active Spotify device to control.');
    }
  } catch (err) {
    showToast(isNetworkError(err) ? 'No signal right now.' : 'Could not reach Spotify.');
  }
}

// -------------------------------------------------------------
// Romanization: every non-English script is shown in English letters
// -------------------------------------------------------------

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

// Any letter outside the Latin alphabet (Tamil, Hindi, Korean, Arabic, ...)
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

function needsRomanization(text) {
  return NON_LATIN_LETTER.test(text || '');
}

// Indic scheme name, 'other' for any other non-Latin script, 'mark' for
// combining marks (they belong to the preceding letter), null for Latin/punctuation
function classifyChar(ch) {
  const indic = scriptOfChar(ch);
  if (indic) return indic;
  if (/\p{M}/u.test(ch)) return 'mark';
  if (NON_LATIN_LETTER.test(ch)) return 'other';
  return null;
}

function romanize(text) {
  if (!text || !needsRomanization(text)) return text;
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
    const s = classifyChar(ch);
    // Spaces, punctuation and combining marks stay attached to the current run
    if (s !== 'mark' && s !== runScript && (s || /\p{L}/u.test(ch))) {
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
  if (script === 'other') return romanizeOther(text);
  if (typeof Sanscript === 'undefined') return text;
  try {
    return simplifyIast(Sanscript.t(text, script, 'iast'), script);
  } catch (err) {
    return text;
  }
}

// Korean, Chinese, Japanese, Cyrillic, Arabic, Thai, ... via any-ascii
function romanizeOther(text) {
  if (typeof window.anyAscii !== 'function') return text;
  try {
    let out = window.anyAscii(text);
    // any-ascii writes Chinese/Japanese as "WoAiNi": split into readable syllables
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
      out = out.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
    }
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) {
      out = out.toLowerCase();
    }
    return out;
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

  // Anusvara sounds like "n" before most consonants (thandi, kanda), "m" before p/b/m
  s = s.replace(/ṃ(?=[kgcjṭḍtdnyrlvśṣsh])/g, 'n');

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

// -------------------------------------------------------------
// Lyrics store: IndexedDB (fast, large), memory-only if unavailable
// -------------------------------------------------------------
const LYRICS_DB = 'carlyrics';
const LYRICS_STORE = 'lyrics';
const LYRICS_CACHE_MAX = 1000;
const LEGACY_CACHE_KEY = 'carlyrics_lyrics_cache_v1';
const OFFSETS_KEY = 'carlyrics_timing_offsets_v1';
const DEFAULT_TIMING_OFFSET = 0.5; // lyrics show half a second early unless a song says otherwise
const pendingLyrics = new Map(); // track key -> in-flight search promise
const memoryStore = new Map();
let dbPromise = null;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) || fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    return false;
  }
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openLyricsDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    let request;
    try {
      request = indexedDB.open(LYRICS_DB, 1);
    } catch (err) {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(LYRICS_STORE, { keyPath: 'key' });
      store.createIndex('usedAt', 'usedAt');
    };
    request.onsuccess = async () => {
      const db = request.result;
      await migrateLegacyCache(db);
      resolve(db);
    };
    // Private mode on some browsers: fall back to memory for this session
    request.onerror = () => resolve(null);
  });
  return dbPromise;
}

// Lyrics saved by the previous version lived in localStorage
async function migrateLegacyCache(db) {
  const legacy = readJson(LEGACY_CACHE_KEY, null);
  if (!legacy) return;
  try {
    const tx = db.transaction(LYRICS_STORE, 'readwrite');
    Object.entries(legacy).forEach(([key, entry]) => tx.objectStore(LYRICS_STORE).put({ ...entry, key }));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch (err) {
    console.warn('Lyrics cache migration failed:', err);
  }
}

async function getCachedLyrics(key) {
  const db = await openLyricsDb();
  let entry = null;
  try {
    entry = db
      ? await idbRequest(db.transaction(LYRICS_STORE).objectStore(LYRICS_STORE).get(key))
      : memoryStore.get(key);
  } catch (err) {
    entry = memoryStore.get(key);
  }
  // Fallback lyrics expire so LRCLIB gets re-checked for a synced version
  if (!entry || (entry.expiresAt && Date.now() > entry.expiresAt)) return null;
  return entry;
}

async function cacheLyrics(key, entry) {
  const record = { ...entry, key, usedAt: Date.now() };
  memoryStore.set(key, record);
  const db = await openLyricsDb();
  if (!db) return;
  try {
    const store = db.transaction(LYRICS_STORE, 'readwrite').objectStore(LYRICS_STORE);
    await idbRequest(store.put(record));
    pruneLyricsCache(db);
  } catch (err) {
    console.warn('Could not save lyrics:', err);
  }
}

// Keep the most recently used songs only
async function pruneLyricsCache(db) {
  const store = db.transaction(LYRICS_STORE, 'readwrite').objectStore(LYRICS_STORE);
  const count = await idbRequest(store.count());
  let excess = count - LYRICS_CACHE_MAX;
  if (excess <= 0) return;
  const cursorRequest = store.index('usedAt').openCursor();
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor || excess <= 0) return;
    cursor.delete();
    excess--;
    cursor.continue();
  };
}

const FALLBACK_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const FALLBACK_TIMEOUT_MS = 10000;

// Our Vercel function: English-letter lyrics from tamil2lyrics.com for songs LRCLIB lacks.
// Returns lyrics, null (not found) or { offline: true }.
async function fetchFallbackLyrics(info) {
  const params = new URLSearchParams({
    title: info.title.trim().slice(0, 120),
    artists: info.artists.slice(0, 4).join(','),
    album: info.album.trim().slice(0, 120)
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
  try {
    const res = await fetch(`/api/fallback-lyrics?${params}`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.plainLyrics) return null;
    return {
      syncedLyrics: null,
      plainLyrics: data.plainLyrics,
      source: data.source,
      sourceUrl: data.url,
      expiresAt: Date.now() + FALLBACK_TTL_MS
    };
  } catch (err) {
    return isNetworkError(err) || err?.name === 'AbortError' ? { offline: true } : null;
  } finally {
    clearTimeout(timer);
  }
}

function buildQuery({ title, artists, album, durationSec }) {
  const cleanTitle = cleanSongTitle(title) || title;
  return {
    rawTitle: title,
    cleanTitle,
    shortTitle: cleanTitle.split(' - ')[0].trim(),
    artists: artists.flatMap(a => a.split(/[,;&]/)).map(a => a.trim()).filter(Boolean),
    album,
    durationSec,
    language: detectSongLanguage(title, album)
  };
}

// Cached lyrics, or one shared search per song (current track and prefetch).
// Resolves to a lyrics entry, null (nothing anywhere) or { offline: true }.
function resolveLyrics(info) {
  if (pendingLyrics.has(info.key)) return pendingLyrics.get(info.key);

  const promise = (async () => {
    const cached = await getCachedLyrics(info.key);
    if (cached) {
      cacheLyrics(info.key, cached); // mark as recently used
      return cached;
    }

    // Not tied to a track change: a prefetched search should still finish and be cached
    const query = buildQuery(info);
    const { result, offline } = await findLyrics(query, new AbortController().signal);
    if (offline) return { offline: true };

    let entry = result
      ? { syncedLyrics: result.syncedLyrics || null, plainLyrics: result.plainLyrics || null, source: 'LRCLIB', sourceUrl: 'https://lrclib.net' }
      : null;

    // LRCLIB only has another language's version (e.g. the Telugu dub of a Tamil song):
    // the right-language lyrics from the fallback beat synced lyrics in the wrong language
    const script = entry && dominantIndicScript(entry.syncedLyrics || entry.plainLyrics);
    const wrongLanguage = script && script !== query.language && query.language === 'tamil';

    let keep = true;
    if (!entry || wrongLanguage) {
      const fallback = await fetchFallbackLyrics(info);
      if (fallback?.offline) {
        if (!entry) return { offline: true };
        keep = false; // show the other-language lyrics now, look again next time
      } else if (fallback) {
        entry = fallback;
      }
    }
    if (!entry) return null;
    if (keep) await cacheLyrics(info.key, entry);
    return entry;
  })().catch((err) => {
    console.warn('Lyrics search failed:', err);
    return null;
  }).finally(() => pendingLyrics.delete(info.key));

  pendingLyrics.set(info.key, promise);
  return promise;
}

function resetLyricsState() {
  lyrics = [];
  plainLines = [];
  activeLyricId = null;
  needsRecenter = false;
  userScrollUntil = 0;
  plainMode = false;
  clearTimeout(lyricsRetryTimer);
  exitSyncMode(false);
  updateSyncStart();
  updateTimingControl();
}

async function fetchLyrics(info) {
  const requestId = ++lyricsRequestId;
  resetLyricsState();

  const cached = await getCachedLyrics(info.key);
  if (requestId !== lyricsRequestId) return;
  if (!cached) renderLoading();
  const lyricsData = cached || await resolveLyrics(info);
  if (cached) cacheLyrics(info.key, cached);

  // A newer track started while we were searching: drop this stale result
  if (requestId !== lyricsRequestId) return;
  renderLyricsData(info, lyricsData, requestId);
}

function renderLyricsData(info, lyricsData, requestId) {
  if (lyricsData?.offline) {
    // No signal: show it, and try again as soon as the network is back
    renderStateMessage('Waiting for signal', 'Lyrics will load as soon as you are back in coverage.');
    scheduleLyricsRetry(info, requestId);
  } else if (lyricsData?.syncedLyrics) {
    lyrics = parseLRC(lyricsData.syncedLyrics, requestId);
    renderLyrics(lyrics, lyricsData);
    updateTimingControl();
    highlightActiveLyric(currentPositionSec);
  } else if (lyricsData?.plainLyrics) {
    renderPlainLyrics(lyricsData.plainLyrics, lyricsData);
  } else {
    const query = buildQuery(info);
    const searchUrl = new URL('https://www.google.com/search');
    searchUrl.searchParams.set('q', `${query.shortTitle} ${query.artists[0] || ''} lyrics in english`);
    renderStateMessage(
      'No lyrics yet',
      'New songs usually reach the lyrics libraries within a few days. We check again every time it plays.',
      { label: 'Search lyrics on the web', href: searchUrl.toString() }
    );
  }
}

function scheduleLyricsRetry(info, requestId) {
  clearTimeout(lyricsRetryTimer);
  const retry = () => {
    window.removeEventListener('online', retry);
    clearTimeout(lyricsRetryTimer);
    if (requestId === lyricsRequestId && info.key === currentTrackKey) fetchLyrics(info);
  };
  window.addEventListener('online', retry, { once: true });
  lyricsRetryTimer = setTimeout(retry, OFFLINE_RETRY_MS);
}

// -------------------------------------------------------------
// Timing nudge (per song: some lyrics run early or late)
// -------------------------------------------------------------
let timingOffsets = {};

function loadOffsets() {
  timingOffsets = readJson(OFFSETS_KEY, {});
  // Another open copy of the app changed a song's timing
  window.addEventListener('storage', (e) => {
    if (e.key === OFFSETS_KEY) {
      timingOffsets = readJson(OFFSETS_KEY, {});
      activeLyricId = null;
      updateTimingControl();
    }
  });
}

function getTimingOffset() {
  if (!currentTrackKey || isDemoMode) return 0;
  const saved = timingOffsets[currentTrackKey];
  return typeof saved === 'number' ? saved : DEFAULT_TIMING_OFFSET;
}

function changeTimingOffset(delta) {
  if (!currentTrackKey) return;
  const next = Math.round((getTimingOffset() + delta) * 10) / 10;
  const clamped = Math.max(-10, Math.min(10, next));
  // Store every explicit choice (including 0) so it wins over the default
  if (clamped === DEFAULT_TIMING_OFFSET) delete timingOffsets[currentTrackKey];
  else timingOffsets[currentTrackKey] = clamped;
  writeJson(OFFSETS_KEY, timingOffsets);

  activeLyricId = null;
  updateTimingControl();
  highlightActiveLyric(currentPositionSec);
}

function updateTimingControl() {
  if (!dom.timing) return;
  const show = lyrics.length > 0 && !isDemoMode && !syncState;
  dom.timing.hidden = !show;
  if (!show) return;
  const offset = getTimingOffset();
  dom.timingValue.textContent = offset === 0 ? 'On beat' : `${offset > 0 ? 'Early' : 'Late'} ${Math.abs(offset).toFixed(1)}s`;
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
    const text = romanize(rawText);

    // A line can carry several timestamps when it repeats (e.g. a chorus)
    stamps.forEach((m, n) => {
      const fractionStr = m[3] || '0';
      const fraction = parseFloat(fractionStr) / Math.pow(10, fractionStr.length);
      result.push({
        id: `lyric-${requestId}-${index}-${n}`,
        text,
        timestamp: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + fraction
      });
    });
  });

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

function renderLoading() {
  const wrapper = document.createElement('div');
  wrapper.className = 'skeleton';
  wrapper.setAttribute('aria-label', 'Loading lyrics');
  [72, 54, 86, 40, 64].forEach((width) => {
    const bar = document.createElement('div');
    bar.className = 'skeleton-line';
    bar.style.width = `${width}%`;
    wrapper.appendChild(bar);
  });
  dom.lyricsContainer.replaceChildren(wrapper);
  dom.lyricsContainer.scrollTop = 0;
}

function renderStateMessage(title, message, action = null) {
  const wrapper = document.createElement('div');
  wrapper.className = 'state-message';
  const h2 = document.createElement('h2');
  h2.textContent = title;
  const p = document.createElement('p');
  p.textContent = message;
  wrapper.append(h2, p);
  if (action) {
    const actions = document.createElement('div');
    actions.className = 'state-actions';
    const link = document.createElement('a');
    link.className = 'btn btn-outline';
    link.href = action.href;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = action.label;
    actions.appendChild(link);
    wrapper.appendChild(actions);
  }
  dom.lyricsContainer.replaceChildren(wrapper);
  dom.lyricsContainer.scrollTop = 0;
}

function sourceCredit(meta) {
  const credit = document.createElement('div');
  credit.className = 'lyrics-credit';
  if (meta.source === 'you') {
    credit.textContent = 'Synced by you on this device';
    return credit;
  }
  if (!meta.source) return null;
  credit.append('Lyrics from ');
  if (meta.sourceUrl) {
    const link = document.createElement('a');
    link.href = meta.sourceUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = meta.source;
    credit.append(link);
  } else {
    credit.append(meta.source);
  }
  return credit;
}

function renderPlainLyrics(plainText, meta = {}) {
  plainLines = plainText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(romanize);

  const header = document.createElement('div');
  header.className = 'plain-header';
  const label = document.createElement('span');
  label.className = 'plain-label';
  label.textContent = 'Not synced, scrolls with the song';
  header.append(label);
  plainMeta = meta;

  const nodes = plainLines.map((line) => {
    const div = document.createElement('div');
    div.className = 'lyric-line plain';
    div.textContent = line;
    return div;
  });

  const credit = sourceCredit(meta);
  dom.lyricsContainer.replaceChildren(header, ...nodes, ...(credit ? [credit] : []));
  dom.lyricsContainer.scrollTop = 0;
  plainMode = true;
  updateSyncStart();
}

function updateSyncStart() {
  if (dom.syncStart) dom.syncStart.hidden = !(plainMode && !syncState && plainLines.length > 0);
}

// Unsynced lyrics: keep the part of the song we're probably at in the middle of the screen
function scrollPlainLyrics() {
  if (!plainMode || syncState || currentDurationSec <= 0 || Date.now() < userScrollUntil) return;
  const el = dom.lyricsContainer;
  const max = el.scrollHeight - el.clientHeight;
  if (max <= 0) return;
  const target = max * Math.min(1, currentPositionSec / currentDurationSec);
  // Ease towards the target so it glides instead of jumping on each poll
  el.scrollTop += (target - el.scrollTop) * 0.08;
}

function renderLyrics(lyricItems, meta = {}) {
  const nodes = lyricItems.map((item) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = item.id;
    div.textContent = item.text;
    // Lines are buttons: tap, Enter or Space jumps the song there
    div.setAttribute('role', 'button');
    div.tabIndex = 0;
    div.addEventListener('click', () => seekTo(item.timestamp));
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        seekTo(item.timestamp);
      }
    });
    return div;
  });
  const credit = sourceCredit(meta);
  dom.lyricsContainer.replaceChildren(...nodes, ...(credit ? [credit] : []));
  dom.lyricsContainer.scrollTop = 0;
}

function highlightActiveLyric(seconds) {
  if (!lyrics.length) return;

  const position = seconds + getTimingOffset();
  let activeIndex = -1;
  for (let i = 0; i < lyrics.length; i++) {
    if (lyrics[i].timestamp > position) break;
    activeIndex = i;
  }

  const activeId = activeIndex >= 0 ? lyrics[activeIndex].id : null;
  if (activeLyricId === activeId) return;
  activeLyricId = activeId;

  // Lines already sung fade further back than the ones coming up.
  // Before the first line (e.g. after seeking back) nothing is highlighted.
  lyrics.forEach((line, i) => {
    const el = document.getElementById(line.id);
    if (!el) return;
    el.classList.toggle('active', i === activeIndex);
    el.classList.toggle('past', activeIndex >= 0 && i < activeIndex);
  });

  if (Date.now() < userScrollUntil) {
    needsRecenter = true;
  } else {
    scrollToActiveLine();
  }
}

function scrollToActiveLine() {
  const target = activeLyricId
    ? document.getElementById(activeLyricId)
    : (lyrics[0] && document.getElementById(lyrics[0].id));
  if (!target) return;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
}

// A passenger scrolling to read ahead or back: hold auto-scroll for a few seconds
function onUserScroll() {
  userScrollUntil = Date.now() + USER_SCROLL_PAUSE_MS;
  needsRecenter = true;
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

function showToast(message, action = null) {
  if (!dom.toast) return;
  const text = document.createElement('span');
  text.textContent = message;
  const nodes = [text];
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = action.label;
    btn.addEventListener('click', action.onClick);
    nodes.push(btn);
  }
  dom.toast.replaceChildren(...nodes);
  dom.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, action ? 8000 : 4000);
}

// -------------------------------------------------------------
// Tap-to-sync: turn unsynced lyrics into synced ones by tapping along
// -------------------------------------------------------------
function enterSyncMode(meta) {
  if (!plainLines.length || !currentTrackKey) return;
  syncState = { lines: plainLines.slice(), times: [], index: 0, meta, trackKey: currentTrackKey };

  const intro = document.createElement('div');
  intro.className = 'plain-header';
  const label = document.createElement('span');
  label.className = 'plain-label';
  label.textContent = 'Tap the button the moment each line starts';
  intro.append(label);

  const nodes = syncState.lines.map((line, i) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = `sync-line-${i}`;
    div.textContent = line;
    return div;
  });
  dom.lyricsContainer.replaceChildren(intro, ...nodes);
  plainMode = false;
  updateSyncStart();
  dom.syncBar.hidden = false;
  updateTimingControl();
  updateSyncView();
}

function updateSyncView() {
  if (!syncState) return;
  const { lines, index } = syncState;
  dom.syncProgress.textContent = `Line ${Math.min(index + 1, lines.length)} of ${lines.length}`;
  dom.syncUndo.disabled = index === 0;
  lines.forEach((_, i) => {
    const el = document.getElementById(`sync-line-${i}`);
    if (!el) return;
    el.classList.toggle('active', i === index);
    el.classList.toggle('past', i < index);
  });
  const next = document.getElementById(`sync-line-${index}`);
  if (next) next.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function syncTap() {
  if (!syncState || syncState.trackKey !== currentTrackKey) return exitSyncMode(false);
  syncState.times[syncState.index] = currentPositionSec;
  syncState.index++;
  if (syncState.index >= syncState.lines.length) {
    finishSync();
  } else {
    updateSyncView();
  }
}

function syncUndo() {
  if (!syncState || syncState.index === 0) return;
  syncState.index--;
  syncState.times.length = syncState.index;
  updateSyncView();
}

function formatLrcTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

async function finishSync() {
  const { lines, times, meta, trackKey } = syncState;
  const lrc = lines.map((line, i) => `[${formatLrcTime(times[i])}]${line}`).join('\n');
  exitSyncMode(false);

  // Saved for good on this device (no expiry), replacing the unsynced copy
  const entry = { syncedLyrics: lrc, plainLyrics: lines.join('\n'), source: 'you', sourceUrl: meta?.sourceUrl || null };
  await cacheLyrics(trackKey, entry);
  if (trackKey !== currentTrackKey) return;

  // Taps land after the singer starts: these lyrics run on the default early offset
  lyrics = parseLRC(lrc, ++lyricsRequestId);
  renderLyrics(lyrics, entry);
  updateTimingControl();
  highlightActiveLyric(currentPositionSec);
  showToast('Synced. These lyrics now follow the song every time it plays.');
}

function exitSyncMode(restore = true) {
  if (!syncState) return;
  const meta = syncState.meta;
  const lines = syncState.lines;
  syncState = null;
  if (dom.syncBar) dom.syncBar.hidden = true;
  if (restore) renderPlainLyrics(lines.join('\n'), meta);
  updateTimingControl();
}

// -------------------------------------------------------------
// Look & feel: album accent colour, text size, fullscreen
// -------------------------------------------------------------
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

// Pick the album's most colourful tone and make it readable on the dark UI
function applyAccentFromArt(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      const size = 24;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);

      // Bucket hues, weighting saturated mid-tone pixels
      const buckets = new Array(36).fill(0);
      for (let i = 0; i < data.length; i += 4) {
        const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        if (s < 0.25 || l < 0.15 || l > 0.85) continue;
        buckets[Math.floor(h / 10) % 36] += s * (1 - Math.abs(l - 0.5));
      }
      const best = buckets.indexOf(Math.max(...buckets));
      if (buckets[best] < 2) return resetAccent(); // grey / black-and-white covers
      const hue = best * 10 + 5;
      document.documentElement.style.setProperty('--accent', `hsl(${hue} 62% 58%)`);
      document.documentElement.style.setProperty('--accent-ink', `hsl(${hue} 60% 10%)`);
    } catch (err) {
      resetAccent();
    }
  };
  img.onerror = resetAccent;
  img.src = url;
}

function resetAccent() {
  document.documentElement.style.removeProperty('--accent');
  document.documentElement.style.removeProperty('--accent-ink');
}

const TEXT_SIZES = [
  { scale: 0.85, label: 'Small' },
  { scale: 1, label: 'Medium' },
  { scale: 1.18, label: 'Large' },
  { scale: 1.36, label: 'Extra large' }
];
const TEXT_SIZE_KEY = 'carlyrics_text_size';

function applyTextSize() {
  let index = parseInt(localStorage.getItem(TEXT_SIZE_KEY) || '1', 10);
  if (!TEXT_SIZES[index]) index = 1;
  document.documentElement.style.setProperty('--lyric-scale', TEXT_SIZES[index].scale);
  if (dom.textSizeBtn) {
    dom.textSizeBtn.title = `Text size: ${TEXT_SIZES[index].label}`;
    dom.textSizeBtn.setAttribute('aria-label', `Text size: ${TEXT_SIZES[index].label}`);
  }
  return index;
}

function cycleTextSize() {
  const index = (applyTextSize() + 1) % TEXT_SIZES.length;
  localStorage.setItem(TEXT_SIZE_KEY, String(index));
  applyTextSize();
  showToast(`Text size: ${TEXT_SIZES[index].label}`);
  // Keep the current line centred at the new size
  setTimeout(scrollToActiveLine, 50);
}

function setupFullscreen() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  if (!dom.fullscreenBtn || !document.fullscreenEnabled || standalone) return;
  dom.fullscreenBtn.hidden = false;
  const update = () => {
    dom.fullscreenBtn.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  };
  dom.fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  document.addEventListener('fullscreenchange', update);
  update();
}

// -------------------------------------------------------------
// In-Car Demo Mode (Instant Test without Spotify Login)
// -------------------------------------------------------------
function startDemoMode() {
  isDemoMode = true;
  currentTrackKey = 'demo';
  currentPositionSec = 0;
  currentDurationSec = 200;
  lastClockTick = performance.now();

  // Cancel any in-flight Spotify lyrics search so it can't overwrite the demo
  const requestId = ++lyricsRequestId;
  resetLyricsState();

  dom.trackTitle.textContent = 'Blinding Lights';
  dom.artistName.textContent = 'The Weeknd';
  dom.statusBadge.hidden = false;
  setPlaybackStatus(true, 'Demo');

  const demoAlbumArt = 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36';
  dom.albumArt.src = demoAlbumArt;
  dom.ambientBg.style.backgroundImage = `url('${demoAlbumArt}')`;
  applyAccentFromArt(demoAlbumArt);

  const demoLRC = `
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
  highlightActiveLyric(currentPositionSec);
}

// -------------------------------------------------------------
// Passenger QR Code Sharing (generated on the device)
// -------------------------------------------------------------
function showQrCodeModal() {
  if (typeof qrcode === 'function') {
    const qr = qrcode(0, 'M');
    qr.addData(getRedirectUri());
    qr.make();
    dom.qrCode.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  }
  dom.qrModal.classList.add('open');
}

function hideQrCodeModal() {
  dom.qrModal.classList.remove('open');
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------
function setupEventListeners() {
  const copyUriBtn = document.getElementById('copy-uri-btn');
  if (copyUriBtn) {
    copyUriBtn.addEventListener('click', () => {
      const uri = getRedirectUri();
      navigator.clipboard.writeText(uri).then(() => {
        const originalText = copyUriBtn.textContent;
        copyUriBtn.textContent = 'Copied';
        setTimeout(() => { copyUriBtn.textContent = originalText; }, 2500);
      });
    });
  }

  ['wheel', 'touchmove', 'keydown'].forEach((type) => {
    dom.lyricsContainer.addEventListener(type, onUserScroll, { passive: true });
  });

  dom.timingEarlier.addEventListener('click', () => changeTimingOffset(0.5));
  dom.timingLater.addEventListener('click', () => changeTimingOffset(-0.5));
  dom.textSizeBtn.addEventListener('click', cycleTextSize);
  setupFullscreen();

  const placeholderArt = dom.albumArt.getAttribute('src');
  dom.albumArt.addEventListener('error', () => {
    if (dom.albumArt.getAttribute('src') === placeholderArt) return;
    dom.albumArt.src = placeholderArt;
    dom.ambientBg.style.backgroundImage = '';
    resetAccent();
  });

  dom.syncStart.addEventListener('click', () => enterSyncMode(plainMeta));
  dom.syncTap.addEventListener('click', syncTap);
  dom.syncUndo.addEventListener('click', syncUndo);
  dom.syncCancel.addEventListener('click', () => exitSyncMode(true));
  document.addEventListener('keydown', (e) => {
    if (syncState && e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      syncTap();
    }
  });

  // Catch up straight away when the screen comes back on or signal returns
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollCurrentlyPlaying();
  });
  window.addEventListener('online', () => pollCurrentlyPlaying());

  // Another open copy of the app signed in, renewed or signed out
  window.addEventListener('storage', (e) => {
    if (!Object.values(TOKEN_KEYS).includes(e.key)) return;
    adoptStoredTokens();
    if (refreshToken && !isAuthenticated) onSpotifyAuthenticated();
    if (!refreshToken && !accessToken && isAuthenticated) signOut('Signed out in another window.');
  });

  dom.loginBtn.addEventListener('click', loginWithSpotify);
  dom.demoBtn.addEventListener('click', startDemoMode);
  dom.qrBtn.addEventListener('click', showQrCodeModal);
  dom.closeQrBtn.addEventListener('click', hideQrCodeModal);
  dom.qrModal.addEventListener('click', (e) => {
    if (e.target === dom.qrModal) hideQrCodeModal();
  });
}
