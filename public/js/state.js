// ===================================================
// MangaFlow Client State & Storage Management
// ===================================================

const State = {
  BOOKMARKS_KEY: 'mangaflow_bookmarks',
  HISTORY_KEY: 'mangaflow_history',
  SETTINGS_KEY: 'mangaflow_settings',
  AUTH_TOKEN_KEY: 'mangaflow_auth_token',
  AUTH_USER_KEY: 'mangaflow_auth_user',

  user: null,
  token: null,
  syncTimeout: null,

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

    // Merge bookmarks
    if (Array.isArray(cloudData.bookmarks)) {
      const local = this.getBookmarks();
      const map = new Map();
      cloudData.bookmarks.forEach((b) => map.set(b.id, b));
      local.forEach((b) => {
        if (!map.has(b.id) || (b.addedAt && b.addedAt > (map.get(b.id).addedAt || 0))) {
          map.set(b.id, b);
        }
      });
      const merged = Array.from(map.values());
      try {
        localStorage.setItem(this.BOOKMARKS_KEY, JSON.stringify(merged));
      } catch (_) {}
    }

    // Merge history
    if (Array.isArray(cloudData.history)) {
      const local = this.getHistory();
      const map = new Map();
      cloudData.history.forEach((h) => map.set(h.mangaId, h));
      local.forEach((h) => {
        if (!map.has(h.mangaId) || (h.updatedAt && h.updatedAt > (map.get(h.mangaId).updatedAt || 0))) {
          map.set(h.mangaId, h);
        }
      });
      const mergedHistory = Array.from(map.values())
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .slice(0, 50);
      try {
        localStorage.setItem(this.HISTORY_KEY, JSON.stringify(mergedHistory));
      } catch (_) {}
    }

    if (typeof app !== 'undefined') {
      app.updateBadgeCounts();
      app.renderContinueReading();
    }
  },

  triggerBackgroundSync() {
    if (!this.isLoggedIn() || typeof Api === 'undefined') return;

    clearTimeout(this.syncTimeout);
    this.syncTimeout = setTimeout(async () => {
      try {
        const res = await Api.syncUserData(this.getBookmarks(), this.getHistory());
        if (res.success && res.data) {
          // Cloud sync success
        }
      } catch (err) {
        console.warn('[Cloud Sync Error]:', err.message);
      }
    }, 2000);
  },

  saveSettings() {
    try {
      localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(this.settings));
    } catch (e) {
      console.warn('Failed to save settings:', e);
    }
  },

  // ---------------- Bookmarks ----------------
  getBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(this.BOOKMARKS_KEY) || '[]');
    } catch (e) {
      return [];
    }
  },

  isBookmarked(mangaId) {
    const list = this.getBookmarks();
    return list.some((item) => item.id === mangaId);
  },

  toggleBookmark(manga) {
    let list = this.getBookmarks();
    const index = list.findIndex((item) => item.id === manga.id);
    let added = false;

    if (index >= 0) {
      list.splice(index, 1);
      added = false;
    } else {
      list.unshift({
        id: manga.id,
        title: manga.title,
        coverUrl: manga.coverUrlSmall || manga.coverUrl,
        status: manga.status,
        addedAt: Date.now()
      });
      added = true;
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
      return JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '[]');
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
      coverUrl: manga.coverUrlSmall || manga.coverUrl,
      chapterId: chapter.id,
      chapterNum: chapter.chapter || '0',
      chapterTitle: chapter.title || '',
      page,
      totalPages,
      updatedAt: Date.now()
    });

    // Keep max 50 items
    if (list.length > 50) list = list.slice(0, 50);

    try {
      localStorage.setItem(this.HISTORY_KEY, JSON.stringify(list));
    } catch (e) {}

    this.triggerBackgroundSync();
  },

  clearHistory() {
    localStorage.removeItem(this.HISTORY_KEY);
  },

  isChapterRead(chapterId) {
    const list = this.getHistory();
    return list.some((h) => h.chapterId === chapterId);
  }
};

State.init();
