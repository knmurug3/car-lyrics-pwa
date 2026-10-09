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
  return window.location.origin + window.location.pathname;
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

async function pollCurrentlyPlaying() {
  if (isDemoMode) return;
  if (!accessToken) return;

  if (Date.now() > tokenExpiresAt - 60000) {
    await refreshAccessToken();
  }

  try {
    const res = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (res.status === 204 || res.status > 400) {
      if (res.status === 401) await refreshAccessToken();
      return;
    }

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

      fetchLyrics(currentTrackTitle, currentArtist, Math.round(currentDurationSec));
    }

    updateProgressBar();
    highlightActiveLyric(currentPositionSec);
  } catch (err) {
    console.error('Playback poll error:', err);
  }
}

// -------------------------------------------------------------
// LRCLIB Synced Lyrics API Engine
// -------------------------------------------------------------
async function fetchLyrics(track, artist, durationSec) {
  dom.lyricsContainer.innerHTML = `
    <div class="state-message">
      <div class="spinner"></div>
      <h2>Fetching Synced Lyrics</h2>
      <p>Searching for synchronized timestamps...</p>
    </div>
  `;

  try {
    const url = new URL('https://lrclib.net/api/get');
    url.searchParams.set('track_name', track);
    url.searchParams.set('artist_name', artist);
    url.searchParams.set('duration', durationSec);

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'CarLyricsPWA/1.0.0 (https://github.com/carlyrics)'
      }
    });

    if (!res.ok) throw new Error('Lyrics not found');
    const data = await res.json();

    if (data.syncedLyrics) {
      lyrics = parseLRC(data.syncedLyrics);
      renderLyrics(lyrics);
      highlightActiveLyric(currentPositionSec);
    } else {
      renderNoLyrics('Synced lyrics not found for this song.');
    }
  } catch (err) {
    renderNoLyrics('No synchronized lyrics found for this track.');
  }
}

function parseLRC(lrcText) {
  const lines = lrcText.split('\n');
  const result = [];
  const regex = /^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)$/;

  lines.forEach((line, index) => {
    const match = line.trim().match(regex);
    if (match) {
      const minutes = parseFloat(match[1]);
      const seconds = parseFloat(match[2]);
      const fractionStr = match[3];
      const fraction = parseFloat(fractionStr) / (fractionStr.length === 3 ? 1000 : 100);
      const timestamp = (minutes * 60) + seconds + fraction;
      const text = match[4].trim();

      if (text) {
        result.push({ id: `lyric-${index}`, timestamp, text });
      }
    }
  });

  return result.sort((a, b) => a.timestamp - b.timestamp);
}

function renderLyrics(lyricItems) {
  dom.lyricsContainer.innerHTML = '';
  lyricItems.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'lyric-line';
    div.id = item.id;
    div.textContent = item.text;
    div.addEventListener('click', () => {
      // Manual click line preview
      currentPositionSec = item.timestamp;
      highlightActiveLyric(currentPositionSec);
    });
    dom.lyricsContainer.appendChild(div);
  });
}

function renderNoLyrics(msg) {
  dom.lyricsContainer.innerHTML = `
    <div class="state-message">
      <h2>🎵 Instrumental or Unsynced</h2>
      <p>${msg}</p>
    </div>
  `;
}

function highlightActiveLyric(seconds) {
  if (!lyrics.length) return;

  const active = lyrics.filter(l => l.timestamp <= seconds).slice(-1)[0];
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

  lyrics = parseLRC(demoLRC);
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
  dom.loginBtn.addEventListener('click', loginWithSpotify);
  dom.demoBtn.addEventListener('click', startDemoMode);
  dom.qrBtn.addEventListener('click', showQrCodeModal);
  dom.closeQrBtn.addEventListener('click', hideQrCodeModal);
  dom.qrModal.addEventListener('click', (e) => {
    if (e.target === dom.qrModal) hideQrCodeModal();
  });
}
