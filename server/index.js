import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { resolveSessionFromNumeric } from './resolver.js';
import { upstream } from './upstream.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3001;

const app = express();

app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*'
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

function sendUpstreamError(res, err, fallback) {
  if (err?.response) {
    return res.status(err.response.status).json({
      error: fallback,
      upstreamStatus: err.response.status,
      upstreamBody: err.response.data
    });
  }
  if (err?.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Upstream timeout' });
  }
  return res.status(500).json({ error: fallback });
}

// Simple in-memory full episodes cache
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
    const isNumeric = /^[0-9]+$/.test(token);
    if (isNumeric) {
      try {
        token = await resolveSessionFromNumeric(token);
      } catch (resolveErr) {
        const upstreamStatus = resolveErr?.response?.status;
        if (upstreamStatus === 403) {
          return res.status(403).json({
            error: 'Upstream blocked numeric id lookup (403). Use session from /api/search instead.',
            detail: resolveErr.message
          });
        }
        return res.status(400).json({
            error: 'Unable to resolve numeric id to session. Use /api/search to obtain the session token.',
            detail: resolveErr.message
        });
      }
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
    episodesCache.set(token, { episodes, last_page, cachedAt: Date.now() });

    res.json({
      session: token,
      total: episodes.length,
      last_page,
      episodes,
      cached: false
    });
  } catch (err) {
    if (err?.response?.status === 403) {
      return res.status(403).json({
        error: 'Forbidden by upstream while fetching episodes (possible anti-bot). Try again or switch session.',
        upstreamStatus: 403
      });
    }
    sendUpstreamError(res, err, 'Could not retrieve episodes');
  }
});
app.get('/api/stream', async (req, res) => {
  const episodeId = (req.query.episodeId || '').trim();
  const epSession = (req.query.session || '').trim();

  if (!episodeId || !epSession) {
    return res.status(400).json({
      error: 'Missing required parameters: episodeId AND session are both needed'
    });
  }

  try {
    const params = new URLSearchParams({ m: 'links', id: episodeId, session: epSession });
    const { data } = await upstream.get('?' + params.toString());
    res.json(data);
  } catch (e) {
    sendUpstreamError(res, e, 'Failed to fetch stream links');
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
