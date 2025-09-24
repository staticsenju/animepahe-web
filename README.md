# animepahe-web

A minimal, self‑hosted web UI plus backend proxy for searching anime, listing episodes, and streaming HLS playlists extracted from Animepahe mirrors.  
The frontend is a single-page experience: search (poster grid) → select title → player view (episodes grid + mirrors + subtitles).

> WARNING: `/api/hls` is currently a wide‑open proxy that will fetch ANY external http(s) URL and rewrite manifests. This is convenient for development but unsafe for production without host allow‑listing and limits.

---

## Features

- Poster grid search interface
- Episode retrieval and grid
- Mirror enumeration (listOnly flow)
- Resolution + audio selector with re-fetch
- HLS playlist proxy + manifest rewriting
- Subtitle track extraction (WEBVTT auto wrapper)
- Autoplay next episode
- Mirror panel overlay
- Zero build tooling (vanilla JS + Hls.js CDN)

---


Key endpoints:
- `GET /api/search?q=...`
- `GET /api/episodes?id=<session|numeric>`
- `GET /api/play/:slug/:epSession?listOnly=true`
- `GET /api/play/:slug/:epSession?resolution=&audio=`
- `GET /api/hls?u=<encoded-absolute-url>&c=<cookie>` 

---

## Quick Start
clone the repo:

```bash
git clone https://github.com/staticsenju/animepahe-web
```

Install & run:

```bash
npm i
npm start
```
Visit: http://localhost:3001/

---

## Usage Flow

1. Search a title.
2. Click a result → episodes load.
3. First episode auto-resolves default mirror.
4. Adjust Resolution / Audio → Apply.
5. Open Mirrors panel to pick an explicit mirror.
6. Select subtitle track if present.

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Express port | 3001 |
| CORS_ORIGIN | Allowed origins or `*` | * |
| USER_AGENT | Override upstream UA | Internal fallback |

(You can add these via `.env` and load with a simple dotenv import if desired.)

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| Video not playing | Mirror broken or playlist 403 | Pick different mirror, check Network tab |
| No subtitles | Mirror has none | Try another mirror |
| 404 on episodes | Wrong id/session | Inspect network response payloads |
| High memory | Many large playlists proxied | Implement caching + limits |
| CORS errors | Origin mismatch | Set proper `CORS_ORIGIN` |

---

## Roadmap Ideas

- Host allow-list + SSRF safeguards
- Rate limiting & caching
- Persist user subtitle / resolution preference
- Episode progress saving
- Service worker caching
- Search suggestions (debounced incremental)

---

## License
This project is licensed under the MIT License - see the LICENSE file for details.

---

## Disclaimer

For personal/educational use. Ensure compliance with upstream site terms and applicable law before deployment.
