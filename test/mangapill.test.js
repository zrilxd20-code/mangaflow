// ===================================================
// MangaPill Provider Integration & Completeness Tests
// ===================================================

const mangapill = require('../providers/mangapill');

async function runTests() {
  console.log('\n====================================================');
  console.log('📚 MEMULAI PENGUJIAN PROVIDER LENGKAP (MANGAPILL)');
  console.log('====================================================\n');

  let passed = 0;
  let total = 4;

  try {
    // 1. Test Search
    console.log('--- [1/4] UJI PENCARIAN MANGA ---');
    const searchRes = await mangapill.searchMangaPill('one piece');
    if (searchRes.success && searchRes.data.length > 0 && searchRes.data[0].pillId) {
      console.log(`  🟢 [PASS] Pencarian berhasil menemukan ${searchRes.data.length} hasil (Contoh: "${searchRes.data[0].title}")`);
      passed++;
    } else {
      console.error('  🔴 [FAIL] Pencarian gagal mengembalikan data yang valid');
    }

    // 2. Test Detail & Completeness
    console.log('\n--- [2/4] UJI KELENGKAPAN CHAPTER ---');
    const detailRes = await mangapill.getMangaPillDetail('2', 'one-piece');
    if (detailRes.success && detailRes.data.totalChapters > 1000) {
      console.log(`  🟢 [PASS] Arsip lengkap terverifikasi: ${detailRes.data.totalChapters} chapter (Bebas gap lisensi)`);
      passed++;
    } else {
      console.error(`  🔴 [FAIL] Jumlah chapter tidak sesuai ekspektasi: ${detailRes.data?.totalChapters}`);
    }

    // 3. Test Chapter Pages
    console.log('\n--- [3/4] UJI EKSTRAKSI HALAMAN CHAPTER ---');
    const firstCh = detailRes.data.chapters[0];
    const chapterRes = await mangapill.getMangaPillChapter(firstCh.pillChapterId, firstCh.slug);
    if (chapterRes.success && chapterRes.data.totalPages > 0 && chapterRes.data.pages[0].proxyUrl) {
      console.log(`  🟢 [PASS] Ekstraksi halaman chapter berhasil: ${chapterRes.data.totalPages} halaman terdeteksi`);
      passed++;
    } else {
      console.error('  🔴 [FAIL] Gagal mengekstrak halaman gambar chapter');
    }

    // 4. Test Image Proxy Routing
    console.log('\n--- [4/4] UJI STREAMING PROXY GAMBAR MANGA ---');
    const sampleProxyPath = chapterRes.data.pages[0].proxyUrl;
    const proxyRes = await fetch(`http://localhost:3000${sampleProxyPath}`);
    if (proxyRes.ok && (proxyRes.headers.get('content-type') || '').includes('image')) {
      console.log(`  🟢 [PASS] Proxy gambar MangaPill berhasil mengalirkan gambar (HTTP ${proxyRes.status}, Content-Type: ${proxyRes.headers.get('content-type')})`);
      passed++;
    } else {
      console.error(`  🔴 [FAIL] Proxy gambar gagal: Status ${proxyRes.status}`);
    }

  } catch (err) {
    console.error('  🔴 [ERROR] Terjadi kesalahan saat pengujian:', err.message);
  }

  console.log('\n====================================================');
  console.log(`📊 HASIL PENGUJIAN MANGAPILL: ${passed} DARI ${total} TEST LULUS (${Math.round((passed / total) * 100)}%)`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

runTests();
