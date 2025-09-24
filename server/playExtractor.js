import axios from 'axios';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import vm from 'vm';

const DEFAULT_HOST = process.env.ANIMEPAHE_HOST || 'https://animepahe.si';
const UA = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const DEBUG = !!process.env.DEBUG_PLAYLIST_EXTRACTION;

export function generateCookie() {
  const raw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `__ddg2_=${raw}`;
}

function httpForAnime(cookie) {
  return axios.create({
    baseURL: DEFAULT_HOST,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': DEFAULT_HOST + '/',
      'Cookie': cookie
    },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 400
  });
}

async function fetchHtmlAbsolute(url, cookie, referer) {
  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': referer || DEFAULT_HOST + '/',
    'Cookie': cookie
  };
  const resp = await axios.get(url, {
    headers,
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: s => s >= 200 && s < 400
  });
  const setCookies = resp.headers['set-cookie'] || [];
  return { html: resp.data, finalUrl: resp.request?.res?.responseUrl || url, setCookies };
}

export async function fetchPlayPage(slug, episodeSession, cookie) {
  const http = httpForAnime(cookie);
  const path = `/play/${slug}/${episodeSession}`;
  const { data } = await http.get(path);
  return data;
}

export function extractButtons(html) {
  const $ = cheerio.load(html);
  const buttons = [];
  $('button[data-src]').each((_, el) => {
    const a = el.attribs || {};
    buttons.push({
      src: a['data-src'],
      resolution: a['data-resolution'] || '',
      audio: a['data-audio'] || '',
      av1: a['data-av1'] || '',
      rawAttributes: a
    });
  });
  return buttons;
}

export function chooseButton(buttons, { audio, resolution }) {
  if (!buttons || !buttons.length) return null;
  let candidates = buttons.slice();
  if (audio) {
    const audFiltered = candidates.filter(b => b.audio === audio);
    if (audFiltered.length) candidates = audFiltered;
  }
  if (resolution) {
    const resFiltered = candidates.filter(b => b.resolution === resolution);
    if (resFiltered.length) candidates = resFiltered;
  }
  const nonAv1 = candidates.filter(b => b.av1 === '0');
  if (nonAv1.length) candidates = nonAv1;
  candidates.sort((a, b) => (parseInt(b.resolution || '0', 10) - parseInt(a.resolution || '0', 10)));
  return candidates[0] || null;
}

export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('mirrorUrl is required');
  const norm = normalizeUrl(mirrorUrl);
  const origin = new URL(norm).origin;
  const { html: initialHtml, setCookies: sc1 } = await fetchHtmlAbsolute(norm, cookie, DEFAULT_HOST + '/');
  const redirectedHtml = await followMetaRefreshIfAny(initialHtml, cookie, norm);
  const html = redirectedHtml || initialHtml;
  const scripts = extractAllScripts(html);
  const chainResult = deobfuscateByEvalChain(scripts, origin);
  const codeCorpus = [
    ...scripts,
    ...chainResult.capturedEvalStrings,
    chainResult.combinedEvalOutput
  ].join('\n\n/* ---- */\n\n');
  const primary = extractPlaylistFromCorpus(codeCorpus) ||
                  extractPlaylistFromCorpus(html) ||
                  scanBase64ForPlaylist(codeCorpus) ||
                  scanBase64ForPlaylist(html);
  const allCandidates = collectAllM3u8s(codeCorpus, html);
  if (primary && !allCandidates.includes(primary)) allCandidates.unshift(primary);
  const unique = [...new Set(allCandidates)];
  const evaluated = await evaluateCandidates(unique.slice(0, 12));
  const best = pickBestPlaylist(evaluated);
  if (!best) {
    if (DEBUG) {
      throw new Error('No viable video playlist. Candidates=' + JSON.stringify(evaluated, null, 2));
    }
    throw new Error('Playlist source (.m3u8) not discovered or all candidates are non-video');
  }
  return {
    playlist: best.url,
    classification: best.kind,
    candidatesTried: evaluated.map(e => ({ url: e.url, kind: e.kind })),
    debug: DEBUG ? {
      totalScripts: scripts.length,
      evalChainDepth: chainResult.stagesMeta.length,
      evalCaptured: chainResult.capturedEvalStrings.length
    } : undefined
  };
}

function deobfuscateByEvalChain(scriptBodies, originHref) {
  const capturedEvalStrings = [];
  const stagesMeta = [];
  const queue = scriptBodies.filter(s => /eval\(/.test(s) || /source\s*=/.test(s)).slice();
  const seen = new Set();
  while (queue.length) {
    const original = queue.shift();
    if (!original || seen.has(original)) continue;
    seen.add(original);
    const stageLogs = [];
    const nestedCaptured = [];
    const sandbox = makeSandbox(nestedCaptured, stageLogs, originHref);
    const prepared = original;
    let error = null;
    try {
      vm.runInNewContext(prepared, sandbox, { timeout: 3000 });
    } catch (e) {
      error = e;
    }
    stagesMeta.push({
      inputSnippet: original.slice(0, 140),
      logsSnippet: stageLogs.slice(0, 6).join('\n').slice(0, 300),
      nestedCount: nestedCaptured.length,
      error: error ? (error.message || String(error)) : null
    });
    for (const nested of nestedCaptured) {
      capturedEvalStrings.push(nested);
      if (!seen.has(nested) && /eval\(/.test(nested)) queue.push(nested);
    }
  }
  return {
    capturedEvalStrings,
    stagesMeta,
    combinedEvalOutput: capturedEvalStrings.join('\n')
  };
}

function makeSandbox(nestedCaptured, stageLogs, originHref = 'https://kwik.si/') {
  const sandbox = {
    console: {
      log: (...args) => {
        stageLogs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      }
    },
    eval: (arg) => {
      try {
        if (typeof arg === 'string') {
          nestedCaptured.push(arg);
          try {
            return vm.runInNewContext(arg, sandbox, { timeout: 3000 });
          } catch (inner) {
            stageLogs.push('[eval-exec-error] ' + inner.message);
          }
          return arg;
        }
        return arg;
      } catch (e) {
        stageLogs.push('[eval-error] ' + e.message);
        return undefined;
      }
    },
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    window: {},
    document: {
      querySelector: () => ({ click: () => {}, remove: () => {} }),
      createElement: () => ({ style: {}, appendChild: () => {} }),
      body: { appendChild: () => {} }
    },
    navigator: { userAgent: UA },
    atob: (b64) => Buffer.from(b64, 'base64').toString('utf8'),
    btoa: (str) => Buffer.from(str, 'utf8').toString('base64'),
    crypto: {},
    location: { href: originHref },
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

const PLAYLIST_REGEXES = [
  /source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
  /['"]([^'"]+\.m3u8[^'"]*)['"]\s*[,;)]/i,
  /\bfile\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
  /\bsrc\s*:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
  /\burl\s*[:=]\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i,
  /PLAYLIST\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i
];

function extractPlaylistFromCorpus(text) {
  if (!text) return null;
  for (const rx of PLAYLIST_REGEXES) {
    const m = text.match(rx);
    if (m && m[1]) {
      return sanitizeUrl(m[1]);
    }
  }
  return null;
}

function scanBase64ForPlaylist(text) {
  if (!text) return null;
  const candidates = text.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const c of candidates.slice(0, 200)) {
    try {
      const decoded = Buffer.from(c, 'base64').toString('utf8');
      if (/\.m3u8/i.test(decoded)) {
        const pl = extractPlaylistFromCorpus(decoded) ||
                   decoded.match(/https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/i)?.[0];
        if (pl) return sanitizeUrl(pl);
      }
    } catch {}
  }
  return null;
}

function sanitizeUrl(u) {
  if (!u) return u;
  return u.replace(/&quot;?$/,'').replace(/['")\\]+$/,'').trim();
}

function extractAllScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = (m[1] || '').trim();
    if (body) out.push(body);
  }
  return out;
}

async function followMetaRefreshIfAny(html, cookie, refererUrl) {
  const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/i);
  if (!meta) return null;
  const urlMatch = meta[0].match(/url=([^"'>\s]+)/i);
  if (!urlMatch) return null;
  const target = urlMatch[1];
  let absolute = target;
  if (!/^https?:/i.test(absolute)) {
    const base = refererUrl.split('/').slice(0, 3).join('/');
    absolute = base + (target.startsWith('/') ? target : '/' + target);
  }
  const { html: followHtml } = await fetchHtmlAbsolute(absolute, cookie, refererUrl);
  return followHtml;
}

function normalizeUrl(u) {
  if (u.startsWith('//')) return 'https:' + u;
  if (!/^https?:/i.test(u)) {
    if (u.startsWith('/')) return 'https://kwik.si' + u;
    return 'https://kwik.si/' + u.replace(/^\/+/, '');
  }
  return u;
}

function collectAllM3u8s(...texts) {
  const out = [];
  for (const t of texts) {
    if (!t) continue;
    const matches = t.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi);
    if (matches) out.push(...matches.map(sanitizeUrl));
  }
  return out;
}

async function evaluateCandidates(urls) {
  const results = [];
  for (const url of urls) {
    try {
      const { data } = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          'Referer': new URL(url).origin + '/',
          'Accept': 'application/vnd.apple.mpegurl,text/plain;q=0.9,*/*;q=0.8'
        },
        timeout: 12000,
        responseType: 'text',
        validateStatus: s => s >= 200 && s < 400
      });
      const kind = classifyPlaylistText(data);
      results.push({ url, kind });
      if (kind === 'video-media' || kind === 'master') continue;
    } catch (e) {
      results.push({ url, kind: 'error:' + (e.code || e.message) });
    }
  }
  return results;
}

function classifyPlaylistText(text) {
  if (!/^#EXTM3U/.test(text.trim())) return 'not-playlist';
  if (/#EXT-X-STREAM-INF/i.test(text)) return 'master';
  const lines = text.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  const exts = lines.map(l => l.split(/[?#]/)[0].toLowerCase());
  const hasVideoSeg = exts.some(e => /\.(ts|m4s|mp4|aac)$/.test(e));
  const hasImages = exts.some(e => /\.(jpe?g|png|webp)$/.test(e));
  if (hasVideoSeg) return 'video-media';
  if (hasImages && !hasVideoSeg) return 'image-media';
  return 'unknown-media';
}

function pickBestPlaylist(evaluated) {
  const order = ['master', 'video-media', 'unknown-media', 'image-media'];
  evaluated.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return evaluated.find(e => e.kind === 'master') ||
         evaluated.find(e => e.kind === 'video-media') ||
         null;
}

export { classifyPlaylistText };
