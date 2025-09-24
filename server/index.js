import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { resolveSessionFromNumeric } from './resolver.js';
import { upstream } from './upstream.js';
import {
  generateCookie,
  fetchPlayPage,
  extractButtons,
  chooseButton,
  fetchPlaylistFromMirror
} from './playExtractor.js';

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

app.get('/api/play/:slug/:epSession', async (req, res) => {
  const { slug, epSession } = req.params;
  const { resolution, audio, listOnly } = req.query;

  if (!slug || !epSession) {
    return res.status(400).json({ error: 'Missing slug or epSession' });
  }

  const cookie = generateCookie();
  let html;
  try {
    html = await fetchPlayPage(slug, epSession, cookie);
  } catch (e) {
    const status = e?.response?.status || 500;
    return res.status(status).json({
      error: 'Failed to fetch play page',
      details: e.message
    });
  }

  const buttons = extractButtons(html);
  if (!buttons.length) {
    return res.status(502).json({
      error: 'No mirrors found (buttons with data-src missing)',
      slug,
      epSession
    });
  }

  const selected = chooseButton(buttons, { audio, resolution });
  
  if (listOnly === 'true') {
    return res.json({
      slug,
      epSession,
      cookie,
      filters: { audio: audio || null, resolution: resolution || null },
      buttons,
      selected
    });
  }

  if (!selected) {
    return res.status(422).json({
      error: 'No suitable mirror after applying filters',
      filtersTried: { audio, resolution },
      available: buttons.map(b => ({
        src: b.src,
        resolution: b.resolution,
        audio: b.audio,
        av1: b.av1
      }))
    });
  }

  let playlistResult;
  try {
    playlistResult = await fetchPlaylistFromMirror(selected.src, cookie);
  } catch (e) {
    return res.status(502).json({
      error: 'Failed to extract playlist',
      mirror: selected.src,
      details: e.message
    });
  }

  res.json({
    slug,
    epSession,
    cookie,
    filters: { audio: audio || null, resolution: resolution || null },
    buttons,
    selected,
    playlist: playlistResult.playlist,
    debug: playlistResult.debug
  });
});

app.get('/api/stream', async (req, res) => {
  const episodeId = (req.query.episodeId || '').trim();
  const epSession = (req.query.session || '').trim();
  const looksLikeSessionHash = episodeId && episodeId.length > 40 && !epSession;


  if (!episodeId || !epSession) {
    return res.status(400).json({
      error: 'Missing required parameters: episodeId AND session are required',
      hint: looksLikeSessionHash
        ? 'You passed the episode session as episodeId. Provide the numeric episode id in episodeId and the long hash in session.'
        : 'Call /api/episodes first; each episode object has id (numeric) and session (hash).'
    });
  }

  try {
    const params = new URLSearchParams({ m: 'links', id: episodeId, session: epSession });
    console.log('STREAM QUERY', params.toString());
    const { data } = await upstream.get('?' + params.toString());
    res.json(data);
  } catch (e) {
    if (e?.response) {
      return res.status(e.response.status).json({
        error: 'Failed to fetch stream links',
        upstreamStatus: e.response.status,
        upstreamBody: e.response.data
      });
    }
    if (e?.code === 'ECONNABORTED') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    res.status(500).json({ error: 'Failed to fetch stream links' });
  }
});
app.get('/api/hls', async (req, res) => {
  const targetEnc = req.query.u;
  const cookieRaw = req.query.c || '';
  const range = req.headers.range || '';

  if (!targetEnc) {
    return res.status(400).json({ error: 'Missing u parameter' });
  }

  let target;
  try {
    target = decodeURIComponent(targetEnc);
  } catch {
    return res.status(400).json({ error: 'Invalid encoded URL' });
  }

  if (!/^https?:\/\//i.test(target)) {
    return res.status(400).json({ error: 'Only absolute http/https URLs allowed' });
  }

  const isManifest = /\.m3u8(\?|$)/i.test(target);
  const base = target.split('/').slice(0, -1).join('/');

  try {
    const upstream = await axios.get(target, {
      responseType: isManifest ? 'text' : 'arraybuffer',
      timeout: 25000,
      headers: {
        'User-Agent': process.env.USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Referer': 'https://kwik.si/',
        'Origin': 'https://kwik.si',
        'Accept': isManifest
          ? 'application/vnd.apple.mpegurl,text/plain;q=0.9,*/*;q=0.8'
          : '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(cookieRaw ? { 'Cookie': cookieRaw } : {}),
        ...(range ? { 'Range': range } : {})
      },
      validateStatus: s => s >= 200 && s < 400,
      maxRedirects: 5
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, Range, Accept, User-Agent');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Length, Accept-Ranges');
    if (upstream.headers['accept-ranges']) {
      res.setHeader('Accept-Ranges', upstream.headers['accept-ranges']);
    }

    if (!isManifest) {
      const ct = upstream.headers['content-type'] || 'application/octet-stream';
      res.setHeader('Content-Type', ct);
      if (upstream.status === 206) res.status(206);
      return res.send(upstream.data);
    }

    const rewritten = rewriteManifest(upstream.data, base, cookieRaw);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    return res.send(rewritten);
  } catch (e) {
    const status = e?.response?.status || 502;
    return res.status(status).json({
      error: 'Upstream fetch failed',
      status,
      details: e.message
    });
  }
});

function rewriteManifest(text, base, cookieRaw) {
  const lines = text.split(/\r?\n/);
  return lines.map(line => {
    if (!line || line.startsWith('#')) {
      if (/^#EXT-X-KEY/i.test(line)) {
        return line.replace(/URI="([^"]+)"/i, (m, g1) => {
          const abs = absolutize(g1, base);
          return 'URI="' + proxyLink(abs, cookieRaw) + '"';
        });
      }
      return line;
    }
    const abs = absolutize(line.trim(), base);
    return proxyLink(abs, cookieRaw);
  }).join('\n');
}

function proxyLink(abs, cookieRaw) {
  return '/api/hls?u=' + encodeURIComponent(abs) + (cookieRaw ? '&c=' + encodeURIComponent(cookieRaw) : '');
}

function absolutize(ref, base) {
  if (!ref) return ref;
  if (/^https?:\/\//i.test(ref)) return ref;
  if (ref.startsWith('//')) return 'https:' + ref;
  if (ref.startsWith('/')) {
    const origin = base.split('/').slice(0, 3).join('/');
    return origin + ref;
  }
  return base + '/' + ref.replace(/^\.\//, '');
}

app.get('/api/health', (_, res) => res.json({ ok: true }));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
