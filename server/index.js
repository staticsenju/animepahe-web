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
  let token = (req.query.id || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing anime id' });

  try {
    if (/^[0-9]+$/.test(token)) {
      token = await resolveSessionFromNumeric(token);
    }
    const params = new URLSearchParams({ m: 'release', id: token, sort: 'episode_asc' });
    const { data } = await upstream.get('?' + params.toString());
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Could not retrieve episodes', detail: err.message });
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
