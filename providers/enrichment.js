// ===================================================
// Multi-API Metadata Enrichment Provider (AniList, Kitsu, MangaUpdates)
// Zero-API-Key Public APIs with Strict Host Proxy & Sanitization
// ===================================================

const ANILIST_GRAPHQL = 'https://graphql.anilist.co';
const KITSU_API = 'https://kitsu.io/api/edge';
const MANGAUPDATES_API = 'https://api.mangaupdates.com/v1';

const ALLOWED_EXTERNAL_IMAGE_HOSTS = [
  's4.anilist.co',
  'img.anili.st',
  'media.kitsu.app',
  'media.kitsu.io',
  'cdn.myanimelist.net'
];

function stripHtmlToText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#039;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function proxyExternalImage(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const host = parsed.hostname.toLowerCase();
    const isAllowed = ALLOWED_EXTERNAL_IMAGE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
    if (!isAllowed) return null;
    return `/api/proxy/image?url=${encodeURIComponent(trimmed)}`;
  } catch {
    return null;
  }
}

function mapCountryToComicType(countryOfOrigin) {
  const code = String(countryOfOrigin || '').toUpperCase();
  if (code === 'KR') return 'manhwa';
  if (code === 'CN' || code === 'TW') return 'manhua';
  if (code === 'JP') return 'manga';
  return 'manga';
}

const ANILIST_FIELDS = `
  id
  idMal
  countryOfOrigin
  bannerImage
  coverImage { extraLarge large }
  averageScore
  popularity
  chapters
  volumes
  status
  title { romaji english native }
  synonyms
  description(asHtml: false)
  characters(sort: [ROLE, RELEVANCE], perPage: 8) {
    edges {
      role
      node {
        id
        name { full }
        image { large }
      }
    }
  }
  relations {
    edges {
      relationType(version: 2)
      node {
        id
        type
        format
        countryOfOrigin
        title { english romaji }
        coverImage { large }
      }
    }
  }
  recommendations(sort: [RATING_DESC], perPage: 8) {
    nodes {
      mediaRecommendation {
        id
        type
        countryOfOrigin
        title { english romaji }
        coverImage { large }
        averageScore
      }
    }
  }
`;

async function queryAniList(queryStr, variables) {
  const res = await fetch(ANILIST_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ query: queryStr, variables }),
    signal: AbortSignal.timeout(5500)
  });

  if (!res.ok) {
    throw new Error(`AniList HTTP ${res.status}`);
  }

  const json = await res.json();
  return json?.data?.Media || null;
}

async function fetchAniListMedia({ anilistId = null, search = '' } = {}) {
  const numericId = parseInt(anilistId, 10);
  if (Number.isInteger(numericId) && numericId > 0) {
    try {
      const byIdQuery = `query ($id: Int) { Media(id: $id, type: MANGA, isAdult: false) { ${ANILIST_FIELDS} } }`;
      const media = await queryAniList(byIdQuery, { id: numericId });
      if (media) return media;
    } catch (_) {
      // Fallback to search query if ID lookup fails
    }
  }

  const cleanSearch = String(search || '').trim();
  if (!cleanSearch) return null;

  try {
    const bySearchQuery = `query ($search: String) { Media(search: $search, type: MANGA, isAdult: false) { ${ANILIST_FIELDS} } }`;
    return await queryAniList(bySearchQuery, { search: cleanSearch });
  } catch (_) {
    return null;
  }
}

async function fetchKitsuFallback({ kitsuId = null, search = '' } = {}) {
  try {
    const cleanId = kitsuId ? String(kitsuId).trim() : '';
    let item = null;

    if (cleanId && /^\d+$/.test(cleanId)) {
      const res = await fetch(`${KITSU_API}/manga/${cleanId}`, {
        headers: { Accept: 'application/vnd.api+json' },
        signal: AbortSignal.timeout(4500)
      });
      if (res.ok) {
        const json = await res.json();
        item = json?.data || null;
      }
    }

    if (!item && search && String(search).trim()) {
      const res = await fetch(
        `${KITSU_API}/manga?filter[text]=${encodeURIComponent(String(search).trim())}&page[limit]=1`,
        {
          headers: { Accept: 'application/vnd.api+json' },
          signal: AbortSignal.timeout(4500)
        }
      );
      if (res.ok) {
        const json = await res.json();
        item = Array.isArray(json?.data) ? json.data[0] || null : null;
      }
    }

    if (!item) return null;
    const attrs = item.attributes || {};
    const bannerRaw = attrs.coverImage?.original || attrs.coverImage?.large || attrs.coverImage?.small || null;
    const posterRaw = attrs.posterImage?.large || attrs.posterImage?.medium || attrs.posterImage?.original || null;

    return {
      id: item.id || null,
      synopsis: stripHtmlToText(attrs.synopsis || attrs.description || ''),
      averageRating: attrs.averageRating ? (parseFloat(attrs.averageRating) / 10).toFixed(1) : null,
      abbreviatedTitles: Array.isArray(attrs.abbreviatedTitles) ? attrs.abbreviatedTitles.filter(Boolean) : [],
      canonicalTitle: attrs.canonicalTitle || null,
      titles: attrs.titles ? Object.values(attrs.titles).filter(Boolean) : [],
      coverImage: bannerRaw ? proxyExternalImage(bannerRaw) : null,
      posterImage: posterRaw ? proxyExternalImage(posterRaw) : null,
      subtype: attrs.subtype || null
    };
  } catch {
    return null;
  }
}

async function fetchMangaUpdatesAliases(title) {
  const cleanTitle = String(title || '').trim();
  if (!cleanTitle) return [];
  try {
    const res = await fetch(`${MANGAUPDATES_API}/series/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ search: cleanTitle, perpage: 3 }),
      signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return [];
    const json = await res.json();
    const aliases = [];
    for (const entry of (json?.results || [])) {
      const rec = entry?.record;
      if (rec?.title) aliases.push(rec.title);
      if (Array.isArray(rec?.associated)) {
        for (const a of rec.associated) {
          if (a?.title) aliases.push(a.title);
        }
      }
    }
    return [...new Set(aliases.map((s) => String(s).trim()).filter(Boolean))].slice(0, 12);
  } catch {
    return [];
  }
}

async function getEnrichedMetadata({ title = '', altTitles = [], links = {} } = {}) {
  const searchCandidates = [title, ...(Array.isArray(altTitles) ? altTitles : [])]
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const primarySearch = searchCandidates.find((s) => /[a-zA-Z]{2,}/.test(s)) || searchCandidates[0] || '';

  let media = await fetchAniListMedia({
    anilistId: links?.al || null,
    search: primarySearch
  });

  // Secondary search try with alternative English/Latin title if primary failed
  if (!media && searchCandidates.length > 1) {
    const secondSearch = searchCandidates.find((s) => s !== primarySearch && /[a-zA-Z]{2,}/.test(s));
    if (secondSearch) {
      media = await fetchAniListMedia({ search: secondSearch });
    }
  }

  const anilistDesc = stripHtmlToText(media?.description || '');
  const anilistBanner = media?.bannerImage ? proxyExternalImage(media.bannerImage) : null;

  let kitsu = null;
  if (!media || !anilistDesc || !anilistBanner) {
    kitsu = await fetchKitsuFallback({
      kitsuId: links?.kt || null,
      search: media?.title?.english || media?.title?.romaji || primarySearch
    });
  }

  const synonymSet = new Set();
  const pushAlias = (val) => {
    if (!val || typeof val !== 'string') return;
    const cleaned = val.trim();
    if (cleaned) synonymSet.add(cleaned);
  };

  if (media?.title) {
    pushAlias(media.title.english);
    pushAlias(media.title.romaji);
    pushAlias(media.title.native);
  }
  if (Array.isArray(media?.synonyms)) {
    media.synonyms.forEach(pushAlias);
  }
  if (kitsu) {
    pushAlias(kitsu.canonicalTitle);
    (kitsu.abbreviatedTitles || []).forEach(pushAlias);
    (kitsu.titles || []).forEach(pushAlias);
  }

  const characters = (media?.characters?.edges || [])
    .filter((edge) => edge?.node?.name?.full)
    .slice(0, 8)
    .map((edge) => ({
      id: edge.node.id,
      name: edge.node.name.full,
      role: edge.role || 'MAIN',
      avatarUrl: proxyExternalImage(edge.node.image?.large)
    }));

  const relations = (media?.relations?.edges || [])
    .filter((edge) => {
      const t = edge?.node?.type;
      return edge?.node && (t === 'MANGA' || t === 'ANIME' || t === 'NOVEL');
    })
    .slice(0, 6)
    .map((edge) => ({
      id: edge.node.id,
      relationType: edge.relationType || 'SIDE_STORY',
      type: edge.node.type,
      format: edge.node.format || edge.node.type,
      title: edge.node.title?.english || edge.node.title?.romaji || 'Related Series',
      comicType: mapCountryToComicType(edge.node.countryOfOrigin),
      coverUrl: proxyExternalImage(edge.node.coverImage?.large)
    }));

  const recommendations = (media?.recommendations?.nodes || [])
    .map((n) => n?.mediaRecommendation)
    .filter((rec) => rec && rec.type === 'MANGA' && (rec.title?.english || rec.title?.romaji))
    .slice(0, 8)
    .map((rec) => ({
      id: rec.id,
      anilistId: rec.id,
      title: rec.title?.english || rec.title?.romaji,
      score: rec.averageScore ? (rec.averageScore / 10).toFixed(1) : null,
      comicType: mapCountryToComicType(rec.countryOfOrigin),
      coverUrl: proxyExternalImage(rec.coverImage?.large)
    }));

  const subtypeLower = String(kitsu?.subtype || '').toLowerCase();
  const countryOfOrigin = media?.countryOfOrigin || (subtypeLower === 'manhwa' ? 'KR' : subtypeLower === 'manhua' ? 'CN' : null);

  return {
    anilistId: media?.id || (links?.al ? parseInt(links.al, 10) || null : null),
    malId: media?.idMal || links?.mal || null,
    kitsuId: links?.kt || kitsu?.id || null,
    muId: links?.mu || null,
    countryOfOrigin,
    comicType: mapCountryToComicType(countryOfOrigin),
    bannerUrl: anilistBanner || kitsu?.coverImage || null,
    coverUrlExtra: proxyExternalImage(media?.coverImage?.extraLarge || media?.coverImage?.large) || kitsu?.posterImage || null,
    anilistScore: media?.averageScore ? (media.averageScore / 10).toFixed(1) : kitsu?.averageRating || null,
    popularity: media?.popularity || null,
    totalChaptersKnown: media?.chapters || null,
    volumesKnown: media?.volumes || null,
    description: anilistDesc || kitsu?.synopsis || '',
    synonyms: Array.from(synonymSet).slice(0, 15),
    characters,
    relations,
    recommendations
  };
}

module.exports = {
  stripHtmlToText,
  proxyExternalImage,
  fetchAniListMedia,
  fetchKitsuFallback,
  fetchMangaUpdatesAliases,
  getEnrichedMetadata
};
