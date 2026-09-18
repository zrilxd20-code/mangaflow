// ===================================================
// MangaFlow Automated Security & Hardening Test Suite
// ===================================================

const http = require('http');
const assert = require('assert');
const app = require('../server');
const db = require('../database');

async function runSecurityAudit() {
  console.log('====================================================');
  console.log('🛡️  MEMULAI PENGUJIAN KEAMANAN SISTEM MANGAFLOW');
  console.log('====================================================\n');

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  let passedTests = 0;
  let totalTests = 0;

  function report(name, passed, detail = '') {
    totalTests++;
    if (passed) {
      passedTests++;
      console.log(`  🟢 [PASS] ${name}${detail ? ' - ' + detail : ''}`);
    } else {
      console.error(`  🔴 [FAIL] ${name}${detail ? ' - ' + detail : ''}`);
    }
  }

  try {
    // ----------------------------------------------------
    // KATEGORI 1: SSRF (Server-Side Request Forgery) PROXY DEFENSE
    // ----------------------------------------------------
    console.log('--- [1/5] UJI PERTAHANAN SSRF & PROXY IMAGE ---');

    // 1.1 Localhost IP
    const r1 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://127.0.0.1:8080/admin')}`);
    report('Blokir Loopback IPv4 (127.0.0.1)', r1.status === 403, `Status: ${r1.status}`);

    // 1.2 Localhost Hostname
    const r2 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://localhost:3000/env')}`);
    report('Blokir Hostname localhost', r2.status === 403, `Status: ${r2.status}`);

    // 1.3 Subnet Privat Kelas A (10.0.0.0/8)
    const r3 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://10.1.2.3/secret')}`);
    report('Blokir IP Privat Kelas A (10.x.x.x)', r3.status === 403, `Status: ${r3.status}`);

    // 1.4 Subnet Privat Kelas B (172.16.0.0/12)
    const r4 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://172.20.0.1/db')}`);
    report('Blokir IP Privat Kelas B (172.20.x.x)', r4.status === 403, `Status: ${r4.status}`);

    // 1.5 Subnet Privat Kelas C (192.168.0.0/16)
    const r5 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://192.168.1.1/router')}`);
    report('Blokir IP Privat Kelas C (192.168.x.x)', r5.status === 403, `Status: ${r5.status}`);

    // 1.6 Cloud Metadata IP (AWS / GCP / Azure 169.254.169.254)
    const r6 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
    report('Blokir Endpoint Cloud Metadata (169.254.x.x)', r6.status === 403, `Status: ${r6.status}`);

    // 1.7 Domain Asing Tidak Masuk Whitelist
    const r7 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('https://malicious-attack.org/payload.png')}`);
    report('Blokir Domain Tak Terotorisasi (Whitelist)', r7.status === 403, `Status: ${r7.status}`);

    // 1.8 Skema Protokol Berbahaya (file:///)
    const r8 = await fetch(`${baseUrl}/api/proxy/image?url=${encodeURIComponent('file:///etc/passwd')}`);
    report('Blokir Protokol Non-HTTP (file://)', r8.status === 403, `Status: ${r8.status}`);

    // 1.9 Parameter Kosong
    const r9 = await fetch(`${baseUrl}/api/proxy/image`);
    report('Tolak Permintaan Tanpa Parameter URL', r9.status === 400, `Status: ${r9.status}`);

    // ----------------------------------------------------
    // KATEGORI 2: HTTP SECURITY HEADERS (OWASP RECOMMENDATIONS)
    // ----------------------------------------------------
    console.log('\n--- [2/5] UJI HTTP SECURITY HEADERS ---');

    const rHead = await fetch(`${baseUrl}/`);
    report('Header X-Content-Type-Options (nosniff)', rHead.headers.get('x-content-type-options') === 'nosniff');
    report('Header X-Frame-Options (Anti-Clickjacking)', rHead.headers.get('x-frame-options') === 'SAMEORIGIN');
    report('Header X-XSS-Protection', rHead.headers.get('x-xss-protection') === '1; mode=block');
    report('Header Referrer-Policy', rHead.headers.get('referrer-policy') === 'strict-origin-when-cross-origin');

    // ----------------------------------------------------
    // KATEGORI 3: AUTENTIKASI & KONTROL AKSES (RBAC & TOKENS)
    // ----------------------------------------------------
    console.log('\n--- [3/5] UJI OTORISASI & TOKEN VALIDATION ---');

    // 3.1 Akses endpoint terproteksi tanpa Bearer token
    const rAuth1 = await fetch(`${baseUrl}/api/auth/me`);
    report('Tolak Akses Rute Privat Tanpa Token', rAuth1.status === 401, `Status: ${rAuth1.status}`);

    // 3.2 Akses dengan Bearer token palsu/acak
    const rAuth2 = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer token_palsu_12345' }
    });
    report('Tolak Akses Token Palsu / Kedaluwarsa', rAuth2.status === 401, `Status: ${rAuth2.status}`);

    // 3.3 Sinkronisasi tanpa token
    const rAuth3 = await fetch(`${baseUrl}/api/auth/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookmarks: [] })
    });
    report('Tolak Sync Data Tanpa Otorisasi', rAuth3.status === 401, `Status: ${rAuth3.status}`);

    // ----------------------------------------------------
    // KATEGORI 4: BRUTE-FORCE RATE LIMITING
    // ----------------------------------------------------
    console.log('\n--- [4/5] UJI BRUTE-FORCE RATE LIMITER ---');

    // Coba login salah berkali-kali hingga kena limit (maxAttempts = 5)
    let rateLimitTriggered = false;
    let retryAfterHeader = null;

    for (let i = 1; i <= 7; i++) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'unknown_user_test', password: 'wrongpassword' })
      });

      if (res.status === 429) {
        rateLimitTriggered = true;
        retryAfterHeader = res.headers.get('retry-after');
        break;
      }
    }

    report('Rate Limiter Mengunci Setelah 5x Percobaan (HTTP 429)', rateLimitTriggered);
    report('Penyertaan Header Retry-After', Boolean(retryAfterHeader), `Jeda: ${retryAfterHeader} detik`);

    // ----------------------------------------------------
    // KATEGORI 5: KRIPTOGRAFI PASSWORD & INTEGRITAS DATABASE
    // ----------------------------------------------------
    console.log('\n--- [5/5] UJI KRIPTOGRAFI & ISOLASI DATABASE ---');

    // 5.1 Password Hashing menggunakan scrypt dengan random salt
    const rawPass = 'SuperSecretP@ss123';
    const h1 = await db.hashPassword(rawPass);
    const h2 = await db.hashPassword(rawPass);

    report('Hash Salt Acak (Dua hash teks sama menghasilkan hash beda)', h1.hash !== h2.hash && h1.salt !== h2.salt);
    
    // 5.2 Password Verification Constant-time
    const isPassValid = await db.verifyPassword(rawPass, h1.hash, h1.salt);
    const isPassInvalid = await db.verifyPassword('WrongPass123', h1.hash, h1.salt);
    report('Verifikasi Password Benar', isPassValid === true);
    report('Penolakan Password Salah', isPassInvalid === false);

    // 5.3 Sanitasi & Batas Input
    let regFailedOnShort = false;
    try {
      await db.createUser('ab', 'ab@c.com', 'short');
    } catch (e) {
      regFailedOnShort = true;
    }
    report('Validasi Panjang Username/Password Minimum', regFailedOnShort);

    console.log('\n====================================================');
    console.log(`📊 HASIL PENGUJIAN KEAMANAN: ${passedTests} DARI ${totalTests} TEST LULUS (${Math.round((passedTests / totalTests) * 100)}%)`);
    console.log('====================================================');

  } catch (err) {
    console.error('Error saat audit keamanan:', err);
  } finally {
    server.close();
    process.exit(0);
  }
}

runSecurityAudit();
