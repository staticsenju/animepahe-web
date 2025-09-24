import express from 'express';
import {
  searchAnime,
  fetchAllEpisodes,
  getEpisodeSessionForNumber,
  fetchPlayPage,
  parseButtonsFromPlayPage,
  pickLink
} from './animeService.js';

export const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ ok: true });
});

router.get('/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing query parameter q' });
  try {
    const results = await searchAnime(q);
    res.json({ total: results.length, results });
  } catch (err) {
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

router.get('/anime/:session/episodes', async (req, res) => {
  const { session } = req.params;
  if (!session) return res.status(400).json({ error: 'Missing session param' });
  const force = req.query.refresh === '1';
  try {
    const data = await fetchAllEpisodes(session, { force });
    res.json({
      session,
      total: data.episodes.length,
      last_page: data.last_page,
      episodes: data.episodes
    });
  } catch (err) {
    res.status(500).json({ error: 'Episodes fetch failed', detail: err.message });
  }
});

router.get('/anime/:session/episode/:number/links', async (req, res) => {
  const { session, number } = req.params;
  if (!session || !number) {
    return res.status(400).json({ error: 'Missing session or number param' });
  }
  const { resolution, audio } = req.query;

  try {
    const epSession = await getEpisodeSessionForNumber(session, number);
    if (!epSession) {
      return res.status(404).json({ error: 'Episode not found for that number' });
    }

    const html = await fetchPlayPage(session, epSession);
    const links = parseButtonsFromPlayPage(html);
    const chosen = pickLink(links, { resolution, audio });

    res.json({
      session,
      episode: Number(number),
      episodeSession: epSession,
      count: links.length,
      chosen,
      links
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve episode links', detail: err.message });
  }
});
