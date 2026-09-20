// ===================================================
// MangaPill Complete Manga Provider Scraper
// Provides complete archives for mainstream & licensed series
// ===================================================

const BASE_URL = 'https://mangapill.com';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Search manga on MangaPill
 * @param {string} query 
 * @param {number} page 
 */
async function searchMangaPill(query, page = 1) {
  if (!query || typeof query !== 'string') {
    return { success: true, data: [], total: 0 };
  }

  const url = `${BASE_URL}/search?q=${encodeURIComponent(query.trim())}&page=${page}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) {
    throw new Error(`MangaPill search HTTP ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();
  const mangaRegex = /<a[^>]+href="(\/manga\/(\d+)\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/g;
  const results = [];
  const seenIds = new Set();
  let m;

  while ((m = mangaRegex.exec(html)) !== null) {
    const id = m[2];
    const slug = m[3];
    const block = m[4];

    if (seenIds.has(id)) continue;
    seenIds.add(id);

    // Title
    const titleMatch = block.match(/<div class="line-clamp-2 font-bold[^"]*">([\s\S]*?)<\/div>/i) ||
      block.match(/class="[^"]*font-bold[^"]*">([\s\S]*?)<\/div>/i);
    const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : slug.replace(/-/g, ' ');
    const title = decodeHtmlEntities(rawTitle);

    // Cover Image
    const imgMatch = block.match(/data-src="([^"]+)"|src="([^"]+)"/i);
    const rawCover = imgMatch ? (imgMatch[1] || imgMatch[2]) : null;
    const coverUrl = rawCover ? `/api/proxy/image?url=${encodeURIComponent(rawCover)}` : '/placeholder.jpg';

    // Type & Status badges
    const typeMatch = block.match(/<div[^>]*class="[^"]*text-xs[^"]*"[^>]*>([^<]+)<\/div>/i);
    const type = typeMatch ? typeMatch[1].trim() : 'Manga';

    results.push({
      id: `pill-${id}`,
      pillId: id,
      slug,
      title,
      coverUrl,
      coverUrlSmall: coverUrl,
      type,
      status: 'Publishing',
      source: 'mangapill',
      isCompleteSource: true,
      tags: [type, 'Complete Chapters'],
      latestChapter: null
    });
  }

  return {
    success: true,
    data: results,
    total: results.length,
    source: 'mangapill'
  };
}

/**
 * Get manga detail & all chapters from MangaPill
 * @param {string} id 
 * @param {string} slug 
 */
async function getMangaPillDetail(id, slug = '') {
  let cleanId = String(id).replace(/^pill-/, '');
  if (!slug && cleanId.includes('/')) {
    const parts = cleanId.split('/');
    cleanId = parts[0];
    slug = parts[1];
  } else if (!slug && cleanId.includes('__')) {
    const parts = cleanId.split('__');
    cleanId = parts[0];
    slug = parts[1];
  }

  // Never append trailing slash if slug is empty (MangaPill gives 404 for trailing slash without slug)
  const url = slug ? `${BASE_URL}/manga/${cleanId}/${slug}` : `${BASE_URL}/manga/${cleanId}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`MangaPill detail HTTP ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();

  // Title
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : slug.replace(/-/g, ' ');
  const title = decodeHtmlEntities(rawTitle);

  // Description
  const descMatch = html.match(/<p class="text-sm text-secondary my-3">([\s\S]*?)<\/p>/i) ||
    html.match(/<p class="text-sm[^"]*">([\s\S]*?)<\/p>/i);
  const description = descMatch ? decodeHtmlEntities(descMatch[1].replace(/<[^>]+>/g, '').trim()) : '';

  // Cover
  const coverMatch = html.match(/<img[^>]+class="[^"]*lazy[^"]*"[^>]+(?:data-src|src)="([^"]+)"/i) ||
    html.match(/<img[^>]+(?:data-src|src)="([^"]+)"[^>]+class="[^"]*lazy/i);
  const rawCover = coverMatch ? (coverMatch[1] || coverMatch[2]) : `https://cdn.readdetectiveconan.com/file/mangapill/i/${cleanId}.jpeg`;
  const coverUrl = `/api/proxy/image?url=${encodeURIComponent(rawCover)}`;

  // Genres
  const genreRegex = /<a[^>]+href="\/search\?[^"]*genre=([^"&]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const genres = [];
  let gm;
  while ((gm = genreRegex.exec(html)) !== null) {
    const gName = gm[2].replace(/<[^>]+>/g, '').trim();
    if (gName && !genres.includes(gName)) genres.push(gName);
  }

  // Meta (Type, Status, Year)
  const metaRegex = /<div>\s*<label[^>]*>([^<]+)<\/label>\s*<div>([^<]+)<\/div>\s*<\/div>/gi;
  const meta = {};
  let mm;
  while ((mm = metaRegex.exec(html)) !== null) {
    meta[mm[1].trim().toLowerCase()] = mm[2].trim();
  }

  // Chapters list
  const chRegex = /<a[^>]+href="(\/chapters\/(\d+-\d+)\/([^"]+))"[^>]*>([\s\S]*?)<\/a>/gi;
  const chapters = [];
  let cm;

  while ((cm = chRegex.exec(html)) !== null) {
    const chHref = cm[1];
    const chId = cm[2];
    const chSlug = cm[3];
    const chText = decodeHtmlEntities(cm[4].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());

    // Extract chapter number from text or slug
    const numMatch = chText.match(/Chapter\s+([\d.]+)/i) || chSlug.match(/chapter-([\d.]+)/i);
    const chapterNum = numMatch ? numMatch[1] : chId;

    chapters.push({
      id: `pill-${chId}`,
      pillChapterId: chId,
      slug: chSlug,
      href: chHref,
      chapter: chapterNum,
      volume: null,
      title: chText,
      language: 'en',
      releaseDate: null,
      isExternal: false,
      externalUrl: null,
      source: 'mangapill'
    });
  }

  return {
    success: true,
    data: {
      id: `pill-${cleanId}`,
      pillId: cleanId,
      slug,
      title,
      altTitles: [],
      description,
      status: meta.status || 'Publishing',
      type: meta.type || 'Manga',
      year: meta.year || null,
      coverUrl,
      coverUrlSmall: coverUrl,
      tags: genres.length > 0 ? genres : ['Manga', 'Action'],
      source: 'mangapill',
      isCompleteSource: true,
      totalChapters: chapters.length,
      chapters
    }
  };
}

/**
 * Get chapter pages from MangaPill
 * @param {string} chapterId 
 * @param {string} slug 
 */
async function getMangaPillChapter(chapterId, slug = '') {
  let cleanChId = String(chapterId).replace(/^pill-/, '');
  if (!slug && cleanChId.includes('/')) {
    const parts = cleanChId.split('/');
    cleanChId = parts[0];
    slug = parts[1];
  } else if (!slug && cleanChId.includes('__')) {
    const parts = cleanChId.split('__');
    cleanChId = parts[0];
    slug = parts[1];
  }

  // Never append trailing slash if slug is empty (MangaPill gives 404 for trailing slash without slug)
  const url = slug ? `${BASE_URL}/chapters/${cleanChId}/${slug}` : `${BASE_URL}/chapters/${cleanChId}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`MangaPill chapter HTTP ${res.status}: ${res.statusText}`);
  }

  const html = await res.text();

  // Find images in reader
  const pageRegex = /<picture[^>]*>[\s\S]*?<img[^>]+(?:data-src|src)="([^"]+)"[^>]*>[\s\S]*?<\/picture>/gi;
  const rawPages = [];
  let pm;

  while ((pm = pageRegex.exec(html)) !== null) {
    const rawUrl = pm[1].trim();
    if (rawUrl && !rawPages.includes(rawUrl)) {
      rawPages.push(rawUrl);
    }
  }

  // Fallback if picture regex found nothing
  if (rawPages.length === 0) {
    const imgRegex = /<img[^>]+data-src="(https:\/\/cdn\.readdetectiveconan\.com\/[^"]+)"/gi;
    let im;
    while ((im = imgRegex.exec(html)) !== null) {
      if (!rawPages.includes(im[1])) {
        rawPages.push(im[1]);
      }
    }
  }

  const pages = rawPages.map((imgUrl, index) => {
    const proxyUrl = `/api/proxy/image?url=${encodeURIComponent(imgUrl)}`;
    return {
      page: index + 1,
      directUrl: proxyUrl,
      proxyUrl: proxyUrl,
      dataSaverUrl: proxyUrl,
      proxyDataSaverUrl: proxyUrl
    };
  });

  // Extract title & chapter number
  const titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : `Chapter ${cleanChId}`;
  const title = decodeHtmlEntities(rawTitle);
  const numMatch = rawTitle.match(/Chapter\s+([\d.]+)/i) || (slug || '').match(/chapter-([\d.]+)/i);
  const chapterNum = numMatch ? numMatch[1] : cleanChId;

  return {
    success: true,
    data: {
      id: `pill-${cleanChId}`,
      chapterId: cleanChId,
      chapter: chapterNum,
      title,
      pages,
      totalPages: pages.length,
      source: 'mangapill'
    }
  };
}

module.exports = {
  searchMangaPill,
  getMangaPillDetail,
  getMangaPillChapter
};
