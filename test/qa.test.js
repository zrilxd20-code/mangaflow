// ===================================================
// MangaFlow Comprehensive QA & Penetration Test Suite
// ===================================================

const http = require('http');
const app = require('../server');
const db = require('../database');
const mangapill = require('../providers/mangapill');

async function runComprehensiveQA() {
  console.log('\n====================================================');
  console.log('🛡️  MEMULAI PENGUJIAN KEAMANAN & QA LENGKAP (MANGAFLOW)');
  console.log('====================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passed = 0;
  let total = 0;

  function assertTest(name, condition, detail = '') {
    total++;
    if (condition) {
      passed++;
      console.log(`  🟢 [PASS] ${name}${detail ? ' - ' + detail : ''}`);
    } else {
      console.error(`  🔴 [FAIL] ${name}${detail ? ' - ' + detail : ''}`);
    }
  }

  try {
    // ----------------------------------------------------
    // 1. SSRF ADVANCED EVASION & PROXY HARDENING
    // ----------------------------------------------------
    console.log('--- [1/9] UJI LANJUTAN PERTAHANAN SSRF & PROXY ---');

    // 1.1 Hex IP bypass attempt
    const rHex = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://0x7f000001/admin')}`);
    assertTest('Blokir Obfuscated Hex IP (0x7f000001)', rHex.status === 403, `Status: ${rHex.status}`);

    // 1.2 Dword/Decimal IP bypass attempt (2130706433 = 127.0.0.1)
    const rDec = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://2130706433/admin')}`);
    assertTest('Blokir Obfuscated Decimal IP (2130706433)', rDec.status === 403, `Status: ${rDec.status}`);

    // 1.3 IPv6 Loopback
    const rIpv6 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://[::1]:8080/admin')}`);
    assertTest('Blokir IPv6 Loopback ([::1])', rIpv6.status === 403, `Status: ${rIpv6.status}`);

    // 1.4 Userinfo Spoofing trick (http://uploads.mangadex.org@evil.com)
    const rUserinfo = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://uploads.mangadex.org@127.0.0.1/evil')}`);
    assertTest('Blokir Userinfo Hostname Spoofing', rUserinfo.status === 403, `Status: ${rUserinfo.status}`);

    // 1.5 Suffix spoofing (http://uploads.mangadex.org.attacker.com)
    const rSuffix = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://uploads.mangadex.org.attacker.com/evil.jpg')}`);
    assertTest('Blokir Suffix Domain Spoofing', rSuffix.status === 403, `Status: ${rSuffix.status}`);

    // ----------------------------------------------------
    // 2. INPUT SANITIZATION & INJECTION ATTACK DEFENSE
    // ----------------------------------------------------
    console.log('\n--- [2/9] UJI PERTAHANAN INJEKSI (XSS, SQLi, PATH TRAVERSAL) ---');

    // 2.1 XSS Payload in Search Query
    const xssPayload = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
    const rXss = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent(xssPayload)}`);
    const xssData = await rXss.json();
    assertTest('Penanganan Aman XSS Payload pada Pencarian', rXss.status === 200 && Array.isArray(xssData.data));

    // 2.2 SQLi string in manga id
    const sqliPayload = "1' OR '1'='1' --";
    const rSqli = await fetch(`${baseUrl}/api/manga/${encodeURIComponent(sqliPayload)}`);
    assertTest('Penanganan Aman SQLi pada Parameter ID', rSqli.status >= 400 && rSqli.status < 600);

    // 2.3 Path Traversal attempt on manga detail
    const rTraversal = await fetch(`${baseUrl}/api/manga/..%2f..%2fpackage.json`);
    assertTest('Blokir Path Traversal pada Rute Manga', rTraversal.status === 404 || rTraversal.status === 400 || rTraversal.status === 500);

    // 2.4 Malformed JSON in POST body
    const rBadJson = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"bad json syntax: true'
    });
    assertTest('Penolakan Aman Malformed JSON (HTTP 400)', rBadJson.status === 400);

    // 2.5 Payload > 500KB (Body Size Limit Protection)
    const giantString = 'A'.repeat(600 * 1024); // 600KB > 500KB limit
    const rGiant = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'giant', email: 'g@test.com', password: giantString })
    });
    assertTest('Batas Ukuran Request Payload (HTTP 413)', rGiant.status === 413);

    // ----------------------------------------------------
    // 3. AUTHENTICATION & DATA PRIVACY LIFECYCLE
    // ----------------------------------------------------
    console.log('\n--- [3/9] UJI SIKLUS HIDUP AUTENTIKASI & PRIVASI DATA ---');

    const testUser = `qa_user_${Date.now()}`;
    const testEmail = `${testUser}@example.com`;
    const testPassword = 'StrongPassword123!';

    // 3.1 Register User
    const rReg = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUser, email: testEmail, password: testPassword })
    });
    const regData = await rReg.json();
    assertTest('Registrasi Akun Baru Berhasil (HTTP 201)', rReg.status === 201 && regData.token);

    const authToken = regData.token;

    // 3.2 Duplicate User Registration Rejection
    const rDup = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUser, email: testEmail, password: testPassword })
    });
    assertTest('Tolak Duplikasi Username / Email (HTTP 400)', rDup.status === 400);

    // 3.3 Valid Login
    const rLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: testUser, password: testPassword })
    });
    const loginData = await rLogin.json();
    assertTest('Login Berhasil & Terbitkan JWT Valid (HTTP 200)', rLogin.status === 200 && loginData.token);

    // 3.4 Protected Profile Endpoint (/api/auth/me)
    const rMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const meData = await rMe.json();
    assertTest('Verifikasi Profil Pengguna Terautentikasi', rMe.status === 200 && meData.user?.username === testUser);

    // 3.5 Cloud Sync Bookmarks & History
    const sampleBookmarks = [{ id: 'test-manga-1', title: 'Test Manga', coverUrl: 'https://test.com/img.jpg' }];
    const sampleHistory = [{ mangaId: 'test-manga-1', chapterId: 'ch-1', page: 5, totalPages: 20 }];

    const rSync = await fetch(`${baseUrl}/api/auth/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ bookmarks: sampleBookmarks, history: sampleHistory })
    });
    assertTest('Sinkronisasi Cloud Data Bookmark & Riwayat Berhasil', rSync.status === 200);

    // 3.6 Verify Synced Data on Profile
    const rMeSynced = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const meSyncedData = await rMeSynced.json();
    assertTest('Integritas Persistensi Data Sinkronisasi Cloud', meSyncedData.data?.bookmarks?.length === 1 && meSyncedData.data?.history?.length === 1);

    // 3.6b Verify Accurate Deletion Sync (Unbookmark & Clear History)
    const rSyncDelete = await fetch(`${baseUrl}/api/auth/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        bookmarks: [],
        history: [],
        removedBookmarkIds: ['test-manga-1'],
        replaceHistory: true,
        settings: { readerMode: 'single', readerBg: 'sepia' }
      })
    });
    const syncDelData = await rSyncDelete.json();
    assertTest(
      'Sinkronisasi Hapus Bookmark, Hapus Riwayat & Simpan Settings Akurat',
      rSyncDelete.status === 200 &&
        syncDelData.data?.bookmarks?.length === 0 &&
        syncDelData.data?.history?.length === 0 &&
        syncDelData.data?.settings?.readerBg === 'sepia'
    );

    // 3.6c Community Social Lifecycle (Like, Rating, Comment & XSS Strip)
    const rLike = await fetch(`${baseUrl}/api/manga/test-manga-1/like`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const likeData = await rLike.json();
    assertTest('Fitur Suka (Like) Manga Berhasil', rLike.status === 200 && likeData.data?.liked === true && likeData.data?.likesCount === 1);

    const rRate = await fetch(`${baseUrl}/api/manga/test-manga-1/rate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ score: 5 })
    });
    const rateData = await rRate.json();
    assertTest('Fitur Rating Bintang (1-5) Manga Berhasil', rRate.status === 200 && rateData.data?.userRating === 5 && rateData.data?.ratingAvg === 5);

    const rComment = await fetch(`${baseUrl}/api/manga/test-manga-1/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ text: '<script>alert(1)</script>Komik ini sangat seru!' })
    });
    const commentData = await rComment.json();
    const createdComment = commentData.data?.comment;
    assertTest(
      'Fitur Komentar Manga & Sanitasi Anti-XSS Berhasil',
      rComment.status === 201 && createdComment && !createdComment.text.includes('<script>') && createdComment.text.includes('Komik ini sangat seru!')
    );

    const rDelComment = await fetch(`${baseUrl}/api/manga/test-manga-1/comments/${createdComment.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const delCommentData = await rDelComment.json();
    assertTest('Penghapusan Komentar Milik Sendiri Berhasil', rDelComment.status === 200 && delCommentData.data?.comments?.length === 0);

    // 3.6d Database Storage Info Endpoint
    const rStorageInfo = await fetch(`${baseUrl}/api/auth/storage-info`);
    const storageInfo = await rStorageInfo.json();
    assertTest('Endpoint Status Database (/api/auth/storage-info) Aktif', rStorageInfo.status === 200 && Boolean(storageInfo.storageMode));

    // 3.7 Logout Session Revocation
    const rLogout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assertTest('Logout Berhasil & Penghapusan Sesi Server', rLogout.status === 200);

    // ----------------------------------------------------
    // 4. MANGADEX (SERVER 1) API QA
    // ----------------------------------------------------
    console.log('\n--- [4/9] UJI KUALITAS & INTEGRITAS SERVER 1 (MANGADEX) ---');

    // 4.1 Trending
    const rTrending = await fetch(`${baseUrl}/api/trending`);
    const trendingData = await rTrending.json();
    assertTest('Endpoint /api/trending Mengembalikan Manga Populer', rTrending.status === 200 && Array.isArray(trendingData.data) && trendingData.data.length > 0);
    assertTest(
      'Header Edge CDN Cache-Control (s-maxage) Aktif di /api/trending',
      (rTrending.headers.get('cache-control') || '').includes('s-maxage=')
    );

    // 4.2 Latest
    const rLatest = await fetch(`${baseUrl}/api/latest?page=1`);
    const latestData = await rLatest.json();
    assertTest('Endpoint /api/latest Mengembalikan Update Terbaru', rLatest.status === 200 && Array.isArray(latestData.data) && latestData.data.length > 0);

    // 4.3 Tags / Genres
    const rTags = await fetch(`${baseUrl}/api/tags`);
    const tagsData = await rTags.json();
    assertTest('Endpoint /api/tags Mengembalikan Daftar Genre', rTags.status === 200 && Array.isArray(tagsData.data) && tagsData.data.length > 10);

    // 4.4 Search
    const rSearch = await fetch(`${baseUrl}/api/search?q=naruto`);
    const searchResult = await rSearch.json();
    assertTest('Endpoint /api/search Berfungsi Normal', rSearch.status === 200 && Array.isArray(searchResult.data));

    // 4.5 MangaDex Cover Proxy Streaming (Anti-403 Regression Test)
    const sampleCoverPath = trendingData.data?.[0]?.coverUrlSmall || trendingData.data?.[0]?.coverUrl;
    const rDexCover = await fetch(`${baseUrl}${sampleCoverPath}`);
    assertTest(
      'Proxy Cover MangaDex Mengalirkan Gambar (HTTP 200)',
      Boolean(sampleCoverPath) && rDexCover.status === 200 && (rDexCover.headers.get('content-type') || '').includes('image'),
      `Status: ${rDexCover.status}, Type: ${rDexCover.headers.get('content-type')}`
    );

    // 4.6 Safe Non-Numeric Pagination Guard (/api/latest & /api/search)
    const rBadPageLatest = await fetch(`${baseUrl}/api/latest?page=abc`);
    const rBadPageSearch = await fetch(`${baseUrl}/api/search?q=naruto&page=abc`);
    assertTest(
      'Guard Pagination Non-Angka (?page=abc) Tetap Aman (HTTP 200)',
      rBadPageLatest.status === 200 && rBadPageSearch.status === 200
    );

    // ----------------------------------------------------
    // 5. MANGAPILL (SERVER 2) API QA (KOMPLIT & ANTI-404)
    // ----------------------------------------------------
    console.log('\n--- [5/9] UJI KUALITAS & INTEGRITAS SERVER 2 (MANGAPILL) ---');

    // 5.1 Search
    const rPillSearch = await fetch(`${baseUrl}/api/mangapill/search?q=naruto`);
    const pillSearchData = await rPillSearch.json();
    assertTest('Pencarian MangaPill Mengembalikan Data Terstruktur', rPillSearch.status === 200 && Array.isArray(pillSearchData.data) && pillSearchData.data.length > 0);

    // 5.2 Manga Detail without Slug (Clean ID Resolution)
    const samplePillManga = pillSearchData.data[0];
    const cleanPillId = String(samplePillManga.id).replace(/^pill-/, '');
    const rPillDetail = await fetch(`${baseUrl}/api/mangapill/manga/${cleanPillId}`);
    const pillDetailData = await rPillDetail.json();
    assertTest(`Resolusi Detail Manga Tanpa Slug (ID: ${cleanPillId}, Bebas 404)`, rPillDetail.status === 200 && pillDetailData.data?.chapters?.length > 0);

    // 5.3 Chapter Pages without Slug (Clean Chapter ID Resolution)
    const sampleChapter = pillDetailData.data?.chapters[0];
    const cleanChapterId = String(sampleChapter.id).replace(/^pill-/, '');
    const rPillChapter = await fetch(`${baseUrl}/api/mangapill/chapter/${cleanChapterId}`);
    const pillChapterData = await rPillChapter.json();
    assertTest(`Resolusi Halaman Gambar Chapter Tanpa Slug (ID: ${cleanChapterId})`, rPillChapter.status === 200 && pillChapterData.data?.pages?.length > 0);

    // 5.4 Image Proxy on MangaPill CDN
    const samplePageProxy = pillChapterData.data?.pages[0]?.proxyUrl;
    const rProxyStream = await fetch(`${baseUrl}${samplePageProxy}`);
    assertTest('Proxy Gambar Streaming dengan Bypass Referer 403', rProxyStream.status === 200 && (rProxyStream.headers.get('content-type') || '').includes('image'));

    // ----------------------------------------------------
    // 6. FRONTEND STATIC ASSETS & SYSTEM INTEGRITY QA
    // ----------------------------------------------------
    console.log('\n--- [6/9] UJI INTEGRITAS FRONTEND, HEADERS & STATIC ASSETS ---');

    // 6.1 Homepage HTTP 200
    const rHome = await fetch(`${baseUrl}/`);
    assertTest('Homepage Terlayani dengan Status HTTP 200', rHome.status === 200);

    // 6.2 Security headers on static assets
    assertTest('Static Asset Dilindungi X-Content-Type-Options', rHome.headers.get('x-content-type-options') === 'nosniff');
    assertTest('Static Asset Dilindungi Anti-Clickjacking X-Frame-Options', rHome.headers.get('x-frame-options') === 'SAMEORIGIN');

    // 6.3 Core CSS availability
    const rCss = await fetch(`${baseUrl}/css/style.css`);
    assertTest('Stylesheet Utama /css/style.css Tersedia (HTTP 200)', rCss.status === 200);

    // 6.4 Core JS availability
    const rJs = await fetch(`${baseUrl}/js/app.js`);
    assertTest('Script Utama /js/app.js Tersedia (HTTP 200)', rJs.status === 200);

    // 6.5 PWA Manifest & Service Worker availability
    const rManifest = await fetch(`${baseUrl}/manifest.json`);
    assertTest('PWA Manifest /manifest.json Tersedia (HTTP 200)', rManifest.status === 200);

    const rSw = await fetch(`${baseUrl}/sw.js`);
    assertTest('PWA Service Worker /sw.js Tersedia (HTTP 200)', rSw.status === 200);

    // ----------------------------------------------------
    // 7. SEO, SITEMAP & VIRAL SHAREABILITY QA
    // ----------------------------------------------------
    console.log('\n--- [7/9] UJI TEKNIKAL SEO, SITEMAP & DYNAMIC OPENGRAPH PREVIEWS ---');

    // 7.1 Robots.txt endpoint & directives
    const rRobots = await fetch(`${baseUrl}/robots.txt`);
    const robotsText = await rRobots.text();
    assertTest(
      'Endpoint /robots.txt Mengembalikan HTTP 200 & Directive Sitemap',
      rRobots.status === 200 &&
      (rRobots.headers.get('content-type') || '').includes('text/plain') &&
      robotsText.includes('User-agent: *') &&
      robotsText.includes('Allow: /') &&
      robotsText.includes('Disallow: /api/auth/') &&
      robotsText.includes('Sitemap:')
    );

    // 7.2 Sitemap.xml endpoint & XML urlset
    const rSitemap = await fetch(`${baseUrl}/sitemap.xml`);
    const sitemapXml = await rSitemap.text();
    assertTest(
      'Endpoint /sitemap.xml Mengembalikan HTTP 200 & Valid XML URLSet',
      rSitemap.status === 200 &&
      (rSitemap.headers.get('content-type') || '').includes('xml') &&
      sitemapXml.includes('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">') &&
      sitemapXml.includes('<loc>') &&
      sitemapXml.includes('/?manga=')
    );

    // 7.3 Dynamic OpenGraph & Meta Tag Injection (?manga=pill-2)
    const rOg = await fetch(`${baseUrl}/?manga=pill-2`);
    const ogHtml = await rOg.text();
    assertTest(
      'Dynamic OpenGraph & Title Tag Terinjeksi untuk ?manga=pill-2',
      rOg.status === 200 &&
      ogHtml.includes('<title>Baca One Piece') &&
      ogHtml.includes('property="og:title"') &&
      ogHtml.includes('property="og:description"') &&
      ogHtml.includes('property="og:image"') &&
      ogHtml.includes('property="og:url"') &&
      ogHtml.includes('property="og:type" content="article"') &&
      ogHtml.includes('name="twitter:card" content="summary_large_image"') &&
      ogHtml.includes('rel="canonical"')
    );

    // 7.4 Graceful fallback untuk ID manga tidak valid
    const rFallback = await fetch(`${baseUrl}/?manga=nonexistent-id-99999`);
    const fallbackHtml = await rFallback.text();
    assertTest(
      'Fallback Aman untuk ID Manga Tidak Valid (HTTP 200 Default Index)',
      rFallback.status === 200 &&
      fallbackHtml.includes('<title>MangaFlow - Baca Manga Online Modern & Minimalis</title>') &&
      fallbackHtml.includes('property="og:type" content="website"')
    );

    // ----------------------------------------------------
    // 8. 1-CLICK PWA APP INSTALLATION QA
    // ----------------------------------------------------
    console.log('\n--- [8/9] UJI 1-CLICK PWA APP INSTALLATION & IOS GUIDE ---');

    // 8.1 PWA Manifest Metadata Completeness
    const rManifestCheck = await fetch(`${baseUrl}/manifest.json`);
    const manifestJson = await rManifestCheck.json();
    assertTest(
      'PWA Manifest Valid & Lengkap (name, short_name, start_url, display="standalone", icons)',
      manifestJson.name &&
      manifestJson.short_name &&
      manifestJson.start_url === '/' &&
      manifestJson.display === 'standalone' &&
      Array.isArray(manifestJson.icons) &&
      manifestJson.icons.length > 0 &&
      manifestJson.icons.some((i) => i.src === '/favicon.svg')
    );

    // 8.2 Apple Touch Icon & PWA Meta in index.html
    const rIndex = await fetch(`${baseUrl}/`);
    const indexHtml = await rIndex.text();
    assertTest(
      'Index.html Memiliki link apple-touch-icon & BeforeInstallPrompt Handler',
      indexHtml.includes('<link rel="apple-touch-icon"') &&
      indexHtml.includes("window.addEventListener('beforeinstallprompt'") &&
      indexHtml.includes('window.deferredInstallPrompt')
    );

    // 8.3 PWA Install UI Elements in index.html
    assertTest(
      'Index.html Memiliki Elemen UI PWA (#btn-install-app, #user-menu-install-item, #pwa-install-banner, #ios-install-modal)',
      indexHtml.includes('id="btn-install-app"') &&
      indexHtml.includes('id="user-menu-install-item"') &&
      indexHtml.includes('id="pwa-install-banner"') &&
      indexHtml.includes('id="ios-install-modal"') &&
      indexHtml.includes('ios-install-steps')
    );

    // 8.4 Client App Controller PWA Installation Logic
    const rAppJs = await fetch(`${baseUrl}/js/app.js`);
    const appJsContent = await rAppJs.text();
    assertTest(
      'App.js Memiliki Implementasi Asli promptInstallApp, dismissInstallBanner & toggleIosInstallModal',
      appJsContent.includes('initPWA()') &&
      appJsContent.includes('handleInstallPromptReady(') &&
      appJsContent.includes('updatePWAUI()') &&
      appJsContent.includes('promptInstallApp()') &&
      appJsContent.includes('dismissInstallBanner()') &&
      appJsContent.includes('toggleIosInstallModal(') &&
      appJsContent.includes('mangaflow_pwa_banner_dismissed')
    );

    // ----------------------------------------------------
    // 9. MOBILE SMARTPHONE UI/UX OVERHAUL QA (<= 768px & <= 480px)
    // ----------------------------------------------------
    console.log('\n--- [9/9] UJI OVERHAUL TAMPILAN MOBILE HP & UX RESPONSIVE ---');

    // 9.1 Fetch CSS for responsive validation
    const rStyleCss = await fetch(`${baseUrl}/css/style.css`);
    const styleCss = await rStyleCss.text();

    // 9.2 Mobile Hero Carousel Poster & Flex Layout
    assertTest(
      'Style.css Menampilkan Poster Kompak Hero (.hero-poster) & Flex Row pada Mobile (max-width: 768px)',
      styleCss.includes('.hero-poster') &&
      styleCss.includes('display: block !important') &&
      styleCss.includes('width: 75px') &&
      styleCss.includes('height: 110px') &&
      styleCss.includes('.hero-content') &&
      styleCss.includes('flex-direction: row') &&
      styleCss.includes('-webkit-line-clamp: 2')
    );

    // 9.3 Manga Detail Action Buttons CSS Grid
    assertTest(
      'Style.css Menggunakan 2-Kolom CSS Grid pada .detail-actions-row dengan #detail-read-first-btn Full Width',
      styleCss.includes('.detail-actions-row') &&
      styleCss.includes('grid-template-columns: repeat(2, minmax(0, 1fr))') &&
      styleCss.includes('#detail-read-first-btn') &&
      styleCss.includes('grid-column: 1 / -1') &&
      styleCss.includes('text-overflow: ellipsis')
    );

    // 9.4 Mobile Bottom Navigation Dock Favorites Badge Styling
    assertTest(
      'Style.css Mendukung Badge Favorit Mobile (.mob-badge-count) dengan Posisi Absolute & Pill Styling',
      styleCss.includes('.mobile-nav-item') &&
      styleCss.includes('position: relative') &&
      styleCss.includes('.mob-badge-count') &&
      styleCss.includes('position: absolute') &&
      styleCss.includes('border-radius: 99px') &&
      styleCss.includes('display: inline-flex')
    );

    // 9.5 Dedicated Mobile Breakpoint (<= 480px) & Horizontal Overflow Protection
    assertTest(
      'Style.css Memiliki Dedicated Breakpoint (max-width: 480px) & Proteksi Overflow Horizontal',
      styleCss.includes('@media (max-width: 480px)') &&
      styleCss.includes('overflow-x: hidden') &&
      styleCss.includes('.chapter-row-left') &&
      styleCss.includes('min-width: 0') &&
      styleCss.includes('.chapter-row-title') &&
      styleCss.includes('text-overflow: ellipsis')
    );

    // 9.6 Client App Controller Updates mob-fav-count in updateBadgeCounts()
    assertTest(
      'App.js updateBadgeCounts() Memperbarui Desktop (#nav-fav-count) dan Mobile Dock (#mob-fav-count)',
      appJsContent.includes('updateBadgeCounts()') &&
      appJsContent.includes('nav-fav-count') &&
      appJsContent.includes('mob-fav-count') &&
      appJsContent.includes('State.getBookmarks().length') &&
      appJsContent.includes("'inline-flex'")
    );

    // 9.7 Upgrade Features: Chapter Quick Search, Search Pagination & Reader Auto-Resume
    const rReaderJs = await fetch(`${baseUrl}/js/reader.js`);
    const readerJsContent = await rReaderJs.text();
    assertTest(
      'Fitur Peningkatan UX Aktif (chapter-search-input, search-pagination, Auto-Resume Reader)',
      appJsContent.includes('chapter-search-input') &&
      appJsContent.includes('search-pagination') &&
      readerJsContent.includes('Melanjutkan dari Halaman')
    );

    // 9.8 UI/CSS Bug Fixes: Modal Z-Index, Reader Linear Brightness & Mobile Preload Pill
    const rReaderCss = await fetch(`${baseUrl}/css/reader.css`);
    const readerCss = await rReaderCss.text();
    assertTest(
      'Perbaikan UI/CSS Aktif (.modal-backdrop z-index: 1200, .reader-preload-pill bottom: auto, Single Brightness Filter)',
      /\.modal-backdrop\s*\{[^}]*z-index\s*:\s*1200/s.test(styleCss) &&
      /\.reader-preload-pill\s*\{[^}]*bottom\s*:\s*auto/s.test(readerCss) &&
      !/\.reader-workspace\s*\{[^}]*filter\s*:\s*brightness/is.test(readerCss)
    );

    // 9.9 Premium Visual Overhaul, Bespoke SVG Logo & Comfortable Loading Screen QA
    const rFavicon = await fetch(`${baseUrl}/favicon.svg`);
    const faviconSvg = await rFavicon.text();
    assertTest(
      'Logo SVG Kustom, Splash Loading Screen, Semantic Spinner & Kontrol Hero Aktif',
      rFavicon.status === 200 &&
      faviconSvg.includes('mfLeftWing') &&
      indexHtml.includes('id="app-splash-screen"') &&
      indexHtml.includes('id="top-loading-bar"') &&
      indexHtml.includes('class="loading-spinner"') &&
      indexHtml.includes('class="brand-logo-svg"') &&
      indexHtml.includes('class="site-footer"') &&
      appJsContent.includes('hideSplashScreen()') &&
      appJsContent.includes('toggleHeroPause()') &&
      appJsContent.includes('fetchpriority="high"') &&
      styleCss.includes('scrollbar-color') &&
      styleCss.includes('progress.loading-spinner:indeterminate')
    );

    // 9.10 Deep Bugfix Regression Suite (RTL Single-Page, XSS Toast, Apostrophe Titles, Reader Race Guard, Edge Headers)
    assertTest(
      'Perbaikan Bug Mendalam Aktif (RTL Reader, Anti-XSS Toast, Title Apostrof, Race Guard & Edge Cache Proxy)',
      (rHome.headers.get('permissions-policy') || '').includes('camera=()') &&
      (rHome.headers.get('cross-origin-opener-policy') || '') === 'same-origin-allow-popups' &&
      (rDexCover.headers.get('cache-control') || '').includes('s-maxage=86400') &&
      !readerCss.includes('.reader-single-view.direction-rtl .single-nav-btn.prev') &&
      readerJsContent.includes('loadRequestId') &&
      readerJsContent.includes('if (e.ctrlKey || e.metaKey || e.altKey) return') &&
      appJsContent.includes('detail-complete-source-btn') &&
      appJsContent.includes('textSpan.textContent = String(message') &&
      appJsContent.includes('syncLangPrefUI()')
    );

  } catch (err) {
    console.error('  🔴 [ERROR] Terjadi kegagalan tak terduga selama QA:', err);
  } finally {
    try {
      const u = db.data.users.find((user) => user.username.startsWith('qa_user_'));
      if (u) db.deleteUser(u.id);
    } catch (_) {}
    server.close();
  }

  console.log('\n====================================================');
  console.log(`📊 HASIL PENGUJIAN QA & KEAMANAN LENGKAP: ${passed} DARI ${total} TEST LULUS (${Math.round((passed / total) * 100)}%)`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runComprehensiveQA();
