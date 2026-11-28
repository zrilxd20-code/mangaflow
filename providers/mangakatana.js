// ===================================================
// MangaKatana Public Provider (Complete Manhwa, Manhua & Manga Archive)
// Supplies complete chapters for Manhwa/Manhua/Manga including titles missing from MangaDex/MangaPill
// ===================================================

const MK_BASE = 'https://mangakatana.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MK_STOP_WORDS = new Set([
  'the', 'of', 'in', 'to', 'and', 'for', 'with', 'from', 'that', 'this', 'my', 'a', 'an', 'at', 'by', 'on', 'is', 'are', 'was'
]);

function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&rsquo;|&#8217;|&#39;|&#039;/gi, "'")
    .replace(/&lsquo;|&#8216;/gi, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;|&quot;|&#34;/gi, '"')
    .replace(/&amp;|&#038;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/gi, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(str) {
  return decodeHtml(String(str || '').replace(/<[^>]+>/g, ' '));
}

function detectComicType(genres = []) {
  const lower = genres.map((g) => String(g || '').toLowerCase());
  if (lower.some((g) => g.includes('manhwa') || g.includes('webtoon'))) return 'manhwa';
  if (lower.some((g) => g.includes('manhua'))) return 'manhua';
  return 'manga';
}

function proxyMkImage(rawUrl) {
  const cleaned = decodeHtml(rawUrl || '').trim();
  if (!cleaned || !/^https?:\/\//i.test(cleaned)) return null;
  return `/api/proxy/image?url=${encodeURIComponent(cleaned)}`;
}

function buildFallbackQueries(rawQuery) {
  const cleaned = String(rawQuery || '').trim();
  const tokens = cleaned
    .replace(/['’`][a-z]+/gi, '')
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !MK_STOP_WORDS.has(w.toLowerCase()));

  const candidates = [];
  const seen = new Set([cleaned.toLowerCase()]);

  if (tokens.length >= 3) {
    const lastTwo = tokens.slice(-2).join(' ');
    if (lastTwo.length >= 5 && !seen.has(lastTwo.toLowerCase())) {
      seen.add(lastTwo.toLowerCase());
      candidates.push(lastTwo);
    }
    const firstTwo = tokens.slice(0, 2).join(' ');
    if (firstTwo.length >= 5 && !seen.has(firstTwo.toLowerCase())) {
      seen.add(firstTwo.toLowerCase());
      candidates.push(firstTwo);
    }
  }
  return candidates.slice(0, 2);
}

function extractSlugFromUrl(urlStr) {
  const match = String(urlStr || '').match(/\/manga\/([^\/?#]+)/i);
  return match ? match[1].trim() : null;
}

function parseSingleMangaPageAsSearchItem(html, finalUrl) {
  const slug = extractSlugFromUrl(finalUrl);
  if (!slug) return null;

  const titleMatch = html.match(/<h1[^>]*class="heading"[^>]*>([\s\S]*?)<\/h1>/i);
  const title = stripTags(titleMatch ? titleMatch[1] : slug.replace(/\.\d+$/, '').replace(/-/g, ' '));
  if (!title) return null;

  const altMatch = html.match(/<div class="alt_name"[^>]*>([\s\S]*?)<\/div>/i);
  const altTitles = altMatch
    ? stripTags(altMatch[1]).split(/\s*;\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    : [];

  const coverMatch = html.match(/<div class="cover"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i);
  const rawCover = coverMatch ? decodeHtml(coverMatch[1]) : '';
  const coverUrl = proxyMkImage(rawCover) || `https://placehold.co/400x600/181a20/818cf8?text=${encodeURIComponent(title.slice(0, 20))}`;

  const genres = [...html.matchAll(/<div class="genres"[^>]*>([\s\S]*?)<\/div>/gi)]
    .flatMap((m) => [...m[1].matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((a) => stripTags(a[1])))
    .filter(Boolean);

  const comicType = detectComicType(genres);
  const statusMatch = html.match(/<div class="value status[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
    html.match(/<div class="d-cell-small value status[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const statusRaw = statusMatch ? stripTags(statusMatch[1]).toLowerCase() : 'ongoing';
  const status = statusRaw.includes('completed') ? 'completed' : 'ongoing';

  return {
    id: `mk-${slug}`,
    mkSlug: slug,
    slug,
    title,
    altTitles,
    coverUrl,
    coverUrlSmall: coverUrl,
    rawCover: rawCover || coverUrl,
    type: comicType === 'manhwa' ? 'Manhwa' : (comicType === 'manhua' ? 'Manhua' : 'Manga'),
    comicType,
    status,
    source: 'mangakatana',
    isCompleteSource: true,
    tags: genres.length ? genres : ['Complete Chapters']
  };
}

function parseSearchListHtml(html) {
  const blocks = html.split(/<div class="item"[^>]*data-id="/i).slice(1);
  const results = [];
  const seenSlugs = new Set();

  for (const block of blocks) {
    const linkMatch = block.match(/<h3 class="title"[^>]*>[\s\S]*?<a[^>]+href="(https?:\/\/mangakatana\.com\/manga\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const slug = extractSlugFromUrl(linkMatch[1]);
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const title = stripTags(linkMatch[2]);
    if (!title) continue;

    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/i);
    const rawCover = imgMatch ? decodeHtml(imgMatch[1]) : '';
    const coverUrl = proxyMkImage(rawCover) || `https://placehold.co/400x600/181a20/818cf8?text=${encodeURIComponent(title.slice(0, 20))}`;

    const statusMatch = block.match(/<div class="status[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const statusRaw = statusMatch ? stripTags(statusMatch[1]).toLowerCase() : 'ongoing';
    const status = statusRaw.includes('completed') ? 'completed' : 'ongoing';

    const genresBlock = block.match(/<div class="genres[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const genres = genresBlock
      ? [...genresBlock[1].matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((a) => stripTags(a[1])).filter(Boolean)
      : [];

    const comicType = detectComicType(genres);

    results.push({
      id: `mk-${slug}`,
      mkSlug: slug,
      slug,
      title,
      altTitles: [],
      coverUrl,
      coverUrlSmall: coverUrl,
      rawCover: rawCover || coverUrl,
      type: comicType === 'manhwa' ? 'Manhwa' : (comicType === 'manhua' ? 'Manhua' : 'Manga'),
      comicType,
      status,
      source: 'mangakatana',
      isCompleteSource: true,
      tags: genres.length ? genres : ['Complete Chapters']
    });
  }

  return results;
}

async function fetchMkSearch(queryText, page = 1) {
  const pagePath = page > 1 ? `page/${page}` : '';
  const url = `${MK_BASE}/${pagePath}?search=${encodeURIComponent(queryText)}&search_by=book_name`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(7500)
  });

  if (!res.ok) {
    throw new Error(`MangaKatana search HTTP ${res.status}`);
  }

  const html = await res.text();
  if (/\/manga\/[^\/?#]+/i.test(res.url)) {
    const single = parseSingleMangaPageAsSearchItem(html, res.url);
    return single ? [single] : [];
  }
  return parseSearchListHtml(html);
}

/**
 * Search MangaKatana public archive (Manhwa, Manhua & Manga)
 */
async function searchMangaKatana(query, page = 1) {
  const cleanQ = String(query || '').trim();
  if (!cleanQ) {
    return { success: true, data: [], total: 0, source: 'mangakatana' };
  }

  let results = await fetchMkSearch(cleanQ, page);
  if (results.length === 0 && page === 1) {
    const fallbacks = buildFallbackQueries(cleanQ);
    for (const fbQ of fallbacks) {
      try {
        const fbRes = await fetchMkSearch(fbQ, 1);
        if (fbRes.length > 0) {
          results = fbRes;
          break;
        }
      } catch (_) {}
    }
  }

  return {
    success: true,
    data: results,
    total: results.length,
    source: 'mangakatana'
  };
}

/**
 * Get MangaKatana series detail & complete chapter list
 */
async function getMangaKatanaDetail(slug) {
  const cleanSlug = String(slug || '').replace(/^mk-/, '').replace(/^\/+|\/+$/g, '').trim();
  if (!cleanSlug || !/^[a-z0-9._-]+$/i.test(cleanSlug)) {
    throw new Error('Slug MangaKatana tidak valid.');
  }

  const url = `${MK_BASE}/manga/${encodeURIComponent(cleanSlug)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    throw new Error(`MangaKatana detail HTTP ${res.status}`);
  }

  const html = await res.text();
  const baseItem = parseSingleMangaPageAsSearchItem(html, res.url || url);
  if (!baseItem) {
    throw new Error('Detail komik MangaKatana tidak ditemukan.');
  }

  const descMatch = html.match(/<div class="summary"[^>]*>[\s\S]*?<p>([\s\S]*?)<\/p>/i);
  const description = descMatch ? stripTags(descMatch[1]) : 'No description available.';

  const authorBlock = html.match(/<div class="authors"[^>]*>([\s\S]*?)<\/div>/i);
  const authors = authorBlock
    ? [...authorBlock[1].matchAll(/<a[^>]*>([^<]+)<\/a>/gi)].map((a) => stripTags(a[1])).filter(Boolean)
    : [];

  // Scope chapter links strictly to this manga's slug so sidebar chapters are never mixed in
  const escapedSlug = cleanSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const chRe = new RegExp(
    `<a[^>]+href="(?:https?:\\/\\/mangakatana\\.com)?\\/manga\\/${escapedSlug}\\/(c[0-9a-z._-]+)"[^>]*>([\\s\\S]*?)<\\/a>`,
    'gi'
  );

  const chapters = [];
  const seenCh = new Set();
  for (const m of html.matchAll(chRe)) {
    const chSlug = m[1].trim();
    if (!chSlug || seenCh.has(chSlug)) continue;
    seenCh.add(chSlug);

    const rawLabel = stripTags(m[2]);
    const numMatch = chSlug.match(/^c(\d+(?:\.\d+)?)/i) || rawLabel.match(/chapter\s*(\d+(?:\.\d+)?)/i);
    const chNum = numMatch ? String(parseFloat(numMatch[1])) : chSlug.replace(/^c/i, '');

    chapters.push({
      id: `mk-${cleanSlug}--${chSlug}`,
      mkSlug: cleanSlug,
      mkChapterSlug: chSlug,
      chapter: chNum,
      volume: null,
      title: rawLabel || `Chapter ${chNum}`,
      language: 'en',
      isExternal: false,
      externalUrl: null,
      group: 'Auto-Fill • Arsip Manhwa',
      source: 'mangakatana'
    });
  }

  return {
    success: true,
    data: {
      ...baseItem,
      description,
      authors,
      artists: authors,
      chapters,
      totalChapters: chapters.length
    },
    source: 'mangakatana'
  };
}

/**
 * Get MangaKatana chapter pages (extracts full `var thzq = [...]` image array)
 */
async function getMangaKatanaChapter(compoundId) {
  const clean = String(compoundId || '').replace(/^mk-/, '').trim();
  const sepIdx = clean.lastIndexOf('--');
  if (sepIdx === -1) {
    throw new Error('ID chapter MangaKatana tidak valid.');
  }

  const mangaSlug = clean.slice(0, sepIdx).trim();
  const chSlug = clean.slice(sepIdx + 2).trim();
  if (!mangaSlug || !chSlug || !/^[a-z0-9._-]+$/i.test(mangaSlug) || !/^[a-z0-9._-]+$/i.test(chSlug)) {
    throw new Error('Slug chapter MangaKatana tidak valid.');
  }

  const url = `${MK_BASE}/manga/${encodeURIComponent(mangaSlug)}/${encodeURIComponent(chSlug)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${MK_BASE}/manga/${encodeURIComponent(mangaSlug)}`
    },
    signal: AbortSignal.timeout(9000)
  });

  if (!res.ok) {
    throw new Error(`MangaKatana chapter HTTP ${res.status}`);
  }

  const html = await res.text();
  const thzqMatch = html.match(/var\s+thzq\s*=\s*\[([\s\S]*?)\];/);
  const fallbackMatch = !thzqMatch ? html.match(/var\s+ytaw\s*=\s*\[([\s\S]*?)\];/) : null;
  const arrBody = thzqMatch ? thzqMatch[1] : (fallbackMatch ? fallbackMatch[1] : '');

  const rawUrls = [...arrBody.matchAll(/['"](https?:\/\/[^'"]+)['"]/g)].map((m) => m[1].trim());
  const seenUrls = new Set();
  const pages = [];

  for (const imgUrl of rawUrls) {
    if (!imgUrl || seenUrls.has(imgUrl)) continue;
    seenUrls.add(imgUrl);
    const proxyUrl = proxyMkImage(imgUrl);
    if (!proxyUrl) continue;
    pages.push({
      page: pages.length + 1,
      directUrl: proxyUrl,
      dataSaverUrl: proxyUrl,
      proxyUrl,
      proxyDataSaverUrl: proxyUrl
    });
  }

  if (pages.length === 0) {
    throw new Error('Halaman gambar chapter MangaKatana tidak ditemukan.');
  }

  const numMatch = chSlug.match(/^c(\d+(?:\.\d+)?)/i);
  const chNum = numMatch ? String(parseFloat(numMatch[1])) : chSlug;

  return {
    success: true,
    data: {
      id: `mk-${mangaSlug}--${chSlug}`,
      mangaId: `mk-${mangaSlug}`,
      chapter: chNum,
      title: `Chapter ${chNum}`,
      language: 'en',
      pages,
      totalPages: pages.length,
      source: 'mangakatana'
    },
    source: 'mangakatana'
  };
}

module.exports = {
  searchMangaKatana,
  getMangaKatanaDetail,
  getMangaKatanaChapter
};
