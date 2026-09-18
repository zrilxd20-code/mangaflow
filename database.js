// ===================================================
// MangaFlow Zero-Break Embedded Database Engine
// Pure Node.js (Zero external native dependencies)
// ===================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const scryptAsync = util.promisify(crypto.scrypt);

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

class Database {
  constructor() {
    this.data = {
      users: [],      // { id, username, email, passwordHash, salt, avatar, createdAt }
      sessions: {},   // token: { userId, expiresAt }
      bookmarks: {},  // userId: [ { id, title, coverUrl, status, addedAt } ]
      history: {}     // userId: [ { mangaId, mangaTitle, coverUrl, chapterId, ... } ]
    };
    this.init();
  }

  init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = {
          users: parsed.users || [],
          sessions: parsed.sessions || {},
          bookmarks: parsed.bookmarks || {},
          history: parsed.history || {}
        };
      } else {
        this.persist();
      }
    } catch (err) {
      console.warn('[Database Init] Using fallback memory state:', err.message);
    }
  }

  persist() {
    try {
      const tempFile = `${DB_FILE}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (err) {
      console.error('[Database Persist Error]:', err.message);
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
    const initial = username.charAt(0).toUpperCase();
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

    const token = crypto.randomBytes(32).toString('hex');
    // Session valid for 30 days
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;

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
    if (!token) return null;
    const session = this.data.sessions[token];
    if (!session) return null;

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

  destroySession(token) {
    if (token && this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.persist();
    }
  }

  // ---------------- Cloud Synchronization ----------------
  syncUserData(userId, clientBookmarks = [], clientHistory = []) {
    if (!this.data.bookmarks[userId]) this.data.bookmarks[userId] = [];
    if (!this.data.history[userId]) this.data.history[userId] = [];

    // Merge Bookmarks (union by manga id)
    const serverBookmarks = this.data.bookmarks[userId];
    const bookmarkMap = new Map();

    // Server items first
    serverBookmarks.forEach((b) => bookmarkMap.set(b.id, b));
    // Client items take priority if newer
    clientBookmarks.forEach((b) => {
      if (!bookmarkMap.has(b.id) || (b.addedAt && b.addedAt > (bookmarkMap.get(b.id).addedAt || 0))) {
        bookmarkMap.set(b.id, b);
      }
    });
    this.data.bookmarks[userId] = Array.from(bookmarkMap.values());

    // Merge History (union by mangaId)
    const serverHistory = this.data.history[userId];
    const historyMap = new Map();

    serverHistory.forEach((h) => historyMap.set(h.mangaId, h));
    clientHistory.forEach((h) => {
      if (!historyMap.has(h.mangaId) || (h.updatedAt && h.updatedAt > (historyMap.get(h.mangaId).updatedAt || 0))) {
        historyMap.set(h.mangaId, h);
      }
    });

    const mergedHistory = Array.from(historyMap.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.data.history[userId] = mergedHistory.slice(0, 50);

    this.persist();

    return {
      bookmarks: this.data.bookmarks[userId],
      history: this.data.history[userId]
    };
  }

  getUserData(userId) {
    return {
      bookmarks: this.data.bookmarks[userId] || [],
      history: this.data.history[userId] || []
    };
  }
}

module.exports = new Database();
