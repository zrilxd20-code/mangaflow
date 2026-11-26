// ===================================================
// MangaFlow Main Application Controller
// ===================================================

const app = {
  currentView: 'home',
  selectedManga: null,
  trendingData: [],
  heroIndex: 0,
  heroItemsCount: 0,
  heroInterval: null,
  heroPaused: false,
  splashDismissed: false,
  topLoaderTimer: null,
  searchTimeout: null,
  quickSearchAbort: null,
  searchViewAbort: null,
  filterTags: [],
  selectedFilterTags: new Set(),
  selectedSort: 'relevance',
  selectedStatus: '',
  activeSource: 'auto',
  chaptersDisplayLimit: 80,

  async init() {
    const bootStart = Date.now();
    // Hard failsafe so visitors see content fast even on slow networks
    setTimeout(() => this.hideSplashScreen(), 1200);

    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.heroPaused = true;
    }

    Reader.init();
    this.bindGlobalEvents();
    this.initScrollTopButton();
    this.syncLangPrefUI();
    this.updateBadgeCounts();
    this.updateAuthUI();
    this.initPWA();
    this.renderContinueReading();
    this.initRouter();

    // Launch all initial requests in parallel; dismiss splash as soon as Hero/Trending is ready
    const heroPromise = this.loadHeroAndTrending();
    this.loadLatestUpdates();
    this.loadTags();

    await Promise.allSettled([heroPromise]);

    const elapsed = Date.now() - bootStart;
    const minHold = Math.max(0, 260 - elapsed);
    setTimeout(() => this.hideSplashScreen(), minHold);
  },

  hideSplashScreen() {
    if (this.splashDismissed) return;
    this.splashDismissed = true;
    const splash = document.getElementById('app-splash-screen');
    if (!splash) return;

    splash.classList.add('is-hiding');
    const finish = () => splash.classList.add('is-hidden');
    const activeAnimations = typeof splash.getAnimations === 'function' ? splash.getAnimations() : [];
    if (activeAnimations.length === 0) {
      finish();
      return;
    }
    splash.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 480);
  },

  showTopLoader() {
    const bar = document.getElementById('top-loading-bar');
    if (!bar) return;
    clearTimeout(this.topLoaderTimer);
    bar.classList.remove('done');
    bar.classList.add('active');
  },

  finishTopLoader() {
    const bar = document.getElementById('top-loading-bar');
    if (!bar) return;
    bar.classList.remove('active');
    bar.classList.add('done');
    clearTimeout(this.topLoaderTimer);
    this.topLoaderTimer = setTimeout(() => {
      bar.classList.remove('done');
    }, 320);
  },

  bindGlobalEvents() {
    const searchInput = document.getElementById('global-search-input');
    const searchDropdown = document.getElementById('quick-search-results');
    const clearBtn = document.getElementById('search-clear-btn');
    const kbdHint = document.getElementById('search-kbd-hint');

    if (searchInput) {
      searchInput.addEventListener('focus', () => {
        if (kbdHint) kbdHint.style.display = 'none';
        if (!searchInput.value.trim()) {
          this.renderRecentSearchSuggestions('quick-search-results');
        }
      });

      searchInput.addEventListener('blur', () => {
        if (kbdHint && !searchInput.value.trim()) {
          kbdHint.style.display = '';
        }
      });

      searchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';
        if (kbdHint) kbdHint.style.display = 'none';

        clearTimeout(this.searchTimeout);
        if (!q) {
          this.renderRecentSearchSuggestions('quick-search-results');
          return;
        }

        this.searchTimeout = setTimeout(() => {
          this.executeQuickSearch(q, 'quick-search-results');
        }, 200);
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = searchInput.value.trim();
          if (q) {
            if (searchDropdown) searchDropdown.classList.remove('open');
            this.performSearch(q);
          }
        }
      });
    }

    // Mobile Search Bar Inputs & Dropdown
    const mobSearchInput = document.getElementById('mobile-search-input');
    const mobSearchDropdown = document.getElementById('mobile-quick-search-results');
    const mobClearBtn = document.getElementById('mobile-search-clear-btn');

    if (mobSearchInput) {
      mobSearchInput.addEventListener('focus', () => {
        if (!mobSearchInput.value.trim()) {
          this.renderRecentSearchSuggestions('mobile-quick-search-results');
        }
      });

      mobSearchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (mobClearBtn) mobClearBtn.style.display = q ? 'block' : 'none';

        clearTimeout(this.searchTimeout);
        if (!q) {
          this.renderRecentSearchSuggestions('mobile-quick-search-results');
          return;
        }

        this.searchTimeout = setTimeout(() => {
          this.executeQuickSearch(q, 'mobile-quick-search-results');
        }, 200);
      });

      mobSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const q = mobSearchInput.value.trim();
          if (q) {
            if (mobSearchDropdown) mobSearchDropdown.classList.remove('open');
            this.toggleMobileSearch(false);
            this.performSearch(q);
          }
        }
      });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-search')) {
        const dd = document.getElementById('quick-search-results');
        if (dd) dd.classList.remove('open');
      }
      if (!e.target.closest('.mobile-search-bar') && !e.target.closest('#btn-mobile-search-toggle') && !e.target.closest('#mob-nav-search')) {
        const mobDd = document.getElementById('mobile-quick-search-results');
        if (mobDd) mobDd.classList.remove('open');
      }
      if (!e.target.closest('.lang-selector')) {
        const lm = document.getElementById('lang-dropdown-menu');
        if (lm) lm.classList.remove('open');
      }
      if (!e.target.closest('.user-menu-wrap')) {
        const um = document.getElementById('user-dropdown-menu');
        if (um) um.classList.remove('open');
      }
    });

    // Bind Filter Modal Sort & Status Option Chips
    document.querySelectorAll('#filter-sort-options .filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#filter-sort-options .filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.selectedSort = chip.dataset.sort || 'relevance';
      });
    });

    document.querySelectorAll('#filter-status-options .filter-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('#filter-status-options .filter-chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.selectedStatus = chip.dataset.status || '';
      });
    });

    // Global keyboard shortcuts: Escape closes active modals; '/' focuses search
    document.addEventListener('keydown', (e) => {
      if (Reader.active) return;

      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT' && !e.target?.isContentEditable) {
          e.preventDefault();
          if (window.innerWidth <= 768) {
            this.toggleMobileSearch(true);
          } else {
            const globalInput = document.getElementById('global-search-input');
            if (globalInput) globalInput.focus();
          }
          return;
        }
      }

      if (e.key !== 'Escape') return;
      const filterModal = document.getElementById('filter-modal');
      if (filterModal && filterModal.style.display === 'flex') {
        filterModal.style.display = 'none';
        return;
      }
      const authModal = document.getElementById('auth-modal');
      if (authModal && authModal.style.display === 'flex') {
        this.toggleAuthModal(false);
        return;
      }
      const iosModal = document.getElementById('ios-install-modal');
      if (iosModal && iosModal.style.display === 'flex') {
        this.toggleIosInstallModal(false);
      }
    });
  },

  initScrollTopButton() {
    const btn = document.getElementById('scroll-top-btn');
    const sentinel = document.getElementById('scroll-top-sentinel');
    const viewport = document.getElementById('app-viewport');
    if (!btn) return;

    // Fallback for browsers without CSS container scroll-state queries (Firefox / Safari)
    const supportsScrollState = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('container-type', 'scroll-state');
    if (!supportsScrollState && sentinel && 'IntersectionObserver' in window) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          document.documentElement.classList.toggle('scrolled', !entry.isIntersecting);
        });
      });
      observer.observe(sentinel);
    }

    // Focus guard: if button hides while focused (e.g. PageUp/Home), move focus cleanly to main viewport
    btn.addEventListener('focusout', (e) => {
      if (!e.relatedTarget && getComputedStyle(btn).visibility === 'hidden' && viewport) {
        viewport.focus({ preventScroll: true });
      }
    });
  },

  scrollToTop() {
    const reduceMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  },

  syncDocumentTitle(customTitle = '') {
    const defaultTitle = 'MangaFlow - Baca Manga Online Modern & Minimalis';
    if (customTitle) {
      document.title = `${customTitle} | MangaFlow`;
      return;
    }
    const map = {
      home: defaultTitle,
      latest: 'Update Manga Terbaru | MangaFlow',
      library: 'Koleksi Favorit | MangaFlow',
      history: 'Riwayat Membaca | MangaFlow',
      search: 'Jelajahi & Cari Komik | MangaFlow'
    };
    document.title = map[this.currentView] || defaultTitle;
  },

  initRouter() {
    window.addEventListener('hashchange', () => this.handleHashChange());

    // Deep-linking via query parameters (?manga=<id> or ?q=<query>)
    const searchParams = new URLSearchParams(window.location.search);
    const mangaId = searchParams.get('manga');
    if (mangaId) {
      const normalizedId = /^\d+$/.test(mangaId.trim()) ? `pill-${mangaId.trim()}` : mangaId.trim();
      this.navigate('manga', { id: normalizedId }, false);
      return;
    }

    const searchQuery = searchParams.get('q');
    if (searchQuery && searchQuery.trim()) {
      this.navigate('search', { q: searchQuery.trim() }, false);
      return;
    }

    // Process initial route if provided
    if (window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#') {
      this.handleHashChange();
    }
  },

  handleHashChange() {
    const rawHash = window.location.hash.replace(/^#\/?/, '') || 'home';
    const [path, queryString] = rawHash.split('?');
    const params = {};
    if (queryString) {
      new URLSearchParams(queryString).forEach((val, key) => {
        params[key] = val;
      });
    }

    const segments = path.split('/').filter(Boolean);
    const view = segments[0] || 'home';

    // If Reader is currently active but new hash is not reader, close reader cleanly
    if (Reader.active && view !== 'reader') {
      Reader.close(false);
    }

    if (view === 'manga' && segments[1]) {
      this.navigate('manga', { id: segments[1] }, false);
    } else if (view === 'reader' && segments[1] && segments[2]) {
      const targetMangaId = segments[1];
      const targetChapterId = segments[2];

      // If Reader is currently active and already displaying this chapter, do nothing
      if (Reader.active && Reader.manga && Reader.manga.id === targetMangaId && Reader.currentChapterId === targetChapterId) {
        return;
      }

      // If Reader is active for this manga, switch chapter smoothly without re-fetching manga
      if (Reader.active && Reader.manga && Reader.manga.id === targetMangaId) {
        Reader.loadChapter(targetChapterId);
        return;
      }

      // Fresh direct open
      this.openDirectChapter(targetMangaId, targetChapterId);
    } else if (view === 'search') {
      this.navigate('search', params, false);
    } else if (['home', 'latest', 'library', 'history'].includes(view)) {
      this.navigate(view, {}, false);
    } else {
      this.navigate('home', {}, false);
    }
  },

  async openDirectChapter(mangaId, chapterId) {
    try {
      const [mangaRes, chaptersRes] = await Promise.all([
        Api.getManga(mangaId),
        Api.getChapters(mangaId, State.settings.languages.join(','))
      ]);
      const readable = (chaptersRes.data || []).filter((c) => !c.isExternal);
      Reader.open(mangaRes.data, chapterId, readable.length > 0 ? readable : (chaptersRes.data || []));
    } catch (err) {
      this.showToast('Gagal memuat chapter langsung: ' + err.message);
      this.navigate('home');
    }
  },

  // ---------------- Navigation ----------------
  navigate(viewName, params = {}, updateHash = true) {
    this.currentView = viewName;

    if (updateHash) {
      let targetHash = '#/' + viewName;
      if (viewName === 'manga' && params.id) {
        targetHash = `#/manga/${params.id}`;
      } else if (viewName === 'search') {
        const qParams = new URLSearchParams();
        if (params.q) qParams.set('q', params.q);
        if (params.tags) qParams.set('tags', params.tags);
        if (params.sort && params.sort !== 'relevance') qParams.set('sort', params.sort);
        if (params.status) qParams.set('status', params.status);
        if (params.page && Number(params.page) > 1) qParams.set('page', params.page);
        const qs = qParams.toString();
        targetHash = qs ? `#/search?${qs}` : '#/search';
      } else if (viewName === 'home') {
        targetHash = '#/';
      }

      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
        return; // will be handled by hashchange event
      }
    }

    const performViewSwitch = () => {
      // Update active nav links
      document.querySelectorAll('.nav-link, .mobile-nav-item, .mob-tab-btn').forEach((el) => {
        el.classList.remove('active');
      });

      const activeNavBtn = document.getElementById(`nav-${viewName}`);
      const activeMobBtn = document.getElementById(`mob-nav-${viewName}`);
      const activeMobTopBtn = document.getElementById(`mob-top-${viewName}`);
      if (activeNavBtn) activeNavBtn.classList.add('active');
      if (activeMobBtn) activeMobBtn.classList.add('active');
      if (activeMobTopBtn) activeMobTopBtn.classList.add('active');

      // Hide all view sections
      document.querySelectorAll('.view-section').forEach((el) => {
        el.style.display = 'none';
      });

      const reduceMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
      this.syncDocumentTitle();

      if (viewName === 'home') {
        document.getElementById('home-view').style.display = 'block';
        this.renderContinueReading();
      } else if (viewName === 'latest') {
        this.showTopLoader();
        this.renderLatestView().finally(() => this.finishTopLoader());
      } else if (viewName === 'library') {
        this.renderLibraryView();
      } else if (viewName === 'history') {
        this.renderHistoryView();
      } else if (viewName === 'manga') {
        this.showTopLoader();
        this.renderMangaDetailView(params.id).finally(() => this.finishTopLoader());
      } else if (viewName === 'search') {
        this.showTopLoader();
        this.renderSearchView(params).finally(() => this.finishTopLoader());
      }
    };

    const canViewTransition =
      this.splashDismissed &&
      typeof document !== 'undefined' &&
      typeof document.startViewTransition === 'function' &&
      !(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    if (!canViewTransition) {
      performViewSwitch();
      if (this.splashDismissed) {
        document.getElementById('app-viewport')?.focus({ preventScroll: true });
      }
      return;
    }

    try {
      const transition = document.startViewTransition(() => performViewSwitch());
      transition.finished.finally(() => {
        document.getElementById('app-viewport')?.focus({ preventScroll: true });
      });
    } catch (_) {
      performViewSwitch();
      document.getElementById('app-viewport')?.focus({ preventScroll: true });
    }
  },

  applyGridStagger(gridEl) {
    if (!gridEl) return;
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function' || !CSS.supports('animation-delay: calc(sibling-index() * 0.04s)')) {
      Array.from(gridEl.children).forEach((el, index) => {
        el.style.setProperty('--sibling-index', String(Math.min(index + 1, 16)));
      });
    }
  },

  // ---------------- Hero & Trending ----------------
  async loadHeroAndTrending() {
    try {
      const res = await Api.getTrending();
      if (!res.success || !res.data) throw new Error('Data trending kosong');

      this.trendingData = res.data;
      this.renderHeroCarousel(res.data.slice(0, 5));
      this.renderTrendingGrid(res.data);
    } catch (err) {
      console.error('Failed to load trending:', err);
      const hero = document.getElementById('hero-container');
      const grid = document.getElementById('trending-grid');
      if (hero) {
        hero.innerHTML = `
          <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:32px;text-align:center;color:var(--text-muted);">
            <i class="ri-wifi-off-line" style="font-size:2.4rem;color:var(--accent-primary);margin-bottom:10px;"></i>
            <h3 style="color:var(--text-main);margin-bottom:6px;">Gagal Memuat Manga Populer</h3>
            <p style="font-size:0.88rem;margin-bottom:16px;">Server sedang sibuk atau koneksi terganggu.</p>
            <button type="button" class="btn btn-primary btn-sm" onclick="app.loadHeroAndTrending()"><i class="ri-refresh-line"></i> Coba Lagi</button>
          </div>
        `;
      }
      if (grid) {
        grid.innerHTML = `
          <div style="grid-column:1 / -1;text-align:center;padding:32px 0;color:var(--text-dim);">
            <p style="margin-bottom:12px;">Tidak dapat memuat daftar trending saat ini.</p>
            <button type="button" class="btn btn-secondary btn-sm" onclick="app.loadHeroAndTrending()"><i class="ri-refresh-line"></i> Muat Ulang</button>
          </div>
        `;
      }
    }
  },

  renderHeroCarousel(items) {
    const container = document.getElementById('hero-container');
    if (!items.length) {
      container.style.display = 'none';
      return;
    }

    this.heroItemsCount = items.length;
    this.heroIndex = 0;
    container.classList.toggle('is-paused', Boolean(this.heroPaused));
    container.innerHTML = '';

    items.forEach((item, index) => {
      const slide = document.createElement('div');
      slide.className = `hero-slide ${index === 0 ? 'active' : ''}`;
      slide.dataset.index = index;

      const tagsHtml = (item.tags || []).slice(0, 3)
        .map((t) => `<span class="hero-tag">${this.escapeHtml(t)}</span>`)
        .join('');

      const fullCover = this.resolveCoverUrl(item.coverUrl) || this.getFallbackCoverDataUri(item.title);
      const smallCover = this.resolveCoverUrl(item.coverUrlSmall || item.coverUrl) || fullCover;
      const priorityAttr = index === 0 ? 'fetchpriority="high"' : 'fetchpriority="low" loading="lazy"';

      slide.innerHTML = `
        <img class="hero-backdrop-img" src="${this.escapeHtml(fullCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(item.title)}" ${priorityAttr} onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
        <div class="hero-gradient-overlay"></div>
        <div class="hero-content">
          <img class="hero-poster" src="${this.escapeHtml(smallCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(item.title)}" ${priorityAttr} onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
          <div class="hero-details">
            <div class="hero-tag-list">
              <span class="hero-rank-pill"><i class="ri-fire-fill"></i> #${index + 1} Trending</span>
              ${tagsHtml}
            </div>
            <h1 class="hero-title">${this.escapeHtml(item.title)}</h1>
            <p class="hero-synopsis">${this.escapeHtml((item.description || '').replace(/\[\/?\w+\]/g, ''))}</p>
            <div class="hero-actions">
              <button class="btn btn-primary" onclick="app.navigate('manga', { id: '${this.escapeHtml(item.id)}' })">
                <i class="ri-book-read-line"></i> Mulai Baca
              </button>
              <button class="btn btn-secondary" data-hero-bookmark-id="${this.escapeHtml(item.id)}" onclick="app.toggleBookmarkFromHero('${this.escapeHtml(item.id)}')">
                <i class="${State.isBookmarked(item.id) ? 'ri-bookmark-fill' : 'ri-bookmark-line'}"></i> <span>${State.isBookmarked(item.id) ? 'Tersimpan' : 'Favorit'}</span>
              </button>
            </div>
          </div>
        </div>
      `;

      container.appendChild(slide);
    });

    // Accessible Carousel Controls (Prev, Pause/Play, Next)
    const controlsWrap = document.createElement('div');
    controlsWrap.className = 'hero-controls';
    controlsWrap.innerHTML = `
      <button type="button" class="hero-ctrl-btn" aria-label="Slide sebelumnya" title="Slide sebelumnya" onclick="app.stepHeroSlide(-1)">
        <i class="ri-arrow-left-s-line"></i>
      </button>
      <button type="button" class="hero-ctrl-btn" id="hero-pause-btn" aria-label="${this.heroPaused ? 'Putar slide otomatis' : 'Jeda slide otomatis'}" title="${this.heroPaused ? 'Putar slide otomatis' : 'Jeda slide otomatis'}" onclick="app.toggleHeroPause()">
        <i class="${this.heroPaused ? 'ri-play-fill' : 'ri-pause-fill'}"></i>
      </button>
      <button type="button" class="hero-ctrl-btn" aria-label="Slide selanjutnya" title="Slide selanjutnya" onclick="app.stepHeroSlide(1)">
        <i class="ri-arrow-right-s-line"></i>
      </button>
    `;
    container.appendChild(controlsWrap);

    // Navigation Dots
    const dotsWrap = document.createElement('div');
    dotsWrap.className = 'hero-nav-dots';
    items.forEach((_, idx) => {
      const dot = document.createElement('div');
      dot.className = `hero-dot ${idx === 0 ? 'active' : ''}`;
      dot.onclick = () => this.setHeroSlide(idx);
      dotsWrap.appendChild(dot);
    });
    container.appendChild(dotsWrap);

    this.startHeroAutoRotate();
  },

  startHeroAutoRotate() {
    clearInterval(this.heroInterval);
    if (this.heroPaused || this.heroItemsCount <= 1) return;
    this.heroInterval = setInterval(() => {
      this.heroIndex = (this.heroIndex + 1) % this.heroItemsCount;
      this.setHeroSlide(this.heroIndex);
    }, 6000);
  },

  stepHeroSlide(delta) {
    if (this.heroItemsCount <= 1) return;
    this.heroIndex = (this.heroIndex + delta + this.heroItemsCount) % this.heroItemsCount;
    this.setHeroSlide(this.heroIndex);
    this.startHeroAutoRotate();
  },

  toggleHeroPause() {
    this.heroPaused = !this.heroPaused;
    const container = document.getElementById('hero-container');
    if (container) {
      container.classList.toggle('is-paused', this.heroPaused);
    }
    const btn = document.getElementById('hero-pause-btn');
    if (btn) {
      const label = this.heroPaused ? 'Putar slide otomatis' : 'Jeda slide otomatis';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.innerHTML = `<i class="${this.heroPaused ? 'ri-play-fill' : 'ri-pause-fill'}"></i>`;
    }
    this.startHeroAutoRotate();
  },

  setHeroSlide(index) {
    this.heroIndex = index;
    const slides = document.querySelectorAll('.hero-slide');
    const dots = document.querySelectorAll('.hero-dot');

    slides.forEach((s, idx) => {
      s.classList.toggle('active', idx === index);
    });
    dots.forEach((d, idx) => {
      d.classList.toggle('active', idx === index);
    });
  },

  renderTrendingGrid(items) {
    const grid = document.getElementById('trending-grid');
    grid.innerHTML = '';

    items.forEach((item, index) => {
      const card = this.createMangaCard(item, index + 1);
      grid.appendChild(card);
    });
    this.applyGridStagger(grid);
  },

  // ---------------- Latest Updates ----------------
  async loadLatestUpdates() {
    try {
      const res = await Api.getLatest(1);
      if (!res.success || !res.data) throw new Error('Data update terbaru kosong');

      const grid = document.getElementById('latest-grid');
      if (!grid) return;
      grid.innerHTML = '';

      res.data.slice(0, 12).forEach((item) => {
        const card = this.createMangaCard(item);
        grid.appendChild(card);
      });
      this.applyGridStagger(grid);
    } catch (err) {
      console.error('Failed to load latest:', err);
      const grid = document.getElementById('latest-grid');
      if (grid) {
        grid.innerHTML = `
          <div style="grid-column:1 / -1;text-align:center;padding:32px 0;color:var(--text-dim);">
            <p style="margin-bottom:12px;">Gagal memuat update terbaru.</p>
            <button type="button" class="btn btn-secondary btn-sm" onclick="app.loadLatestUpdates()"><i class="ri-refresh-line"></i> Muat Ulang</button>
          </div>
        `;
      }
    }
  },

  async renderLatestView(page = 1) {
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const view = document.getElementById('latest-view');
    view.style.display = 'block';

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header">
          <div class="section-title-wrap">
            <i class="ri-sparkling-fill title-icon new"></i>
            <h2>Semua Rilis & Update Terbaru (Hal. ${safePage})</h2>
          </div>
        </div>
        <div class="manga-grid" id="latest-full-grid">
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
        </div>
        <div style="display: flex; justify-content: center; gap: 14px; margin-top: 36px;" id="latest-pagination"></div>
      </div>
    `;

    try {
      const res = await Api.getLatest(safePage);
      const grid = document.getElementById('latest-full-grid');
      if (!grid) return;
      grid.innerHTML = '';

      if (res.data && res.data.length > 0) {
        res.data.forEach((item) => {
          const card = this.createMangaCard(item);
          grid.appendChild(card);
        });
        this.applyGridStagger(grid);

        // Pagination buttons
        const pagination = document.getElementById('latest-pagination');
        if (pagination) {
          pagination.innerHTML = `
            ${safePage > 1 ? `<button class="btn btn-secondary" onclick="app.renderLatestView(${safePage - 1})"><i class="ri-arrow-left-s-line"></i> Halaman Sebelumnya</button>` : ''}
            <button class="btn btn-primary" onclick="app.renderLatestView(${safePage + 1})">Halaman Selanjutnya <i class="ri-arrow-right-s-line"></i></button>
          `;
        }
      } else {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 48px 0; color: var(--text-dim);">
            <i class="ri-file-search-line" style="font-size: 2.5rem; display: block; margin-bottom: 10px;"></i>
            <p>Belum ada rilis terbaru pada halaman ini.</p>
          </div>
        `;
      }
    } catch (err) {
      console.error(err);
      const grid = document.getElementById('latest-full-grid');
      if (grid) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 48px 0; color: var(--text-muted);">
            <i class="ri-error-warning-line" style="font-size: 2.8rem; color: var(--danger); display: block; margin-bottom: 10px;"></i>
            <h3 style="color: var(--text-main); margin-bottom: 6px;">Gagal Memuat Update Terbaru</h3>
            <p style="margin-bottom: 16px;">${this.escapeHtml(err.message || 'Server sedang sibuk.')}</p>
            <button type="button" class="btn btn-primary btn-sm" onclick="app.renderLatestView(${safePage})"><i class="ri-refresh-line"></i> Coba Lagi</button>
          </div>
        `;
      }
    }
  },

  // ---------------- Manga Card Builder ----------------
  createMangaCard(item, rank = null) {
    const card = document.createElement('div');
    card.className = 'manga-card';
    card.onclick = () => this.navigate('manga', { id: item.id });
    const warmDetail = () => Api.prefetchManga(item.id, State.settings.languages.join(','));
    card.addEventListener('pointerenter', warmDetail, { once: true, passive: true });
    card.addEventListener('touchstart', warmDetail, { once: true, passive: true });

    const statusClass = item.status === 'completed' ? 'completed' : 'ongoing';
    const statusText = item.status === 'completed' ? 'Tamat' : 'Ongoing';
    const isPill = item.source === 'mangapill' || String(item.id).startsWith('pill-');
    const isHybrid = Boolean(item.hasCompleteBackup || item.hybridSource);
    const fullCover = this.resolveCoverUrl(item.coverUrl) || this.getFallbackCoverDataUri(item.title);
    const thumbCover = this.resolveCoverUrl(item.coverUrlSmall || item.coverUrl) || fullCover;
    const rankRibbonHtml = Number.isInteger(rank) && rank >= 1 && rank <= 10
      ? `<span class="card-rank-ribbon rank-${rank <= 3 ? rank : 'top'}" aria-label="Peringkat ${rank}">#${rank}</span>`
      : '';

    card.innerHTML = `
      <div class="card-cover-wrap">
        <img class="card-cover" src="${this.escapeHtml(thumbCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(item.title)}" loading="lazy" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
        ${rankRibbonHtml}
        <div class="card-badges">
          ${isPill ? `
            <span class="card-badge" style="background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; font-weight: 700;">
              <i class="ri-check-double-line"></i> Komplit
            </span>
          ` : `
            <span class="card-badge badge-status ${statusClass}">
              <i class="ri-checkbox-blank-circle-fill" style="font-size: 0.55rem;"></i> ${statusText}
            </span>
          `}
          ${isHybrid ? `<span class="card-badge" style="background: rgba(16, 185, 129, 0.85); color: #fff; border: none; font-weight: 700;"><i class="ri-links-line"></i> Hybrid</span>` : ''}
          ${!isHybrid && item.tags && item.tags[0] ? `<span class="card-badge">${this.escapeHtml(item.tags[0])}</span>` : ''}
        </div>
        <span class="card-read-pill"><i class="ri-book-open-line"></i> Baca</span>
      </div>
      <div class="card-body">
        <h4 class="card-title" title="${this.escapeHtml(item.title)}">${this.escapeHtml(item.title)}</h4>
        <div class="card-meta">
          <span>${item.year ? item.year : (isPill ? 'Server Komplit' : 'Manga')}</span>
          <span style="color: #fbbf24;"><i class="ri-star-fill"></i> Populer</span>
        </div>
      </div>
    `;

    return card;
  },

  // ---------------- Continue Reading ----------------
  renderContinueReading() {
    const history = State.getHistory();
    const section = document.getElementById('continue-reading-section');
    const container = document.getElementById('continue-reading-list');

    if (!history.length) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    container.innerHTML = '';

    history.slice(0, 4).forEach((item) => {
      const card = document.createElement('div');
      card.className = 'continue-card';
      card.onclick = () => this.navigate('manga', { id: item.mangaId });

      const thumbCover = this.resolveCoverUrl(item.coverUrl) || this.getFallbackCoverDataUri(item.mangaTitle);

      card.innerHTML = `
        <img class="continue-thumb" src="${this.escapeHtml(thumbCover)}" data-fallback-cover="${this.escapeHtml(thumbCover)}" alt="${this.escapeHtml(item.mangaTitle)}" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
        <div class="continue-info">
          <div class="continue-title">${this.escapeHtml(item.mangaTitle)}</div>
          <div class="continue-sub">Chapter ${this.escapeHtml(String(item.chapterNum))} (Hal. ${Number(item.page) || 1}/${Number(item.totalPages) || 1})</div>
          <button type="button" class="btn btn-primary continue-btn">
            <i class="ri-play-fill"></i> Lanjut
          </button>
        </div>
      `;
      const resumeBtn = card.querySelector('.continue-btn');
      if (resumeBtn) {
        resumeBtn.onclick = (e) => {
          e.stopPropagation();
          this.resumeReading(item.mangaId, item.chapterId);
        };
      }
      container.appendChild(card);
    });
  },

  async resumeReading(mangaId, chapterId) {
    try {
      const [mangaRes, chaptersRes] = await Promise.all([
        Api.getManga(mangaId),
        Api.getChapters(mangaId, State.settings.languages.join(','))
      ]);
      const readable = (chaptersRes.data || []).filter((c) => !c.isExternal);
      Reader.open(mangaRes.data, chapterId, readable.length > 0 ? readable : (chaptersRes.data || []));
    } catch (err) {
      this.showToast('Gagal memuat chapter terakhir: ' + err.message);
    }
  },

  // ---------------- Manga Detail View ----------------
  async renderMangaDetailView(mangaId) {
    this.chaptersDisplayLimit = 80;
    const view = document.getElementById('manga-view');
    view.style.display = 'block';
    view.innerHTML = `
      <div class="detail-container">
        <div class="detail-header skeleton-hero" style="height: 380px;"></div>
      </div>
    `;

    try {
      const [mangaRes, chaptersRes, socialRes] = await Promise.all([
        Api.getManga(mangaId),
        Api.getChapters(mangaId, State.settings.languages.join(','), 'desc', { hybrid: true }),
        Api.getMangaSocial(mangaId).catch(() => ({
          success: true,
          data: { likesCount: 0, userLiked: false, ratingAvg: null, ratingCount: 0, userRating: null, comments: [] }
        }))
      ]);

      const manga = mangaRes.data;
      const chapters = chaptersRes.data || [];
      const hybridMerged = Boolean(chaptersRes.hybridMerged);
      const addedFromPill = Number(chaptersRes.addedFromPill) || 0;
      const social = socialRes?.data || { likesCount: 0, userLiked: false, ratingAvg: null, ratingCount: 0, userRating: null, comments: [] };
      this.selectedManga = manga;
      this.currentMangaSocial = social;
      this.syncDocumentTitle(manga.title);

      const lastReadEntry = State.getHistory().find((h) => h.mangaId === manga.id);

      const isFav = State.isBookmarked(manga.id);
      const isLiked = social.userLiked || State.isMangaLikedLocally(manga.id);
      const likesCount = Math.max(social.likesCount || 0, isLiked ? 1 : 0);
      const userRating = social.userRating || 0;
      const isPill = manga.source === 'mangapill' || String(manga.id).startsWith('pill-');
      const tagsHtml = (manga.tags || [])
        .map((t) => `<span class="detail-tag">${this.escapeHtml(t)}</span>`)
        .join('');

      const starsHtml = [1, 2, 3, 4, 5]
        .map(
          (star) => `
            <button type="button" class="rate-star-btn ${star <= userRating ? 'active' : ''}" onclick="app.submitMangaRating('${manga.id}', ${star})" title="Beri ${star} Bintang">
              <i class="${star <= userRating ? 'ri-star-fill' : 'ri-star-line'}"></i>
            </button>
          `
        )
        .join('');

      const fullCover = this.resolveCoverUrl(manga.coverUrl) || this.getFallbackCoverDataUri(manga.title);

      view.innerHTML = `
        <div class="detail-container">
          <!-- Backdrop Header -->
          <div class="detail-header">
            <img class="detail-backdrop" src="${this.escapeHtml(fullCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(manga.title)}" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
            <div class="detail-header-inner">
              <div class="detail-cover-box">
                <img class="detail-cover-img" src="${this.escapeHtml(fullCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(manga.title)}" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
              </div>
              <div class="detail-main-info">
                <h1 class="detail-title">${this.escapeHtml(manga.title)}</h1>
                <div class="detail-alt-titles">${(manga.altTitles || []).map((t) => this.escapeHtml(t)).join(' • ')}</div>

                <div class="detail-stats-bar">
                  <div class="stat-item" title="Rating Global">
                    <i class="ri-star-fill" style="color: #fbbf24;"></i>
                    <span>${manga.rating || '8.5'} / 10</span>
                  </div>
                  <div class="stat-item" id="detail-community-rating-stat" title="Rating Komunitas MangaFlow">
                    <i class="ri-award-fill" style="color: #a855f7;"></i>
                    <span id="detail-community-rating-text">
                      ${social.ratingAvg ? `${social.ratingAvg} / 5 (${social.ratingCount} Suara)` : 'Belum ada rating komunitas'}
                    </span>
                  </div>
                  ${isPill ? `
                  <div class="stat-item" style="color: #10b981; font-weight: 700;">
                    <i class="ri-checkbox-circle-fill"></i>
                    <span>Server Komplit 100% (${chapters.length} Chapter)</span>
                  </div>
                  ` : `
                  <div class="stat-item">
                    <i class="ri-book-mark-line"></i>
                    <span>${(manga.follows || 0).toLocaleString()} Pembaca</span>
                  </div>
                  ${hybridMerged ? `
                  <div class="stat-item" style="color: #34d399; font-weight: 700;" title="Chapter bolong/eksternal ditambal otomatis dari Server 2">
                    <i class="ri-links-line"></i>
                    <span>Hybrid Otomatis (+${addedFromPill} Ch. Ditambal)</span>
                  </div>
                  ` : ''}
                  `}
                  <div class="stat-item">
                    <i class="ri-information-line"></i>
                    <span style="text-transform: capitalize;">${this.escapeHtml(manga.status)}</span>
                  </div>
                  <div class="stat-item">
                    <i class="ri-calendar-line"></i>
                    <span>${manga.year || 'Unknown'}</span>
                  </div>
                </div>

                <!-- Interactive User Star Rating Bar -->
                <div class="community-rate-bar">
                  <span class="rate-bar-label"><i class="ri-sparkling-line"></i> Beri Rating Anda:</span>
                  <div class="rate-stars-group" id="detail-rate-stars">
                    ${starsHtml}
                  </div>
                  <span class="rate-user-badge" id="detail-user-rating-label">
                    ${userRating ? `Pilihan Anda: ${userRating}/5 ⭐` : 'Klik bintang (1-5)'}
                  </span>
                </div>

                <div class="detail-description">${this.escapeHtml((manga.description || '').replace(/\[\/?\w+\]/g, ''))}</div>

                <div class="detail-tags-wrap">${tagsHtml}</div>

                <div class="detail-actions-row">
                  ${lastReadEntry ? `
                  <button type="button" class="btn btn-resume-reading" id="detail-resume-btn">
                    <i class="ri-play-circle-fill"></i> Lanjutkan Ch. ${this.escapeHtml(String(lastReadEntry.chapterNum || '0'))} (Hal. ${Number(lastReadEntry.page) || 1}/${Number(lastReadEntry.totalPages) || 1})
                  </button>
                  ` : ''}
                  <button class="btn btn-primary" id="detail-read-first-btn">
                    <i class="ri-book-open-line"></i> Baca Chapter Pertama
                  </button>
                  <button class="btn btn-secondary" id="detail-bookmark-btn" onclick="app.toggleBookmarkDetail('${this.escapeHtml(manga.id)}')">
                    <i class="${isFav ? 'ri-bookmark-fill' : 'ri-bookmark-line'}"></i>
                    <span>${isFav ? 'Tersimpan di Favorit' : 'Tambah ke Favorit'}</span>
                  </button>
                  <button class="btn btn-secondary btn-like ${isLiked ? 'liked' : ''}" id="detail-like-btn" onclick="app.toggleLikeDetail('${this.escapeHtml(manga.id)}')">
                    <i class="${isLiked ? 'ri-heart-3-fill' : 'ri-heart-3-line'}"></i>
                    <span id="detail-like-label">${isLiked ? 'Disukai' : 'Suka'}</span>
                    <span class="like-counter-pill" id="detail-like-count">${likesCount}</span>
                  </button>
                  <button class="btn btn-secondary" onclick="app.shareManga()">
                    <i class="ri-share-line"></i> Bagikan
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Chapters Feed Section -->
          <div class="chapters-section">
            <div class="chapters-header-bar">
              <div class="section-title-wrap">
                <i class="ri-list-check-2 title-icon"></i>
                <h2>Daftar Chapter (${chapters.length})</h2>
              </div>
              <div class="chapters-filters">
                <input type="text" class="filter-select chapter-search-input" id="chapter-search-input" placeholder="Cari chapter (misal: 100)..." oninput="app.filterChapters()" autocomplete="off" />
                <select class="filter-select" id="chapter-type-filter" onchange="app.filterChapters()">
                  <option value="all">Semua Tipe</option>
                  <option value="readable" selected>Bisa Dibaca Langsung</option>
                  <option value="external">Hanya Link Eksternal</option>
                </select>
                <select class="filter-select" id="chapter-lang-filter" onchange="app.filterChapters()">
                  <option value="all" selected>Semua Bahasa (ID + EN)</option>
                  <option value="id">Indonesia (ID)</option>
                  <option value="en">English (EN)</option>
                </select>
                <select class="filter-select" id="chapter-sort-order" onchange="app.sortChapters(this.value)">
                  <option value="desc" selected>Terbaru Dulu</option>
                  <option value="asc">Terawal Dulu</option>
                </select>
              </div>
            </div>

            <div class="chapters-grid" id="chapters-list-grid"></div>
          </div>

          <!-- Community Comments & Discussion Section -->
          <div class="comments-section" id="manga-comments-section">
            <div class="chapters-header-bar">
              <div class="section-title-wrap">
                <i class="ri-chat-smile-3-line title-icon"></i>
                <h2>Komentar & Diskusi Pembaca (<span id="comments-total-count">${(social.comments || []).length}</span>)</h2>
              </div>
            </div>

            <form class="comment-form" onsubmit="app.submitMangaComment(event, '${manga.id}')">
              <textarea
                id="manga-comment-input"
                class="comment-textarea"
                rows="3"
                maxlength="600"
                placeholder="${State.isLoggedIn() ? `Tulis pendapat atau review Anda tentang ${this.escapeHtml(manga.title)}...` : 'Masuk ke akun MangaFlow untuk ikut berkomentar dan berdiskusi...'}"
              ></textarea>
              <div class="comment-form-footer">
                <span class="comment-hint">
                  ${State.isLoggedIn() ? `<i class="ri-user-smile-line"></i> Berkomentar sebagai <strong>${this.escapeHtml(State.user.username)}</strong>` : '<i class="ri-information-line"></i> Login diperlukan agar komentar tersimpan dengan nama akun Anda.'}
                </span>
                <button type="submit" class="btn btn-primary btn-sm" id="manga-comment-submit-btn">
                  <i class="ri-send-plane-fill"></i> Kirim Komentar
                </button>
              </div>
            </form>

            <div class="comments-list" id="manga-comments-list"></div>
          </div>
        </div>
      `;

      this.currentChaptersList = [...chapters];
      this.filterChapters();
      this.renderCommentsList(manga.id, social.comments || []);

      // Bind Smart Resume Reading button if user has reading history for this manga
      const resumeDetailBtn = document.getElementById('detail-resume-btn');
      if (resumeDetailBtn && lastReadEntry) {
        resumeDetailBtn.onclick = () => {
          const readable = chapters.filter((c) => !c.isExternal);
          Reader.open(manga, lastReadEntry.chapterId, readable.length > 0 ? readable : chapters);
        };
      }

      // Read first chapter button logic (always picks earliest chapter regardless of current sort order)
      const firstBtn = document.getElementById('detail-read-first-btn');
      firstBtn.onclick = () => {
        const readable = chapters.filter((c) => !c.isExternal);
        if (readable.length > 0) {
          const sortedAsc = [...readable].sort((a, b) => (parseFloat(a.chapter) || 0) - (parseFloat(b.chapter) || 0));
          const firstChapter = sortedAsc[0];
          Reader.open(manga, firstChapter.id, readable);
        } else if (chapters.length > 0 && chapters[0].externalUrl) {
          window.open(chapters[0].externalUrl, '_blank');
        } else {
          app.showToast('Belum ada chapter yang tersedia.');
        }
      };

    } catch (err) {
      view.innerHTML = `
        <div class="section-container" style="text-align: center; padding: 60px 0;">
          <i class="ri-error-warning-line" style="font-size: 3rem; color: var(--danger);"></i>
          <h2 style="margin: 14px 0;">Gagal Memuat Detail Manga</h2>
          <p style="color: var(--text-muted); margin-bottom: 20px;">${this.escapeHtml(err.message)}</p>
          <button class="btn btn-primary" onclick="app.navigate('home')">Kembali ke Beranda</button>
        </div>
      `;
    }
  },

  renderChaptersList(chapters) {
    const list = document.getElementById('chapters-list-grid');
    if (!list) return;

    if (!chapters.length) {
      list.innerHTML = `
        <div style="text-align: center; padding: 40px; color: var(--text-dim);">
          <i class="ri-file-search-line" style="font-size: 2.5rem; display: block; margin-bottom: 10px;"></i>
          Tidak ada chapter dengan bahasa yang dipilih. Coba ganti filter bahasa ke 'Semua Bahasa'.
        </div>
      `;
      return;
    }

    list.innerHTML = '';
    const internalChapters = chapters.filter((c) => !c.isExternal);
    const displayList = chapters.slice(0, this.chaptersDisplayLimit || 80);
    const lastReadChapterId = this.selectedManga
      ? State.getHistory().find((h) => h.mangaId === this.selectedManga.id)?.chapterId
      : null;

    displayList.forEach((ch) => {
      const isRead = State.isChapterRead(ch.id);
      const isLastRead = Boolean(lastReadChapterId && ch.id === lastReadChapterId);
      const row = document.createElement('div');
      row.className = `chapter-row ${isRead ? 'read' : ''} ${isLastRead ? 'last-read' : ''}`.trim();

      if (ch.isExternal) {
        row.onclick = () => window.open(ch.externalUrl, '_blank');
      } else {
        row.onclick = () => Reader.open(this.selectedManga, ch.id, internalChapters);
      }

      const safeChapterNum = this.escapeHtml(ch.chapter || '0');
      const safeChapterTitle = this.escapeHtml(ch.title ? ch.title : 'Chapter ' + (ch.chapter || '0'));
      const safeGroup = this.escapeHtml(ch.group || (ch.source === 'mangapill' ? 'MangaPill Complete Archive' : 'Scanlation'));
      const safeLang = this.escapeHtml(ch.language || '');

      row.innerHTML = `
        <div class="chapter-row-left">
          <span class="chapter-badge">CH ${safeChapterNum}</span>
          <div>
            <div class="chapter-row-title">${safeChapterTitle}</div>
            <div class="chapter-row-group">
              ${safeGroup}
              ${ch.isHybridFill ? '<span class="hybrid-fill-chip">Auto-Fill</span>' : ''}
              ${isLastRead ? '<span class="last-read-chip">Terakhir Dibaca</span>' : ''}
              ${ch.isExternal ? '<span style="color: #38bdf8; margin-left: 6px;">[Eksternal]</span>' : ''}
            </div>
          </div>
        </div>
        <div class="chapter-row-right">
          <span style="font-weight: 700; text-transform: uppercase;">${safeLang}</span>
          ${
            ch.isExternal
              ? '<i class="ri-external-link-line" title="Buka di situs resmi"></i>'
              : isRead
              ? '<i class="ri-check-double-line" style="color: var(--success);" title="Sudah dibaca"></i>'
              : '<i class="ri-arrow-right-s-line"></i>'
          }
        </div>
      `;

      list.appendChild(row);
    });

    if (chapters.length > displayList.length) {
      const moreBtn = document.createElement('button');
      moreBtn.className = 'btn btn-secondary';
      moreBtn.style.cssText = 'grid-column: 1 / -1; margin: 16px auto; display: block; border-radius: var(--radius-full); padding: 8px 24px; font-weight: 600;';
      moreBtn.innerHTML = `<i class="ri-arrow-down-line"></i> Tampilkan 100 Chapter Selanjutnya (Menampilkan ${displayList.length} dari ${chapters.length})`;
      moreBtn.onclick = () => {
        this.chaptersDisplayLimit = (this.chaptersDisplayLimit || 80) + 100;
        this.renderChaptersList(chapters);
      };
      list.appendChild(moreBtn);
    }
  },

  filterChapters() {
    if (!this.currentChaptersList) return;
    const langSelect = document.getElementById('chapter-lang-filter');
    const typeSelect = document.getElementById('chapter-type-filter');
    const chSearch = (document.getElementById('chapter-search-input')?.value || '').trim().toLowerCase();
    const lang = langSelect ? langSelect.value : 'all';
    const type = typeSelect ? typeSelect.value : 'all';

    let filtered = [...this.currentChaptersList];

    if (lang !== 'all') {
      filtered = filtered.filter((c) => c.language === lang);
    }

    if (type === 'readable') {
      const internalOnly = filtered.filter((c) => !c.isExternal);
      // If none are internal, show all and alert
      if (internalOnly.length > 0) {
        filtered = internalOnly;
      }
    } else if (type === 'external') {
      filtered = filtered.filter((c) => c.isExternal);
    }

    if (chSearch) {
      this.chaptersDisplayLimit = 80;
      filtered = filtered.filter(
        (c) =>
          String(c.chapter || '').toLowerCase().includes(chSearch) ||
          String(c.title || '').toLowerCase().includes(chSearch)
      );
    }

    this.renderChaptersList(filtered);
  },

  filterChaptersByLang(lang) {
    this.filterChapters();
  },

  sortChapters(order) {
    if (!this.currentChaptersList) return;
    this.currentChaptersList.sort((a, b) => {
      const numA = parseFloat(a.chapter) || 0;
      const numB = parseFloat(b.chapter) || 0;
      return order === 'asc' ? numA - numB : numB - numA;
    });
    this.filterChapters();
  },

  // ---------------- Library / Favorites View ----------------
  renderLibraryView(filterQuery = '') {
    const view = document.getElementById('library-view');
    view.style.display = 'block';
    const bookmarks = State.getBookmarks();
    const cleanFilter = (filterQuery || '').trim().toLowerCase();
    const filteredBookmarks = cleanFilter
      ? bookmarks.filter((b) => (b.title || '').toLowerCase().includes(cleanFilter))
      : bookmarks;

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header" style="flex-wrap: wrap; gap: 12px;">
          <div class="section-title-wrap">
            <i class="ri-bookmark-3-fill title-icon"></i>
            <h2>Koleksi Favorit (${bookmarks.length})</h2>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            ${
              bookmarks.length > 0
                ? `<div class="search-input-wrapper" style="flex: 1 1 180px; max-width: 240px; min-width: 140px;">
                     <i class="ri-search-line search-icon"></i>
                     <input type="text" id="library-filter-input" value="${this.escapeHtml(filterQuery)}" placeholder="Filter koleksi..." oninput="app.filterLibraryGrid(this.value)" />
                   </div>`
                : ''
            }
            <button class="btn btn-secondary btn-sm" onclick="app.exportBackup()" title="Simpan cadangan Favorit & Riwayat ke file .json">
              <i class="ri-download-2-line"></i> Backup Data
            </button>
            <button class="btn btn-secondary btn-sm" onclick="app.triggerImportBackup()" title="Pulihkan Favorit & Riwayat dari file .json">
              <i class="ri-upload-2-line"></i> Restore Data
            </button>
          </div>
        </div>
        ${
          bookmarks.length === 0
            ? `<div style="text-align: center; padding: 60px 0; color: var(--text-dim);">
                 <i class="ri-bookmark-line" style="font-size: 3rem; margin-bottom: 12px; display: block;"></i>
                 <h3>Belum ada manga yang disimpan</h3>
                 <p style="margin: 8px 0 20px 0;">Klik ikon bookmark pada manga untuk menyimpannya ke koleksi Anda, atau pulihkan dari file Backup.</p>
                 <div style="display: flex; justify-content: center; gap: 12px; flex-wrap: wrap;">
                   <button class="btn btn-primary" onclick="app.navigate('home')">Jelajahi Manga</button>
                   <button class="btn btn-secondary" onclick="app.triggerImportBackup()"><i class="ri-upload-2-line"></i> Restore dari Backup</button>
                 </div>
               </div>`
            : `<div class="manga-grid" id="library-grid"></div>`
        }
      </div>
    `;

    if (bookmarks.length > 0) {
      this.populateLibraryGrid(filteredBookmarks);
    }
  },

  filterLibraryGrid(query) {
    const bookmarks = State.getBookmarks();
    const cleanFilter = (query || '').trim().toLowerCase();
    const filtered = cleanFilter
      ? bookmarks.filter((b) => (b.title || '').toLowerCase().includes(cleanFilter))
      : bookmarks;
    this.populateLibraryGrid(filtered);
  },

  populateLibraryGrid(items) {
    const grid = document.getElementById('library-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!items.length) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px 0; color: var(--text-dim);">
          Tidak ada komik favorit yang cocok dengan pencarian Anda.
        </div>
      `;
      return;
    }

    items.forEach((item) => {
      const card = this.createMangaCard(item);
      grid.appendChild(card);
    });
    this.applyGridStagger(grid);
  },

  // ---------------- History View ----------------
  renderHistoryView() {
    const view = document.getElementById('history-view');
    view.style.display = 'block';
    const history = State.getHistory();

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header" style="flex-wrap: wrap; gap: 12px;">
          <div class="section-title-wrap">
            <i class="ri-history-line title-icon"></i>
            <h2>Riwayat Membaca (${history.length})</h2>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" onclick="app.exportBackup()">
              <i class="ri-download-2-line"></i> Backup Data
            </button>
            ${history.length ? '<button class="btn btn-secondary btn-sm" onclick="app.clearHistory()"><i class="ri-delete-bin-line"></i> Hapus Semua</button>' : ''}
          </div>
        </div>
        ${
          history.length === 0
            ? `<div style="text-align: center; padding: 60px 0; color: var(--text-dim);">
                 <i class="ri-book-read-line" style="font-size: 3rem; margin-bottom: 12px; display: block;"></i>
                 <h3>Belum ada riwayat baca</h3>
                 <p style="margin: 8px 0 20px 0;">Manga yang baru saja Anda baca akan muncul di sini.</p>
                 <button class="btn btn-primary" onclick="app.navigate('home')">Mulai Membaca</button>
               </div>`
            : `<div class="continue-grid manga-grid" id="history-full-grid"></div>`
        }
      </div>
    `;

    if (history.length > 0) {
      const grid = document.getElementById('history-full-grid');
      history.forEach((item) => {
        const card = document.createElement('div');
        card.className = 'continue-card';
        card.style.position = 'relative';
        card.onclick = () => this.navigate('manga', { id: item.mangaId });

        const thumbCover = this.resolveCoverUrl(item.coverUrl) || this.getFallbackCoverDataUri(item.mangaTitle);

        card.innerHTML = `
          <img class="continue-thumb" src="${this.escapeHtml(thumbCover)}" data-fallback-cover="${this.escapeHtml(thumbCover)}" alt="${this.escapeHtml(item.mangaTitle)}" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
          <div class="continue-info">
            <div class="continue-title" style="padding-right: 24px;">${this.escapeHtml(item.mangaTitle)}</div>
            <div class="continue-sub">Chapter ${this.escapeHtml(String(item.chapterNum))} (Hal. ${Number(item.page) || 1}/${Number(item.totalPages) || 1})</div>
            <button type="button" class="btn btn-primary continue-btn">
              <i class="ri-play-fill"></i> Lanjutkan
            </button>
          </div>
          <button
            type="button"
            class="history-item-remove-btn"
            title="Hapus dari riwayat"
          >
            <i class="ri-close-line"></i>
          </button>
        `;
        const resumeBtn = card.querySelector('.continue-btn');
        if (resumeBtn) {
          resumeBtn.onclick = (e) => {
            e.stopPropagation();
            this.resumeReading(item.mangaId, item.chapterId);
          };
        }
        const removeBtn = card.querySelector('.history-item-remove-btn');
        if (removeBtn) {
          removeBtn.onclick = (e) => {
            e.stopPropagation();
            this.removeSingleHistory(item.mangaId);
          };
        }
        grid.appendChild(card);
      });
    }
  },

  removeSingleHistory(mangaId) {
    State.removeHistoryItem(mangaId);
    this.showToast('Item dihapus dari riwayat baca');
  },

  clearHistory() {
    if (confirm('Hapus seluruh riwayat membaca?')) {
      State.clearHistory();
      this.renderHistoryView();
      this.showToast('Riwayat membaca telah dibersihkan');
    }
  },

  // ---------------- Search & Filter View (100% Unified Smart Hybrid Engine) ----------------
  async performSearch(q) {
    if (q && q.trim()) {
      State.addRecentSearch(q.trim());
    }
    this.navigate('search', { q });
  },

  async renderSearchView(params = {}) {
    const view = document.getElementById('search-view');
    view.style.display = 'block';

    // Sync filter state from URL hash params if present (supports genre pills, direct links & back/forward)
    if (typeof params.tags === 'string') {
      this.selectedFilterTags = new Set(params.tags.split(',').filter(Boolean));
    }
    if (typeof params.sort === 'string' && params.sort) {
      this.selectedSort = params.sort;
    }
    if (typeof params.status === 'string') {
      this.selectedStatus = params.status;
    }

    const currentQ = params.q || '';
    if (currentQ.trim()) {
      State.addRecentSearch(currentQ.trim());
      this.syncDocumentTitle(`Cari: "${currentQ.trim()}"`);
    } else {
      this.syncDocumentTitle();
    }
    const safeQ = this.escapeHtml(currentQ);
    const page = Math.max(1, parseInt(params.page || '1', 10) || 1);

    view.innerHTML = `
      <div class="section-container">
        <!-- Prominent Mobile & Desktop Search Bar -->
        <div class="search-page-bar" style="margin-bottom: 18px;">
          <div class="search-input-wrapper" style="max-width: 640px; margin: 0 auto;">
            <i class="ri-search-line search-icon"></i>
            <input type="text" id="search-page-input" value="${safeQ}" placeholder="Cari judul manga, manhwa, atau author..." />
            ${currentQ ? `<button class="clear-btn" style="display:block;" onclick="app.navigate('search')"><i class="ri-close-line"></i></button>` : ''}
          </div>
        </div>

        <div class="section-header" style="flex-wrap: wrap; gap: 12px;">
          <div class="section-title-wrap">
            <i class="ri-sparkling-2-fill title-icon"></i>
            <h2>${currentQ ? `Hasil Pencarian: "${safeQ}"` : 'Jelajahi Katalog Manga'}${page > 1 ? ` (Hal. ${page})` : ''}</h2>
          </div>
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm random-discover-btn" onclick="app.openRandomManga()">
              <i class="ri-shuffle-line"></i> Kejutan Acak
            </button>
            <button type="button" class="btn btn-secondary btn-sm" onclick="app.toggleFilterModal()">
              <i class="ri-sound-module-line"></i> Filter & Opsi
            </button>
          </div>
        </div>
        <div class="manga-grid" id="search-results-grid">
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
        </div>
        <div style="display: flex; justify-content: center; align-items: center; gap: 14px; margin-top: 36px; flex-wrap: wrap;" id="search-pagination"></div>
      </div>
    `;

    const pageInput = document.getElementById('search-page-input');
    if (pageInput) {
      pageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const val = e.target.value.trim();
          this.navigate('search', { q: val });
        }
      });
    }

    if (this.searchViewAbort) {
      this.searchViewAbort.abort();
    }
    this.searchViewAbort = new AbortController();
    const { signal } = this.searchViewAbort;

    try {
      const queryParams = {
        q: params.q || '',
        sort: this.selectedSort,
        status: this.selectedStatus,
        tags: Array.from(this.selectedFilterTags).join(','),
        page
      };
      const res = await Api.searchHybrid(queryParams, signal);

      if (signal.aborted) return;

      const grid = document.getElementById('search-results-grid');
      const pagination = document.getElementById('search-pagination');
      grid.innerHTML = '';

      if (!res.data || !res.data.length) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 60px 0; color: var(--text-dim);">
            <i class="ri-file-search-line" style="font-size: 3rem; margin-bottom: 12px; display: block;"></i>
            <h3>Tidak menemukan komik yang cocok</h3>
            <p>Coba gunakan kata kunci yang lebih singkat atau periksa ejaan judul.</p>
          </div>
        `;
      } else {
        res.data.forEach((item) => {
          const card = this.createMangaCard(item);
          grid.appendChild(card);
        });
        this.applyGridStagger(grid);
      }

      if (pagination && ((res.data && res.data.length > 0) || page > 1)) {
        pagination.innerHTML = '';
        const hasNext = page * 24 < (res.total || 0) || (res.data && res.data.length === 24);

        const navBase = {
          q: currentQ,
          tags: Array.from(this.selectedFilterTags).join(','),
          sort: this.selectedSort,
          status: this.selectedStatus
        };

        if (page > 1) {
          const prevBtn = document.createElement('button');
          prevBtn.className = 'btn btn-secondary';
          prevBtn.innerHTML = '<i class="ri-arrow-left-s-line"></i> Halaman Sebelumnya';
          prevBtn.onclick = () => this.navigate('search', { ...navBase, page: page - 1 });
          pagination.appendChild(prevBtn);
        }

        if (page > 1 || hasNext) {
          const pageBadge = document.createElement('span');
          pageBadge.style.cssText = 'color: var(--text-muted); font-weight: 600; font-size: 0.9rem; padding: 0 6px;';
          pageBadge.textContent = `Halaman ${page}`;
          pagination.appendChild(pageBadge);
        }

        if (hasNext) {
          const nextBtn = document.createElement('button');
          nextBtn.className = 'btn btn-primary';
          nextBtn.innerHTML = 'Halaman Selanjutnya <i class="ri-arrow-right-s-line"></i>';
          nextBtn.onclick = () => this.navigate('search', { ...navBase, page: page + 1 });
          pagination.appendChild(nextBtn);
        }
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      const grid = document.getElementById('search-results-grid');
      if (grid) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 52px 0; color: var(--text-muted);">
            <i class="ri-error-warning-line" style="font-size: 2.8rem; color: var(--danger); display: block; margin-bottom: 10px;"></i>
            <h3 style="color: var(--text-main); margin-bottom: 6px;">Gagal Memuat Hasil Pencarian</h3>
            <p style="margin-bottom: 16px;">${this.escapeHtml(err.message || 'Koneksi sedang sibuk, silakan coba lagi.')}</p>
            <div style="display:flex;justify-content:center;gap:10px;flex-wrap:wrap;">
              <button type="button" class="btn btn-primary btn-sm" id="search-retry-btn"><i class="ri-refresh-line"></i> Coba Lagi</button>
              <button type="button" class="btn btn-secondary btn-sm" onclick="app.openRandomManga()"><i class="ri-shuffle-line"></i> Kejutan Acak</button>
            </div>
          </div>
        `;
        const retryBtn = document.getElementById('search-retry-btn');
        if (retryBtn) retryBtn.onclick = () => this.renderSearchView(params);
      }
    }
  },

  // ---------------- Quick Search Dropdown & Unified Query ----------------
  async executeQuickSearch(q, targetId) {
    if (this.quickSearchAbort) {
      this.quickSearchAbort.abort();
    }
    this.quickSearchAbort = new AbortController();
    const { signal } = this.quickSearchAbort;

    const dropdown = document.getElementById(targetId);
    if (dropdown) {
      dropdown.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;gap:10px;padding:18px 12px;color:var(--text-muted);font-size:0.86rem;">
          <progress aria-label="Mencari" class="loading-spinner" style="--size:22px;--thickness:2.5px;"></progress>
          <span>Mencari "<strong>${this.escapeHtml(q)}</strong>"...</span>
        </div>
      `;
      dropdown.classList.add('open');
    }

    try {
      const res = await Api.searchHybrid({ q, limit: 8 }, signal);
      const items = (res.data || []).slice(0, 8);
      if (signal.aborted) return;
      this.renderQuickSearchDropdown(items, targetId, q);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Quick search error:', err);
      if (dropdown) {
        dropdown.innerHTML = `
          <div style="padding:14px 12px;text-align:center;color:var(--text-muted);font-size:0.84rem;">
            <div style="margin-bottom:8px;color:#fca5a5;"><i class="ri-error-warning-line"></i> Pencarian gagal dimuat.</div>
            <div style="display:flex;justify-content:center;gap:8px;flex-wrap:wrap;">
              <button type="button" class="btn btn-sm btn-primary" style="padding:4px 12px;font-size:0.76rem;" id="qs-retry-btn">Coba Lagi</button>
            </div>
          </div>
        `;
        const retryBtn = dropdown.querySelector('#qs-retry-btn');
        if (retryBtn) {
          retryBtn.onclick = (e) => {
            e.stopPropagation();
            this.executeQuickSearch(q, targetId);
          };
        }
        dropdown.classList.add('open');
      }
    }
  },

  renderQuickSearchDropdown(items, targetId = 'quick-search-results', currentQ = '') {
    const dropdown = document.getElementById(targetId);
    if (!dropdown) return;
    dropdown.innerHTML = '';

    const headerEl = document.createElement('div');
    headerEl.className = 'quick-search-header-bar';
    headerEl.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 6px 10px 8px 10px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 6px;';
    headerEl.innerHTML = `
      <span style="font-size: 0.75rem; color: #a5b4fc; font-weight: 600;">
        <i class="ri-sparkling-2-fill"></i> Smart Hybrid Search • Otomatis Komplit
      </span>
    `;
    dropdown.appendChild(headerEl);

    if (!items.length) {
      const emptyEl = document.createElement('div');
      emptyEl.style.cssText = 'padding: 18px 10px; text-align: center; color: var(--text-dim); font-size: 0.85rem;';
      emptyEl.textContent = 'Tidak menemukan komik yang cocok. Coba kata kunci lain.';
      dropdown.appendChild(emptyEl);
      dropdown.classList.add('open');
      return;
    }

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'search-dropdown-item';
      el.addEventListener('pointerenter', () => Api.prefetchManga(item.id, State.settings.languages.join(',')), { once: true, passive: true });
      el.onclick = () => {
        if (currentQ) State.addRecentSearch(currentQ);
        dropdown.classList.remove('open');
        this.toggleMobileSearch(false);
        this.navigate('manga', { id: item.id });
      };

      const isItemPill = item.source === 'mangapill' || String(item.id).startsWith('pill-');
      const isItemHybrid = Boolean(item.hasCompleteBackup || item.hybridSource);
      const fullCover = this.resolveCoverUrl(item.coverUrl) || this.getFallbackCoverDataUri(item.title);
      const thumbCover = this.resolveCoverUrl(item.coverUrlSmall || item.coverUrl) || fullCover;

      el.innerHTML = `
        <img class="search-item-thumb" src="${this.escapeHtml(thumbCover)}" data-fallback-cover="${this.escapeHtml(fullCover)}" alt="${this.escapeHtml(item.title)}" onerror="app.handleCoverError(this, this.dataset.fallbackCover, this.alt)" />
        <div class="search-item-info">
          <div class="search-item-title">${this.escapeHtml(item.title)}</div>
          <div class="search-item-meta">
            <span>${this.escapeHtml(item.status || 'Publishing')}</span>
            <span>•</span>
            <span style="${(isItemPill || isItemHybrid) ? 'color: #10b981; font-weight: 600;' : ''}">${isItemHybrid ? '⚡ Hybrid Komplit' : (isItemPill ? 'Komplit 100%' : (item.tags && item.tags[0] ? this.escapeHtml(item.tags[0]) : 'Manga'))}</span>
          </div>
        </div>
      `;

      dropdown.appendChild(el);
    });

    if (currentQ) {
      const footerEl = document.createElement('div');
      footerEl.style.cssText = 'padding: 8px 10px 4px 10px; border-top: 1px solid var(--border-subtle); margin-top: 6px; text-align: center;';
      const seeAllBtn = document.createElement('button');
      seeAllBtn.type = 'button';
      seeAllBtn.style.cssText = 'background: none; border: none; color: var(--accent-primary); cursor: pointer; font-weight: 600; font-size: 0.82rem; width: 100%; padding: 4px;';
      seeAllBtn.innerHTML = 'Lihat Semua Hasil Pencarian <i class="ri-arrow-right-line"></i>';
      seeAllBtn.onclick = () => {
        dropdown.classList.remove('open');
        this.toggleMobileSearch(false);
        this.performSearch(currentQ);
      };
      footerEl.appendChild(seeAllBtn);
      dropdown.appendChild(footerEl);
    }

    dropdown.classList.add('open');
  },

  renderRecentSearchSuggestions(targetId = 'quick-search-results') {
    const dropdown = document.getElementById(targetId);
    if (!dropdown) return;

    const recent = State.getRecentSearches();
    dropdown.innerHTML = '';

    // Quick Random Discovery Row
    const randomRow = document.createElement('button');
    randomRow.type = 'button';
    randomRow.className = 'quick-random-btn';
    randomRow.innerHTML = '<i class="ri-shuffle-line"></i> <span>Kejutan! Buka Rekomendasi Manga Acak</span> <i class="ri-arrow-right-s-line" style="margin-left:auto;"></i>';
    randomRow.onclick = (e) => {
      e.stopPropagation();
      dropdown.classList.remove('open');
      this.toggleMobileSearch(false);
      this.openRandomManga();
    };
    dropdown.appendChild(randomRow);

    if (recent.length > 0) {
      const headerRow = document.createElement('div');
      headerRow.className = 'recent-search-header';
      headerRow.innerHTML = '<span><i class="ri-history-line"></i> Pencarian Terakhir</span>';
      const clearAllBtn = document.createElement('button');
      clearAllBtn.type = 'button';
      clearAllBtn.className = 'recent-clear-all-btn';
      clearAllBtn.textContent = 'Hapus';
      clearAllBtn.onclick = (e) => {
        e.stopPropagation();
        State.clearRecentSearches();
        this.renderRecentSearchSuggestions(targetId);
      };
      headerRow.appendChild(clearAllBtn);
      dropdown.appendChild(headerRow);

      const chipsWrap = document.createElement('div');
      chipsWrap.className = 'recent-search-chips';
      recent.forEach((term) => {
        const chip = document.createElement('div');
        chip.className = 'recent-search-chip';

        const labelBtn = document.createElement('button');
        labelBtn.type = 'button';
        labelBtn.className = 'recent-chip-label';
        labelBtn.textContent = term;
        labelBtn.onclick = (e) => {
          e.stopPropagation();
          const input = targetId.includes('mobile')
            ? document.getElementById('mobile-search-input')
            : document.getElementById('global-search-input');
          if (input) input.value = term;
          dropdown.classList.remove('open');
          this.toggleMobileSearch(false);
          this.performSearch(term);
        };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'recent-chip-del';
        delBtn.setAttribute('aria-label', `Hapus pencarian ${term}`);
        delBtn.innerHTML = '<i class="ri-close-line"></i>';
        delBtn.onclick = (e) => {
          e.stopPropagation();
          State.removeRecentSearch(term);
          this.renderRecentSearchSuggestions(targetId);
        };

        chip.appendChild(labelBtn);
        chip.appendChild(delBtn);
        chipsWrap.appendChild(chip);
      });
      dropdown.appendChild(chipsWrap);
    }

    dropdown.classList.add('open');
  },

  async openRandomManga() {
    if (this.randomLoading) return;
    this.randomLoading = true;
    this.showTopLoader();
    try {
      const res = await Api.getRandomManga();
      if (res && res.success && res.data && res.data.id) {
        this.showToast(`Rekomendasi Acak: ${res.data.title}`);
        this.navigate('manga', { id: res.data.id });
      } else {
        throw new Error('Tidak dapat memuat manga acak');
      }
    } catch (err) {
      if (this.trendingData && this.trendingData.length > 0) {
        const pick = this.trendingData[Math.floor(Math.random() * this.trendingData.length)];
        this.showToast(`Rekomendasi Pilihan: ${pick.title}`);
        this.navigate('manga', { id: pick.id });
      } else {
        this.showToast('Gagal memuat manga acak: ' + (err.message || 'Coba lagi'));
      }
    } finally {
      this.randomLoading = false;
      this.finishTopLoader();
    }
  },

  clearSearch() {
    const input = document.getElementById('global-search-input');
    if (input) input.value = '';
    const clearBtn = document.getElementById('search-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    const kbdHint = document.getElementById('search-kbd-hint');
    if (kbdHint && document.activeElement !== input) kbdHint.style.display = '';
    const dd = document.getElementById('quick-search-results');
    if (dd) dd.classList.remove('open');
  },

  toggleMobileSearch(force) {
    const bar = document.getElementById('mobile-search-bar');
    const input = document.getElementById('mobile-search-input');
    if (!bar) return;

    const isCurrentlyOpen = bar.style.display === 'flex';
    const shouldOpen = typeof force === 'boolean' ? force : !isCurrentlyOpen;

    if (shouldOpen) {
      bar.style.display = 'flex';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (input) {
        setTimeout(() => input.focus(), 60);
      }
    } else {
      bar.style.display = 'none';
      const dd = document.getElementById('mobile-quick-search-results');
      if (dd) dd.classList.remove('open');
    }
  },

  clearMobileSearch() {
    const input = document.getElementById('mobile-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    const clearBtn = document.getElementById('mobile-search-clear-btn');
    if (clearBtn) clearBtn.style.display = 'none';
    const dd = document.getElementById('mobile-quick-search-results');
    if (dd) dd.classList.remove('open');
  },

  openMobileSearch() {
    this.navigate('search');
    this.toggleMobileSearch(true);
  },

  // ---------------- Tags & Genres ----------------
  async loadTags() {
    try {
      const res = await Api.getTags();
      if (!res.success || !res.data) return;

      this.filterTags = res.data;
      const pillsContainer = document.getElementById('genre-pills');
      pillsContainer.innerHTML = '';

      // Prominent Genres
      const topGenres = ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Isekai', 'Romance', 'Sci-Fi', 'Slice of Life', 'Supernatural'];
      
      topGenres.forEach((g) => {
        const btn = document.createElement('button');
        btn.className = 'genre-pill';
        btn.textContent = g;
        btn.onclick = () => {
          document.querySelectorAll('.genre-pill').forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');

          const found = this.filterTags.find((t) => t.name.toLowerCase() === g.toLowerCase());
          if (found) {
            this.selectedFilterTags.clear();
            this.selectedFilterTags.add(found.id);
            this.navigate('search', { tags: found.id });
          }
        };
        pillsContainer.appendChild(btn);
      });

      // Populate Modal Tags Picker
      const modalPicker = document.getElementById('modal-tags-picker');
      modalPicker.innerHTML = '';
      this.filterTags.slice(0, 40).forEach((t) => {
        const chip = document.createElement('button');
        chip.className = 'filter-chip';
        chip.textContent = t.name;
        chip.dataset.id = t.id;
        chip.onclick = () => {
          if (this.selectedFilterTags.has(t.id)) {
            this.selectedFilterTags.delete(t.id);
            chip.classList.remove('active');
          } else {
            this.selectedFilterTags.add(t.id);
            chip.classList.add('active');
          }
        };
        modalPicker.appendChild(chip);
      });
    } catch (err) {
      console.error(err);
    }
  },

  // ---------------- Filter Modal ----------------
  toggleFilterModal() {
    const modal = document.getElementById('filter-modal');
    const isShowing = modal.style.display === 'flex';
    modal.style.display = isShowing ? 'none' : 'flex';
  },

  resetFilters() {
    this.selectedFilterTags.clear();
    this.selectedSort = 'relevance';
    this.selectedStatus = '';

    document.querySelectorAll('#filter-modal .filter-chip').forEach((c) => {
      c.classList.remove('active');
    });
    document.querySelector('#filter-sort-options [data-sort="relevance"]').classList.add('active');
    document.querySelector('#filter-status-options [data-status=""]').classList.add('active');
  },

  applyFilters() {
    this.toggleFilterModal();
    const pageInput = document.getElementById('search-page-input');
    const mobInput = document.getElementById('mobile-search-input');
    const globalInput = document.getElementById('global-search-input');
    const q = (pageInput?.value || mobInput?.value || globalInput?.value || '').trim();
    const filterParams = {
      q,
      tags: Array.from(this.selectedFilterTags).join(','),
      sort: this.selectedSort,
      status: this.selectedStatus
    };
    if (this.currentView === 'search') {
      this.renderSearchView(filterParams);
    } else {
      this.navigate('search', filterParams);
    }
  },

  // ---------------- Bookmarking Actions ----------------
  toggleBookmarkDetail(mangaId) {
    if (!this.selectedManga) return;
    const added = State.toggleBookmark(this.selectedManga);
    this.updateBadgeCounts();

    const btn = document.getElementById('detail-bookmark-btn');
    if (btn) {
      btn.innerHTML = `
        <i class="${added ? 'ri-bookmark-fill' : 'ri-bookmark-line'}"></i>
        <span>${added ? 'Tersimpan di Favorit' : 'Tambah ke Favorit'}</span>
      `;
    }

    this.showToast(added ? 'Disimpan ke Favorit' : 'Dihapus dari Favorit');
  },

  toggleBookmarkFromHero(mangaId) {
    const item = this.trendingData.find((m) => m.id === mangaId);
    if (!item) return;

    const added = State.toggleBookmark(item);
    this.updateBadgeCounts();

    document.querySelectorAll('[data-hero-bookmark-id]').forEach((btn) => {
      if (btn.getAttribute('data-hero-bookmark-id') === mangaId) {
        btn.innerHTML = `<i class="${added ? 'ri-bookmark-fill' : 'ri-bookmark-line'}"></i> <span>${added ? 'Tersimpan' : 'Favorit'}</span>`;
      }
    });

    this.showToast(added ? 'Disimpan ke Favorit' : 'Dihapus dari Favorit');
  },

  updateBadgeCounts() {
    const count = State.getBookmarks().length;
    const badge = document.getElementById('nav-fav-count');
    if (badge) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    const mobBadge = document.getElementById('mob-fav-count');
    if (mobBadge) {
      mobBadge.textContent = count > 99 ? '99+' : count;
      mobBadge.style.display = count > 0 ? 'inline-flex' : 'none';
    }
  },

  shareManga() {
    if (!this.selectedManga) return;
    const shareUrl = `${window.location.origin}/?manga=${encodeURIComponent(this.selectedManga.id)}`;

    if (navigator.share) {
      navigator.share({
        title: this.selectedManga.title,
        text: `Baca ${this.selectedManga.title} di MangaFlow`,
        url: shareUrl
      }).catch(() => {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        this.showToast('Link manga disalin ke clipboard!');
      }).catch(() => {
        this.showToast('Gagal menyalin link.');
      });
    } else {
      const tempInput = document.createElement('input');
      tempInput.value = shareUrl;
      document.body.appendChild(tempInput);
      tempInput.select();
      document.execCommand('copy');
      document.body.removeChild(tempInput);
      this.showToast('Link manga disalin ke clipboard!');
    }
  },

  toggleLangMenu() {
    const menu = document.getElementById('lang-dropdown-menu');
    menu.classList.toggle('open');
  },

  syncLangPrefUI() {
    const langs = Array.isArray(State.settings.languages) && State.settings.languages.length > 0
      ? State.settings.languages
      : ['en', 'id'];
    document.querySelectorAll('#lang-dropdown-menu input[type="checkbox"]').forEach((cb) => {
      cb.checked = langs.includes(cb.value);
    });
    const label = document.getElementById('current-lang-label');
    if (label) {
      label.textContent = langs.map((l) => l.toUpperCase()).join(' / ');
    }
  },

  updateLangPref() {
    const checkboxes = document.querySelectorAll('#lang-dropdown-menu input[type="checkbox"]');
    const langs = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) langs.push(cb.value);
    });

    if (!langs.length) {
      langs.push('en');
    }

    State.settings.languages = langs;
    State.saveSettings();
    this.syncLangPrefUI();
    this.showToast('Preferensi bahasa chapter diperbarui');

    // Reload chapters if on detail view
    if (this.currentView === 'manga' && this.selectedManga) {
      this.renderMangaDetailView(this.selectedManga.id);
    }
  },

  // ---------------- Authentication & Cloud Sync UI ----------------
  updateAuthUI() {
    const authBtn = document.getElementById('btn-open-auth');
    const userWrap = document.getElementById('user-menu-wrap');
    const avatarImg = document.getElementById('nav-user-avatar');
    const nameText = document.getElementById('nav-user-name');
    const ddName = document.getElementById('dropdown-user-name');
    const ddEmail = document.getElementById('dropdown-user-email');

    if (State.isLoggedIn() && State.user) {
      if (authBtn) authBtn.style.display = 'none';
      if (userWrap) userWrap.style.display = 'block';

      if (avatarImg && State.user.avatar) avatarImg.src = State.user.avatar;
      if (nameText) nameText.textContent = State.user.username;
      if (ddName) ddName.textContent = State.user.username;
      if (ddEmail) ddEmail.textContent = State.user.email || '';
    } else {
      if (authBtn) authBtn.style.display = 'flex';
      if (userWrap) userWrap.style.display = 'none';
    }
  },

  openAuthModal(tab = 'login') {
    this.switchAuthTab(tab);
    this.toggleAuthModal(true);
  },

  toggleAuthModal(force) {
    const modal = document.getElementById('auth-modal');
    if (!modal) return;
    const isShowing = force !== undefined ? force : modal.style.display !== 'flex';
    const errBanner = document.getElementById('auth-error-banner');
    const successOverlay = document.getElementById('auth-success-overlay');
    const modalBox = document.getElementById('auth-modal-box');

    if (isShowing) {
      if (errBanner) errBanner.style.display = 'none';
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalBox) modalBox.classList.remove('is-shaking');
      modal.style.display = 'flex';

      const activeTab = document.getElementById('auth-tabs-wrap')?.getAttribute('data-active-tab') || 'login';
      setTimeout(() => {
        const targetInput = document.getElementById(activeTab === 'register' ? 'reg-username' : 'login-identifier');
        if (targetInput && window.innerWidth > 768) targetInput.focus();
      }, 120);
    } else {
      modal.style.display = 'none';
      if (errBanner) errBanner.style.display = 'none';
      if (successOverlay) successOverlay.style.display = 'none';
      if (modalBox) modalBox.classList.remove('is-shaking');
    }
  },

  switchAuthTab(tab) {
    const tabsWrap = document.getElementById('auth-tabs-wrap');
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-register');
    const formLogin = document.getElementById('form-login');
    const formReg = document.getElementById('form-register');
    const title = document.getElementById('auth-modal-title');
    const subtitle = document.getElementById('auth-modal-subtitle');
    const errBanner = document.getElementById('auth-error-banner');

    if (tabsWrap) tabsWrap.setAttribute('data-active-tab', tab === 'register' ? 'register' : 'login');
    if (errBanner) errBanner.style.display = 'none';

    if (tab === 'login') {
      if (tabLogin) tabLogin.classList.add('active');
      if (tabReg) tabReg.classList.remove('active');
      if (formLogin) formLogin.style.display = 'flex';
      if (formReg) formReg.style.display = 'none';
      if (title) title.textContent = 'Masuk ke MangaFlow';
      if (subtitle) subtitle.textContent = 'Sinkronisasi favorit, progres halaman & riwayat baca di semua perangkat.';
    } else {
      if (tabLogin) tabLogin.classList.remove('active');
      if (tabReg) tabReg.classList.add('active');
      if (formLogin) formLogin.style.display = 'none';
      if (formReg) formReg.style.display = 'flex';
      if (title) title.textContent = 'Buat Akun Baru';
      if (subtitle) subtitle.textContent = 'Daftar gratis dalam 5 detik — koleksi komik Anda aman di cloud.';
    }
  },

  showAuthError(message) {
    const errBanner = document.getElementById('auth-error-banner');
    const errText = document.getElementById('auth-error-text');
    const modalBox = document.getElementById('auth-modal-box');
    if (errText) errText.textContent = String(message || 'Terjadi kesalahan otentikasi.');
    if (errBanner) errBanner.style.display = 'flex';
    if (modalBox) {
      modalBox.classList.remove('is-shaking');
      void modalBox.offsetWidth;
      modalBox.classList.add('is-shaking');
    }
  },

  updatePasswordStrength(value = '') {
    const meter = document.getElementById('reg-strength-meter');
    const label = document.getElementById('reg-strength-label');
    const val = String(value || '');
    let score = 0;
    if (val.length >= 6) score += 1;
    if (val.length >= 10) score += 1;
    if (/[a-z]/.test(val) && /[A-Z]/.test(val)) score += 1;
    if (/\d/.test(val) || /[^A-Za-z0-9]/.test(val)) score += 1;

    if (meter) meter.setAttribute('data-score', String(score));
    if (label) {
      const texts = [
        'Kekuatan sandi: Minimal 6 karakter',
        'Kekuatan sandi: Cukup (tambahkan angka/huruf besar)',
        'Kekuatan sandi: Lumayan Baik',
        'Kekuatan sandi: Kuat',
        'Kekuatan sandi: Sangat Kuat ✨'
      ];
      label.textContent = val.length === 0 ? texts[0] : texts[score];
    }
  },

  playAuthSuccessAndClose(titleText, subText) {
    const overlay = document.getElementById('auth-success-overlay');
    const titleEl = document.getElementById('auth-success-title');
    const subEl = document.getElementById('auth-success-sub');
    if (!overlay) {
      this.toggleAuthModal(false);
      return Promise.resolve();
    }
    if (titleEl) titleEl.textContent = titleText;
    if (subEl) subEl.textContent = subText;
    overlay.style.display = 'flex';

    const reduceMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const holdMs = reduceMotion ? 220 : 820;
    return new Promise((resolve) => {
      setTimeout(() => {
        this.toggleAuthModal(false);
        resolve();
      }, holdMs);
    });
  },

  toggleUserMenu(force) {
    const menu = document.getElementById('user-dropdown-menu');
    if (!menu) return;
    if (force !== undefined) {
      menu.classList.toggle('open', force);
    } else {
      menu.classList.toggle('open');
    }
  },

  togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const icon = btn.querySelector('i');
    if (icon) {
      icon.className = isPassword ? 'ri-eye-off-line' : 'ri-eye-line';
    }
  },

  async handleLoginSubmit(e) {
    e.preventDefault();
    const identifier = document.getElementById('login-identifier').value.trim();
    const password = document.getElementById('login-password').value;
    const submitBtn = document.getElementById('login-submit-btn');

    if (!identifier || !password) return;
    const errBanner = document.getElementById('auth-error-banner');
    if (errBanner) errBanner.style.display = 'none';

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="ri-loader-4-line spin"></i> <span>Memproses...</span>';
    }

    try {
      const res = await Api.login(identifier, password);
      if (res.success && res.user) {
        State.setAuth(res.user, res.token, res.data);
        await this.playAuthSuccessAndClose(
          `Selamat Datang, ${res.user.username}!`,
          'Koleksi favorit & riwayat baca Anda siap.'
        );
        this.showToast(`Selamat datang kembali, ${res.user.username}!`);
        if (this.currentView === 'manga' && this.selectedManga) {
          this.renderMangaDetailView(this.selectedManga.id);
        }
      }
    } catch (err) {
      const msg = err.message || 'Gagal masuk. Periksa kembali username/password.';
      this.showAuthError(msg);
      this.showToast(msg);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Masuk ke Akun</span> <i class="ri-arrow-right-line"></i>';
      }
    }
  },

  async handleRegisterSubmit(e) {
    e.preventDefault();
    const username = document.getElementById('reg-username').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const submitBtn = document.getElementById('reg-submit-btn');

    if (!username || !email || !password) return;
    const errBanner = document.getElementById('auth-error-banner');
    if (errBanner) errBanner.style.display = 'none';

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="ri-loader-4-line spin"></i> <span>Mendaftarkan...</span>';
    }

    try {
      const res = await Api.register(username, email, password);
      if (res.success && res.user) {
        State.setAuth(res.user, res.token);
        await this.playAuthSuccessAndClose(
          `Akun Siap, ${res.user.username}!`,
          'Cloud Sync telah diaktifkan otomatis.'
        );
        this.showToast(`Akun berhasil dibuat! Selamat membaca, ${res.user.username}!`);
        if (this.currentView === 'manga' && this.selectedManga) {
          this.renderMangaDetailView(this.selectedManga.id);
        }
      }
    } catch (err) {
      const msg = err.message || 'Gagal membuat akun.';
      this.showAuthError(msg);
      this.showToast(msg);
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>Daftar Sekarang</span> <i class="ri-sparkling-fill"></i>';
      }
    }
  },

  handleLogout() {
    this.toggleUserMenu(false);
    State.logout();
    this.showToast('Anda telah keluar akun.');
    if (this.currentView === 'manga' && this.selectedManga) {
      this.renderMangaDetailView(this.selectedManga.id);
    }
  },

  async syncNow() {
    this.toggleUserMenu(false);
    if (!State.isLoggedIn()) {
      this.openAuthModal('login');
      return;
    }

    this.showToast('Menyinkronkan data...');
    try {
      const res = await Api.syncUserData(State.getBookmarks(), State.getHistory(), {
        removedBookmarkIds: Array.from(State.pendingRemovedBookmarks),
        removedHistoryIds: Array.from(State.pendingRemovedHistory),
        replaceHistory: State.pendingReplaceHistory,
        settings: State.settings
      });
      if (res.success && res.data) {
        State.pendingRemovedBookmarks.clear();
        State.pendingRemovedHistory.clear();
        State.pendingReplaceHistory = false;
        State.mergeCloudData(res.data);
        this.showToast('Data favorit, riwayat & preferensi berhasil disinkronkan ke cloud!');
      }
    } catch (err) {
      this.showToast('Gagal sinkron: ' + err.message);
    }
  },

  // ---------------- Community Social Handlers (Likes, Ratings, Comments) ----------------
  async toggleLikeDetail(mangaId) {
    if (!mangaId) return;

    if (!State.isLoggedIn()) {
      // Allow local like toggle even without login, plus prompt that login syncs to cloud
      const currentlyLiked = State.isMangaLikedLocally(mangaId);
      const nextLiked = !currentlyLiked;
      State.setMangaLikedLocally(mangaId, nextLiked);

      const btn = document.getElementById('detail-like-btn');
      const countEl = document.getElementById('detail-like-count');
      const labelEl = document.getElementById('detail-like-label');
      const baseCount = this.currentMangaSocial?.likesCount || 0;
      const displayCount = Math.max(0, baseCount + (nextLiked ? 1 : 0));

      if (btn) {
        btn.classList.toggle('liked', nextLiked);
        const icon = btn.querySelector('i');
        if (icon) icon.className = nextLiked ? 'ri-heart-3-fill' : 'ri-heart-3-line';
      }
      if (labelEl) labelEl.textContent = nextLiked ? 'Disukai' : 'Suka';
      if (countEl) countEl.textContent = displayCount;

      this.showToast(nextLiked ? 'Disukai ❤️ (Masuk akun untuk simpan ke Cloud)' : 'Batal menyukai manga');
      return;
    }

    try {
      const res = await Api.toggleMangaLike(mangaId);
      if (res.success && res.data) {
        const { liked, likesCount } = res.data;
        State.setMangaLikedLocally(mangaId, liked);
        if (this.currentMangaSocial) {
          this.currentMangaSocial.userLiked = liked;
          this.currentMangaSocial.likesCount = likesCount;
        }

        const btn = document.getElementById('detail-like-btn');
        const countEl = document.getElementById('detail-like-count');
        const labelEl = document.getElementById('detail-like-label');

        if (btn) {
          btn.classList.toggle('liked', liked);
          const icon = btn.querySelector('i');
          if (icon) icon.className = liked ? 'ri-heart-3-fill' : 'ri-heart-3-line';
        }
        if (labelEl) labelEl.textContent = liked ? 'Disukai' : 'Suka';
        if (countEl) countEl.textContent = likesCount;

        this.showToast(liked ? 'Anda menyukai komik ini ❤️' : 'Suka dihapus');
      }
    } catch (err) {
      this.showToast('Gagal menyimpan suka: ' + err.message);
    }
  },

  async submitMangaRating(mangaId, score) {
    if (!State.isLoggedIn()) {
      this.showToast('Silakan masuk akun untuk memberi rating bintang ⭐');
      this.openAuthModal('login');
      return;
    }

    try {
      const res = await Api.rateManga(mangaId, score);
      if (res.success && res.data) {
        const { userRating, ratingAvg, ratingCount } = res.data;
        if (this.currentMangaSocial) {
          this.currentMangaSocial.userRating = userRating;
          this.currentMangaSocial.ratingAvg = ratingAvg;
          this.currentMangaSocial.ratingCount = ratingCount;
        }

        const starsGroup = document.getElementById('detail-rate-stars');
        if (starsGroup) {
          starsGroup.innerHTML = [1, 2, 3, 4, 5]
            .map(
              (star) => `
                <button type="button" class="rate-star-btn ${star <= userRating ? 'active' : ''}" onclick="app.submitMangaRating('${mangaId}', ${star})" title="Beri ${star} Bintang">
                  <i class="${star <= userRating ? 'ri-star-fill' : 'ri-star-line'}"></i>
                </button>
              `
            )
            .join('');
        }

        const userLabel = document.getElementById('detail-user-rating-label');
        if (userLabel) userLabel.textContent = `Pilihan Anda: ${userRating}/5 ⭐`;

        const commStat = document.getElementById('detail-community-rating-text');
        if (commStat) {
          commStat.textContent = ratingAvg ? `${ratingAvg} / 5 (${ratingCount} Suara)` : 'Belum ada rating komunitas';
        }

        this.showToast(`Terima kasih! Anda memberi rating ${userRating}/5 bintang ⭐`);
      }
    } catch (err) {
      this.showToast('Gagal mengirim rating: ' + err.message);
    }
  },

  async submitMangaComment(e, mangaId) {
    e.preventDefault();
    if (!State.isLoggedIn()) {
      this.showToast('Silakan masuk akun untuk mengirim komentar');
      this.openAuthModal('login');
      return;
    }

    const input = document.getElementById('manga-comment-input');
    const submitBtn = document.getElementById('manga-comment-submit-btn');
    if (!input) return;

    const text = input.value.trim();
    if (!text) {
      this.showToast('Tulis isi komentar terlebih dahulu');
      return;
    }

    if (submitBtn) submitBtn.disabled = true;

    try {
      const res = await Api.addMangaComment(mangaId, text);
      if (res.success && res.data) {
        input.value = '';
        const comments = res.data.comments || [];
        if (this.currentMangaSocial) {
          this.currentMangaSocial.comments = comments;
        }
        this.renderCommentsList(mangaId, comments);
        this.showToast('Komentar berhasil dikirim!');
      }
    } catch (err) {
      this.showToast(err.message || 'Gagal mengirim komentar');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  },

  async deleteMangaComment(mangaId, commentId) {
    if (!State.isLoggedIn()) return;
    try {
      const res = await Api.deleteMangaComment(mangaId, commentId);
      if (res.success && res.data) {
        const comments = res.data.comments || [];
        if (this.currentMangaSocial) {
          this.currentMangaSocial.comments = comments;
        }
        this.renderCommentsList(mangaId, comments);
        this.showToast('Komentar telah dihapus');
      }
    } catch (err) {
      this.showToast(err.message || 'Gagal menghapus komentar');
    }
  },

  renderCommentsList(mangaId, comments = []) {
    const listEl = document.getElementById('manga-comments-list');
    const countEl = document.getElementById('comments-total-count');
    if (countEl) countEl.textContent = comments.length;
    if (!listEl) return;

    if (!comments.length) {
      listEl.innerHTML = `
        <div class="comments-empty">
          <i class="ri-chat-3-line"></i>
          <p>Belum ada komentar untuk manga ini. Jadilah yang pertama berkomentar!</p>
        </div>
      `;
      return;
    }

    const currentUserId = State.user?.id || null;
    listEl.innerHTML = comments
      .map((c) => {
        const isOwn = currentUserId && c.userId === currentUserId;
        const safeName = this.escapeHtml(c.username || 'Pembaca');
        const safeText = this.escapeHtml(c.text || '');
        const fallbackAvatar = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="%236366f1"/><text x="50%" y="54%" font-family="sans-serif" font-size="28" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${safeName.charAt(0).toUpperCase()}</text></svg>`;

        const safeAvatar = (typeof c.avatar === 'string' && /^(data:image\/svg\+xml|https:\/\/)/i.test(c.avatar))
          ? this.escapeHtml(c.avatar)
          : fallbackAvatar;

        return `
          <div class="comment-card">
            <img class="comment-avatar" src="${safeAvatar}" alt="${safeName}" />
            <div class="comment-body">
              <div class="comment-header">
                <span class="comment-author">${safeName}</span>
                <span class="comment-time">${this.formatRelativeTime(c.createdAt)}</span>
                ${
                  isOwn
                    ? `<button type="button" class="comment-delete-btn" onclick="app.deleteMangaComment('${this.escapeHtml(mangaId)}', '${this.escapeHtml(c.id)}')" title="Hapus komentar saya">
                         <i class="ri-delete-bin-line"></i>
                       </button>`
                    : ''
                }
              </div>
              <div class="comment-text">${safeText}</div>
            </div>
          </div>
        `;
      })
      .join('');
  },

  // ---------------- Backup Export & Import Handlers ----------------
  exportBackup() {
    this.toggleUserMenu(false);
    try {
      const backup = State.exportBackupData();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `mangaflow-backup-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      this.showToast('File Backup (.json) berhasil diunduh!');
    } catch (err) {
      this.showToast('Gagal mengekspor backup: ' + err.message);
    }
  },

  triggerImportBackup() {
    this.toggleUserMenu(false);
    const fileInput = document.getElementById('backup-file-input');
    if (fileInput) {
      fileInput.value = '';
      fileInput.click();
    }
  },

  handleBackupFileImport(event) {
    const file = event.target?.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = JSON.parse(e.target.result);
        const stats = State.importBackupData(parsed);
        this.updateBadgeCounts();
        if (this.currentView === 'library') {
          this.renderLibraryView();
        }
        this.showToast(`Restore berhasil! (${stats.bookmarksCount} Favorit, ${stats.historyCount} Riwayat)`);
      } catch (err) {
        this.showToast('Gagal memulihkan file backup: ' + err.message);
      }
    };
    reader.readAsText(file);
  },

  // ---------------- Utility Helpers ----------------
  resolveCoverUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (!trimmed) return '';
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

  getFallbackCoverDataUri(title = 'MangaFlow') {
    const cleanTitle = String(title || 'MangaFlow').replace(/[<>&"']/g, '').trim().slice(0, 22) || 'No Cover';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#141720"/><stop offset="100%" stop-color="#1e2230"/></linearGradient></defs><rect width="400" height="600" fill="url(#g)"/><rect x="16" y="16" width="368" height="568" rx="16" fill="none" stroke="#6366f1" stroke-opacity="0.28" stroke-width="2"/><text x="200" y="285" font-family="sans-serif" font-size="22" font-weight="700" fill="#818cf8" text-anchor="middle">${cleanTitle}</text><text x="200" y="320" font-family="sans-serif" font-size="14" fill="#64748b" text-anchor="middle">Cover Tidak Tersedia</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  },

  handleCoverError(img, fallbackCoverUrl = '', title = 'MangaFlow') {
    if (!img) return;
    const currentSrc = img.getAttribute('src') || img.src || '';
    const resolvedFallback = this.resolveCoverUrl(fallbackCoverUrl);

    if (!img.dataset.triedAlt) {
      const hasThumbSuffix = /\.(256|512)\.jpg/i.test(currentSrc) || /%2E(256|512)%2Ejpg/i.test(currentSrc);
      let altSrc = '';
      if (resolvedFallback && resolvedFallback !== currentSrc && !resolvedFallback.includes('.256.jpg')) {
        altSrc = resolvedFallback;
      } else if (hasThumbSuffix) {
        altSrc = currentSrc
          .replace(/\.(256|512)\.jpg/gi, '')
          .replace(/%2E(256|512)%2Ejpg/gi, '');
      }
      if (altSrc && altSrc !== currentSrc) {
        img.dataset.triedAlt = '1';
        img.src = altSrc;
        return;
      }
    }

    if (!img.dataset.triedDirect && currentSrc.includes('/api/proxy/image?url=')) {
      try {
        const parsed = new URL(currentSrc, window.location.origin);
        const rawUrl = parsed.searchParams.get('url');
        if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
          img.dataset.triedDirect = '1';
          img.referrerPolicy = 'no-referrer';
          img.src = rawUrl;
          return;
        }
      } catch (_) {}
    }

    img.onerror = null;
    img.src = this.getFallbackCoverDataUri(title || img.alt || 'MangaFlow');
  },

  escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  formatRelativeTime(timestamp) {
    if (!timestamp) return 'Baru saja';
    const diffSeconds = Math.floor((Date.now() - Number(timestamp)) / 1000);
    if (diffSeconds < 60) return 'Baru saja';
    const diffMinutes = Math.floor(diffSeconds / 60);
    if (diffMinutes < 60) return `${diffMinutes} menit lalu`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours} jam lalu`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} hari lalu`;
    return new Date(Number(timestamp)).toLocaleDateString('id-ID');
  },

  showToast(message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast';

    const icon = document.createElement('i');
    icon.className = 'ri-checkbox-circle-fill';
    icon.style.color = 'var(--accent-primary)';

    const textSpan = document.createElement('span');
    textSpan.textContent = String(message ?? '');

    toast.appendChild(icon);
    toast.appendChild(textSpan);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  },

  // ---------------- PWA 1-Click App Installation ----------------
  initPWA() {
    this.isStandalone = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && navigator.standalone === true);

    this.isIOS = typeof navigator !== 'undefined' && (
      /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );

    window.addEventListener('appinstalled', () => {
      window.deferredInstallPrompt = null;
      this.updatePWAUI();
      this.showToast('Aplikasi MangaFlow berhasil dipasang!');
    });

    if (window.deferredInstallPrompt) {
      this.handleInstallPromptReady(window.deferredInstallPrompt);
    } else {
      this.updatePWAUI();
    }
  },

  handleInstallPromptReady(e) {
    window.deferredInstallPrompt = e;
    this.updatePWAUI();
  },

  updatePWAUI() {
    const installBtn = document.getElementById('btn-install-app');
    const userMenuItem = document.getElementById('user-menu-install-item');
    const banner = document.getElementById('pwa-install-banner');

    if (this.isStandalone) {
      if (installBtn) installBtn.style.display = 'none';
      if (userMenuItem) userMenuItem.style.display = 'none';
      if (banner) banner.style.display = 'none';
      return;
    }

    const canInstall = Boolean(window.deferredInstallPrompt) || this.isIOS;

    if (canInstall) {
      if (installBtn) installBtn.style.display = 'inline-flex';
      if (userMenuItem) userMenuItem.style.display = 'flex';
      if (banner) {
        let dismissed = false;
        try {
          dismissed = localStorage.getItem('mangaflow_pwa_banner_dismissed') === 'true';
        } catch (_) {}
        banner.style.display = dismissed ? 'none' : 'flex';
      }
    } else {
      if (installBtn) installBtn.style.display = 'none';
      if (userMenuItem) userMenuItem.style.display = 'none';
      if (banner) banner.style.display = 'none';
    }
  },

  async promptInstallApp() {
    const dropdown = document.getElementById('user-dropdown-menu');
    if (dropdown && dropdown.classList.contains('open')) {
      dropdown.classList.remove('open');
    }

    if (window.deferredInstallPrompt) {
      const promptEvent = window.deferredInstallPrompt;
      try {
        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice && choice.outcome === 'accepted') {
          this.showToast('Memulai pemasangan aplikasi MangaFlow...');
        }
      } catch (err) {
        console.warn('[PWA Install Prompt Error]:', err);
      } finally {
        window.deferredInstallPrompt = null;
        this.updatePWAUI();
      }
    } else if (this.isIOS) {
      this.toggleIosInstallModal(true);
    } else if (this.isStandalone) {
      this.showToast('Aplikasi MangaFlow sudah terpasang');
    } else {
      this.showToast('Gunakan menu browser untuk menginstall aplikasi');
    }
  },

  dismissInstallBanner() {
    try {
      localStorage.setItem('mangaflow_pwa_banner_dismissed', 'true');
    } catch (_) {}
    const banner = document.getElementById('pwa-install-banner');
    if (banner) {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(-8px)';
      banner.style.transition = 'all 0.25s ease';
      setTimeout(() => {
        banner.style.display = 'none';
      }, 250);
    }
  },

  toggleIosInstallModal(show) {
    const modal = document.getElementById('ios-install-modal');
    if (!modal) return;
    modal.style.display = show ? 'flex' : 'none';
  }
};

// Expose app to window for inline handlers & early install capture
if (typeof window !== 'undefined') {
  window.app = app;
}

// Initialize Application when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
