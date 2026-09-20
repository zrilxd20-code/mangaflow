// ===================================================
// MangaFlow API Client with Anti-Fail & Fallback Logic
// ===================================================

const Api = {
  baseUrl: '/api',

  token: null,

  setToken(token) {
    this.token = token;
  },

  async request(endpoint, options = {}) {
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const res = await fetch(`${this.baseUrl}${endpoint}`, {
        ...options,
        headers
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(errorData.error || `HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      console.error(`[API Error] ${endpoint}:`, err);
      throw err;
    }
  },

  // ---------------- Authentication & Cloud Sync ----------------
  async register(username, email, password) {
    return this.request('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password })
    });
  },

  async login(identifier, password) {
    return this.request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    });
  },

  async getMe() {
    return this.request('/auth/me');
  },

  async syncUserData(bookmarks, history) {
    return this.request('/auth/sync', {
      method: 'POST',
      body: JSON.stringify({ bookmarks, history })
    });
  },

  async logout() {
    try {
      await this.request('/auth/logout', { method: 'POST' });
    } catch (_) {}
    this.token = null;
  },

  // 1. Trending
  async getTrending() {
    return this.request('/trending');
  },

  // 2. Latest Updates
  async getLatest(page = 1) {
    return this.request(`/latest?page=${page}`);
  },

  // 3. Search with filters
  async search(params = {}) {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.tags) qs.set('tags', params.tags);
    if (params.status) qs.set('status', params.status);
    if (params.sort) qs.set('sort', params.sort);
    if (params.lang) qs.set('lang', params.lang);
    if (params.page) qs.set('page', params.page);

    return this.request(`/search?${qs.toString()}`);
  },

  // 4. Tags
  async getTags() {
    return this.request('/tags');
  },

  // 5. Manga Details
  async getManga(id) {
    if (String(id).startsWith('pill-')) {
      return this.getMangaPillDetail(id);
    }
    return this.request(`/manga/${id}`);
  },

  // 6. Manga Chapters
  async getChapters(mangaId, lang = 'en,id', order = 'desc') {
    if (String(mangaId).startsWith('pill-')) {
      const res = await this.getMangaPillDetail(mangaId);
      let chapters = res.data?.chapters || [];
      if (order === 'asc') {
        chapters = [...chapters].reverse();
      }
      return { success: true, data: chapters, total: chapters.length };
    }
    return this.request(`/manga/${mangaId}/chapters?lang=${encodeURIComponent(lang)}&order=${order}`);
  },

  // 7. Chapter Pages
  async getChapterPages(chapterId) {
    if (String(chapterId).startsWith('pill-')) {
      return this.getMangaPillChapter(chapterId);
    }
    return this.request(`/chapter/${chapterId}`);
  },

  // ---------------- MangaPill (Complete Chapters Provider) ----------------
  async searchMangaPill(q) {
    return this.request(`/mangapill/search?q=${encodeURIComponent(q)}`);
  },

  async getMangaPillDetail(id, slug = '') {
    const cleanId = String(id).replace(/^pill-/, '');
    return this.request(`/mangapill/manga/${cleanId}${slug ? '/' + slug : ''}`);
  },

  async getMangaPillChapter(chapterId, slug = '') {
    const cleanChId = String(chapterId).replace(/^pill-/, '');
    return this.request(`/mangapill/chapter/${cleanChId}${slug ? '/' + slug : ''}`);
  },

  // ---------------- Image Resilience Helper ----------------
  // Bypasses ISP blocks, MangaDex 404s, CORS, or broken mirrors
  setupImageResilience(imgElement, pageData) {
    if (!imgElement || !pageData) return;

    let step = 0; // 0: direct, 1: proxy, 2: direct data-saver, 3: proxy data-saver

    imgElement.onerror = () => {
      step++;
      console.warn(`[Image Failover Step ${step}] Retrying page ${pageData.page}`);

      if (step === 1) {
        // Retry through backend image proxy
        imgElement.src = pageData.proxyUrl;
      } else if (step === 2 && pageData.dataSaverUrl) {
        // Retry with direct dataSaver URL
        imgElement.src = pageData.dataSaverUrl;
      } else if (step === 3 && pageData.proxyDataSaverUrl) {
        // Retry with proxy dataSaver URL
        imgElement.src = pageData.proxyDataSaverUrl;
      } else {
        // Complete failure fallback: sleek dark placeholder
        imgElement.onerror = null;
        imgElement.src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1200" viewBox="0 0 800 1200"><rect fill="%2311141c" width="800" height="1200"/><text fill="%23818cf8" font-family="sans-serif" font-size="28" x="50%" y="48%" text-anchor="middle">Halaman ' + pageData.page + ' Tidak Tersedia</text><text fill="%2364748b" font-family="sans-serif" font-size="18" x="50%" y="52%" text-anchor="middle">Klik untuk memuat ulang</text></svg>';
        imgElement.style.cursor = 'pointer';
        imgElement.onclick = () => {
          step = 0;
          imgElement.src = pageData.proxyUrl + '&t=' + Date.now();
        };
      }
    };
  }
};
