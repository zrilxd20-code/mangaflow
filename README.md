# MangaFlow - Ultra-Modern Online Manga Reader

Aplikasi web baca manga online berdesain **modern, minimalis, dan estetis (OLED Dark & Glassmorphism)** yang ditenagai oleh **Node.js (Express)** dan terintegrasi dengan **MangaDex API**. Dilengkapi arsitektur pertahanan anti-gagal (*resilience layer*) agar API dan gambar tidak terblokir atau mengalami *rate limit*.

---

## ✨ Fitur-Fitur Unggulan

### 1. Desain Modern & Minimalis (OLED Dark Glassmorphism)
- Palet warna mewah: Obsidian Black (`#08090d`), Deep Slate, Neon Indigo/Violet accents.
- Tipografi modern Google Fonts (*Outfit*, *Plus Jakarta Sans*, *JetBrains Mono*).
- Hero Carousel sinematik dengan auto-rotate, badge status (*Ongoing / Tamat*), dan micro-animations halus.
- Kartu manga interaktif dengan efek *hover lift*, *backdrop blur*, dan *shimmer skeleton loader*.

### 2. Solusi Anti-Gagal (API & Image Resilience)
- **Token-Bucket Request Limiter:** Backend membatasi panggilan ke MangaDex maksimal 4 req/detik agar tidak pernah terkena `HTTP 429 Too Many Requests`.
- **In-Memory TTL Caching (Node-Cache):** Menyimpan manga populer, metadata, dan chapter feeds sehingga 85-90% request disajikan instan tanpa beban ke MangaDex.
- **Smart Image Proxy & Bypass:**
  - Endpoint `/api/proxy/image` untuk melewati blokir ISP, adblocker, dan CORS domain `mangadex.network`.
  - Client secara otomatis beralih (*failover*) ke proxy atau mode **Data-Saver** jika gambar gagal dimuat.
- **Exponential Backoff & Retries:** Backend otomatis mencoba ulang (retry) hingga 3 kali dengan jeda eksponensial jika terjadi gangguan jaringan.

### 3. Manga Reader Interaktif Lengkap
- **Mode 1: Webtoon (Continuous Scroll):** Gulir ke bawah tanpa henti dengan pelacak nomor halaman dinamis berbasis scroll (*IntersectionObserver*) dan selektor lebar strip (*Compact 650px*, *Standard 850px*, *Wide 1100px*, *Full 100%*).
- **Mode 2: Single Page Viewer:** Baca per lembar dengan pilihan arah baca:
  - **RTL (Right-to-Left):** Format otentik manga Jepang.
  - **LTR (Left-to-Right):** Format komik barat / manhwa.
- **Smart Preload Engine:** Otomatis memuat 3-4 halaman berikutnya di memori dengan indikator visual agar membaca lancar tanpa jeda.
- **Keyboard Shortcuts Modal (`?`):** Dialog interaktif panduan tombol navigasi keyboard (`Arrows/A/D/Space`, `R`, `W`, `M`, `Q`, `F`, `[ / ]`, `H`, `Esc`).
- **Quality Switcher:** Pilihan kualitas *Original HD* atau *Mode Hemat Data (Data Saver)*.
- **Chapter Switcher & Slider:** Dropdown chapter lengkap, tombol Prev/Next chapter, dan progress slider halamannya.
- **Fullscreen Mode:** Tekan tombol `F` atau ikon layar penuh untuk pengalaman membaca tanpa gangguan.

### 4. Perpustakaan & Manajemen Bacaan (Otomatis & Offline-Ready)
- **SPA Hash Routing:** Sinkronisasi URL penuh (`#/manga/:id`, `#/reader/:mangaId/:chapterId`, `#/latest`, `#/library`, `#/history`) dengan dukungan tombol Back/Forward browser.
- **Favorit / Bookmarks:** Simpan komik favorit langsung ke `localStorage`.
- **Riwayat Baca ("Continue Reading"):** Mengingat chapter dan halaman terakhir yang dibaca sehingga bisa langsung dilanjutkan dengan satu klik.
- **Pencarian Cepat & Filter Komplit:** Live search dengan debounce, filter status (*Ongoing / Completed*), urutan (*Populer, Rating, Terbaru*), dan filter multi-bahasa (*EN / ID*).

---

## 🚀 Cara Menjalankan

### 1. Instal Dependensi
```bash
npm install
```

### 2. Jalankan Server
```bash
npm start
```
Server akan berjalan di `http://localhost:3000`. Buka browser Anda dan nikmati membaca manga tanpa gangguan!

---

## 📁 Struktur Proyek

```
.
├── server.js               # Express backend, rate limiter, cache, MangaDex API wrapper & image proxy
├── package.json            # Konfigurasi Node.js & dependencies
├── README.md               # Dokumentasi lengkap proyek
└── public/
    ├── index.html          # Single-Page Application HTML shell & SEO meta
    ├── css/
    │   ├── style.css       # Design tokens, glassmorphism, responsive cards & typography
    │   └── reader.css      # Styling khusus reader (webtoon, single page, floating HUD)
    └── js/
        ├── state.js        # State manager (Bookmarks, History, Reader Settings di localStorage)
        ├── api.js          # Client API client dengan error handling & multi-tier failover
        ├── reader.js       # Reader engine (webtoon & single page, keyboard shortcuts, HUD)
        └── app.js          # App router, Hero carousel, search dropdown & view renderer
```

---

## 🛡️ Arsitektur "Biar API Gak Pada Gagal"

```mermaid
graph TD
    User([User Browser]) -->|Request Halaman / Chapter| Backend[Node.js Express Server]
    Backend -->|1. Cek In-Memory Cache| Cache[(NodeCache TTL)]
    Cache -->|Data Ada (Hit)| FastReturn[Return Instant JSON < 5ms] --> User

    Cache -->|Data Kosong (Miss)| Throttler[Token-Bucket Queue: max 4 req/s]
    Throttler -->|Panggilan Terjadwal| MDAPI[MangaDex API]
    
    MDAPI -->|HTTP 429 / 5xx| Retry[Exponential Backoff Retry 3x]
    Retry -->|Coba Lagi| MDAPI
    MDAPI -->|HTTP 200 OK| SaveCache[Simpan ke Cache] --> User

    User -->|Load Image| DirectCDN[MangaDex CDN / @Home Server]
    DirectCDN -->|Gagal / Terblokir ISP / 404| ImgProxy[Backend Image Proxy /api/proxy/image]
    ImgProxy -->|Bypass Referer & Stream| DirectCDN
    ImgProxy -->|Gagal Total| DataSaver[MangaDex Data-Saver Fallback]
```
