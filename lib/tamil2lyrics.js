// Finds English-letter lyrics on tamil2lyrics.com for songs LRCLIB doesn't have yet
// (mostly brand-new Tamil songs). Reads only song, film and sitemap pages, which the
// site's robots.txt allows; its search pages are never used.

const SITE = 'https://www.tamil2lyrics.com';
const USER_AGENT = 'Paadu/1.0 (+https://github.com/knmurug3/car-lyrics-pwa)';
const FETCH_TIMEOUT_MS = 6000;
const SITEMAP_TTL_MS = 6 * 60 * 60 * 1000;
// The newest-songs sitemap (the one updated most recently); robots.txt advertises it for discovery
const NEWEST_SITEMAP = `${SITE}/lyrics-sitemap.xml`;

let sitemapCache = { at: 0, slugs: [] }; // reused while this function instance stays warm

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '-', mdash: '-' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function normalize(text) {
  return decodeEntities(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(text) {
  return normalize(text).replace(/\s+/g, '-');
}

// Same cleanup the app uses: drop "(From "Movie")", "feat." and friends
function cleanTitle(title) {
  return (title || '')
    .replace(/[([{](?:from|feat|ft|ost|soundtrack|original|tamil|telugu|hindi|malayalam|kannada|remastered|lyric).*?[)\]}]/gi, '')
    .replace(/\s-\s*(?:from|ost|soundtrack|original|reprise|version|remastered).*$/gi, '')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Film name from 'Song (From "Jailer 2")' or an album like 'Jailer 2 (Original Motion Picture Soundtrack)'
function filmNames(title, album) {
  const names = [];
  const fromMatch = `${title} ${album}`.match(/from\s+["“]([^"”]+)["”]/i);
  if (fromMatch) names.push(fromMatch[1]);
  const albumClean = (album || '').replace(/[([].*?[)\]]/g, '').replace(/\s-\s.*$/, '').trim();
  // A single's album is just the song title again: that says nothing about the film
  const song = normalize(cleanTitle(title));
  const albumNorm = normalize(albumClean);
  if (albumNorm && albumNorm !== song && !song.includes(albumNorm) && !albumNorm.includes(song)) {
    names.push(albumClean);
  }
  return [...new Set(names.filter(Boolean))];
}

// Tamil titles get spelled many ways in English (Vermari / Veramaari / Vera Maari):
// compare consonant skeletons with doubled letters collapsed
function skeleton(text) {
  return normalize(text).replace(/\s+/g, '').replace(/(.)\1+/g, '$1').replace(/[aeiouy]/g, '').replace(/h/g, '');
}

function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

function titlesMatch(wanted, candidate) {
  const a = normalize(wanted).replace(/\s+/g, '');
  const b = normalize(candidate).replace(/\s+/g, '');
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const sa = skeleton(wanted);
  const sb = skeleton(candidate);
  return sa.length >= 3 && editDistance(sa, sb) <= Math.max(1, Math.floor(sa.length / 5));
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: controller.signal, redirect: 'follow' });
    if (!res.ok) return null;
    return await res.text();
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function newestSongSlugs() {
  if (Date.now() - sitemapCache.at < SITEMAP_TTL_MS && sitemapCache.slugs.length) return sitemapCache.slugs;
  const xml = await fetchPage(NEWEST_SITEMAP);
  if (!xml) return sitemapCache.slugs;
  const slugs = [];
  const re = /\/lyrics\/([a-z0-9-]+)\/\s*(?:\]\]>)?\s*<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) slugs.push(m[1]);
  sitemapCache = { at: Date.now(), slugs };
  return slugs;
}

function slugToName(slug) {
  return slug.replace(/-song-lyrics.*$/, '').replace(/-lyrics$/, '').replace(/-/g, ' ');
}

// Song links on a film page or in a song page's "More from <film>" list
function songLinks(html) {
  const links = new Map();
  const re = /href="https:\/\/www\.tamil2lyrics\.com\/lyrics\/([a-z0-9-]+)\/"/g;
  let m;
  while ((m = re.exec(html))) {
    links.set(m[1], slugToName(m[1]));
  }
  return links;
}

const LABEL = /^(?:(?:male|female|chorus|both|all|kids?|group|boys|girls|men|women|humming|rap|singers?)\s*(?:(?:and|&|\+|,)\s*)?)+(?:part)?\s*(?::|-)?\s*/i;
const PAGE_CONTROLS = /^(?:a\s*[−+-]|copy|copied|share|print|font size|english|tamil)$/i;
const CREDIT = /^(?:singers?|music(?: director| directors| by)?|lyric(?:s|ist)(?: by)?|humming|starring|composer|movie|film|written by|programmed|mixed)\b.*?:/i;

function textLines(htmlFragment) {
  const withBreaks = htmlFragment
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withBreaks).split('\n').map(l => l.replace(/\s+/g, ' ').trim());
}

function extractLyrics(html) {
  // The article runs from the credits to the "More from" list / comments
  let start = html.search(/Music Director|Lyricist/);
  if (start < 0) return null;
  let body = html.slice(start);
  for (const stop of ['More from', 'Leave a Comment', 'id="comments"', 't2l-share']) {
    const k = body.indexOf(stop);
    if (k > 0) body = body.slice(0, k);
  }

  const lines = textLines(body);
  // English-letter section: after the "English" tab label, before the "Tamil" one
  let from = lines.findIndex(l => /^english$/i.test(l));
  let to = lines.findIndex((l, i) => i > from && /^tamil$/i.test(l));
  if (from < 0) from = 0;
  if (to < 0) to = lines.length;
  // Lyrics start after the credits block (Singer / Music Director / Lyricist ...)
  const section = lines.slice(from + 1, to);
  let lastCredit = -1;
  section.slice(0, 30).forEach((l, i) => { if (CREDIT.test(l)) lastCredit = i; });

  const out = [];
  for (const raw of section.slice(lastCredit + 1)) {
    if (PAGE_CONTROLS.test(raw)) continue;
    // The site's own description paragraph ("X Song Lyrics is the track from ... starring ...")
    if (/\bsong lyrics\b/i.test(raw) || (raw.length > 120 && /\b(starring|composed|penned|sung by)\b/i.test(raw))) continue;
    if (/[஀-௿]/.test(raw)) continue; // Tamil script: the app shows English letters only
    if (CREDIT.test(raw)) continue;
    const text = raw.replace(LABEL, '').trim();
    if (!text || /^[.…\-–—_*~]+$/.test(text)) { // blank, or "…………" placeholders
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(text);
  }
  while (out.length && out[out.length - 1] === '') out.pop();

  const lyricLines = out.filter(Boolean);
  // Too short to be real lyrics (e.g. a page with only credits)
  if (lyricLines.length < 6) return null;
  return out.join('\n');
}

// Accept the page only if it is about the same film or the same artists
// Only the page's own title and credits count: menus and "popular songs" lists
// on every page name the same big composers
function pageIdentity(html) {
  const credits = html.search(/Music Director|Lyricist/);
  const creditText = credits >= 0 ? html.slice(credits, credits + 1500).replace(/<[^>]+>/g, ' ') : '';
  return ` ${normalize(`${pageTitle(html)} ${creditText}`)} `;
}

function containsPhrase(haystack, phrase) {
  const p = normalize(phrase);
  return p.length > 1 && haystack.includes(` ${p} `);
}

// When Spotify tells us the film, the page must be from that film.
// Otherwise the credits must name one of the artists.
function pageMatches(html, films, artists) {
  const identity = pageIdentity(html);
  if (films.length) return films.some(f => containsPhrase(identity, f));
  return artists.some(a => normalize(a).length > 3 && containsPhrase(identity, a));
}

function pageTitle(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

async function findOnTamil2Lyrics({ title, artists, album }) {
  const wanted = cleanTitle(title);
  const films = filmNames(title, album);
  if (!wanted) return null;

  const tryPage = async (slug) => {
    const url = `${SITE}/lyrics/${slug}/`;
    const html = await fetchPage(url);
    if (!html || !pageMatches(html, films, artists)) return null;
    const plainLyrics = extractLyrics(html);
    return plainLyrics ? { url, html, plainLyrics } : { url, html, plainLyrics: null };
  };

  // 1) Direct song page from the title
  const direct = await tryPage(`${slugify(wanted)}-song-lyrics`);
  if (direct?.plainLyrics) return direct;

  // 2) Fuzzy match against the film's song list (film page + a song page's "More from" list)
  const candidates = new Map();
  for (const film of films) {
    const html = await fetchPage(`${SITE}/movie/${slugify(film)}/`);
    if (html) songLinks(html).forEach((name, slug) => candidates.set(slug, name));
    if (candidates.size) break;
  }
  if (direct?.html) songLinks(direct.html).forEach((name, slug) => candidates.set(slug, name));
  const firstSong = [...candidates.keys()][0];
  if (firstSong && !direct?.html) {
    const html = await fetchPage(`${SITE}/lyrics/${firstSong}/`);
    if (html) songLinks(html).forEach((name, slug) => candidates.set(slug, name));
  }

  for (const [slug, name] of candidates) {
    if (!titlesMatch(wanted, name)) continue;
    const page = await tryPage(slug);
    if (page?.plainLyrics) return page;
  }

  // 3) Newest songs on the site (sitemap): best fuzzy title matches. Only when the film is
  // known, so a stray request can't make us download the whole list for nothing.
  if (!films.length) return null;
  const tried = new Set([`${slugify(wanted)}-song-lyrics`, ...candidates.keys()]);
  const wantedSkeleton = skeleton(wanted);
  const matches = (await newestSongSlugs())
    .filter(slug => !tried.has(slug) && titlesMatch(wanted, slugToName(slug)))
    .sort((a, b) => editDistance(wantedSkeleton, skeleton(slugToName(a))) - editDistance(wantedSkeleton, skeleton(slugToName(b))))
    .slice(0, 3);
  for (const slug of matches) {
    const page = await tryPage(slug);
    if (page?.plainLyrics) return page;
  }
  return null;
}

module.exports = { findOnTamil2Lyrics, pageTitle };
