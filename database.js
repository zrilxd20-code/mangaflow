// ===================================================
// MangaFlow Zero-Break Embedded + Cloud Database Engine
// Pure Node.js (Zero external native dependencies)
// Supports Local Atomic JSON + Serverless Cloud KV (Upstash / Vercel KV / REST)
// ===================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const os = require('os');
const scryptAsync = util.promisify(crypto.scrypt);

const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const DATA_DIR = isServerless ? path.join(os.tmpdir(), 'mangaflow_data') : path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_DB_FILE = path.join(__dirname, 'data', 'db.json');
const TOKEN_SECRET = process.env.MANGAFLOW_SECRET || 'mangaflow-serverless-hmac-secret-v1';

// Optional Cloud KV / REST Configuration (Vercel KV / Upstash Redis / Custom REST)
const CLOUD_KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || process.env.MANGAFLOW_CLOUD_DB_URL || '';
const CLOUD_KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || process.env.MANGAFLOW_CLOUD_DB_KEY || '';
const CLOUD_KV_KEY = process.env.MANGAFLOW_CLOUD_DB_KEY_NAME || 'mangaflow_db_v1';

class Database {
  constructor() {
    this.data = {
      users: [],      // { id, username, email, passwordHash, salt, avatar, createdAt }
      sessions: {},   // token: { userId, expiresAt }
      bookmarks: {},  // userId: [ { id, title, coverUrl, status, addedAt } ]
      history: {},    // userId: [ { mangaId, mangaTitle, coverUrl, chapterId, ... } ]
      settings: {},   // userId: { readerMode, direction, ... }
      likes: {},      // mangaId: [ userId1, userId2, ... ]
      ratings: {},    // mangaId: { [userId]: number (1-5) }
      comments: {}    // mangaId: [ { id, userId, username, avatar, text, createdAt } ]
    };
    this.cloudReady = false;
    this.cloudSyncPromise = null;
    this.revokedTokens = new Set();
    this.init();
  }

  _normalizeCoverUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (trimmed.startsWith('/api/proxy/image?url=%2Fapi%2Fproxy%2Fimage')) {
      try {
        const inner = new URL(trimmed, 'http://localhost').searchParams.get('url');
        if (inner && inner.startsWith('/api/proxy/image')) {
          return inner;
        }
      } catch (_) {}
    }
    if (
      trimmed.startsWith('https://uploads.mangadex.org/') ||
      trimmed.startsWith('http://uploads.mangadex.org/') ||
      trimmed.startsWith('https://cdn.readdetectiveconan.com/') ||
      trimmed.startsWith('http://cdn.readdetectiveconan.com/')
    ) {
      return `/api/proxy/image?url=${encodeURIComponent(trimmed)}`;
    }
    return trimmed;
  }

  _normalizeState(parsed = {}) {
    const rawBookmarks = parsed.bookmarks && typeof parsed.bookmarks === 'object' ? parsed.bookmarks : {};
    const bookmarks = {};
    for (const [uid, list] of Object.entries(rawBookmarks)) {
      bookmarks[uid] = Array.isArray(list)
        ? list.map((b) => (b && b.coverUrl ? { ...b, coverUrl: this._normalizeCoverUrl(b.coverUrl) } : b))
        : [];
    }

    const rawHistory = parsed.history && typeof parsed.history === 'object' ? parsed.history : {};
    const history = {};
    for (const [uid, list] of Object.entries(rawHistory)) {
      history[uid] = Array.isArray(list)
        ? list.map((h) => (h && h.coverUrl ? { ...h, coverUrl: this._normalizeCoverUrl(h.coverUrl) } : h))
        : [];
    }

    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      bookmarks,
      history,
      settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {},
      likes: parsed.likes && typeof parsed.likes === 'object' ? parsed.likes : {},
      ratings: parsed.ratings && typeof parsed.ratings === 'object' ? parsed.ratings : {},
      comments: parsed.comments && typeof parsed.comments === 'object' ? parsed.comments : {}
    };
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = this._normalizeState(parsed);
      } else if (isServerless && fs.existsSync(SEED_DB_FILE)) {
        const raw = fs.readFileSync(SEED_DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = this._normalizeState(parsed);
        this.persistLocalOnly();
      } else {
        this.persistLocalOnly();
      }
    } catch (err) {
      console.warn('[Database Init] Using fallback memory state:', err.message);
    }

    // Trigger initial Cloud KV pull if configured
    if (this.hasCloudConfig()) {
      this.cloudSyncPromise = this.pullFromCloud().catch((err) => {
        console.warn('[Cloud DB Init] Fallback to local storage:', err.message);
        return false;
      });
    }
  }

  async ensureReady() {
    if (this.cloudSyncPromise) {
      try {
        await this.cloudSyncPromise;
      } finally {
        this.cloudSyncPromise = null;
      }
    }
  }

  hasCloudConfig() {
    return Boolean(CLOUD_KV_URL && CLOUD_KV_TOKEN);
  }

  getStorageMode() {
    if (this.hasCloudConfig()) return 'cloud-kv';
    return isServerless ? 'serverless-tmp' : 'local-disk';
  }

  async pullFromCloud() {
    if (!this.hasCloudConfig()) return false;
    try {
      const isUpstash = CLOUD_KV_URL.includes('upstash.io') || Boolean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
      const targetUrl = isUpstash
        ? `${CLOUD_KV_URL.replace(/\/$/, '')}/get/${encodeURIComponent(CLOUD_KV_KEY)}`
        : CLOUD_KV_URL;

      const res = await fetch(targetUrl, {
        headers: {
          Authorization: `Bearer ${CLOUD_KV_TOKEN}`,
          Accept: 'application/json'
        },
        signal: AbortSignal.timeout(4000)
      });

      if (!res.ok) return false;
      const json = await res.json();
      const rawPayload = isUpstash ? json.result : json;
      if (rawPayload) {
        const parsed = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
        if (parsed && typeof parsed === 'object') {
          this.data = this._normalizeState(parsed);
          this.persistLocalOnly();
          this.cloudReady = true;
          return true;
        }
      }
    } catch (err) {
      console.warn('[Cloud DB Pull Warning]:', err.message);
    }
    return false;
  }

  async pushToCloud() {
    if (!this.hasCloudConfig()) return false;
    try {
      const isUpstash = CLOUD_KV_URL.includes('upstash.io') || Boolean(process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL);
      const serialized = JSON.stringify(this.data);

      if (isUpstash) {
        await fetch(`${CLOUD_KV_URL.replace(/\/$/, '')}/set/${encodeURIComponent(CLOUD_KV_KEY)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${CLOUD_KV_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(serialized),
          signal: AbortSignal.timeout(4000)
        });
      } else {
        await fetch(CLOUD_KV_URL, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${CLOUD_KV_TOKEN}`,
            'Content-Type': 'application/json'
          },
          body: serialized,
          signal: AbortSignal.timeout(4000)
        });
      }
      return true;
    } catch (err) {
      console.warn('[Cloud DB Push Warning]:', err.message);
      return false;
    }
  }

  persistLocalOnly() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const tempFile = `${DB_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      console.error('[Database Persist Error]:', err.message);
    }
  }

  persist() {
    this.persistLocalOnly();
    if (this.hasCloudConfig()) {
      this.pushToCloud().catch(() => {});
    }
  }

  // ---------------- Password Cryptography ----------------
  async hashPassword(password, salt = null) {
    if (!salt) {
      salt = crypto.randomBytes(16).toString('hex');
    }
    const derivedKey = await scryptAsync(password, salt, 64);
    const hash = derivedKey.toString('hex');
    return { hash, salt };
  }

  async verifyPassword(password, storedHash, salt) {
    const { hash } = await this.hashPassword(password, salt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  }

  // ---------------- User Management ----------------
  async createUser(username, email, password) {
    username = (username || '').trim();
    email = (email || '').trim().toLowerCase();

    if (!username || username.length < 3) {
      throw new Error('Username minimal 3 karakter.');
    }
    if (username.length > 32) {
      throw new Error('Username maksimal 32 karakter.');
    }
    if (!email || !email.includes('@')) {
      throw new Error('Format email tidak valid.');
    }
    if (!password || password.length < 6) {
      throw new Error('Kata sandi minimal 6 karakter.');
    }

    // Check unique username & email
    const exists = this.data.users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === email
    );
    if (exists) {
      if (exists.email.toLowerCase() === email) {
        throw new Error('Email ini sudah terdaftar. Silakan masuk.');
      }
      throw new Error('Username ini sudah dipakai. Pilih username lain.');
    }

    const { hash, salt } = await this.hashPassword(password);
    const userId = crypto.randomUUID();

    // Generate cute SVG avatar based on username initials
    const initial = username.charAt(0).toUpperCase().replace(/[<>"'&]/g, 'U');
    const avatar = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="%236366f1"/><text x="50%" y="54%" font-family="sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;

    const newUser = {
      id: userId,
      username,
      email,
      passwordHash: hash,
      salt,
      avatar,
      createdAt: new Date().toISOString()
    };

    this.data.users.push(newUser);
    this.data.bookmarks[userId] = [];
    this.data.history[userId] = [];
    this.data.settings[userId] = {};
    this.persist();

    return this.createSession(userId);
  }

  async authenticateUser(identifier, password) {
    identifier = (identifier || '').trim().toLowerCase();
    const user = this.data.users.find(
      (u) => u.email.toLowerCase() === identifier || u.username.toLowerCase() === identifier
    );

    if (!user) {
      throw new Error('Akun dengan username atau email tersebut tidak ditemukan.');
    }

    const isValid = await this.verifyPassword(password, user.passwordHash, user.salt);
    if (!isValid) {
      throw new Error('Kata sandi salah. Silakan periksa kembali.');
    }

    return this.createSession(user.id);
  }

  createSession(userId) {
    const user = this.data.users.find((u) => u.id === userId);
    if (!user) throw new Error('User not found');

    // Session valid for 30 days
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = Buffer.from(
      JSON.stringify({
        uid: user.id,
        u: user.username,
        e: user.email,
        c: user.createdAt,
        exp: expiresAt
      })
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(`${nonce}.${payload}`).digest('base64url');
    const token = `${nonce}.${payload}.${sig}`;

    this.data.sessions[token] = { userId, expiresAt };
    this.persist();

    return {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        createdAt: user.createdAt
      }
    };
  }

  getUserByToken(token) {
    if (!token || typeof token !== 'string') return null;
    if (this.revokedTokens.has(token)) return null;

    const session = this.data.sessions[token];
    if (session) {
      if (Date.now() > session.expiresAt) {
        delete this.data.sessions[token];
        this.persist();
        return null;
      }

      const user = this.data.users.find((u) => u.id === session.userId);
      if (!user) return null;

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        createdAt: user.createdAt
      };
    }

    // Stateless HMAC token verification fallback across serverless cold starts/instances
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [nonce, payloadB64, sigB64] = parts;
    if (!nonce || !payloadB64 || !sigB64) return null;

    try {
      const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(`${nonce}.${payloadB64}`).digest('base64url');
      const sigBuf = Buffer.from(sigB64);
      const expectedBuf = Buffer.from(expectedSig);
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return null;
      }

      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      if (!payload || !payload.uid || !payload.exp || Date.now() > Number(payload.exp)) {
        return null;
      }

      let user = this.data.users.find((u) => u.id === payload.uid);
      if (!user) {
        const username = String(payload.u || 'Reader');
        const initial = username.charAt(0).toUpperCase().replace(/[<>"'&]/g, 'U');
        const avatar = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="%236366f1"/><text x="50%" y="54%" font-family="sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
        user = {
          id: payload.uid,
          username,
          email: payload.e || '',
          passwordHash: '',
          salt: '',
          avatar,
          createdAt: payload.c || new Date().toISOString()
        };
        this.data.users.push(user);
        if (!this.data.bookmarks[user.id]) this.data.bookmarks[user.id] = [];
        if (!this.data.history[user.id]) this.data.history[user.id] = [];
        if (!this.data.settings[user.id]) this.data.settings[user.id] = {};
      }

      this.data.sessions[token] = { userId: user.id, expiresAt: Number(payload.exp) };

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar: user.avatar,
        createdAt: user.createdAt
      };
    } catch (_) {
      return null;
    }
  }

  destroySession(token) {
    if (token) {
      this.revokedTokens.add(token);
      if (this.data.sessions[token]) {
        delete this.data.sessions[token];
        this.persist();
      }
    }
  }

  // ---------------- Cloud Synchronization ----------------
  syncUserData(userId, clientBookmarks = [], clientHistory = [], options = {}) {
    if (!this.data.bookmarks[userId]) this.data.bookmarks[userId] = [];
    if (!this.data.history[userId]) this.data.history[userId] = [];
    if (!this.data.settings[userId]) this.data.settings[userId] = {};

    const normalizedBookmarks = Array.isArray(clientBookmarks)
      ? clientBookmarks.map((b) => (b && b.coverUrl ? { ...b, coverUrl: this._normalizeCoverUrl(b.coverUrl) } : b))
      : [];
    const normalizedHistory = Array.isArray(clientHistory)
      ? clientHistory.map((h) => (h && h.coverUrl ? { ...h, coverUrl: this._normalizeCoverUrl(h.coverUrl) } : h))
      : [];

    const {
      replaceBookmarks = false,
      replaceHistory = false,
      removedBookmarkIds = [],
      removedHistoryIds = [],
      settings = null
    } = options || {};

    // 1. Sync Bookmarks (supports accurate deletion & full replacement)
    if (replaceBookmarks) {
      this.data.bookmarks[userId] = normalizedBookmarks.slice(0, 500);
    } else {
      const serverBookmarks = this.data.bookmarks[userId];
      const bookmarkMap = new Map();

      serverBookmarks.forEach((b) => {
        if (b && b.id) bookmarkMap.set(b.id, b);
      });

      normalizedBookmarks.forEach((b) => {
        if (!b || !b.id) return;
        if (!bookmarkMap.has(b.id) || (b.addedAt && b.addedAt > (bookmarkMap.get(b.id).addedAt || 0))) {
          bookmarkMap.set(b.id, b);
        }
      });

      if (Array.isArray(removedBookmarkIds)) {
        removedBookmarkIds.forEach((id) => bookmarkMap.delete(id));
      }

      this.data.bookmarks[userId] = Array.from(bookmarkMap.values()).slice(0, 500);
    }

    // 2. Sync History (supports accurate deletion, clear all, & full replacement)
    if (replaceHistory) {
      this.data.history[userId] = normalizedHistory
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 50);
    } else {
      const serverHistory = this.data.history[userId];
      const historyMap = new Map();

      serverHistory.forEach((h) => {
        if (h && h.mangaId) historyMap.set(h.mangaId, h);
      });

      normalizedHistory.forEach((h) => {
        if (!h || !h.mangaId) return;
        if (!historyMap.has(h.mangaId) || (h.updatedAt && h.updatedAt > (historyMap.get(h.mangaId).updatedAt || 0))) {
          historyMap.set(h.mangaId, h);
        }
      });

      if (Array.isArray(removedHistoryIds)) {
        removedHistoryIds.forEach((id) => historyMap.delete(id));
      }

      const mergedHistory = Array.from(historyMap.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      this.data.history[userId] = mergedHistory.slice(0, 50);
    }

    // 3. Sync Reader Settings if provided
    if (settings && typeof settings === 'object') {
      this.data.settings[userId] = {
        ...this.data.settings[userId],
        ...settings
      };
    }

    this.persist();

    return this.getUserData(userId);
  }

  getUserData(userId) {
    // Also collect list of manga IDs liked by this user
    const likedMangaIds = [];
    for (const [mangaId, userList] of Object.entries(this.data.likes || {})) {
      if (Array.isArray(userList) && userList.includes(userId)) {
        likedMangaIds.push(mangaId);
      }
    }

    return {
      bookmarks: this.data.bookmarks[userId] || [],
      history: this.data.history[userId] || [],
      settings: this.data.settings[userId] || null,
      likedMangaIds
    };
  }

  // ---------------- Community Social Features (Likes, Ratings, Comments) ----------------
  getMangaSocial(mangaId, currentUserId = null) {
    if (!mangaId) throw new Error('Manga ID wajib diisi');
    const likesList = Array.isArray(this.data.likes[mangaId]) ? this.data.likes[mangaId] : [];
    const ratingsMap = this.data.ratings[mangaId] && typeof this.data.ratings[mangaId] === 'object'
      ? this.data.ratings[mangaId]
      : {};
    const commentsList = Array.isArray(this.data.comments[mangaId]) ? this.data.comments[mangaId] : [];

    const ratingValues = Object.values(ratingsMap).filter((v) => typeof v === 'number' && v >= 1 && v <= 5);
    const ratingCount = ratingValues.length;
    const ratingAvg = ratingCount > 0
      ? Number((ratingValues.reduce((a, b) => a + b, 0) / ratingCount).toFixed(2))
      : null;

    return {
      mangaId,
      likesCount: likesList.length,
      userLiked: currentUserId ? likesList.includes(currentUserId) : false,
      ratingAvg,
      ratingCount,
      userRating: currentUserId && ratingsMap[currentUserId] ? ratingsMap[currentUserId] : null,
      comments: commentsList.slice(0, 100)
    };
  }

  toggleMangaLike(mangaId, userId) {
    if (!mangaId || !userId) throw new Error('Manga ID dan User ID wajib diisi');
    if (!Array.isArray(this.data.likes[mangaId])) {
      this.data.likes[mangaId] = [];
    }

    const list = this.data.likes[mangaId];
    const idx = list.indexOf(userId);
    let liked = false;

    if (idx >= 0) {
      list.splice(idx, 1);
      liked = false;
    } else {
      list.push(userId);
      liked = true;
    }

    this.persist();
    return {
      liked,
      likesCount: list.length
    };
  }

  rateManga(mangaId, userId, score) {
    if (!mangaId || !userId) throw new Error('Manga ID dan User ID wajib diisi');
    const numericScore = Math.round(Number(score));
    if (!numericScore || numericScore < 1 || numericScore > 5) {
      throw new Error('Rating harus berupa angka antara 1 sampai 5 bintang.');
    }

    if (!this.data.ratings[mangaId] || typeof this.data.ratings[mangaId] !== 'object') {
      this.data.ratings[mangaId] = {};
    }

    this.data.ratings[mangaId][userId] = numericScore;
    this.persist();

    const social = this.getMangaSocial(mangaId, userId);
    return {
      userRating: social.userRating,
      ratingAvg: social.ratingAvg,
      ratingCount: social.ratingCount
    };
  }

  addMangaComment(mangaId, user, text) {
    if (!mangaId || !user || !user.id) throw new Error('Anda harus masuk akun untuk mengirim komentar.');
    const cleanText = String(text || '')
      .replace(/<[^>]*>/g, '')
      .trim();

    if (!cleanText) {
      throw new Error('Isi komentar tidak boleh kosong.');
    }
    if (cleanText.length > 600) {
      throw new Error('Komentar maksimal 600 karakter.');
    }

    if (!Array.isArray(this.data.comments[mangaId])) {
      this.data.comments[mangaId] = [];
    }

    const comment = {
      id: crypto.randomUUID(),
      userId: user.id,
      username: user.username,
      avatar: user.avatar,
      text: cleanText,
      createdAt: Date.now()
    };

    this.data.comments[mangaId].unshift(comment);
    // Keep max 100 latest comments per manga
    if (this.data.comments[mangaId].length > 100) {
      this.data.comments[mangaId] = this.data.comments[mangaId].slice(0, 100);
    }

    this.persist();
    return {
      comment,
      comments: this.data.comments[mangaId]
    };
  }

  deleteMangaComment(mangaId, commentId, userId) {
    if (!mangaId || !commentId || !userId) throw new Error('Parameter tidak lengkap.');
    const list = this.data.comments[mangaId];
    if (!Array.isArray(list)) {
      throw new Error('Komentar tidak ditemukan.');
    }

    const idx = list.findIndex((c) => c.id === commentId);
    if (idx === -1) {
      throw new Error('Komentar tidak ditemukan.');
    }

    if (list[idx].userId !== userId) {
      throw new Error('Anda hanya dapat menghapus komentar milik sendiri.');
    }

    list.splice(idx, 1);
    this.persist();
    return {
      comments: list
    };
  }

  deleteUser(userId) {
    this.data.users = this.data.users.filter((u) => u.id !== userId);
    for (const [token, sess] of Object.entries(this.data.sessions)) {
      if (sess.userId === userId) {
        this.revokedTokens.add(token);
        delete this.data.sessions[token];
      }
    }
    delete this.data.bookmarks[userId];
    delete this.data.history[userId];
    delete this.data.settings[userId];

    // Clean up likes, ratings, and comments by this user
    for (const mangaId of Object.keys(this.data.likes || {})) {
      if (Array.isArray(this.data.likes[mangaId])) {
        this.data.likes[mangaId] = this.data.likes[mangaId].filter((id) => id !== userId);
      }
    }
    for (const mangaId of Object.keys(this.data.ratings || {})) {
      if (this.data.ratings[mangaId] && typeof this.data.ratings[mangaId] === 'object') {
        delete this.data.ratings[mangaId][userId];
      }
    }
    for (const mangaId of Object.keys(this.data.comments || {})) {
      if (Array.isArray(this.data.comments[mangaId])) {
        this.data.comments[mangaId] = this.data.comments[mangaId].filter((c) => c.userId !== userId);
      }
    }

    this.persist();
  }
}

module.exports = new Database();
