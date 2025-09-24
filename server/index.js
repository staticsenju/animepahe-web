import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { resolveSessionFromNumeric } from './resolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const API_BASE = process.env.ANIME_API_BASE || 'https://animepahe.si/api';

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*'
}));
app.use(express.json());

app.use(express.static(path.join(__dirname, '..', 'public')));

const upstream = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: { 'User-Agent': 'animepahe-proxy/1.0 (+https://github.com/staticsenju/animepahe-web)' }
});

function sendUpstreamError(res, err, fallback) {
  if (err?.response) {
    return res.status(err.response.status).json({
      error: fallback,
      upstreamStatus: err.response.status
    });
  }
  if (err?.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Upstream timeout' });
  }
  return res.status(500).json({ error: fallback });
}

const episodesCache = new Map();

async function fetchAllEpisodes(session) {
  const firstParams = new URLSearchParams({
    m: 'release',
    id: session,
    sort: 'episode_asc',
    page: '1'
  });
  const { data: first } = await upstream.get('?' + firstParams.toString());
  const episodes = Array.isArray(first?.data) ? [...first.data] : [];
  const lastPage = first?.last_page || 1;

  for (let p = 2; p <= lastPage; p++) {
    const params = new URLSearchParams({
      m: 'release',
      id: session,
      sort: 'episode_asc',
      page: String(p)
    });
    const { data } = await upstream.get('?' + params.toString());
    if (Array.isArray(data?.data)) episodes.push(...data.data);
  }

  return { episodes, last_page: lastPage };
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  const page = req.query.page;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
  try {
    const params = new URLSearchParams({ m: 'search', q });
    if (page) params.append('page', page);
    const { data } = await upstream.get('?' + params.toString());
    res.json(data);
  } catch (e) {
    sendUpstreamError(res, e, 'Failed to fetch search results');
  }
});

app.get('/api/episodes', async (req, res) => {
  let token = (req.query.id || req.query.session || '').trim();
  const refresh = req.query.refresh === '1';

  if (!token) {
    return res.status(400).json({ error: 'Missing anime id or session (?id= or ?session=)' });
  }

  try {
    if (/^[0-9]+$/.test(token)) {
      token = await resolveSessionFromNumeric(token);
    }

    if (!refresh && episodesCache.has(token)) {
      const cached = episodesCache.get(token);
      return res.json({
        session: token,
        total: cached.episodes.length,
        last_page: cached.last_page,
        episodes: cached.episodes,
        cached: true
      });
    }

    const { episodes, last_page } = await fetchAllEpisodes(token);

    const payload = {
      session: token,
      total: episodes.length,
      last_page,
      episodes
    };
    episodesCache.set(token, {
      episodes,
      last_page,
      cachedAt: Date.now()
    });

    res.json(payload);
  } catch (err) {
    if (err?.response?.status === 404) {
      return res.status(404).json({ error: 'Anime not found', detail: err.message });
    }
    res.status(500).json({ error: 'Could not retrieve episodes', detail: err.message });
  }
});

app.get('/api/stream', async (req, res) => {
  const episodeId = (req.query.episodeId || '').trim();
  if (!episodeId) return res.status(400).json({ error: 'Missing episodeId' });
  try {
    const params = new URLSearchParams({ m: 'links', id: episodeId });
    const { data } = await upstream.get('?' + params.toString());
    res.json(data);
  } catch (e) {
    sendUpstreamError(res, e, 'Failed to fetch stream link');
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
