const express = require('express');
const cors = require('cors');
const compression = require('compression');
const NodeCache = require('node-cache');
const path = require('path');
const fs = require('fs');
const dns = require('dns');
const { Readable } = require('stream');
const db = require('./database');
const mangapill = require('./providers/mangapill');

// ----------------------------------------------------
// ANTI-ISP BLOCKING & DYNAMIC DNS-OVER-HTTPS (DoH) LAYER
// Resolves MangaDex domains directly via DoH / legitimate IPs on local ISPs,
// skipped on Vercel/AWS serverless where cloud DNS is unrestricted
// ----------------------------------------------------
const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
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

if (!isServerless) {
  // Prefetch and periodically refresh DoH cache for local ISP bypass
  const prefetchTimeout = setTimeout(() => {
    resolveDoH('api.mangadex.org').catch(() => {});
    resolveDoH('uploads.mangadex.org').catch(() => {});
  }, 10);
  if (prefetchTimeout.unref) prefetchTimeout.unref();

  const prefetchInterval = setInterval(() => {
    resolveDoH('api.mangadex.org').catch(() => {});
    resolveDoH('uploads.mangadex.org').catch(() => {});
  }, 3600 * 1000);
  if (prefetchInterval.unref) prefetchInterval.unref();

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
}

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
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), focus-without-user-activation=()');
  next();
});

app.use(cors());
app.use(compression());
app.use(express.json({ limit: '500kb' }));
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ success: false, error: 'Ukuran payload melebihi batas maksimum (500KB).' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ success: false, error: 'Format JSON tidak valid.' });
  }
  next(err);
});

// ----------------------------------------------------
// SEO SITEMAP, ROBOTS.TXT & DYNAMIC OPENGRAPH PREVIEW
// ----------------------------------------------------
function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/robots.txt', (req, res) => {
  const host = `${req.protocol}://${req.get('host') || 'mangaflow-two.vercel.app'}`;
  res.status(200).type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /api/auth/\nSitemap: ${host}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', async (req, res) => {
  const host = `${req.protocol}://${req.get('host') || 'mangaflow-two.vercel.app'}`;
  let mangaList = cache.get('trending_manga') || cache.get('popular_manga') || [];

  if (!Array.isArray(mangaList) || mangaList.length === 0) {
    mangaList = [
      { id: 'pill-2' },
      { id: 'pill-1896' },
      { id: 'pill-1442' },
      { id: 'a1c7c817-4e59-43b7-9365-09675a149a6f' },
      { id: 'c52b2ce3-7f95-469c-96b0-479524fb7a1a' }
    ];
  }

  const nowIso = new Date().toISOString();

  const urls = [
    `<url><loc>${host}/</loc><changefreq>hourly</changefreq><priority>1.0</priority><lastmod>${nowIso}</lastmod></url>`,
    ...mangaList.slice(0, 20).map((m) =>
      `<url><loc>${host}/?manga=${encodeURIComponent(m.id)}</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`
    )
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  ${urls.join('\n  ')}\n</urlset>`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.status(200).send(xml);
});

// Dynamic OpenGraph Preview when sharing /?manga=<id> on WhatsApp, Discord, Telegram, X
app.get('/', async (req, res, next) => {
  const mangaId = req.query.manga;
  if (!mangaId || typeof mangaId !== 'string') {
    return next();
  }

  const trimmedId = mangaId.trim();
  if (!trimmedId) {
    return next();
  }

  try {
    let mangaData = cache.get(`manga_detail_${trimmedId}`) || cache.get(`pill:manga:${trimmedId.replace(/^pill-/, '')}`);
    if (!mangaData) {
      if (trimmedId.startsWith('pill-')) {
        const cleanId = trimmedId.replace(/^pill-/, '');
        const pillRes = await mangapill.getMangaPillDetail(cleanId);
        mangaData = pillRes?.data;
        if (mangaData) {
          cache.set(`pill:manga:${cleanId}`, mangaData, 900);
          cache.set(`manga_detail_${trimmedId}`, mangaData, 900);
        }
      } else if (/^\d+$/.test(trimmedId)) {
        // Pure numeric IDs via MangaPill
        const pillRes = await mangapill.getMangaPillDetail(trimmedId);
        mangaData = pillRes?.data;
        if (mangaData) {
          cache.set(`pill:manga:${trimmedId}`, mangaData, 900);
          cache.set(`manga_detail_pill-${trimmedId}`, mangaData, 900);
          cache.set(`manga_detail_${trimmedId}`, mangaData, 900);
        }
      } else if (/^[0-9a-f-]{20,40}$/i.test(trimmedId)) {
        // UUIDs via MangaDex
        const url = `https://api.mangadex.org/manga/${trimmedId}?includes[]=cover_art`;
        const data = await resilientFetch(url);
        if (data?.data) {
          mangaData = formatManga(data.data);
          if (mangaData) {
            cache.set(`manga_detail_${trimmedId}`, mangaData, 1800);
          }
        }
      } else {
        return next();
      }
    }

    if (!mangaData || !mangaData.title) return next();

    const htmlPath = path.join(__dirname, 'public', 'index.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    const host = `${req.protocol}://${req.get('host') || 'mangaflow-two.vercel.app'}`;
    const safeTitle = escapeAttr(`Baca ${mangaData.title} Bahasa Indonesia & HD - MangaFlow`);
    const cleanDesc = (mangaData.description || 'Baca manga, manhwa, dan manhua online gratis tanpa iklan di MangaFlow.')
      .replace(/\[\/?\w+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
    const safeDesc = escapeAttr(cleanDesc);
    const coverImg = mangaData.coverUrl?.startsWith('/')
      ? `${host}${mangaData.coverUrl}`
      : (mangaData.coverUrl || `${host}/favicon.svg`);
    const safeCover = escapeAttr(coverImg);
    const shareUrl = escapeAttr(`${host}/?manga=${encodeURIComponent(trimmedId)}`);

    html = html
      .replace(/<title>.*?<\/title>/i, () => `<title>${safeTitle}</title>`)
      .replace(/<meta\s+name="description"\s+content=".*?"\s*\/?>/i, () => `<meta name="description" content="${safeDesc}" />`)
      .replace(/<link\s+rel="canonical"\s+href=".*?"\s*\/?>/i, () => `<link rel="canonical" href="${shareUrl}" />`)
      .replace(/<meta\s+property="og:type"\s+content=".*?"\s*\/?>/i, () => `<meta property="og:type" content="article" />`)
      .replace(/<meta\s+property="og:url"\s+content=".*?"\s*\/?>/i, () => `<meta property="og:url" content="${shareUrl}" />`)
      .replace(/<meta\s+property="og:title"\s+content=".*?"\s*\/?>/i, () => `<meta property="og:title" content="${safeTitle}" />`)
      .replace(/<meta\s+property="og:description"\s+content=".*?"\s*\/?>/i, () => `<meta property="og:description" content="${safeDesc}" />`)
      .replace(/<meta\s+property="og:image"\s+content=".*?"\s*\/?>/i, () => `<meta property="og:image" content="${safeCover}" />`)
      .replace(/<meta\s+name="twitter:card"\s+content=".*?"\s*\/?>/i, () => `<meta name="twitter:card" content="summary_large_image" />`)
      .replace(/<meta\s+name="twitter:title"\s+content=".*?"\s*\/?>/i, () => `<meta name="twitter:title" content="${safeTitle}" />`)
      .replace(/<meta\s+name="twitter:description"\s+content=".*?"\s*\/?>/i, () => `<meta name="twitter:description" content="${safeDesc}" />`)
      .replace(/<meta\s+name="twitter:image"\s+content=".*?"\s*\/?>/i, () => `<meta name="twitter:image" content="${safeCover}" />`);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(html);
  } catch (_) {
    return next();
  }
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, must-revalidate');
      } else if (/\.(css|js|svg|json|png|jpg|webp|ico)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
      }
    }
  })
);

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
    const cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (cleanupTimer.unref) cleanupTimer.unref();
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

// Non-Blocking Token-Bucket Request Pacer (spaces starts at max 8 req/s without serial blocking)
class RequestQueue {
  constructor(maxPerSecond = 8) {
    this.interval = Math.floor(1000 / maxPerSecond);
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
      // Dispatch concurrently so one slow upstream response never blocks other requests
      Promise.resolve()
        .then(() => item.fn())
        .then(item.resolve, item.reject);
    }

    this.processing = false;
  }
}

const apiQueue = new RequestQueue(8);

// Resilient Fetch with Timeout & Fast Exponential Backoff
async function resilientFetch(url, options = {}, retries = 2, backoff = 400) {
  const reqHeaders = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    ...(options.headers || {})
  };

  return apiQueue.enqueue(async () => {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          ...options,
          headers: reqHeaders,
          signal: options.signal || AbortSignal.timeout(7000)
        });

        if (res.status === 429) {
          // Rate limited by MangaDex: back off
          const retryAfter = Math.min(3, parseInt(res.headers.get('retry-after') || '1', 10));
          console.warn(`[MangaDex RateLimit 429] Waiting ${retryAfter}s on attempt ${attempt}`);
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }

        if (!res.ok) {
          if (attempt === retries || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
            const errText = await res.text();
            const clientErr = new Error(`HTTP ${res.status}: ${errText.slice(0, 120)}`);
            clientErr.noRetry = true;
            throw clientErr;
          }
          await new Promise((r) => setTimeout(r, backoff * attempt));
          continue;
        }

        return await res.json();
      } catch (err) {
        if (attempt === retries || err.noRetry) throw err;
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
    rawCover,
    rawCoverSmall,
    createdAt: attrs.createdAt,
    updatedAt: attrs.updatedAt
  };
}

// ----------------------------------------------------
// AUTHENTICATION & CLOUD SYNC ROUTES
// ----------------------------------------------------

// Middleware: Require Authenticated User
async function requireAuth(req, res, next) {
  await db.ensureReady();
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
    await db.ensureReady();
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
    await db.ensureReady();
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
  res.json({
    success: true,
    user: req.user,
    data: userData,
    storageMode: db.getStorageMode()
  });
});

// 0.4 Sync Bookmarks, Reading History & Settings
app.post('/api/auth/sync', requireAuth, (req, res) => {
  try {
    const {
      bookmarks = [],
      history = [],
      replaceBookmarks = false,
      replaceHistory = false,
      removedBookmarkIds = [],
      removedHistoryIds = [],
      settings = null
    } = req.body || {};

    const synced = db.syncUserData(req.user.id, bookmarks, history, {
      replaceBookmarks,
      replaceHistory,
      removedBookmarkIds,
      removedHistoryIds,
      settings
    });
    res.json({
      success: true,
      data: synced,
      storageMode: db.getStorageMode()
    });
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

// 0.6 Database Storage Info
app.get('/api/auth/storage-info', (req, res) => {
  res.json({
    success: true,
    storageMode: db.getStorageMode(),
    cloudConfigured: db.hasCloudConfig()
  });
});

// ----------------------------------------------------
// COMMUNITY SOCIAL ROUTES (LIKES, RATINGS, COMMENTS)
// Works across both Server 1 (MangaDex) & Server 2 (MangaPill)
// ----------------------------------------------------

// Helper to optionally extract authenticated user
function getOptionalUser(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  return token ? db.getUserByToken(token) : null;
}

// Get social stats & comments for a manga
app.get('/api/manga/:id/social', async (req, res) => {
  try {
    await db.ensureReady();
    const { id } = req.params;
    const user = getOptionalUser(req);
    const data = db.getMangaSocial(id, user ? user.id : null);
    res.json({ success: true, data });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Toggle Like (Suka) on a manga
app.post('/api/manga/:id/like', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const result = db.toggleMangaLike(id, req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Rate a manga (1 - 5 stars)
app.post('/api/manga/:id/rate', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { score } = req.body || {};
    const result = db.rateManga(id, req.user.id, score);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Post a comment / review on a manga
app.post('/api/manga/:id/comments', requireAuth, (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body || {};
    const result = db.addMangaComment(id, req.user, text);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Delete own comment on a manga
app.delete('/api/manga/:id/comments/:commentId', requireAuth, (req, res) => {
  try {
    const { id, commentId } = req.params;
    const result = db.deleteMangaComment(id, commentId, req.user.id);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

function setEdgeCache(res, browserSec = 180, edgeSec = 600, swrSec = 1200) {
  res.setHeader('Cache-Control', `public, max-age=${browserSec}, s-maxage=${edgeSec}, stale-while-revalidate=${swrSec}`);
}

// 1. Trending / Popular Manga
app.get('/api/trending', async (req, res) => {
  const cacheKey = 'trending_manga';
  const cached = cache.get(cacheKey);
  if (cached) {
    setEdgeCache(res, 300, 900, 1800);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const url = `${MANGADEX_API}/manga?limit=14&offset=0&includes[]=cover_art&includes[]=author&includes[]=artist&order[followedCount]=desc&contentRating[]=safe&contentRating[]=suggestive&hasAvailableChapters=true`;
    const data = await resilientFetch(url);
    const mangaList = (data.data || []).map(formatManga);

    cache.set(cacheKey, mangaList, 900); // 15 min
    setEdgeCache(res, 300, 900, 1800);
    res.json({ success: true, data: mangaList, source: 'api' });
  } catch (err) {
    console.error('Trending error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Latest Updates
app.get('/api/latest', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const cacheKey = `latest_manga_${page}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    setEdgeCache(res, 180, 600, 1200);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const url = `${MANGADEX_API}/manga?limit=${limit}&offset=${offset}&includes[]=cover_art&order[latestUploadedChapter]=desc&contentRating[]=safe&contentRating[]=suggestive&hasAvailableChapters=true`;
    const data = await resilientFetch(url);
    const mangaList = (data.data || []).map(formatManga);

    cache.set(cacheKey, mangaList, 600); // 10 min
    setEdgeCache(res, 180, 600, 1200);
    res.json({ success: true, data: mangaList, total: data.total, source: 'api' });
  } catch (err) {
    console.error('Latest error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Search Manga with Filters
app.get('/api/search', async (req, res) => {
  const { q = '', tags = '', status = '', sort = 'relevance', lang = '', page = '1', limit: rawLimit = '24' } = req.query;
  const limit = Math.max(1, Math.min(24, parseInt(rawLimit, 10) || 24));
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const offset = (pageNum - 1) * limit;

  const cacheKey = `search_${q}_${tags}_${status}_${sort}_${lang}_${pageNum}_${limit}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    setEdgeCache(res, 120, 300, 600);
    return res.json({ success: true, data: cached.data, total: cached.total, source: 'cache' });
  }

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
    setEdgeCache(res, 120, 300, 600);
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
  if (cached) {
    setEdgeCache(res, 3600, 86400, 86400);
    return res.json({ success: true, data: cached });
  }

  try {
    const data = await resilientFetch(`${MANGADEX_API}/manga/tag`);
    const tags = (data.data || []).map((t) => ({
      id: t.id,
      name: t.attributes?.name?.en || 'Unknown',
      group: t.attributes?.group || 'genre'
    })).sort((a, b) => a.name.localeCompare(b.name));

    cache.set(cacheKey, tags, 86400); // 24 hours
    setEdgeCache(res, 3600, 86400, 86400);
    res.json({ success: true, data: tags });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4b. Random Manga Discovery (with instant pool fallback so it never fails)
app.get('/api/random', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await resilientFetch(
      `${MANGADEX_API}/manga/random?includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`
    );
    if (data && data.data) {
      const formatted = formatManga(data.data);
      cache.set(`manga_detail_${formatted.id}`, formatted, 1800);
      return res.json({ success: true, data: formatted, source: 'api' });
    }
    throw new Error('Random manga response empty');
  } catch (err) {
    const fallbackPool = [
      ...(cache.get('trending_manga') || []),
      ...(cache.get('latest_manga_1') || [])
    ];
    if (fallbackPool.length > 0) {
      const pick = fallbackPool[Math.floor(Math.random() * fallbackPool.length)];
      return res.json({ success: true, data: pick, source: 'fallback-pool' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Manga Detail
app.get('/api/manga/:id', async (req, res) => {
  const { id } = req.params;
  const cacheKey = `manga_detail_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    setEdgeCache(res, 300, 900, 1800);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const url = `${MANGADEX_API}/manga/${id}?includes[]=cover_art&includes[]=author&includes[]=artist`;
    const [data, statsRes] = await Promise.all([
      resilientFetch(url),
      resilientFetch(`${MANGADEX_API}/statistics/manga/${id}`).catch(() => null)
    ]);
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

    const stats = statsRes?.statistics?.[id];
    if (stats) {
      formatted.rating = stats.rating?.bayesian ? stats.rating.bayesian.toFixed(2) : null;
      formatted.follows = stats.follows || 0;
    }

    cache.set(cacheKey, formatted, 1800); // 30 min
    setEdgeCache(res, 300, 900, 1800);
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
  if (cached) {
    setEdgeCache(res, 180, 600, 1200);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

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
    setEdgeCache(res, 180, 600, 1200);
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
  if (cached) {
    setEdgeCache(res, 60, 300, 600);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    // Fetch chapter metadata and @Home image server in parallel to halve chapter load latency
    const [metaRes, atHomeRes] = await Promise.all([
      resilientFetch(`${MANGADEX_API}/chapter/${id}?includes[]=manga`),
      resilientFetch(`${MANGADEX_API}/at-home/server/${id}?forcePort443=true`).catch(() => null)
    ]);
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

    const atHomeData = atHomeRes || await resilientFetch(`${MANGADEX_API}/at-home/server/${id}?forcePort443=true`);
    const baseUrl = atHomeData.baseUrl;
    const hash = atHomeData.chapter?.hash;
    const pageFiles = atHomeData.chapter?.data || [];
    const dataSaverFiles = atHomeData.chapter?.dataSaver || [];

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

    // MangaDex @ Home tokens last ~15-20 min, cache for 12 min in memory & 5 min on edge
    cache.set(cacheKey, payload, 720);
    setEdgeCache(res, 60, 300, 600);
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

  const page = Math.max(1, parseInt(req.query.page || '1', 10) || 1);
  const cacheKey = `pill:search:${q.trim().toLowerCase()}:${page}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    setEdgeCache(res, 180, 600, 1200);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.searchMangaPill(q, page);
    cache.set(cacheKey, result.data, 900); // 15 mins cache
    setEdgeCache(res, 180, 600, 1200);
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
    setEdgeCache(res, 180, 600, 1200);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.getMangaPillDetail(cleanId, slug || '');
    cache.set(cacheKey, result.data, 900);
    setEdgeCache(res, 180, 600, 1200);
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
    setEdgeCache(res, 300, 1800, 3600);
    return res.json({ success: true, data: cached, source: 'cache' });
  }

  try {
    const result = await mangapill.getMangaPillChapter(cleanChId, slug || '');
    cache.set(cacheKey, result.data, 1800); // 30 mins cache
    setEdgeCache(res, 300, 1800, 3600);
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
    const isMangaDex = hostname === 'mangadex.org' || hostname.endsWith('.mangadex.org') || hostname.endsWith('.mangadex.network');

    const proxyHeaders = isMangaPill
      ? {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Referer: 'https://mangapill.com/',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      : isMangaDex
      ? {
          'User-Agent': USER_AGENT,
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      : {
          'User-Agent': USER_AGENT
        };

    let response = await fetch(imageUrl, {
      headers: proxyHeaders,
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok && hostname === 'uploads.mangadex.org' && /\.(256|512)\.jpg$/i.test(parsed.pathname)) {
      const fullResUrl = imageUrl.replace(/\.(256|512)\.jpg$/i, '');
      response = await fetch(fullResUrl, {
        headers: proxyHeaders,
        signal: AbortSignal.timeout(10000)
      });
    }

    if (!response.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(response.status).send(`Failed to fetch image: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');

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
    console.log(`📡 Rate limiter: Non-blocking token-bucket active (max 8 req/s)`);
    console.log(`🛡️ Resilience layer & TTL In-Memory Cache active`);
    console.log(`🖼️ Image proxy & Data-saver fallback ready`);
    console.log(`🌐 Open http://localhost:${PORT}`);
    console.log(`=================================================`);
  });
}

module.exports = app;
