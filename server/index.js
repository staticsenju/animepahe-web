import express from 'express';
import axios from 'axios';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = process.env.PORT || 3001;
const API_BASE = process.env.ANIME_API_BASE || 'https://animepahe.si/api';

const app = express();

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*'
}));
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, '..', 'public')));

const upstream = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
  headers: {
    'User-Agent': 'animepahe-proxy/1.0 (+https://github.com/staticsenju/animepahe-web)'
  }
});

const limiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', limiter);

function sendUpstreamError(res, err, fallbackMessage) {
  if (err.response) {
    return res.status(err.response.status).json({
      error: fallbackMessage,
      upstreamStatus: err.response.status,
      upstreamData: err.response.data
    });
  }
  if (err.code === 'ECONNABORTED') {
    return res.status(504).json({ error: 'Upstream timeout' });
  }
  return res.status(500).json({ error: fallbackMessage });
}

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  const page = req.query.page ? Number(req.query.page) : undefined;
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
  try {
    const params = new URLSearchParams({ m: 'search', q });
    if (page && page > 1) params.append('page', page.toString());
    const { data } = await upstream.get(`?${params.toString()}`);
    res.json(data);
  } catch (err) {
    sendUpstreamError(res, err, 'Failed to fetch search results');
  }
});

app.get('/api/episodes', async (req, res) => {
  const id = (req.query.id || '').toString().trim();
  const page = req.query.page ? Number(req.query.page) : undefined;
  if (!id) return res.status(400).json({ error: 'Missing anime id' });
  try {
    const params = new URLSearchParams({ m: 'release', id });
    if (page && page > 1) params.append('page', page.toString());
    const { data } = await upstream.get(`?${params.toString()}`);
    res.json(data);
  } catch (err) {
    sendUpstreamError(res, err, 'Failed to fetch episodes');
  }
});

app.get('/api/stream', async (req, res) => {
  const episodeId = (req.query.episodeId || '').toString().trim();
  if (!episodeId) return res.status(400).json({ error: 'Missing episodeId' });
  try {
    const params = new URLSearchParams({ m: 'links', id: episodeId });
    const { data } = await upstream.get(`?${params.toString()}`);
    res.json(data);
  } catch (err) {
    sendUpstreamError(res, err, 'Failed to fetch stream link');
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
