import axios from 'axios';
import { apiGet, HOST } from './upstream.js';

const searchCache = new Map();
const animeEpisodesCache = new Map();

export async function searchAnime(query) {
  const q = query.trim();
  if (!q) return [];
  const key = q.toLowerCase();
  if (searchCache.has(key)) return searchCache.get(key);

  const data = await apiGet({ m: 'search', q });
  const results = (data?.data || []).map(item => ({
    id: item.id,
    session: item.session,
    title: item.title,
    type: item.type,
    episodes: item.episodes
  }));
  searchCache.set(key, results);
  return results;
}

// Fetch all episodes for a session (paginate)
export async function fetchAllEpisodes(animeSession, { force = false } = {}) {
  if (!force && animeEpisodesCache.has(animeSession)) {
    return animeEpisodesCache.get(animeSession);
  }

  const first = await apiGet({
    m: 'release',
    id: animeSession,
    sort: 'episode_asc',
    page: 1
  });

  const episodes = first?.data || [];
  const lastPage = first?.last_page || 1;

  for (let p = 2; p <= lastPage; p++) {
    const pageData = await apiGet({
      m: 'release',
      id: animeSession,
      sort: 'episode_asc',
      page: p
    });
    if (Array.isArray(pageData?.data)) {
      episodes.push(...pageData.data);
    }
  }

  const payload = {
    episodes,
    last_page: lastPage,
    cachedAt: Date.now()
  };
  animeEpisodesCache.set(animeSession, payload);
  return payload;
}

// Find episode's session by episode number
export async function getEpisodeSessionForNumber(animeSession, episodeNumber) {
  const cache = await fetchAllEpisodes(animeSession);
  const ep = cache.episodes.find(e => Number(e.episode) === Number(episodeNumber));
  return ep ? ep.session : null;
}

// Fetch /play page HTML
export async function fetchPlayPage(animeSession, episodeSession) {
  const url = `${HOST}/play/${animeSession}/${episodeSession}`;
  const { data } = await axios.get(url, {
    headers: {
      'User-Agent': 'animepahe-web/1.0',
      'Referer': HOST
    }
  });
  return data;
}

// Parse <button ... data-src="..."> elements; gather data-* attributes
export function parseButtonsFromPlayPage(html) {
  const results = [];
  if (typeof html !== 'string') return results;

  const buttonRegex = /<button\b[^>]*data-src="([^"]+)"[^>]*>/gi;
  const attrRegex = /\s(data-[a-z0-9_-]+)="([^"]*)"/gi;

  let m;
  while ((m = buttonRegex.exec(html)) !== null) {
    const tag = m[0];
    const obj = { url: m[1] };
    let a;
    while ((a = attrRegex.exec(tag)) !== null) {
      const attrName = a[1]; // e.g. data-resolution
      const val = a[2];
      const key = attrName
        .replace(/^data-/, '')
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase()); // camelCase
      obj[key] = val;
    }
    results.push(obj);
  }
  return results;
}

export function pickLink(links, { audio, resolution } = {}) {
  if (!Array.isArray(links) || links.length === 0) return null;
  let filtered = links.slice();

  if (audio) {
    const aFiltered = filtered.filter(l => (l.audio || l.language) === audio);
    if (aFiltered.length) filtered = aFiltered;
  }

  if (resolution) {
    const rFiltered = filtered.filter(l => (l.resolution || l.quality) === String(resolution));
    if (rFiltered.length) filtered = rFiltered;
  }

  filtered.sort((a, b) => {
    const ra = parseInt(a.resolution || a.quality || '0', 10);
    const rb = parseInt(b.resolution || b.quality || '0', 10);
    return rb - ra;
  });

  return filtered[0];
}
