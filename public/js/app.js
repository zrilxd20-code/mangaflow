// ===================================================
// MangaFlow Main Application Controller
// ===================================================

const app = {
  currentView: 'home',
  selectedManga: null,
  trendingData: [],
  heroIndex: 0,
  heroInterval: null,
  searchTimeout: null,
  filterTags: [],
  selectedFilterTags: new Set(),
  selectedSort: 'relevance',
  selectedStatus: '',

  async init() {
    Reader.init();
    this.bindGlobalEvents();
    this.updateBadgeCounts();
    this.updateAuthUI();

    // Initial data load
    await Promise.allSettled([
      this.loadHeroAndTrending(),
      this.loadLatestUpdates(),
      this.loadTags()
    ]);

    this.renderContinueReading();

    // Initialize SPA Hash Router
    this.initRouter();
  },

  bindGlobalEvents() {
    const searchInput = document.getElementById('global-search-input');
    const searchDropdown = document.getElementById('quick-search-results');
    const clearBtn = document.getElementById('search-clear-btn');

    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();
        if (clearBtn) clearBtn.style.display = q ? 'block' : 'none';

        clearTimeout(this.searchTimeout);
        if (!q) {
          if (searchDropdown) searchDropdown.classList.remove('open');
          return;
        }

        this.searchTimeout = setTimeout(async () => {
          try {
            const res = await Api.search({ q, limit: 6 });
            this.renderQuickSearchDropdown(res.data || []);
          } catch (err) {
            console.error(err);
          }
        }, 350);
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

    // Close dropdowns on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-search')) {
        const dd = document.getElementById('quick-search-results');
        if (dd) dd.classList.remove('open');
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
  },

  initRouter() {
    window.addEventListener('hashchange', () => this.handleHashChange());
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
        targetHash = `#/search?${qParams.toString()}`;
      } else if (viewName === 'home') {
        targetHash = '#/';
      }

      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
        return; // will be handled by hashchange event
      }
    }

    // Update active nav links
    document.querySelectorAll('.nav-link, .mobile-nav-item').forEach((el) => {
      el.classList.remove('active');
    });

    const activeNavBtn = document.getElementById(`nav-${viewName}`);
    const activeMobBtn = document.getElementById(`mob-nav-${viewName}`);
    if (activeNavBtn) activeNavBtn.classList.add('active');
    if (activeMobBtn) activeMobBtn.classList.add('active');

    // Hide all view sections
    document.querySelectorAll('.view-section').forEach((el) => {
      el.style.display = 'none';
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });

    if (viewName === 'home') {
      document.getElementById('home-view').style.display = 'block';
      this.renderContinueReading();
    } else if (viewName === 'latest') {
      this.renderLatestView();
    } else if (viewName === 'library') {
      this.renderLibraryView();
    } else if (viewName === 'history') {
      this.renderHistoryView();
    } else if (viewName === 'manga') {
      this.renderMangaDetailView(params.id);
    } else if (viewName === 'search') {
      this.renderSearchView(params);
    }
  },

  // ---------------- Hero & Trending ----------------
  async loadHeroAndTrending() {
    try {
      const res = await Api.getTrending();
      if (!res.success || !res.data) return;

      this.trendingData = res.data;
      this.renderHeroCarousel(res.data.slice(0, 5));
      this.renderTrendingGrid(res.data);
    } catch (err) {
      console.error('Failed to load trending:', err);
    }
  },

  renderHeroCarousel(items) {
    const container = document.getElementById('hero-container');
    if (!items.length) {
      container.style.display = 'none';
      return;
    }

    container.innerHTML = '';

    items.forEach((item, index) => {
      const slide = document.createElement('div');
      slide.className = `hero-slide ${index === 0 ? 'active' : ''}`;
      slide.dataset.index = index;

      const tagsHtml = (item.tags || []).slice(0, 3)
        .map((t) => `<span class="hero-tag">${t}</span>`)
        .join('');

      slide.innerHTML = `
        <img class="hero-backdrop-img" src="${item.coverUrl}" alt="${item.title}" onerror="if(!this.dataset.triedProxy){this.dataset.triedProxy='1';this.src='/api/proxy/image?url='+encodeURIComponent('${item.coverUrl}');}" />
        <div class="hero-gradient-overlay"></div>
        <div class="hero-content">
          <img class="hero-poster" src="${item.coverUrlSmall || item.coverUrl}" alt="${item.title}" onerror="if(!this.dataset.triedProxy){this.dataset.triedProxy='1';this.src='/api/proxy/image?url='+encodeURIComponent('${item.coverUrlSmall || item.coverUrl}');}" />
          <div class="hero-details">
            <div class="hero-tag-list">${tagsHtml}</div>
            <h1 class="hero-title">${item.title}</h1>
            <p class="hero-synopsis">${item.description.replace(/\[\/?\w+\]/g, '')}</p>
            <div class="hero-actions">
              <button class="btn btn-primary" onclick="app.navigate('manga', { id: '${item.id}' })">
                <i class="ri-book-read-line"></i> Mulai Baca
              </button>
              <button class="btn btn-secondary" onclick="app.toggleBookmarkFromHero('${item.id}')">
                <i class="ri-bookmark-line"></i> ${State.isBookmarked(item.id) ? 'Tersimpan' : 'Favorit'}
              </button>
            </div>
          </div>
        </div>
      `;

      container.appendChild(slide);
    });

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

    // Auto rotate every 6s
    clearInterval(this.heroInterval);
    this.heroInterval = setInterval(() => {
      this.heroIndex = (this.heroIndex + 1) % items.length;
      this.setHeroSlide(this.heroIndex);
    }, 6000);
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

    items.forEach((item) => {
      const card = this.createMangaCard(item);
      grid.appendChild(card);
    });
  },

  // ---------------- Latest Updates ----------------
  async loadLatestUpdates() {
    try {
      const res = await Api.getLatest(1);
      if (!res.success || !res.data) return;

      const grid = document.getElementById('latest-grid');
      grid.innerHTML = '';

      res.data.slice(0, 12).forEach((item) => {
        const card = this.createMangaCard(item);
        grid.appendChild(card);
      });
    } catch (err) {
      console.error('Failed to load latest:', err);
    }
  },

  async renderLatestView(page = 1) {
    const view = document.getElementById('latest-view');
    view.style.display = 'block';

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header">
          <div class="section-title-wrap">
            <i class="ri-sparkling-fill title-icon new"></i>
            <h2>Semua Rilis & Update Terbaru (Hal. ${page})</h2>
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
      const res = await Api.getLatest(page);
      const grid = document.getElementById('latest-full-grid');
      grid.innerHTML = '';

      if (res.data && res.data.length > 0) {
        res.data.forEach((item) => {
          const card = this.createMangaCard(item);
          grid.appendChild(card);
        });

        // Pagination buttons
        const pagination = document.getElementById('latest-pagination');
        pagination.innerHTML = `
          ${page > 1 ? `<button class="btn btn-secondary" onclick="app.renderLatestView(${page - 1})"><i class="ri-arrow-left-s-line"></i> Halaman Sebelumnya</button>` : ''}
          <button class="btn btn-primary" onclick="app.renderLatestView(${page + 1})">Halaman Selanjutnya <i class="ri-arrow-right-s-line"></i></button>
        `;
      }
    } catch (err) {
      console.error(err);
    }
  },

  // ---------------- Manga Card Builder ----------------
  createMangaCard(item) {
    const card = document.createElement('div');
    card.className = 'manga-card';
    card.onclick = () => this.navigate('manga', { id: item.id });

    const statusClass = item.status === 'completed' ? 'completed' : 'ongoing';
    const statusText = item.status === 'completed' ? 'Tamat' : 'Ongoing';

    card.innerHTML = `
      <div class="card-cover-wrap">
        <img class="card-cover" src="${item.coverUrlSmall || item.coverUrl}" alt="${item.title}" loading="lazy" onerror="if(!this.dataset.triedProxy){this.dataset.triedProxy='1';this.src='/api/proxy/image?url='+encodeURIComponent('${item.coverUrlSmall || item.coverUrl}');}else{this.onerror=null;this.src='https://placehold.co/400x600/181a20/818cf8?text=No+Cover';}" />
        <div class="card-badges">
          <span class="card-badge badge-status ${statusClass}">
            <i class="ri-checkbox-blank-circle-fill" style="font-size: 0.55rem;"></i> ${statusText}
          </span>
          ${item.tags && item.tags[0] ? `<span class="card-badge">${item.tags[0]}</span>` : ''}
        </div>
      </div>
      <div class="card-body">
        <h4 class="card-title" title="${item.title}">${item.title}</h4>
        <div class="card-meta">
          <span>${item.year ? item.year : 'Manga'}</span>
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

      card.innerHTML = `
        <img class="continue-thumb" src="${item.coverUrl}" alt="${item.mangaTitle}" />
        <div class="continue-info">
          <div class="continue-title">${item.mangaTitle}</div>
          <div class="continue-sub">Chapter ${item.chapterNum} (Hal. ${item.page}/${item.totalPages})</div>
          <button class="btn btn-primary continue-btn" onclick="event.stopPropagation(); app.resumeReading('${item.mangaId}', '${item.chapterId}')">
            <i class="ri-play-fill"></i> Lanjut
          </button>
        </div>
      `;
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
    const view = document.getElementById('manga-view');
    view.style.display = 'block';
    view.innerHTML = `
      <div class="detail-container">
        <div class="detail-header skeleton-hero" style="height: 380px;"></div>
      </div>
    `;

    try {
      const [mangaRes, chaptersRes] = await Promise.all([
        Api.getManga(mangaId),
        Api.getChapters(mangaId, State.settings.languages.join(','))
      ]);

      const manga = mangaRes.data;
      const chapters = chaptersRes.data || [];
      this.selectedManga = manga;

      const isFav = State.isBookmarked(manga.id);
      const tagsHtml = (manga.tags || [])
        .map((t) => `<span class="detail-tag">${t}</span>`)
        .join('');

      view.innerHTML = `
        <div class="detail-container">
          <!-- Backdrop Header -->
          <div class="detail-header">
            <img class="detail-backdrop" src="${manga.coverUrl}" alt="${manga.title}" onerror="if(!this.dataset.triedProxy){this.dataset.triedProxy='1';this.src='/api/proxy/image?url='+encodeURIComponent('${manga.coverUrl}');}" />
            <div class="detail-header-inner">
              <div class="detail-cover-box">
                <img class="detail-cover-img" src="${manga.coverUrl}" alt="${manga.title}" onerror="if(!this.dataset.triedProxy){this.dataset.triedProxy='1';this.src='/api/proxy/image?url='+encodeURIComponent('${manga.coverUrl}');}" />
              </div>
              <div class="detail-main-info">
                <h1 class="detail-title">${manga.title}</h1>
                <div class="detail-alt-titles">${(manga.altTitles || []).join(' • ')}</div>

                <div class="detail-stats-bar">
                  <div class="stat-item">
                    <i class="ri-star-fill" style="color: #fbbf24;"></i>
                    <span>${manga.rating || '8.5'} / 10</span>
                  </div>
                  <div class="stat-item">
                    <i class="ri-heart-3-line"></i>
                    <span>${(manga.follows || 0).toLocaleString()} Pembaca</span>
                  </div>
                  <div class="stat-item">
                    <i class="ri-information-line"></i>
                    <span style="text-transform: capitalize;">${manga.status}</span>
                  </div>
                  <div class="stat-item">
                    <i class="ri-calendar-line"></i>
                    <span>${manga.year || 'Unknown'}</span>
                  </div>
                </div>

                <div class="detail-description">${manga.description.replace(/\[\/?\w+\]/g, '')}</div>

                <div class="detail-tags-wrap">${tagsHtml}</div>

                <div class="detail-actions-row">
                  <button class="btn btn-primary" id="detail-read-first-btn">
                    <i class="ri-book-open-line"></i> Baca Chapter Pertama
                  </button>
                  <button class="btn btn-secondary" id="detail-bookmark-btn" onclick="app.toggleBookmarkDetail('${manga.id}')">
                    <i class="${isFav ? 'ri-bookmark-fill' : 'ri-bookmark-line'}"></i>
                    <span>${isFav ? 'Tersimpan di Favorit' : 'Tambah ke Favorit'}</span>
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
                <select class="filter-select" id="chapter-type-filter" onchange="app.filterChapters()">
                  <option value="all">Semua Tipe</option>
                  <option value="readable" selected>Bisa Dibaca Langsung</option>
                  <option value="external">Hanya Link Eksternal</option>
                </select>
                <select class="filter-select" id="chapter-lang-filter" onchange="app.filterChapters()">
                  <option value="all">Semua Bahasa</option>
                  <option value="en" selected>English (EN)</option>
                  <option value="id">Indonesia (ID)</option>
                </select>
                <select class="filter-select" id="chapter-sort-order" onchange="app.sortChapters(this.value)">
                  <option value="desc" selected>Terbaru Dulu</option>
                  <option value="asc">Terawal Dulu</option>
                </select>
              </div>
            </div>

            <div class="chapters-grid" id="chapters-list-grid"></div>
          </div>
        </div>
      `;

      this.currentChaptersList = chapters;
      this.filterChapters();

      // Read first chapter button logic
      const firstBtn = document.getElementById('detail-read-first-btn');
      firstBtn.onclick = () => {
        const readable = chapters.filter((c) => !c.isExternal);
        if (readable.length > 0) {
          // Chapter terawal adalah item terakhir jika diurutkan desc
          const firstChapter = readable[readable.length - 1];
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
          <p style="color: var(--text-muted); margin-bottom: 20px;">${err.message}</p>
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

    chapters.forEach((ch) => {
      const isRead = State.isChapterRead(ch.id);
      const row = document.createElement('div');
      row.className = `chapter-row ${isRead ? 'read' : ''}`;

      if (ch.isExternal) {
        row.onclick = () => window.open(ch.externalUrl, '_blank');
      } else {
        row.onclick = () => Reader.open(this.selectedManga, ch.id, internalChapters);
      }

      row.innerHTML = `
        <div class="chapter-row-left">
          <span class="chapter-badge">CH ${ch.chapter || '0'}</span>
          <div>
            <div class="chapter-row-title">${ch.title ? ch.title : 'Chapter ' + (ch.chapter || '0')}</div>
            <div class="chapter-row-group">
              ${ch.group}
              ${ch.isExternal ? '<span style="color: #38bdf8; margin-left: 6px;">[Eksternal]</span>' : ''}
            </div>
          </div>
        </div>
        <div class="chapter-row-right">
          <span style="font-weight: 700; text-transform: uppercase;">${ch.language}</span>
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
  },

  filterChapters() {
    if (!this.currentChaptersList) return;
    const langSelect = document.getElementById('chapter-lang-filter');
    const typeSelect = document.getElementById('chapter-type-filter');
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
  renderLibraryView() {
    const view = document.getElementById('library-view');
    view.style.display = 'block';
    const bookmarks = State.getBookmarks();

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header">
          <div class="section-title-wrap">
            <i class="ri-bookmark-3-fill title-icon"></i>
            <h2>Koleksi Favorit (${bookmarks.length})</h2>
          </div>
        </div>
        ${
          bookmarks.length === 0
            ? `<div style="text-align: center; padding: 60px 0; color: var(--text-dim);">
                 <i class="ri-bookmark-line" style="font-size: 3rem; margin-bottom: 12px; display: block;"></i>
                 <h3>Belum ada manga yang disimpan</h3>
                 <p style="margin: 8px 0 20px 0;">Klik ikon bookmark pada manga untuk menyimpannya ke koleksi Anda.</p>
                 <button class="btn btn-primary" onclick="app.navigate('home')">Jelajahi Manga</button>
               </div>`
            : `<div class="manga-grid" id="library-grid"></div>`
        }
      </div>
    `;

    if (bookmarks.length > 0) {
      const grid = document.getElementById('library-grid');
      bookmarks.forEach((item) => {
        const card = this.createMangaCard(item);
        grid.appendChild(card);
      });
    }
  },

  // ---------------- History View ----------------
  renderHistoryView() {
    const view = document.getElementById('history-view');
    view.style.display = 'block';
    const history = State.getHistory();

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header">
          <div class="section-title-wrap">
            <i class="ri-history-line title-icon"></i>
            <h2>Riwayat Membaca (${history.length})</h2>
          </div>
          ${history.length ? '<button class="btn btn-secondary" onclick="app.clearHistory()"><i class="ri-delete-bin-line"></i> Hapus Riwayat</button>' : ''}
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
        card.onclick = () => this.navigate('manga', { id: item.mangaId });

        card.innerHTML = `
          <img class="continue-thumb" src="${item.coverUrl}" alt="${item.mangaTitle}" />
          <div class="continue-info">
            <div class="continue-title">${item.mangaTitle}</div>
            <div class="continue-sub">Chapter ${item.chapterNum} (Hal. ${item.page}/${item.totalPages})</div>
            <button class="btn btn-primary continue-btn" onclick="event.stopPropagation(); app.resumeReading('${item.mangaId}', '${item.chapterId}')">
              <i class="ri-play-fill"></i> Lanjutkan
            </button>
          </div>
        `;
        grid.appendChild(card);
      });
    }
  },

  clearHistory() {
    if (confirm('Hapus seluruh riwayat membaca?')) {
      State.clearHistory();
      this.renderHistoryView();
      this.showToast('Riwayat membaca telah dibersihkan');
    }
  },

  // ---------------- Search & Filter View ----------------
  async performSearch(q) {
    this.navigate('search', { q });
  },

  async renderSearchView(params = {}) {
    const view = document.getElementById('search-view');
    view.style.display = 'block';

    view.innerHTML = `
      <div class="section-container">
        <div class="section-header">
          <div class="section-title-wrap">
            <i class="ri-search-line title-icon"></i>
            <h2>Hasil Pencarian ${params.q ? `untuk "${params.q}"` : ''}</h2>
          </div>
          <button class="btn btn-secondary" onclick="app.toggleFilterModal()">
            <i class="ri-sound-module-line"></i> Filter & Opsi
          </button>
        </div>
        <div class="manga-grid" id="search-results-grid">
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
          <div class="manga-card skeleton-card"></div>
        </div>
      </div>
    `;

    try {
      const queryParams = {
        q: params.q || '',
        sort: this.selectedSort,
        status: this.selectedStatus,
        tags: Array.from(this.selectedFilterTags).join(',')
      };

      const res = await Api.search(queryParams);
      const grid = document.getElementById('search-results-grid');
      grid.innerHTML = '';

      if (!res.data || !res.data.length) {
        grid.innerHTML = `
          <div style="grid-column: 1 / -1; text-align: center; padding: 60px 0; color: var(--text-dim);">
            <i class="ri-file-search-line" style="font-size: 3rem; margin-bottom: 12px; display: block;"></i>
            <h3>Tidak menemukan komik yang cocok</h3>
            <p>Coba gunakan kata kunci yang lebih singkat atau periksa ejaan judul.</p>
          </div>
        `;
        return;
      }

      res.data.forEach((item) => {
        const card = this.createMangaCard(item);
        grid.appendChild(card);
      });
    } catch (err) {
      console.error(err);
    }
  },

  // ---------------- Quick Search Dropdown ----------------
  renderQuickSearchDropdown(items) {
    const dropdown = document.getElementById('quick-search-results');
    dropdown.innerHTML = '';

    if (!items.length) {
      dropdown.classList.remove('open');
      return;
    }

    items.forEach((item) => {
      const el = document.createElement('div');
      el.className = 'search-dropdown-item';
      el.onclick = () => {
        dropdown.classList.remove('open');
        this.navigate('manga', { id: item.id });
      };

      el.innerHTML = `
        <img class="search-item-thumb" src="${item.coverUrlSmall || item.coverUrl}" alt="${item.title}" />
        <div class="search-item-info">
          <div class="search-item-title">${item.title}</div>
          <div class="search-item-meta">
            <span>${item.status}</span>
            <span>•</span>
            <span>${item.tags && item.tags[0] ? item.tags[0] : 'Manga'}</span>
          </div>
        </div>
      `;

      dropdown.appendChild(el);
    });

    dropdown.classList.add('open');
  },

  clearSearch() {
    const input = document.getElementById('global-search-input');
    input.value = '';
    document.getElementById('search-clear-btn').style.display = 'none';
    document.getElementById('quick-search-results').classList.remove('open');
  },

  openMobileSearch() {
    const input = document.getElementById('global-search-input');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    input.focus();
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
    const q = document.getElementById('global-search-input').value.trim();
    this.navigate('search', { q });
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
    this.showToast(added ? 'Disimpan ke Favorit' : 'Dihapus dari Favorit');
  },

  updateBadgeCounts() {
    const count = State.getBookmarks().length;
    const badge = document.getElementById('nav-fav-count');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  },

  shareManga() {
    if (navigator.share && this.selectedManga) {
      navigator.share({
        title: this.selectedManga.title,
        text: `Baca ${this.selectedManga.title} di MangaFlow`,
        url: window.location.href
      }).catch(() => {});
    } else {
      navigator.clipboard.writeText(window.location.href).then(() => {
        this.showToast('Link manga disalin ke clipboard!');
      });
    }
  },

  toggleLangMenu() {
    const menu = document.getElementById('lang-dropdown-menu');
    menu.classList.toggle('open');
  },

  updateLangPref() {
    const checkboxes = document.querySelectorAll('#lang-dropdown-menu input[type="checkbox"]');
    const langs = [];
    checkboxes.forEach((cb) => {
      if (cb.checked) langs.push(cb.value);
    });

    if (!langs.length) langs.push('en');

    State.settings.languages = langs;
    State.saveSettings();

    document.getElementById('current-lang-label').textContent = langs.map((l) => l.toUpperCase()).join(' / ');
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
    modal.style.display = isShowing ? 'flex' : 'none';
  },

  switchAuthTab(tab) {
    const tabLogin = document.getElementById('tab-login');
    const tabReg = document.getElementById('tab-register');
    const formLogin = document.getElementById('form-login');
    const formReg = document.getElementById('form-register');
    const title = document.getElementById('auth-modal-title');

    if (tab === 'login') {
      if (tabLogin) tabLogin.classList.add('active');
      if (tabReg) tabReg.classList.remove('active');
      if (formLogin) formLogin.style.display = 'flex';
      if (formReg) formReg.style.display = 'none';
      if (title) title.textContent = 'Masuk ke Akun';
    } else {
      if (tabLogin) tabLogin.classList.remove('active');
      if (tabReg) tabReg.classList.add('active');
      if (formLogin) formLogin.style.display = 'none';
      if (formReg) formReg.style.display = 'flex';
      if (title) title.textContent = 'Buat Akun Baru';
    }
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

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="ri-loader-4-line spin"></i> <span>Memproses...</span>';
    }

    try {
      const res = await Api.login(identifier, password);
      if (res.success && res.user) {
        State.setAuth(res.user, res.token, res.data);
        this.toggleAuthModal(false);
        this.showToast(`Selamat datang kembali, ${res.user.username}!`);
      }
    } catch (err) {
      this.showToast(err.message || 'Gagal masuk. Periksa kembali username/password.');
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

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<i class="ri-loader-4-line spin"></i> <span>Mendaftarkan...</span>';
    }

    try {
      const res = await Api.register(username, email, password);
      if (res.success && res.user) {
        State.setAuth(res.user, res.token);
        this.toggleAuthModal(false);
        this.showToast(`Akun berhasil dibuat! Selamat membaca, ${res.user.username}!`);
      }
    } catch (err) {
      this.showToast(err.message || 'Gagal membuat akun.');
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
  },

  async syncNow() {
    this.toggleUserMenu(false);
    if (!State.isLoggedIn()) {
      this.openAuthModal('login');
      return;
    }

    this.showToast('Menyinkronkan data...');
    try {
      const res = await Api.syncUserData(State.getBookmarks(), State.getHistory());
      if (res.success && res.data) {
        State.mergeCloudData(res.data);
        this.showToast('Data favorit & riwayat berhasil disinkronkan ke cloud!');
      }
    } catch (err) {
      this.showToast('Gagal sinkron: ' + err.message);
    }
  },

  showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML = `<i class="ri-checkbox-circle-fill" style="color: var(--accent-primary);"></i> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 2800);
  }
};

// Initialize Application when DOM ready
document.addEventListener('DOMContentLoaded', () => {
  app.init();
});
