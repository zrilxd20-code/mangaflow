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
    console.log('--- [1/6] UJI LANJUTAN PERTAHANAN SSRF & PROXY ---');

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
    console.log('\n--- [2/6] UJI PERTAHANAN INJEKSI (XSS, SQLi, PATH TRAVERSAL) ---');

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
    console.log('\n--- [3/6] UJI SIKLUS HIDUP AUTENTIKASI & PRIVASI DATA ---');

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

    // 3.7 Logout Session Revocation
    const rLogout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` }
    });
    assertTest('Logout Berhasil & Penghapusan Sesi Server', rLogout.status === 200);

    // ----------------------------------------------------
    // 4. MANGADEX (SERVER 1) API QA
    // ----------------------------------------------------
    console.log('\n--- [4/6] UJI KUALITAS & INTEGRITAS SERVER 1 (MANGADEX) ---');

    // 4.1 Trending
    const rTrending = await fetch(`${baseUrl}/api/trending`);
    const trendingData = await rTrending.json();
    assertTest('Endpoint /api/trending Mengembalikan Manga Populer', rTrending.status === 200 && Array.isArray(trendingData.data) && trendingData.data.length > 0);

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

    // ----------------------------------------------------
    // 5. MANGAPILL (SERVER 2) API QA (KOMPLIT & ANTI-404)
    // ----------------------------------------------------
    console.log('\n--- [5/6] UJI KUALITAS & INTEGRITAS SERVER 2 (MANGAPILL) ---');

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
    console.log('\n--- [6/6] UJI INTEGRITAS FRONTEND, HEADERS & STATIC ASSETS ---');

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
