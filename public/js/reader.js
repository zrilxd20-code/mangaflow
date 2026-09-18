// ===================================================
// MangaFlow Reader Engine (Webtoon & Single-Page Modes)
// ===================================================

const Reader = {
  active: false,
  manga: null,
  currentChapterId: null,
  chapterData: null,
  allChapters: [],
  currentPage: 1,
  totalPages: 1,
  mode: 'webtoon', // 'webtoon' | 'single'
  direction: 'rtl', // 'rtl' (Manga Jepang) | 'ltr' (Komik Barat)
  readerWidth: 'standard', // 'compact' | 'standard' | 'wide' | 'full'
  fitMode: 'contain', // 'contain' | 'width' | 'height'
  quality: 'original', // 'original' | 'saver'
  brightness: 100, // 30 - 100 %
  zoom: 100, // 50 - 220 %
  readerBg: 'oled', // 'oled' | 'dark' | 'midnight' | 'sepia'
  autoScrollSpeed: 2, // 1 - 5
  isAutoScrolling: false,
  autoScrollPaused: false,
  autoScrollRafId: null,
  touchStartX: 0,
  touchStartY: 0,
  touchStartTime: 0,
  hudTimeout: null,
  hudVisible: true,
  preloadedSet: new Set(),
  preloadHideTimeout: null,

  // DOM Elements
  elements: {},

  init() {
    this.elements = {
      overlay: document.getElementById('reader-overlay'),
      topHud: document.getElementById('reader-top-hud'),
      bottomHud: document.getElementById('reader-bottom-hud'),
      workspace: document.getElementById('reader-workspace'),
      strip: document.getElementById('reader-strip'),
      singleView: document.getElementById('reader-single-view'),
      singleImg: document.getElementById('single-page-img'),
      singlePrevBtn: document.getElementById('single-prev-btn'),
      singleNextBtn: document.getElementById('single-next-btn'),
      loader: document.getElementById('reader-loader'),
      error: document.getElementById('reader-error'),
      errorMsg: document.getElementById('reader-error-msg'),
      retryBtn: document.getElementById('reader-retry-btn'),
      useSaverBtn: document.getElementById('reader-use-saver-btn'),
      mangaTitle: document.getElementById('reader-manga-title'),
      chapterTitle: document.getElementById('reader-chapter-title'),
      chapterSelect: document.getElementById('reader-chapter-select'),
      autoscrollBtn: document.getElementById('reader-autoscroll-btn'),
      autoscrollLabel: document.getElementById('reader-autoscroll-label'),
      autoscrollPill: document.getElementById('reader-autoscroll-pill'),
      autoscrollPillText: document.getElementById('autoscroll-pill-text'),
      autoscrollPauseBtn: document.getElementById('autoscroll-pause-btn'),
      autoscrollPauseIcon: document.getElementById('autoscroll-pause-icon'),
      autoscrollSpeedBtn: document.getElementById('autoscroll-speed-btn'),
      autoscrollStopBtn: document.getElementById('autoscroll-stop-btn'),
      settingsBtn: document.getElementById('reader-settings-btn'),
      settingsDrawer: document.getElementById('reader-settings-drawer'),
      settingsCloseBtn: document.getElementById('reader-settings-close-btn'),
      brightnessSlider: document.getElementById('reader-brightness-slider'),
      brightnessVal: document.getElementById('drawer-brightness-val'),
      zoomSlider: document.getElementById('reader-zoom-slider'),
      drawerZoomVal: document.getElementById('drawer-zoom-val'),
      speedVal: document.getElementById('drawer-speed-val'),
      modeToggle: document.getElementById('reader-mode-toggle'),
      modeLabel: document.getElementById('reader-mode-label'),
      directionToggle: document.getElementById('reader-direction-toggle'),
      directionLabel: document.getElementById('reader-direction-label'),
      widthToggle: document.getElementById('reader-width-toggle'),
      widthLabel: document.getElementById('reader-width-label'),
      zoomControl: document.getElementById('reader-zoom-control'),
      zoomInBtn: document.getElementById('reader-zoom-in-btn'),
      zoomOutBtn: document.getElementById('reader-zoom-out-btn'),
      zoomResetBtn: document.getElementById('reader-zoom-reset-btn'),
      zoomVal: document.getElementById('reader-zoom-val'),
      fitToggle: document.getElementById('reader-fit-toggle'),
      qualityToggle: document.getElementById('reader-quality-toggle'),
      shortcutsBtn: document.getElementById('reader-shortcuts-btn'),
      shortcutsModal: document.getElementById('shortcut-modal'),
      fullscreenBtn: document.getElementById('reader-fullscreen-btn'),
      backBtn: document.getElementById('reader-btn-back'),
      prevChapterBtn: document.getElementById('reader-prev-chapter-btn'),
      nextChapterBtn: document.getElementById('reader-next-chapter-btn'),
      pageSlider: document.getElementById('reader-page-slider'),
      currentPageLabel: document.getElementById('reader-current-page'),
      totalPagesLabel: document.getElementById('reader-total-pages'),
      preloadPill: document.getElementById('reader-preload-pill'),
      preloadStatusText: document.getElementById('preload-status-text')
    };

    this.mode = State.settings.readerMode || 'webtoon';
    this.direction = State.settings.direction || 'rtl';
    this.readerWidth = State.settings.readerWidth || 'standard';
    this.fitMode = State.settings.fitMode || 'contain';
    this.quality = State.settings.quality || 'original';
    this.brightness = State.settings.brightness !== undefined ? State.settings.brightness : 100;
    this.zoom = State.settings.zoom !== undefined ? State.settings.zoom : 100;
    this.readerBg = State.settings.readerBg || 'oled';
    this.autoScrollSpeed = State.settings.autoScrollSpeed || 2;

    this.bindEvents();
    this.applyReaderTheme(this.readerBg);
    this.applyBrightness(this.brightness);
    this.setZoom(this.zoom);
    this.updateControlsUI();
  },

  bindEvents() {
    // Back / Close
    this.elements.backBtn.onclick = () => this.close();

    // Mode Toggle (Webtoon <-> Single)
    this.elements.modeToggle.onclick = () => {
      this.mode = this.mode === 'webtoon' ? 'single' : 'webtoon';
      State.settings.readerMode = this.mode;
      State.saveSettings();
      this.updateControlsUI();
      this.renderPages();
    };

    // Direction Toggle (RTL <-> LTR)
    if (this.elements.directionToggle) {
      this.elements.directionToggle.onclick = () => this.toggleDirection();
    }

    // Webtoon Width Toggle
    if (this.elements.widthToggle) {
      this.elements.widthToggle.onclick = () => this.cycleWebtoonWidth();
    }

    // Zoom Controls (In, Out, Reset)
    if (this.elements.zoomInBtn) {
      this.elements.zoomInBtn.onclick = () => this.adjustZoom(10);
    }
    if (this.elements.zoomOutBtn) {
      this.elements.zoomOutBtn.onclick = () => this.adjustZoom(-10);
    }
    if (this.elements.zoomResetBtn) {
      this.elements.zoomResetBtn.onclick = () => this.resetZoom();
    }
    if (this.elements.zoomSlider) {
      this.elements.zoomSlider.value = this.zoom;
      this.elements.zoomSlider.oninput = (e) => {
        this.setZoom(parseInt(e.target.value, 10));
      };
    }

    // Single Page Fit Mode Toggle
    if (this.elements.fitToggle) {
      this.elements.fitToggle.onclick = () => this.cycleFitMode();
    }

    // Quality Toggle
    this.elements.qualityToggle.onclick = () => {
      this.quality = this.quality === 'original' ? 'saver' : 'original';
      State.settings.quality = this.quality;
      State.saveSettings();
      this.updateControlsUI();
      app.showToast(this.quality === 'saver' ? 'Mode Hemat Data Aktif' : 'Kualitas HD Original Aktif');
      this.renderPages();
    };

    // Reader Pro: Settings Drawer Toggle & Close
    if (this.elements.settingsBtn) {
      this.elements.settingsBtn.onclick = () => this.toggleSettingsDrawer();
    }
    if (this.elements.settingsCloseBtn) {
      this.elements.settingsCloseBtn.onclick = () => this.toggleSettingsDrawer(false);
    }

    // Reader Pro: Brightness Dimmer Slider
    if (this.elements.brightnessSlider) {
      this.elements.brightnessSlider.value = this.brightness;
      this.elements.brightnessSlider.oninput = (e) => {
        this.applyBrightness(parseInt(e.target.value, 10));
      };
    }

    // Reader Pro: Theme Picker Buttons
    document.querySelectorAll('#reader-bg-picker .bg-theme-btn').forEach((btn) => {
      btn.onclick = () => {
        this.applyReaderTheme(btn.dataset.bg);
      };
    });

    // Reader Pro: Auto-Scroll Speed Selector Chips
    document.querySelectorAll('#reader-speed-selector .speed-chip').forEach((chip) => {
      chip.onclick = () => {
        this.setAutoScrollSpeed(parseInt(chip.dataset.speed, 10));
      };
    });

    // Reader Pro: Auto-Scroll Toggle Button
    if (this.elements.autoscrollBtn) {
      this.elements.autoscrollBtn.onclick = () => this.toggleAutoScroll();
    }

    // Reader Pro: Floating Pill Buttons
    if (this.elements.autoscrollPauseBtn) {
      this.elements.autoscrollPauseBtn.onclick = (e) => {
        e.stopPropagation();
        this.togglePauseAutoScroll();
      };
    }
    if (this.elements.autoscrollSpeedBtn) {
      this.elements.autoscrollSpeedBtn.onclick = (e) => {
        e.stopPropagation();
        this.cycleAutoScrollSpeed();
      };
    }
    if (this.elements.autoscrollStopBtn) {
      this.elements.autoscrollStopBtn.onclick = (e) => {
        e.stopPropagation();
        this.stopAutoScroll();
      };
    }

    // Shortcuts Modal Open
    if (this.elements.shortcutsBtn) {
      this.elements.shortcutsBtn.onclick = () => this.toggleShortcutsModal();
    }

    // Single Nav Buttons Click (respects RTL / LTR)
    this.elements.singlePrevBtn.onclick = (e) => {
      e.stopPropagation();
      this.onNavBtnClick('prev');
    };
    this.elements.singleNextBtn.onclick = (e) => {
      e.stopPropagation();
      this.onNavBtnClick('next');
    };

    // Chapter Switcher Select
    this.elements.chapterSelect.onchange = (e) => {
      this.loadChapter(e.target.value);
    };

    // Prev / Next Chapter Buttons
    this.elements.prevChapterBtn.onclick = () => this.navigateChapter(-1);
    this.elements.nextChapterBtn.onclick = () => this.navigateChapter(1);

    // Page Slider Input
    this.elements.pageSlider.oninput = (e) => {
      const targetPage = parseInt(e.target.value, 10);
      this.goToPage(targetPage);
    };

    // Retry Buttons
    this.elements.retryBtn.onclick = () => this.loadChapter(this.currentChapterId);
    this.elements.useSaverBtn.onclick = () => {
      this.quality = 'saver';
      this.updateControlsUI();
      this.loadChapter(this.currentChapterId);
    };

    // Fullscreen
    this.elements.fullscreenBtn.onclick = () => this.toggleFullscreen();

    // HUD Auto-hide on Workspace Click/Tap
    this.elements.workspace.onclick = (e) => {
      if (
        e.target.closest('.hud-btn') ||
        e.target.closest('.single-nav-btn') ||
        e.target.closest('.shortcut-modal-box') ||
        e.target.closest('.reader-settings-drawer') ||
        e.target.closest('.autoscroll-pill')
      ) return;

      // Close settings drawer first if open
      if (this.elements.settingsDrawer && this.elements.settingsDrawer.style.display === 'flex') {
        this.toggleSettingsDrawer(false);
        return;
      }

      this.toggleHud();
    };

    // Touch Swipe Navigation for Mobile
    this.elements.workspace.addEventListener('touchstart', (e) => {
      if (e.touches && e.touches.length === 1) {
        this.touchStartX = e.touches[0].clientX;
        this.touchStartY = e.touches[0].clientY;
        this.touchStartTime = Date.now();
      }
    }, { passive: true });

    this.elements.workspace.addEventListener('touchend', (e) => {
      if (!this.touchStartX || !e.changedTouches || e.changedTouches.length === 0) return;
      const touchEndX = e.changedTouches[0].clientX;
      const touchEndY = e.changedTouches[0].clientY;
      const deltaX = touchEndX - this.touchStartX;
      const deltaY = touchEndY - this.touchStartY;
      const duration = Date.now() - this.touchStartTime;

      // In single mode: horizontal swipe flips page
      if (this.mode === 'single' && duration < 600) {
        if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
          if (deltaX < 0) {
            // Swiped left
            if (this.direction === 'rtl') {
              this.prevPage();
            } else {
              this.nextPage();
            }
          } else {
            // Swiped right
            if (this.direction === 'rtl') {
              this.nextPage();
            } else {
              this.prevPage();
            }
          }
        }
      }

      this.touchStartX = 0;
      this.touchStartY = 0;
    }, { passive: true });

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      if (!this.active) return;

      // Close modal first if open
      if (this.elements.shortcutsModal && this.elements.shortcutsModal.style.display === 'flex') {
        if (e.key === 'Escape' || e.key === '?') {
          e.preventDefault();
          this.toggleShortcutsModal(false);
          return;
        }
      }

      // Close settings drawer if open on Escape
      if (this.elements.settingsDrawer && this.elements.settingsDrawer.style.display === 'flex') {
        if (e.key === 'Escape' || e.key === 'o' || e.key === 'O') {
          e.preventDefault();
          this.toggleSettingsDrawer(false);
          return;
        }
      }

      if (e.key === 'Escape') {
        this.close();
      } else if (e.key === '?') {
        e.preventDefault();
        this.toggleShortcutsModal();
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        this.toggleSettingsDrawer();
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        this.toggleAutoScroll();
      } else if (e.key === 'f' || e.key === 'F') {
        this.toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        this.elements.modeToggle.click();
      } else if (e.key === 'r' || e.key === 'R') {
        this.toggleDirection();
      } else if (e.key === 'w' || e.key === 'W') {
        if (this.mode === 'webtoon') this.cycleWebtoonWidth();
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        this.adjustZoom(10);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        this.adjustZoom(-10);
      } else if (e.key === '0') {
        e.preventDefault();
        this.resetZoom();
      } else if (e.key === 'q' || e.key === 'Q') {
        this.elements.qualityToggle.click();
      } else if (e.key === 'h' || e.key === 'H') {
        this.toggleHud();
      } else if (e.key === '[') {
        this.navigateChapter(-1);
      } else if (e.key === ']') {
        this.navigateChapter(1);
      } else if (this.mode === 'single') {
        if (e.key === ' ') {
          e.preventDefault();
          this.nextPage();
        } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') {
          if (this.direction === 'rtl') {
            this.prevPage();
          } else {
            this.nextPage();
          }
        } else if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
          if (this.direction === 'rtl') {
            this.nextPage();
          } else {
            this.prevPage();
          }
        }
      }
    });

    // Smooth Ctrl + Mouse Wheel Zoom
    window.addEventListener('wheel', (e) => {
      if (!this.active) return;
      if (e.ctrlKey) {
        e.preventDefault();
        const delta = e.deltaY < 0 ? 10 : -10;
        this.adjustZoom(delta);
      }
    }, { passive: false });

    // Scroll Observer for Webtoon Mode
    this.elements.workspace.addEventListener('scroll', () => {
      if (this.mode !== 'webtoon' || !this.chapterData) return;
      this.detectActiveWebtoonPage();
    }, { passive: true });
  },

  updateControlsUI() {
    // Mode Label
    this.elements.modeLabel.textContent = this.mode === 'webtoon' ? 'Webtoon' : 'Single Page';

    // Quality Label
    this.elements.qualityToggle.innerHTML = this.quality === 'saver'
      ? '<i class="ri-flashlight-line"></i> <span class="hud-btn-text">Data Saver</span>'
      : '<i class="ri-hd-line"></i> <span class="hud-btn-text">Original HD</span>';

    // Direction Toggle (only relevant in single page mode)
    if (this.elements.directionToggle) {
      this.elements.directionToggle.style.display = this.mode === 'single' ? 'flex' : 'none';
      this.elements.directionLabel.textContent = this.direction === 'rtl' ? 'RTL (Manga)' : 'LTR (Komik)';
    }

    // Width Toggle (only relevant in webtoon mode)
    if (this.elements.widthToggle) {
      this.elements.widthToggle.style.display = this.mode === 'webtoon' ? 'flex' : 'none';
      const widthLabels = {
        compact: '750px',
        standard: '1050px',
        wide: '1380px',
        full: '100% Full'
      };
      this.elements.widthLabel.textContent = widthLabels[this.readerWidth] || '1050px';
    }

    // Zoom Controls sync
    if (this.elements.zoomControl) {
      this.elements.zoomControl.style.display = 'inline-flex';
    }
    if (this.elements.zoomVal) {
      this.elements.zoomVal.textContent = `${this.zoom}%`;
    }
    if (this.elements.drawerZoomVal) {
      this.elements.drawerZoomVal.textContent = `${this.zoom}%`;
    }
    if (this.elements.zoomSlider) {
      this.elements.zoomSlider.value = this.zoom;
    }

    // Fit Toggle (only relevant in single mode)
    if (this.elements.fitToggle) {
      this.elements.fitToggle.style.display = this.mode === 'single' ? 'flex' : 'none';
      const fitIcons = {
        contain: '<i class="ri-aspect-ratio-line"></i>',
        width: '<i class="ri-arrow-left-right-line"></i>',
        height: '<i class="ri-arrow-up-down-line"></i>'
      };
      this.elements.fitToggle.innerHTML = fitIcons[this.fitMode] || '<i class="ri-aspect-ratio-line"></i>';
    }

    // Apply classes to workspace containers
    if (this.elements.strip) {
      this.elements.strip.className = `reader-strip width-${this.readerWidth}`;
    }

    if (this.elements.singleView) {
      this.elements.singleView.className = `reader-single-view direction-${this.direction} fit-${this.fitMode}`;
    }
  },

  toggleDirection() {
    this.direction = this.direction === 'rtl' ? 'ltr' : 'rtl';
    State.settings.direction = this.direction;
    State.saveSettings();
    this.updateControlsUI();
    app.showToast(this.direction === 'rtl' ? 'Arah Baca: RTL (Manga Jepang)' : 'Arah Baca: LTR (Komik Barat)');
  },

  cycleWebtoonWidth() {
    const widths = ['compact', 'standard', 'wide', 'full'];
    const nextIdx = (widths.indexOf(this.readerWidth) + 1) % widths.length;
    this.readerWidth = widths[nextIdx];
    State.settings.readerWidth = this.readerWidth;
    State.saveSettings();
    this.updateControlsUI();
    const widthLabels = {
      compact: 'Compact (750px)',
      standard: 'Standard (1050px)',
      wide: 'Wide (1380px)',
      full: 'Full (100% Layar Penuh)'
    };
    app.showToast(`Lebar Webtoon: ${widthLabels[this.readerWidth]}`);
  },

  cycleFitMode() {
    const fits = ['contain', 'width', 'height'];
    const nextIdx = (fits.indexOf(this.fitMode) + 1) % fits.length;
    this.fitMode = fits[nextIdx];
    State.settings.fitMode = this.fitMode;
    State.saveSettings();
    this.updateControlsUI();
    app.showToast(`Fit Mode: ${this.fitMode.toUpperCase()}`);
  },

  // ---------------- Reader Pro: Zoom Engine ----------------
  setZoom(val, showToast = false) {
    val = Math.max(50, Math.min(220, val));
    this.zoom = val;
    State.settings.zoom = val;
    State.saveSettings();

    if (this.elements.workspace) {
      this.elements.workspace.style.setProperty('--reader-zoom', (val / 100).toFixed(2));
    }
    if (this.elements.zoomVal) {
      this.elements.zoomVal.textContent = `${val}%`;
    }
    if (this.elements.drawerZoomVal) {
      this.elements.drawerZoomVal.textContent = `${val}%`;
    }
    if (this.elements.zoomSlider) {
      this.elements.zoomSlider.value = val;
    }

    if (showToast && typeof app !== 'undefined' && app.showToast) {
      app.showToast(`Ukuran Zoom: ${val}%`);
    }
  },

  adjustZoom(delta) {
    this.setZoom(this.zoom + delta, true);
  },

  resetZoom() {
    this.setZoom(100, true);
  },

  // ---------------- Reader Pro: Background Theme ----------------
  applyReaderTheme(theme) {
    this.readerBg = theme || 'oled';
    State.settings.readerBg = this.readerBg;
    State.saveSettings();

    const overlay = this.elements.overlay;
    if (overlay) {
      overlay.classList.remove('reader-theme-oled', 'reader-theme-dark', 'reader-theme-midnight', 'reader-theme-sepia');
      overlay.classList.add(`reader-theme-${this.readerBg}`);
    }

    // Update active button state
    document.querySelectorAll('#reader-bg-picker .bg-theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.bg === this.readerBg);
    });
  },

  // ---------------- Reader Pro: Brightness Dimmer ----------------
  applyBrightness(val) {
    val = Math.max(30, Math.min(100, val));
    this.brightness = val;
    State.settings.brightness = val;
    State.saveSettings();

    if (this.elements.workspace) {
      this.elements.workspace.style.setProperty('--reader-brightness', val / 100);
    }
    if (this.elements.brightnessVal) {
      this.elements.brightnessVal.textContent = `${val}%`;
    }
    if (this.elements.brightnessSlider) {
      this.elements.brightnessSlider.value = val;
    }
  },

  // ---------------- Reader Pro: Settings Drawer ----------------
  toggleSettingsDrawer(force) {
    const drawer = this.elements.settingsDrawer;
    if (!drawer) return;
    const isShowing = force !== undefined ? force : drawer.style.display !== 'flex';
    drawer.style.display = isShowing ? 'flex' : 'none';

    if (isShowing) {
      // Sync controls in drawer
      if (this.elements.brightnessSlider) this.elements.brightnessSlider.value = this.brightness;
      if (this.elements.brightnessVal) this.elements.brightnessVal.textContent = `${this.brightness}%`;
      if (this.elements.zoomSlider) this.elements.zoomSlider.value = this.zoom;
      if (this.elements.drawerZoomVal) this.elements.drawerZoomVal.textContent = `${this.zoom}%`;
      if (this.elements.speedVal) this.elements.speedVal.textContent = `${this.autoScrollSpeed}x`;
      
      const speedGroup = document.getElementById('drawer-autoscroll-group');
      if (speedGroup) {
        speedGroup.style.display = this.mode === 'webtoon' ? 'flex' : 'none';
      }
    }
  },

  // ---------------- Reader Pro: Auto-Scroll Engine ----------------
  toggleAutoScroll() {
    if (this.mode !== 'webtoon') {
      app.showToast('Auto-Scroll khusus untuk mode Webtoon');
      return;
    }

    if (this.isAutoScrolling) {
      this.stopAutoScroll();
    } else {
      this.startAutoScroll();
    }
  },

  startAutoScroll() {
    if (this.mode !== 'webtoon') return;
    this.isAutoScrolling = true;
    this.autoScrollPaused = false;

    if (this.elements.autoscrollPill) {
      this.elements.autoscrollPill.style.display = 'flex';
      this.elements.autoscrollPill.classList.remove('paused');
    }
    if (this.elements.autoscrollPillText) {
      this.elements.autoscrollPillText.textContent = `Auto-Scroll ${this.autoScrollSpeed}x`;
    }
    if (this.elements.autoscrollPauseIcon) {
      this.elements.autoscrollPauseIcon.className = 'ri-pause-fill';
    }
    if (this.elements.autoscrollBtn) {
      this.elements.autoscrollBtn.classList.add('active');
    }

    app.showToast(`Auto-Scroll Aktif (${this.autoScrollSpeed}x) - Tekan 'S' untuk jeda`);
    this.autoScrollLoop();
  },

  stopAutoScroll() {
    this.isAutoScrolling = false;
    this.autoScrollPaused = false;
    if (this.autoScrollRafId) {
      cancelAnimationFrame(this.autoScrollRafId);
      this.autoScrollRafId = null;
    }

    if (this.elements.autoscrollPill) {
      this.elements.autoscrollPill.style.display = 'none';
    }
    if (this.elements.autoscrollBtn) {
      this.elements.autoscrollBtn.classList.remove('active');
    }
  },

  togglePauseAutoScroll() {
    if (!this.isAutoScrolling) {
      this.startAutoScroll();
      return;
    }

    this.autoScrollPaused = !this.autoScrollPaused;

    if (this.autoScrollPaused) {
      if (this.autoScrollRafId) {
        cancelAnimationFrame(this.autoScrollRafId);
        this.autoScrollRafId = null;
      }
      if (this.elements.autoscrollPill) {
        this.elements.autoscrollPill.classList.add('paused');
      }
      if (this.elements.autoscrollPauseIcon) {
        this.elements.autoscrollPauseIcon.className = 'ri-play-fill';
      }
      if (this.elements.autoscrollPillText) {
        this.elements.autoscrollPillText.textContent = `Dijeda (${this.autoScrollSpeed}x)`;
      }
    } else {
      if (this.elements.autoscrollPill) {
        this.elements.autoscrollPill.classList.remove('paused');
      }
      if (this.elements.autoscrollPauseIcon) {
        this.elements.autoscrollPauseIcon.className = 'ri-pause-fill';
      }
      if (this.elements.autoscrollPillText) {
        this.elements.autoscrollPillText.textContent = `Auto-Scroll ${this.autoScrollSpeed}x`;
      }
      this.autoScrollLoop();
    }
  },

  cycleAutoScrollSpeed() {
    const nextSpeed = (this.autoScrollSpeed % 5) + 1;
    this.setAutoScrollSpeed(nextSpeed);
  },

  setAutoScrollSpeed(speed) {
    this.autoScrollSpeed = Math.max(1, Math.min(5, speed));
    State.settings.autoScrollSpeed = this.autoScrollSpeed;
    State.saveSettings();

    if (this.elements.speedVal) {
      this.elements.speedVal.textContent = `${this.autoScrollSpeed}x`;
    }
    if (this.elements.autoscrollPillText && this.isAutoScrolling) {
      this.elements.autoscrollPillText.textContent = `Auto-Scroll ${this.autoScrollSpeed}x`;
    }

    document.querySelectorAll('#reader-speed-selector .speed-chip').forEach((chip) => {
      chip.classList.toggle('active', parseInt(chip.dataset.speed, 10) === this.autoScrollSpeed);
    });

    app.showToast(`Kecepatan Auto-Scroll: ${this.autoScrollSpeed}x`);
  },

  autoScrollLoop() {
    if (!this.isAutoScrolling || this.autoScrollPaused || !this.active || this.mode !== 'webtoon') return;

    const ws = this.elements.workspace;
    if (!ws) return;

    // Base speed in pixels per frame (speed 1: ~1.2px, speed 5: ~6px)
    const pxStep = this.autoScrollSpeed * 1.2;
    ws.scrollTop += pxStep;

    // Check if reached the end of the chapter
    if (ws.scrollTop + ws.clientHeight >= ws.scrollHeight - 5) {
      this.stopAutoScroll();
      app.showToast('Chapter selesai! Membuka chapter selanjutnya...');
      setTimeout(() => {
        this.navigateChapter(1);
      }, 800);
      return;
    }

    this.autoScrollRafId = requestAnimationFrame(() => this.autoScrollLoop());
  },

  toggleShortcutsModal(force) {
    const modal = this.elements.shortcutsModal;
    if (!modal) return;
    const isShowing = force !== undefined ? force : modal.style.display !== 'flex';
    modal.style.display = isShowing ? 'flex' : 'none';
  },

  onNavBtnClick(btnType) {
    // btnType is 'prev' (left button) or 'next' (right button)
    if (this.direction === 'rtl') {
      // In RTL, left button moves forward (next page), right button moves backward (prev page)
      if (btnType === 'prev') {
        this.nextPage();
      } else {
        this.prevPage();
      }
    } else {
      // In LTR, left button is prev, right button is next
      if (btnType === 'prev') {
        this.prevPage();
      } else {
        this.nextPage();
      }
    }
  },

  async open(manga, chapterId, allChapters = []) {
    this.active = true;
    this.manga = manga;
    this.currentChapterId = chapterId;
    this.allChapters = allChapters;
    this.currentPage = 1;
    this.preloadedSet.clear();

    if (manga && manga.id) {
      const targetHash = `#/reader/${manga.id}/${chapterId}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }
    }

    document.body.style.overflow = 'hidden';
    this.elements.overlay.style.display = 'flex';
    this.elements.mangaTitle.textContent = manga.title;

    this.populateChapterSelect();
    await this.loadChapter(chapterId);
  },

  populateChapterSelect() {
    const select = this.elements.chapterSelect;
    select.innerHTML = '';

    this.allChapters.forEach((ch) => {
      const opt = document.createElement('option');
      opt.value = ch.id;
      opt.textContent = `Ch. ${ch.chapter || '0'} ${ch.title ? '- ' + ch.title : ''} (${(ch.language || '').toUpperCase()})`;
      select.appendChild(opt);
    });

    select.value = this.currentChapterId;
  },

  async loadChapter(chapterId) {
    this.currentChapterId = chapterId;
    this.elements.chapterSelect.value = chapterId;

    if (this.manga && this.manga.id) {
      const targetHash = `#/reader/${this.manga.id}/${chapterId}`;
      if (window.location.hash !== targetHash) {
        window.location.hash = targetHash;
      }
    }

    // Show loader
    this.elements.loader.style.display = 'flex';
    this.elements.error.style.display = 'none';
    this.elements.strip.style.display = 'none';
    this.elements.singleView.style.display = 'none';
    this.preloadedSet.clear();

    try {
      const res = await Api.getChapterPages(chapterId);
      if (!res.success || !res.data || !res.data.pages || res.data.pages.length === 0) {
        throw new Error('Chapter tidak memiliki halaman gambar atau server MangaDex sedang limit.');
      }

      this.chapterData = res.data;
      this.totalPages = res.data.totalPages || res.data.pages.length;
      this.currentPage = 1;

      // Update Chapter Info Title
      this.elements.chapterTitle.textContent = `Chapter ${res.data.chapter || '0'}${res.data.title ? ': ' + res.data.title : ''}`;
      this.elements.totalPagesLabel.textContent = this.totalPages;
      this.elements.currentPageLabel.textContent = this.currentPage;
      this.elements.pageSlider.max = this.totalPages;
      this.elements.pageSlider.value = this.currentPage;

      // Save to History State
      State.saveHistory(this.manga, res.data, this.currentPage, this.totalPages);

      // Render View
      this.elements.loader.style.display = 'none';
      this.renderPages();

      // Trigger Smart Preload for upcoming pages
      this.preloadUpcomingPages(1, 4);
    } catch (err) {
      console.error('Failed to load chapter pages:', err);
      this.elements.loader.style.display = 'none';
      this.elements.error.style.display = 'flex';
      this.elements.errorMsg.textContent = err.message || 'Gagal memuat chapter dari server MangaDex.';
    }
  },

  renderPages() {
    if (!this.chapterData || !this.chapterData.pages) return;

    this.updateControlsUI();

    if (this.mode === 'webtoon') {
      this.elements.singleView.style.display = 'none';
      this.elements.strip.style.display = 'flex';
      this.renderWebtoonStrip();
    } else {
      this.elements.strip.style.display = 'none';
      this.elements.singleView.style.display = 'flex';
      this.renderSinglePage();
    }
  },

  // 1. Webtoon Strip Mode
  renderWebtoonStrip() {
    const strip = this.elements.strip;
    strip.innerHTML = '';

    this.chapterData.pages.forEach((page) => {
      const wrap = document.createElement('div');
      wrap.className = 'strip-page-wrap';
      wrap.dataset.page = page.page;

      const badge = document.createElement('div');
      badge.className = 'page-indicator-badge';
      badge.textContent = `${page.page} / ${this.totalPages}`;

      const img = document.createElement('img');
      img.className = 'strip-page-img';
      img.loading = 'lazy';
      img.alt = `Page ${page.page}`;

      Api.setupImageResilience(img, page);

      const initialSrc = this.quality === 'saver' ? page.dataSaverUrl : page.directUrl;
      img.src = initialSrc;

      wrap.appendChild(img);
      wrap.appendChild(badge);
      strip.appendChild(wrap);
    });

    this.elements.workspace.scrollTop = 0;
  },

  detectActiveWebtoonPage() {
    const wraps = this.elements.strip.querySelectorAll('.strip-page-wrap');
    const viewportMiddle = this.elements.workspace.scrollTop + 300;

    for (const wrap of wraps) {
      const top = wrap.offsetTop;
      const height = wrap.offsetHeight;
      if (viewportMiddle >= top && viewportMiddle <= top + height) {
        const pageNum = parseInt(wrap.dataset.page, 10);
        if (pageNum !== this.currentPage) {
          this.currentPage = pageNum;
          this.elements.currentPageLabel.textContent = pageNum;
          this.elements.pageSlider.value = pageNum;
          State.saveHistory(this.manga, this.chapterData, pageNum, this.totalPages);

          // Smart preload next chunk
          this.preloadUpcomingPages(pageNum, 4);
        }
        break;
      }
    }
  },

  // 2. Single Page Mode
  renderSinglePage() {
    const pageIndex = this.currentPage - 1;
    const page = this.chapterData.pages[pageIndex];
    if (!page) return;

    const img = this.elements.singleImg;
    img.style.opacity = '0';

    Api.setupImageResilience(img, page);

    const src = this.quality === 'saver' ? page.dataSaverUrl : page.directUrl;
    img.onload = () => {
      img.style.opacity = '1';
    };
    img.src = src;

    // In case image is preloaded and cached in memory
    if (img.complete && img.naturalWidth !== 0) {
      img.style.opacity = '1';
    }

    this.elements.currentPageLabel.textContent = this.currentPage;
    this.elements.pageSlider.value = this.currentPage;
    State.saveHistory(this.manga, this.chapterData, this.currentPage, this.totalPages);

    // Preload next 3 pages in advance for instant flips
    this.preloadUpcomingPages(this.currentPage, 3);
  },

  // Smart Preload Engine
  preloadUpcomingPages(fromPage, count = 3) {
    if (!this.chapterData || !this.chapterData.pages) return;

    const pill = this.elements.preloadPill;
    const pillText = this.elements.preloadStatusText;
    let preloadingAny = false;

    for (let i = fromPage; i < fromPage + count && i < this.totalPages; i++) {
      const targetPageData = this.chapterData.pages[i]; // next page index is i (1-based is i+1)
      if (targetPageData && !this.preloadedSet.has(targetPageData.page)) {
        this.preloadedSet.add(targetPageData.page);
        preloadingAny = true;

        const preImg = new Image();
        const src = this.quality === 'saver' ? targetPageData.dataSaverUrl : targetPageData.directUrl;
        preImg.src = src;
        Api.setupImageResilience(preImg, targetPageData);
      }
    }

    if (preloadingAny && pill && pillText) {
      pill.classList.remove('hidden', 'ready');
      pillText.textContent = `Preloading Hal. ${fromPage + 1} - ${Math.min(fromPage + count, this.totalPages)}...`;

      clearTimeout(this.preloadHideTimeout);
      this.preloadHideTimeout = setTimeout(() => {
        pill.classList.add('ready');
        pillText.textContent = 'Halaman siap dibaca!';
        setTimeout(() => {
          pill.classList.add('hidden');
        }, 1200);
      }, 900);
    }
  },

  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.renderSinglePage();
    } else {
      app.showToast('Chapter selesai! Membuka chapter selanjutnya...');
      this.navigateChapter(1);
    }
  },

  prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.renderSinglePage();
    } else {
      this.navigateChapter(-1);
    }
  },

  goToPage(pageNum) {
    if (pageNum < 1 || pageNum > this.totalPages) return;
    this.currentPage = pageNum;

    if (this.mode === 'single') {
      this.renderSinglePage();
    } else {
      const targetWrap = this.elements.strip.querySelector(`[data-page="${pageNum}"]`);
      if (targetWrap) {
        targetWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  },

  navigateChapter(direction) {
    const currentIndex = this.allChapters.findIndex((c) => c.id === this.currentChapterId);
    if (currentIndex === -1) return;

    const targetIndex = currentIndex - direction;
    if (targetIndex >= 0 && targetIndex < this.allChapters.length) {
      const targetChapter = this.allChapters[targetIndex];
      this.loadChapter(targetChapter.id);
    } else {
      app.showToast(direction > 0 ? 'Sudah di chapter terbaru!' : 'Sudah di chapter terawal!');
    }
  },

  toggleHud() {
    this.hudVisible = !this.hudVisible;
    if (this.hudVisible) {
      this.elements.topHud.classList.remove('hidden');
      this.elements.bottomHud.classList.remove('hidden');
    } else {
      this.elements.topHud.classList.add('hidden');
      this.elements.bottomHud.classList.add('hidden');
    }
  },

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.elements.overlay.requestFullscreen().catch(() => {});
      this.elements.fullscreenBtn.innerHTML = '<i class="ri-fullscreen-exit-line"></i>';
    } else {
      document.exitFullscreen().catch(() => {});
      this.elements.fullscreenBtn.innerHTML = '<i class="ri-fullscreen-line"></i>';
    }
  },

  close(updateHash = true) {
    this.active = false;
    this.stopAutoScroll();
    this.toggleSettingsDrawer(false);

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
    this.elements.overlay.style.display = 'none';
    if (this.elements.shortcutsModal) {
      this.elements.shortcutsModal.style.display = 'none';
    }
    document.body.style.overflow = '';
    app.renderContinueReading();

    if (updateHash && window.location.hash.startsWith('#/reader')) {
      if (this.manga && this.manga.id) {
        window.location.hash = `#/manga/${this.manga.id}`;
      } else {
        window.location.hash = '#/';
      }
    }
  }
};
