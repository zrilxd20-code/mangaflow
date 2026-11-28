// ===================================================
// Komiku Public Provider (Indonesian Manhwa, Manhua & Manga)
// Supplies complete Bahasa Indonesia chapters for Manhwa/Manhua/Manga
// ===================================================

const KOMIKU_BASE = 'https://komiku.org';
const KOMIKU_API_BASE = 'https://api.komiku.org';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#038;|&amp;/g, '&')
    .replace(/&#8217;|&#39;|&#039;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;|&#34;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;|&#8212;/g, '-')
    .trim();
}

function cleanKomikuTitle(raw) {
  return decodeHtml(String(raw || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .replace(/^Komik\s+/i, '')
    .trim();
}

function normalizeComicType(raw) {
  const lower = String(raw || '').toLowerCase();
  if (lower.includes('manhwa') || lower.includes('webtoon')) return 'manhwa';
  if (lower.includes('manhua')) return 'manhua';
  return 'manga';
}

function proxyKomikuImage(rawUrl) {
  const cleaned = decodeHtml(rawUrl || '').trim();
  if (!cleaned || !/^https?:\/\//i.test(cleaned)) return null;
  return `/api/proxy/image?url=${encodeURIComponent(cleaned)}`;
}

const KOMIKU_STOP_WORDS = new Set([
  'the', 'of', 'in', 'to', 'and', 'for', 'with', 'from', 'that', 'this', 'my', 'a', 'an', 'at', 'by', 'on', 'is', 'are', 'was'
]);

function buildKomikuFallbackQueries(rawQuery) {
  const cleaned = String(rawQuery || '').trim();
  const tokens = cleaned
    .replace(/['’`][a-z]+/gi, '') // strip possessive suffixes like "'s"
    .replace(/[^a-zA-Z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !KOMIKU_STOP_WORDS.has(w.toLowerCase()));

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
  } else if (tokens.length === 2) {
    const joined = tokens.join(' ');
    if (!seen.has(joined.toLowerCase())) {
      seen.add(joined.toLowerCase());
      candidates.push(joined);
    }
  }

  return candidates.slice(0, 2);
}

async function fetchKomikuSearchHtml(queryText, page = 1) {
  const pagePath = page > 1 ? `page/${page}/` : '';
  const url = `${KOMIKU_API_BASE}/manga/${pagePath}?s=${encodeURIComponent(queryText)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${KOMIKU_BASE}/`
    },
    signal: AbortSignal.timeout(7000)
  });

  if (!res.ok) {
    throw new Error(`Komiku search HTTP ${res.status}`);
  }
  return await res.text();
}

function parseKomikuSearchBlocks(html) {
  const blocks = html.split(/<div class="bge">/i).slice(1);
  const results = [];
  const seenSlugs = new Set();

  for (const block of blocks) {
    const linkMatch = block.match(/href="(?:https?:\/\/komiku\.org)?\/manga\/([^"\/?#]+)\/?"/i);
    if (!linkMatch) continue;
    const slug = linkMatch[1].trim();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);

    const titleMatch = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const title = cleanKomikuTitle(titleMatch ? titleMatch[1] : slug.replace(/-/g, ' '));
    if (!title) continue;

    const imgMatch = block.match(/<img[^>]+(?:data-src|src)="([^"]+)"/i);
    const rawCover = imgMatch ? decodeHtml(imgMatch[1]) : '';
    const coverUrl = proxyKomikuImage(rawCover) || `https://placehold.co/400x600/181a20/818cf8?text=${encodeURIComponent(title.slice(0, 20))}`;

    const typeInfoMatch = block.match(/<div class="tpe1_inf"[^>]*>([\s\S]*?)<\/div>/i);
    const typeBoldMatch = typeInfoMatch ? typeInfoMatch[1].match(/<b[^>]*>([\s\S]*?)<\/b>/i) : null;
    const typeLabel = typeBoldMatch ? decodeHtml(typeBoldMatch[1]).trim() : 'Manga';
    const genreLabel = typeInfoMatch
      ? decodeHtml(typeInfoMatch[1].replace(/<b[^>]*>[\s\S]*?<\/b>/i, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
      : '';

    const comicType = normalizeComicType(typeLabel);
    const tags = [typeLabel, genreLabel, 'Sub Indo'].filter(Boolean);

    results.push({
      id: `komiku-${slug}`,
      komikuSlug: slug,
      slug,
      title,
      altTitles: [],
      coverUrl,
      coverUrlSmall: coverUrl,
      rawCover: rawCover || coverUrl,
      type: typeLabel,
      comicType,
      status: 'ongoing',
      source: 'komiku',
      isCompleteSource: true,
      hasIndoSub: true,
      tags
    });
  }

  return results;
}

/**
 * Search Komiku public endpoint for Manhwa, Manhua & Manga (Sub Indo)
 * Automatically retries with distinctive keywords if WordPress exact-apostrophe search misses.
 * @param {string} query
 * @param {number} page
 */
async function searchKomiku(query, page = 1) {
  const cleanQ = String(query || '').trim();
  if (!cleanQ) {
    return { success: true, data: [], total: 0, source: 'komiku' };
  }

  const html = await fetchKomikuSearchHtml(cleanQ, page);
  let results = parseKomikuSearchBlocks(html);

  // Fallback for curly-apostrophe / long-title misses on Komiku WordPress search
  if (results.length === 0 && page === 1) {
    const fallbacks = buildKomikuFallbackQueries(cleanQ);
    for (const fbQ of fallbacks) {
      try {
        const fbHtml = await fetchKomikuSearchHtml(fbQ, 1);
        const fbResults = parseKomikuSearchBlocks(fbHtml);
        if (fbResults.length > 0) {
          results = fbResults;
          break;
        }
      } catch (_) {}
    }
  }

  return {
    success: true,
    data: results,
    total: results.length,
    source: 'komiku'
  };
}

/**
 * Get Komiku series detail and complete Indonesian chapter list
 * @param {string} slug
 */
async function getKomikuDetail(slug) {
  const cleanSlug = String(slug || '').replace(/^komiku-/, '').replace(/^\/+|\/+$/g, '').trim();
  if (!cleanSlug || !/^[a-z0-9._-]+$/i.test(cleanSlug)) {
    throw new Error('Slug Komiku tidak valid.');
  }

  const url = `${KOMIKU_BASE}/manga/${encodeURIComponent(cleanSlug)}/`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${KOMIKU_BASE}/`
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(8500)
  });

  if (!res.ok) {
    throw new Error(`Komiku detail HTTP ${res.status}`);
  }

  const html = await res.text();

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanKomikuTitle(h1Match ? h1Match[1] : cleanSlug.replace(/-/g, ' '));

  const descMatch = html.match(/<p class="desc"[^>]*>([\s\S]*?)<\/p>/i) ||
    html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  const description = descMatch ? decodeHtml(descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) : '';

  const imgMatch = html.match(/<div class="ims"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i) ||
    html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
  const rawCover = imgMatch ? decodeHtml(imgMatch[1]) : '';
  const coverUrl = proxyKomikuImage(rawCover) || `https://placehold.co/400x600/181a20/818cf8?text=${encodeURIComponent(title.slice(0, 20))}`;

  // Extract metadata table rows (Jenis Komik, Pengarang, Status, Judul Indonesia)
  const metaMap = {};
  const trRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let trM;
  while ((trM = trRegex.exec(html)) !== null) {
    const k = decodeHtml(trM[1].replace(/<[^>]+>/g, '')).toLowerCase();
    const v = decodeHtml(trM[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
    if (k && v) metaMap[k] = v;
  }

  const comicType = normalizeComicType(metaMap['jenis komik'] || '');
  const statusRaw = String(metaMap['status'] || 'ongoing').toLowerCase();
  const status = statusRaw.includes('tamat') || statusRaw.includes('end') || statusRaw.includes('completed') ? 'completed' : 'ongoing';
  const authors = metaMap['pengarang'] ? [metaMap['pengarang']] : [];
  const altTitles = metaMap['judul indonesia'] && metaMap['judul indonesia'] !== title ? [metaMap['judul indonesia']] : [];

  // Genres
  const genres = [];
  const genreSection = html.match(/<ul class="genre"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || '';
  const gRegex = /<a[^>]*>([\s\S]*?)<\/a>/gi;
  let gm;
  while ((gm = gRegex.exec(genreSection)) !== null) {
    const g = decodeHtml(gm[1].replace(/<[^>]+>/g, '')).trim();
    if (g && !genres.includes(g)) genres.push(g);
  }

  // Chapters from Daftar_Chapter table (deduplicated)
  const tableSection = html.match(/id="Daftar_Chapter"[\s\S]*?<\/table>/i)?.[0] || html;
  const chRegex = /<a[^>]+href="(?:https?:\/\/komiku\.org)?\/([^"\/?#]*chapter[^"\/?#]*)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
  const chapters = [];
  const seenChSlugs = new Set();
  let cm;

  while ((cm = chRegex.exec(tableSection)) !== null) {
    const chSlug = cm[1].trim();
    const chLabel = decodeHtml(cm[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
    if (!chSlug || seenChSlugs.has(chSlug)) continue;
    if (/^(Awal|Terbaru)\s*:/i.test(chLabel)) continue;
    seenChSlugs.add(chSlug);

    const numMatch = chLabel.match(/Chapter\s+([\d.]+)/i) || chSlug.match(/chapter-([\d]+(?:[.-]\d+)?)/i);
    const rawNum = numMatch ? numMatch[1].replace(/-/g, '.') : '0';
    const parsedNum = parseFloat(rawNum);
    const chapterNum = Number.isFinite(parsedNum) ? String(parsedNum) : rawNum;

    chapters.push({
      id: `komiku-${chSlug}`,
      komikuChapterSlug: chSlug,
      slug: chSlug,
      chapter: chapterNum,
      volume: null,
      title: chLabel || `Chapter ${chapterNum}`,
      language: 'id',
      isExternal: false,
      externalUrl: null,
      group: 'Komiku • Sub Indo',
      source: 'komiku'
    });
  }

  return {
    success: true,
    data: {
      id: `komiku-${cleanSlug}`,
      komikuSlug: cleanSlug,
      slug: cleanSlug,
      title,
      altTitles,
      description: description || 'Baca komik Bahasa Indonesia lengkap di MangaFlow.',
      status,
      comicType,
      authors,
      artists: [],
      year: null,
      coverUrl,
      coverUrlSmall: coverUrl,
      rawCover: rawCover || coverUrl,
      tags: genres.length > 0 ? genres : ['Sub Indo', comicType === 'manhwa' ? 'Manhwa' : 'Manga'],
      source: 'komiku',
      isCompleteSource: true,
      hasIndoSub: true,
      totalChapters: chapters.length,
      chapters
    }
  };
}

/**
 * Get chapter page images from Komiku
 * @param {string} chapterSlug
 */
async function getKomikuChapter(chapterSlug) {
  const cleanChSlug = String(chapterSlug || '').replace(/^komiku-/, '').replace(/^\/+|\/+$/g, '').trim();
  if (!cleanChSlug || !/^[a-z0-9._-]+$/i.test(cleanChSlug)) {
    throw new Error('Slug chapter Komiku tidak valid.');
  }

  const url = `${KOMIKU_BASE}/${encodeURIComponent(cleanChSlug)}/`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: `${KOMIKU_BASE}/`
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000)
  });

  if (!res.ok) {
    throw new Error(`Komiku chapter HTTP ${res.status}`);
  }

  const html = await res.text();
  const bacaSection = html.match(/id="Baca_Komik"[\s\S]*?<\/section>/i)?.[0] || html;

  const imgRegex = /<img[^>]+(?:data-src|src)="(https?:\/\/[^"]+)"/gi;
  const rawPages = [];
  let im;

  while ((im = imgRegex.exec(bacaSection)) !== null) {
    const imgUrl = decodeHtml(im[1]).trim();
    if (!imgUrl) continue;
    // Skip site chrome / opening-closing banners / ads
    if (/\/asset\/img\/|opening\.|closing\.|iklan|banner|logo|icon/i.test(imgUrl)) continue;
    if (!rawPages.includes(imgUrl)) {
      rawPages.push(imgUrl);
    }
  }

  const pages = rawPages.map((imgUrl, idx) => {
    const proxyUrl = `/api/proxy/image?url=${encodeURIComponent(imgUrl)}`;
    return {
      page: idx + 1,
      directUrl: proxyUrl,
      proxyUrl,
      dataSaverUrl: proxyUrl,
      proxyDataSaverUrl: proxyUrl
    };
  });

  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = cleanKomikuTitle(h1Match ? h1Match[1] : cleanChSlug.replace(/-/g, ' '));
  const numMatch = title.match(/Chapter\s+([\d.]+)/i) || cleanChSlug.match(/chapter-([\d]+(?:[.-]\d+)?)/i);
  const rawNum = numMatch ? numMatch[1].replace(/-/g, '.') : '0';
  const parsedNum = parseFloat(rawNum);
  const chapterNum = Number.isFinite(parsedNum) ? String(parsedNum) : rawNum;

  return {
    success: true,
    data: {
      id: `komiku-${cleanChSlug}`,
      chapterId: cleanChSlug,
      chapter: chapterNum,
      title,
      language: 'id',
      pages,
      totalPages: pages.length,
      source: 'komiku'
    }
  };
}

module.exports = {
  searchKomiku,
  getKomikuDetail,
  getKomikuChapter
};
