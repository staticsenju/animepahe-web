import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3001;
const API_BASE = 'https://animepahe.si/api';

app.use(cors());

app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'Missing query' });
  try {
    const response = await axios.get(`${API_BASE}?m=search&q=${encodeURIComponent(q)}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch search results' });
  }
});

// List episodes by anime id
app.get('/api/episodes', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing anime id' });
  try {
    const response = await axios.get(`${API_BASE}?m=release&id=${encodeURIComponent(id)}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch episodes' });
  }
});

app.get('/api/stream', async (req, res) => {
  const { episodeId } = req.query;
  if (!episodeId) return res.status(400).json({ error: 'Missing episode id' });
  try {
    const response = await axios.get(`${API_BASE}?m=links&id=${encodeURIComponent(episodeId)}`);
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stream link' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

