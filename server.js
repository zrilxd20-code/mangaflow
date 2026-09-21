const express = require('express');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');
const path = require('path');
const dns = require('dns');
const { Readable } = require('stream');
const db = require('./database');
const mangapill = require('./providers/mangapill');

// ----------------------------------------------------
// ANTI-ISP BLOCKING & DYNAMIC DNS-OVER-HTTPS (DoH) LAYER
// Resolves MangaDex domains directly via DoH / legitimate IPs,
// completely bypassing ISP DNS blocking (aduankonten.id / 36.86.63.185)
// ----------------------------------------------------
const dnsCache = new Map();
const DEFAULT_MANGADEX_IPS = ['45.129.229.1', '45.129.229.2'];

async function resolveDoH(hostname) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
      headers: { Accept: 'application/dns-json' },
      signal: AbortSignal.timeout(3500)
    });
    if (res.ok) {
      const json = await res.json();
      if (json.Answer && json.Answer.length > 0) {
        const ips = json.Answer.filter((a) => a.type === 1 && a.data).map((a) => a.data);
        if (ips.length > 0) {
          dnsCache.set(hostname, { ips, expiresAt: Date.now() + 3600 * 1000 });
          return ips;
        }
      }
    }
  } catch (_) {}
  return null;
}

// Prefetch and periodically refresh DoH cache
setTimeout(() => {
  resolveDoH('api.mangadex.org').catch(() => {});
  resolveDoH('uploads.mangadex.org').catch(() => {});
}, 1000);
setInterval(() => {
  resolveDoH('api.mangadex.org').catch(() => {});
  resolveDoH('uploads.mangadex.org').catch(() => {});
}, 3600 * 1000);

const origLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (hostname && (hostname === 'mangadex.org' || hostname.endsWith('.mangadex.org'))) {
    const cached = dnsCache.get(hostname);
    const resolvedIPs = cached && cached.ips && cached.ips.length > 0 ? cached.ips : DEFAULT_MANGADEX_IPS;
    const ipRecords = resolvedIPs.map((ip) => ({ address: ip, family: 4 }));
    if (options && options.all) {
      return callback(null, ipRecords);
    }
    return callback(null, ipRecords[0].address, ipRecords[0].family);
  }
  return origLookup(hostname, options, callback);
};

const app = express();
const PORT = process.env.PORT || 3000;

// In-Memory Cache: stdTTL = 15 minutes (900s), checkperiod = 2 minutes
const cache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// ----------------------------------------------------
// HTTP SECURITY HEADERS & BODY LIMIT
// ----------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '500kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ----------------------------------------------------
// IN-MEMORY AUTH RATE LIMITER (BRUTE FORCE DEFENSE)
// ----------------------------------------------------
class AuthRateLimiter {
  constructor({ maxAttempts = 5, windowMs = 15 * 60 * 1000, message = 'Terlalu banyak permintaan.' }) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.message = message;
    this.hits = new Map();
    // Periodically prune expired entries
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  cleanup() {
    const now = Date.now();
    for (const [ip, record] of this.hits.entries()) {
      if (now > record.resetAt) {
        this.hits.delete(ip);
      }
    }
  }

  middleware() {
    return (req, res, next) => {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      let record = this.hits.get(ip);

      if (!record || now > record.resetAt) {
        record = { count: 1, resetAt: now + this.windowMs };
        this.hits.set(ip, record);
        return next();
      }

      record.count++;
      if (record.count > this.maxAttempts) {
        const retryAfterSeconds = Math.ceil((record.resetAt - now) / 1000);
        res.setHeader('Retry-After', retryAfterSeconds);
        return res.status(429).json({
          success: false,
          error: `${this.message} (Tunggu ${retryAfterSeconds} detik lagi).`
        });
      }

      next();
    };
  }
}

const loginLimiter = new AuthRateLimiter({
  maxAttempts: 5,
  windowMs: 10 * 60 * 1000,
  message: 'Terlalu banyak percobaan masuk dari perangkat Anda.'
});

const registerLimiter = new AuthRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  message: 'Batas pembuatan akun terlampaui dari perangkat Anda.'
});

// MangaDex Constants
const MANGADEX_API = 'https://api.mangadex.org';
const USER_AGENT = 'MangaFlow/1.0.0 (https://github.com/mangaflow; contact@mangaflow.app)';

// Rate Limiter / Request Queue (Token Bucket: max 4 requests per second)
class RequestQueue {
  constructor(maxPerSecond = 4) {
    this.interval = 1000 / maxPerSecond;
    this.lastRun = 0;
    this.queue = [];
    this.processing = false;
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.process();
    });
  }

  async process() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const wait = Math.max(0, this.lastRun + this.interval - now);
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      this.lastRun = Date.now();
      const item = this.queue.shift();
      try {
        const result = await item.fn();
        item.resolve(result);
      } catch (err) {
        item.reject(err);
      }
    }

    this.processing = false;
  }
}

const apiQueue = new RequestQueue(4);

// Resilient Fetch with Exponential Backoff & Retry
async function resilientFetch(url, options = {}, retries = 3, backoff = 1000) {
  const reqHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...(options.headers || {})
  };

  return apiQueue.enqueue(async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, { ...options, headers: reqHeaders });

        if (res.status === 429) {
          // Rate limited by MangaDex: back off
          const retryAfter = parseInt(res.headers.get('retry-after') || '2', 10);
          console.warn(`[MangaDex RateLimit 429] Waiting ${retryAfter}s on attempt ${attempt}`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          if (attempt === retries || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
            const errText = await res.text();
            throw new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
          }
          await new Promise((r) => setTimeout(r, backoff * attempt));
          continue;
        }

        return await res.json();
      } catch (err) {
        if (attempt === retries) throw err;
        console.warn(`[Fetch Retry ${attempt}/${retries}] ${url} failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, backoff * attempt));
      }
    }
  });
}

// Helper to format manga item
function formatManga(item) {
  const attrs = item.attributes || {};
  const titles = attrs.title || {};
  const title = titles.en || titles['ja-ro'] || Object.values(titles)[0] || 'Unknown Title';

  const altTitles = (attrs.altTitles || []).map((t) => Object.values(t)[0]).filter(Boolean);

  const descObj = attrs.description || {};
  const description = descObj.en || descObj.id || Object.values(descObj)[0] || 'No description available.';

  // Find cover art
  let coverFileName = null;
  const rels = item.relationships || [];
  for (const rel of rels) {
    if (rel.type === 'cover_art' && rel.attributes && rel.attributes.fileName) {
      coverFileName = rel.attributes.fileName;
      break;
    }
  }

  const rawCover = coverFileName
    ? `https://uploads.mangadex.org/covers/${item.id}/${coverFileName}`
    : `https://placehold.co/400x600/181a20/818cf8?text=${encodeURIComponent(title.slice(0, 20))}`;

  const rawCoverSmall = coverFileName
    ? `https://uploads.mangadex.org/covers/${item.id}/${coverFileName}.256.jpg`
    : rawCover;

  // Route through proxy so client browser never gets blocked by ISP
  const coverUrl = coverFileName ? `/api/proxy/image?url=${encodeURIComponent(rawCover)}` : rawCover;
  const coverUrlSmall = coverFileName ? `/api/proxy/image?url=${encodeURIComponent(rawCoverSmall)}` : coverUrl;

  const tags = (attrs.tags || [])
    .map((t) => t.attributes?.name?.en)
    .filter(Boolean);

  return {
    id: item.id,
    title,
    altTitles: altTitles.slice(0, 3),
    description,
    status: attrs.status || 'unknown',
    year: attrs.year,
    contentRating: attrs.contentRating,
    originalLanguage: attrs.originalLanguage,
    tags,
    coverUrl,
    coverUrlSmall,
    createdAt: attrs.createdAt,
    updatedAt: attrs.updatedAt
  };
}

// ----------------------------------------------------
// AUTHENTICATION & CLOUD SYNC ROUTES
// ----------------------------------------------------

// Middleware: Require Authenticated User
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const user = db.getUserByToken(token);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Sesi login telah berakhir atau tidak valid.' });
  }
  req.user = user;
  req.token = token;
  next();
}

// 0.1 Register with Brute-Force Rate Limiting
app.post('/api/auth/register', registerLimiter.middleware(), async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    const result = await db.createUser(username, email, password);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 0.2 Login with Brute-Force Rate Limiting
app.post('/api/auth/login', loginLimiter.middleware(), async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (!identifier || !password) {
      return res.status(400).json({ success: false, error: 'Username/email dan kata sandi wajib diisi.' });
    }
    const result = await db.authenticateUser(identifier, password);
    const userData = db.getUserData(result.user.id);
    res.json({ success: true, ...result, data: userData });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// 0.3 Get Current User Profile
app.get('/api/auth/me', requireAuth, (req, res) => {
  const userData = db.getUserData(req.user.id);
  res.json({ success: true, user: req.user, data: userData });
});

// 0.4 Sync Bookmarks & Reading History
app.post('/api/auth/sync', requireAuth, (req, res) => {
  try {
    const { bookmarks = [], history = [] } = req.body || {};
    const synced = db.syncUserData(req.user.id, bookmarks, history);
    res.json({ success: true, data: synced });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 0.5 Logout
app.post('/api/auth/logout', (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  db.destroySession(token);
  res.json({ success: true, message: 'Berhasil keluar.' });
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// 1. Trending / Popular Manga
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending_manga';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    const url = `${MANGADEX_API}/manga?limit=14&offset=0&includes[]=cover_art&includes[]=author&includes[]=artist&order[followedCount]=desc&contentRating[]=safe&contentRating[]=suggestive&hasAvailableChapters=true`;
    const data = await resilientFetch(url);
    const mangaList = (data.data || []).map(formatManga);

    cache.set(cacheKey, mangaList, 900); // 15 min
    res.json({ success: true, data: mangaList, source: 'api' });
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Latest Updates
app.get('/api/latest', async (req, res) => {
  const page = parseInt(req.query.page || '1', 10);
  const limit = 20;
  const offset = (page - 1) * limit;
  const cacheKey = `latest_manga_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    const url = `${MANGADEX_API}/manga?limit=${limit}&offset=${offset}&includes[]=cover_art&order[latestUploadedChapter]=desc&contentRating[]=safe&contentRating[]=suggestive&hasAvailableChapters=true`;
    const data = await resilientFetch(url);
    const mangaList = (data.data || []).map(formatManga);

    cache.set(cacheKey, mangaList, 600); // 10 min
    res.json({ success: true, data: mangaList, total: data.total, source: 'api' });
  } catch (err) {
    console.error('Latest error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Search Manga with Filters
app.get('/api/search', async (req, res) => {
  const { q = '', tags = '', status = '', sort = 'relevance', lang = '', page = '1' } = req.query;
  const limit = 24;
  const pageNum = Math.max(1, parseInt(page, 10));
  const offset = (pageNum - 1) * limit;

  const cacheKey = `search_${q}_${tags}_${status}_${sort}_${lang}_${pageNum}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached.data, total: cached.total, source: 'cache' });

  try {
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    params.append('includes[]', 'cover_art');
    params.append('contentRating[]', 'safe');
    params.append('contentRating[]', 'suggestive');
    params.set('hasAvailableChapters', 'true');

    const cleanQ = q.replace(/<[^>]*>/g, '').replace(/[<>"'&]/g, '').trim();
    if (q.trim() && !cleanQ) {
      // Entire query was HTML/script tags
      return res.json({ success: true, data: [], total: 0, source: 'sanitized' });
    }

    if (cleanQ) params.set('title', cleanQ);
    if (status) params.append('status[]', status);

    if (tags) {
      const tagIds = tags.split(',').filter(Boolean);
      tagIds.forEach((t) => params.append('includedTags[]', t));
    }

    if (lang) {
      params.append('availableTranslatedLanguage[]', lang);
    }

    // Sorting
    switch (sort) {
      case 'followed':
        params.set('order[followedCount]', 'desc');
        break;
      case 'rating':
        params.set('order[rating]', 'desc');
        break;
      case 'latest':
        params.set('order[latestUploadedChapter]', 'desc');
        break;
      case 'title':
        params.set('order[title]', 'asc');
        break;
      default:
        params.set('order[relevance]', 'desc');
        break;
    }

    const url = `${MANGADEX_API}/manga?${params.toString()}`;
    const data = await resilientFetch(url);
    const mangaList = (data.data || []).map(formatManga);

    const result = { data: mangaList, total: data.total || 0 };
    cache.set(cacheKey, result, 600);
    res.json({ success: true, data: result.data, total: result.total, source: 'api' });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Genres & Tags List
app.get('/api/tags', async (req, res) => {
  const cacheKey = 'all_tags';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached });

  try {
    const data = await resilientFetch(`${MANGADEX_API}/manga/tag`);
    const tags = (data.data || []).map((t) => ({
      id: t.id,
      name: t.attributes?.name?.en || 'Unknown',
      group: t.attributes?.group || 'genre'
    })).sort((a, b) => a.name.localeCompare(b.name));

    cache.set(cacheKey, tags, 86400); // 24 hours
    res.json({ success: true, data: tags });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Manga Detail
app.get('/api/manga/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `manga_detail_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    const url = `${MANGADEX_API}/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`;
    const data = await resilientFetch(url);
    if (!data.data) throw new Error('Manga not found');

    const formatted = formatManga(data.data);

    // Extract author / artist
    const rels = data.data.relationships || [];
    const authors = rels
      .filter((r) => r.type === 'author')
      .map((r) => r.attributes?.name || 'Unknown');
    const artists = rels
      .filter((r) => r.type === 'artist')
      .map((r) => r.attributes?.name || 'Unknown');

    formatted.authors = authors;
    formatted.artists = artists;

    // Get stats (rating & follows)
    try {
      const statsRes = await resilientFetch(`${MANGADEX_API}/statistics/manga/${id}`);
      const stats = statsRes.statistics?.[id];
      if (stats) {
        formatted.rating = stats.rating?.bayesian ? stats.rating.bayesian.toFixed(2) : null;
        formatted.follows = stats.follows || 0;
      }
    } catch (_) {}

    cache.set(cacheKey, formatted, 1800); // 30 min
    res.json({ success: true, data: formatted, source: 'api' });
  } catch (err) {
    console.error('Manga detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Manga Chapters Feed
app.get('/api/manga/:id/chapters', async (req, res) => {
  const { id } = req.params;
  const lang = req.query.lang || 'en,id';
  const order = req.query.order || 'desc';
  const languages = lang.split(',').filter(Boolean);

  const cacheKey = `chapters_${id}_${lang}_${order}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    // Fetch chapters up to 500
    const params = new URLSearchParams();
    params.set('limit', '500');
    params.append('order[chapter]', order);
    params.append('includes[]', 'scanlation_group');
    params.append('contentRating[]', 'safe');
    params.append('contentRating[]', 'suggestive');
    params.append('contentRating[]', 'erotica');

    languages.forEach((l) => params.append('translatedLanguage[]', l));

    const url = `${MANGADEX_API}/manga/${id}/feed?${params.toString()}`;
    const data = await resilientFetch(url);

    // Group or deduplicate chapters
    const chapters = (data.data || []).map((ch) => {
      const attrs = ch.attributes || {};
      const scanGroup = (ch.relationships || []).find((r) => r.type === 'scanlation_group');

      return {
        id: ch.id,
        chapter: attrs.chapter || '0',
        volume: attrs.volume || null,
        title: attrs.title || '',
        language: attrs.translatedLanguage,
        pages: attrs.pages || 0,
        publishAt: attrs.publishAt,
        externalUrl: attrs.externalUrl || null,
        isExternal: Boolean(attrs.externalUrl && (!attrs.pages || attrs.pages === 0)),
        group: scanGroup?.attributes?.name || 'Unknown Scanlation'
      };
    });

    cache.set(cacheKey, chapters, 900); // 15 min
    res.json({ success: true, data: chapters, total: chapters.length, source: 'api' });
  } catch (err) {
    console.error('Chapters feed error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Chapter Pages (MangaDex @ Home)
app.get('/api/chapter/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `chapter_pages_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, data: cached, source: 'cache' });

  try {
    // Get chapter metadata first
    const metaRes = await resilientFetch(`${MANGADEX_API}/chapter/${id}?includes[]=manga`);
    const chapterMeta = metaRes.data?.attributes || {};
    const mangaRel = (metaRes.data?.relationships || []).find((r) => r.type === 'manga');
    const mangaId = mangaRel?.id;

    if (chapterMeta.externalUrl && (!chapterMeta.pages || chapterMeta.pages === 0)) {
      return res.status(400).json({
        success: false,
        error: `Chapter ini dihosting di platform eksternal (${chapterMeta.externalUrl})`,
        externalUrl: chapterMeta.externalUrl
      });
    }

    // Get MangaDex @ Home Server
    const atHomeRes = await resilientFetch(`${MANGADEX_API}/at-home/server/${id}?forcePort443=true`);
    const baseUrl = atHomeRes.baseUrl;
    const hash = atHomeRes.chapter?.hash;
    const pageFiles = atHomeRes.chapter?.data || [];
    const dataSaverFiles = atHomeRes.chapter?.dataSaver || [];

    if (!pageFiles || pageFiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Tidak ada halaman gambar yang ditemukan untuk chapter ini.'
      });
    }

    // Construct direct URLs & backend proxy fallbacks
    const pages = pageFiles.map((file, idx) => {
      const directUrl = `${baseUrl}/data/${hash}/${file}`;
      const dataSaverUrl = dataSaverFiles[idx] ? `${baseUrl}/data-saver/${hash}/${dataSaverFiles[idx]}` : directUrl;
      const proxyUrl = `/api/proxy/image?url=${encodeURIComponent(directUrl)}`;
      const proxyDataSaverUrl = `/api/proxy/image?url=${encodeURIComponent(dataSaverUrl)}`;

      return {
        page: idx + 1,
        directUrl,
        dataSaverUrl,
        proxyUrl,
        proxyDataSaverUrl
      };
    });

    const payload = {
      id,
      mangaId,
      chapter: chapterMeta.chapter || '0',
      volume: chapterMeta.volume || null,
      title: chapterMeta.title || '',
      language: chapterMeta.translatedLanguage,
      pages,
      totalPages: pages.length
    };

    // MangaDex @ Home tokens last ~15-20 min, cache for 12 min
    cache.set(cacheKey, payload, 720);
    res.json({ success: true, data: payload, source: 'api' });
  } catch (err) {
    console.error('Chapter pages error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// MangaPill Provider Endpoints (Complete Manga Archives)
// ----------------------------------------------------
app.get('/api/mangapill/search', async (req, res) => {
  const q = req.query.q || '';
  if (!q.trim()) {
    return res.json({ success: true, data: [], total: 0, source: 'mangapill' });
  }

  const cacheKey = `pill:search:${q.trim().toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.searchMangaPill(q);
    cache.set(cacheKey, result.data, 900); // 15 mins cache
    res.json(result);
  } catch (err) {
    console.error('MangaPill search error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/mangapill/manga/:id', '/api/mangapill/manga/:id/:slug'], async (req, res) => {
  const { id, slug } = req.params;
  const cleanId = String(id).replace(/^pill-/, '');
  const cacheKey = `pill:manga:${cleanId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.getMangaPillDetail(cleanId, slug || '');
    cache.set(cacheKey, result.data, 900);
    res.json(result);
  } catch (err) {
    console.error('MangaPill detail error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get(['/api/mangapill/chapter/:chapterId', '/api/mangapill/chapter/:chapterId/:slug'], async (req, res) => {
  const { chapterId, slug } = req.params;
  const cleanChId = String(chapterId).replace(/^pill-/, '');
  const cacheKey = `pill:chapter:${cleanChId}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.getMangaPillChapter(cleanChId, slug || '');
    cache.set(cacheKey, result.data, 1800); // 30 mins cache
    res.json(result);
  } catch (err) {
    console.error('MangaPill chapter error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Resilient Image Proxy (Bypasses CORS, Adblocker, & Referer restrictions with strict SSRF guard & streaming)
app.get('/api/proxy/image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl || typeof imageUrl !== 'string') {
    return res.status(400).send('Image URL missing');
  }

  try {
    let parsed;
    try {
      parsed = new URL(imageUrl);
    } catch {
      return res.status(400).send('Format URL tidak valid');
    }

    // 1. Only allow HTTP and HTTPS protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return res.status(403).send('Protokol tidak diizinkan');
    }

    // 2. Prevent SSRF to localhost, loopback, or private network IP addresses
    const hostname = parsed.hostname.toLowerCase();
    const isPrivate =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.localhost') ||
      /^10\./.test(hostname) ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^169\.254\./.test(hostname); // Link-local / Cloud metadata

    if (isPrivate) {
      return res.status(403).send('Akses ke jaringan lokal atau privat dilarang');
    }

    // 3. Strict host whitelist: exact match or official dot-subdomain
    const allowedHosts = [
      'mangadex.org',
      'mangadex.network',
      'uploads.mangadex.org',
      'placehold.co',
      'mangapill.com',
      'cdn.readdetectiveconan.com',
      'readdetectiveconan.com'
    ];
    const isAllowed = allowedHosts.some((h) => hostname === h || hostname.endsWith('.' + h));

    if (!isAllowed) {
      return res.status(403).send('Domain tidak diizinkan');
    }

    const isMangaPill = hostname.includes('readdetectiveconan.com') || hostname.includes('mangapill.com');
    const referer = isMangaPill ? 'https://mangapill.com/' : 'https://mangadex.org/';

    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Referer: referer
      }
    });

    if (!response.ok) {
      return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');

    // 4. Memory-safe streaming directly to client
    if (response.body) {
      const stream = Readable.fromWeb(response.body);
      stream.on('error', (err) => {
        console.warn('[Image Proxy Stream Error]:', err.message);
        if (!res.headersSent) res.status(500).send('Streaming error');
      });
      stream.pipe(res);
    } else {
      const arrayBuffer = await response.arrayBuffer();
      res.send(Buffer.from(arrayBuffer));
    }
  } catch (err) {
    console.error('Image proxy error:', err.message);
    if (!res.headersSent) res.status(500).send('Image proxy error');
  }
});

// Fallback SPA route (Express 5 compatible)
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`=================================================`);
    console.log(`🚀 MangaFlow Online Server is running on port ${PORT}`);
    console.log(`📡 Rate limiter: Token-bucket active (max 4 req/s)`);
    console.log(`🛡️ Resilience layer & TTL In-Memory Cache active`);
    console.log(`🖼️ Image proxy & Data-saver fallback ready`);
    console.log(`🌐 Open http://localhost:${PORT}`);
    console.log(`=================================================`);
  });
}

module.exports = app;
