// ===================================================
// MangaFlow Client State & Storage Management
// ===================================================

const State = {
  BOOKMARKS_KEY: 'mangaflow_bookmarks',
  HISTORY_KEY: 'mangaflow_history',
  SETTINGS_KEY: 'mangaflow_settings',
  LIKES_KEY: 'mangaflow_likes',
  AUTH_TOKEN_KEY: 'mangaflow_auth_token',
  AUTH_USER_KEY: 'mangaflow_auth_user',

  user: null,
  token: null,
  syncTimeout: null,
  storageMode: 'local-disk',
  pendingRemovedBookmarks: new Set(),
  pendingRemovedHistory: new Set(),
  pendingReplaceHistory: false,

  // Default Reader Settings
  settings: {
    readerMode: 'webtoon', // 'webtoon' | 'single'
    direction: 'rtl',      // 'rtl' (Japanese Manga) | 'ltr' (Western / Manhwa)
    fitMode: 'width',      // 'width' | 'height'
    readerWidth: 'standard', // 'compact' | 'standard' | 'wide' | 'full'
    quality: 'original',   // 'original' | 'saver'
    brightness: 100,       // 30 - 100 %
    zoom: 100,             // 50 - 220 %
    readerBg: 'oled',      // 'oled' | 'dark' | 'midnight' | 'sepia'
    autoScrollSpeed: 2,    // 1 - 5
    languages: ['en', 'id']
  },

  init() {
    try {
      const savedSettings = localStorage.getItem(this.SETTINGS_KEY);
      if (savedSettings) {
        this.settings = { ...this.settings, ...JSON.parse(savedSettings) };
      }
    } catch (e) {
      console.warn('Failed to load settings:', e);
    }

    this.initAuth();
  },

  initAuth() {
    try {
      const savedToken = localStorage.getItem(this.AUTH_TOKEN_KEY);
      const savedUser = localStorage.getItem(this.AUTH_USER_KEY);
      if (savedToken && savedUser) {
        this.token = savedToken;
        this.user = JSON.parse(savedUser);
        if (typeof Api !== 'undefined') {
          Api.setToken(this.token);
        }

        // Verify & refresh data in background
        setTimeout(async () => {
          try {
            if (typeof Api !== 'undefined') {
              const res = await Api.getMe();
              if (res.success && res.user) {
                this.user = res.user;
                if (res.storageMode) this.storageMode = res.storageMode;
                localStorage.setItem(this.AUTH_USER_KEY, JSON.stringify(res.user));
                if (res.data) {
                  this.mergeCloudData(res.data);
                }
                if (typeof app !== 'undefined' && app.updateAuthUI) {
                  app.updateAuthUI();
                }
              }
            }
          } catch (err) {
            console.warn('[Auth Check] Sesi berakhir:', err.message);
            if (err && err.status === 401) {
              this.user = null;
              this.token = null;
              if (typeof Api !== 'undefined') Api.setToken(null);
              try {
                localStorage.removeItem(this.AUTH_TOKEN_KEY);
                localStorage.removeItem(this.AUTH_USER_KEY);
              } catch (_) {}
              if (typeof app !== 'undefined' && app.updateAuthUI) {
                app.updateAuthUI();
              }
            }
          }
        }, 100);
      }
    } catch (e) {
      console.warn('Failed to load auth state:', e);
    }
  },

  setAuth(user, token, serverData = null) {
    this.user = user;
    this.token = token;
    try {
      localStorage.setItem(this.AUTH_TOKEN_KEY, token);
      localStorage.setItem(this.AUTH_USER_KEY, JSON.stringify(user));
    } catch (e) {}

    if (typeof Api !== 'undefined') {
      Api.setToken(token);
    }

    if (serverData) {
      this.mergeCloudData(serverData);
      // Push merged local+cloud state back to server
      this.triggerBackgroundSync();
    } else {
      // Sync local bookmarks & history to newly logged in account
      this.triggerBackgroundSync();
    }

    if (typeof app !== 'undefined' && app.updateAuthUI) {
      app.updateAuthUI();
    }
  },

  logout() {
    if (typeof Api !== 'undefined') {
      Api.logout();
    }
    this.user = null;
    this.token = null;
    this.pendingRemovedBookmarks.clear();
    this.pendingRemovedHistory.clear();
    this.pendingReplaceHistory = false;
    try {
      localStorage.removeItem(this.AUTH_TOKEN_KEY);
      localStorage.removeItem(this.AUTH_USER_KEY);
    } catch (e) {}

    if (typeof app !== 'undefined' && app.updateAuthUI) {
      app.updateAuthUI();
    }
  },

  isLoggedIn() {
    return Boolean(this.token && this.user);
  },

  mergeCloudData(cloudData) {
    if (!cloudData) return;

    // Merge bookmarks while respecting pending local deletions
    if (Array.isArray(cloudData.bookmarks)) {
      const local = this.getBookmarks();
      const map = new Map();
      cloudData.bookmarks.forEach((b) => {
        if (b && b.id && !this.pendingRemovedBookmarks.has(b.id)) {
          map.set(b.id, b);
        }
      });
      local.forEach((b) => {
        if (b && b.id && !this.pendingRemovedBookmarks.has(b.id)) {
          if (!map.has(b.id) || (b.addedAt && b.addedAt > (map.get(b.id).addedAt || 0))) {
            map.set(b.id, b);
          }
        }
      });
      const merged = Array.from(map.values());
      try {
        localStorage.setItem(this.BOOKMARKS_KEY, JSON.stringify(merged));
      } catch (_) {}
    }

    // Merge history while respecting pending local deletions
    if (Array.isArray(cloudData.history) && !this.pendingReplaceHistory) {
      const local = this.getHistory();
      const map = new Map();
      cloudData.history.forEach((h) => {
        if (h && h.mangaId && !this.pendingRemovedHistory.has(h.mangaId)) {
          map.set(h.mangaId, h);
        }
      });
      local.forEach((h) => {
        if (h && h.mangaId && !this.pendingRemovedHistory.has(h.mangaId)) {
          if (!map.has(h.mangaId) || (h.updatedAt && h.updatedAt > (map.get(h.mangaId).updatedAt || 0))) {
            map.set(h.mangaId, h);
          }
        }
      });
      const mergedHistory = Array.from(map.values())
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 50);
      try {
        localStorage.setItem(this.HISTORY_KEY, JSON.stringify(mergedHistory));
      } catch (_) {}
    }

    // Merge cloud settings if present
    if (cloudData.settings && typeof cloudData.settings === 'object' && Object.keys(cloudData.settings).length > 0) {
      this.settings = { ...this.settings, ...cloudData.settings };
      try {
        localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings));
      } catch (_) {}
    }

    // Merge liked manga IDs if present
    if (Array.isArray(cloudData.likedMangaIds)) {
      const localLikes = this.getLocalLikes();
      const mergedLikes = Array.from(new Set([...localLikes, ...cloudData.likedMangaIds]));
      try {
        localStorage.setItem(this.LIKES_KEY, JSON.stringify(mergedLikes));
      } catch (_) {}
    }

    if (typeof app !== 'undefined') {
      app.updateBadgeCounts?.();
      app.renderContinueReading?.();
      if (app.currentView === 'library') {
        app.renderLibraryView?.();
      } else if (app.currentView === 'history') {
        app.renderHistoryView?.();
      }
    }
  },

  triggerBackgroundSync(immediateOptions = null) {
    if (!this.isLoggedIn() || typeof Api === 'undefined') return;

    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(async () => {
      const syncOptions = immediateOptions || {
        removedBookmarkIds: Array.from(this.pendingRemovedBookmarks),
        removedHistoryIds: Array.from(this.pendingRemovedHistory),
        replaceHistory: this.pendingReplaceHistory,
        settings: this.settings
      };

      try {
        const res = await Api.syncUserData(this.getBookmarks(), this.getHistory(), syncOptions);
        if (res.success && res.data) {
          this.pendingRemovedBookmarks.clear();
          this.pendingRemovedHistory.clear();
          this.pendingReplaceHistory = false;
          if (res.storageMode) this.storageMode = res.storageMode;
        }
      } catch (err) {
        console.warn('[Cloud Sync Error]:', err.message);
      }
    }, 800);
  },

  saveSettings() {
    try {
      localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
    this.triggerBackgroundSync();
  },

  // ---------------- Local Likes Cache ----------------
  getLocalLikes() {
    try {
      return JSON.parse(localStorage.getItem(this.LIKES_KEY) || '[]');
    } catch (e) {
      return [];
    }
  },

  isMangaLikedLocally(mangaId) {
    return this.getLocalLikes().includes(mangaId);
  },

  setMangaLikedLocally(mangaId, liked) {
    let list = this.getLocalLikes();
    if (liked) {
      if (!list.includes(mangaId)) list.push(mangaId);
    } else {
      list = list.filter((id) => id !== mangaId);
    }
    try {
      localStorage.setItem(this.LIKES_KEY, JSON.stringify(list));
    } catch (_) {}
  },

  // ---------------- Cover URL Normalization ----------------
  normalizeCoverUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    if (trimmed.startsWith('/api/proxy/image?url=%2Fapi%2Fproxy%2Fimage')) {
      try {
        const inner = new URL(trimmed, window.location.origin).searchParams.get('url');
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
  },

  // ---------------- Bookmarks ----------------
  getBookmarks() {
    try {
      const list = JSON.parse(localStorage.getItem(this.BOOKMARKS_KEY) || '[]');
      return Array.isArray(list)
        ? list.map((item) => (item && item.coverUrl ? { ...item, coverUrl: this.normalizeCoverUrl(item.coverUrl) } : item))
        : [];
    } catch (e) {
      return [];
    }
  },

  isBookmarked(mangaId) {
    const list = this.getBookmarks();
    return list.some((item) => item.id === mangaId);
  },

  toggleBookmark(manga) {
    if (!manga || !manga.id) return false;
    let list = this.getBookmarks();
    const index = list.findIndex((item) => item.id === manga.id);
    let added = false;

    if (index >= 0) {
      list.splice(index, 1);
      added = false;
      this.pendingRemovedBookmarks.add(manga.id);
    } else {
      list.unshift({
        id: manga.id,
        title: manga.title,
        coverUrl: this.normalizeCoverUrl(manga.coverUrlSmall || manga.coverUrl),
        status: manga.status,
        source: manga.source || (String(manga.id).startsWith('pill-') ? 'mangapill' : 'mangadex'),
        addedAt: Date.now()
      });
      added = true;
      this.pendingRemovedBookmarks.delete(manga.id);
    }

    try {
      localStorage.setItem(this.BOOKMARKS_KEY, JSON.stringify(list));
    } catch (e) {}

    this.triggerBackgroundSync();
    return added;
  },

  // ---------------- Reading History ----------------
  getHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '[]');
      return Array.isArray(list)
        ? list.map((item) => (item && item.coverUrl ? { ...item, coverUrl: this.normalizeCoverUrl(item.coverUrl) } : item))
        : [];
    } catch (e) {
      return [];
    }
  },

  saveHistory(manga, chapter, page = 1, totalPages = 1) {
    if (!manga || !chapter) return;
    let list = this.getHistory();

    // Remove older entry if exists
    list = list.filter((item) => item.mangaId !== manga.id);

    // Push newest to top
    list.unshift({
      mangaId: manga.id,
      mangaTitle: manga.title,
      coverUrl: this.normalizeCoverUrl(manga.coverUrlSmall || manga.coverUrl),
      chapterId: chapter.id,
      chapterNum: chapter.chapter || '0',
      chapterTitle: chapter.title || '',
      page,
      totalPages,
      updatedAt: Date.now()
    });

    this.pendingRemovedHistory.delete(manga.id);

    // Keep max 50 items
    if (list.length > 50) list = list.slice(0, 50);

    try {
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(list));
    } catch (e) {}

    this.triggerBackgroundSync();
  },

  removeHistoryItem(mangaId) {
    if (!mangaId) return;
    const list = this.getHistory().filter((item) => item.mangaId !== mangaId);
    this.pendingRemovedHistory.add(mangaId);

    try {
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(list));
    } catch (_) {}

    if (typeof app !== 'undefined') {
      app.updateBadgeCounts?.();
      app.renderContinueReading?.();
      if (app.currentView === 'history') {
        app.renderHistoryView?.();
      }
    }
    this.triggerBackgroundSync();
  },

  clearHistory() {
    try {
      localStorage.removeItem(this.HISTORY_KEY);
    } catch (_) {}
    this.pendingReplaceHistory = true;
    if (typeof app !== 'undefined') {
      app.updateBadgeCounts?.();
      app.renderContinueReading?.();
      if (app.currentView === 'history') {
        app.renderHistoryView?.();
      }
    }
    this.triggerBackgroundSync({
      replaceHistory: true,
      settings: this.settings
    });
  },

  isChapterRead(chapterId) {
    const list = this.getHistory();
    return list.some((h) => h.chapterId === chapterId);
  },

  // ---------------- Backup Export & Import (JSON) ----------------
  exportBackupData() {
    return {
      app: 'MangaFlow',
      version: '1.1.0',
      exportedAt: new Date().toISOString(),
      user: this.user ? { username: this.user.username, email: this.user.email } : null,
      bookmarks: this.getBookmarks(),
      history: this.getHistory(),
      likes: this.getLocalLikes(),
      settings: this.settings
    };
  },

  importBackupData(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('File backup tidak valid.');
    }
    if (!Array.isArray(payload.bookmarks) && !Array.isArray(payload.history)) {
      throw new Error('Format data backup MangaFlow tidak dikenali.');
    }

    this.mergeCloudData({
      bookmarks: payload.bookmarks || [],
      history: payload.history || [],
      settings: payload.settings || null,
      likedMangaIds: payload.likes || []
    });

    if (this.isLoggedIn()) {
      this.triggerBackgroundSync({
        replaceBookmarks: true,
        replaceHistory: true,
        settings: this.settings
      });
    }

    return {
      bookmarksCount: this.getBookmarks().length,
      historyCount: this.getHistory().length
    };
  }
};

// Global Online/Offline Network Resilience Handlers
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    State.triggerBackgroundSync();
    if (typeof app !== 'undefined' && app.showToast) {
      app.showToast('Koneksi internet pulih. Data tersinkronisasi.');
    }
  });

  window.addEventListener('offline', () => {
    if (typeof app !== 'undefined' && app.showToast) {
      app.showToast('Koneksi terputus. Mode baca lokal aktif.');
    }
  });
}

State.init();
