eimport axios from 'axios';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import vm from 'vm';

const DEFAULT_HOST = process.env.ANIMEPAHE_HOST || 'https://animepahe.si';
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

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
  return { html: resp.data, finalUrl: resp.request?.res?.responseUrl || url };
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

  // Prefer non AV1
  const nonAv1 = candidates.filter(b => b.av1 === '0');
  if (nonAv1.length) candidates = nonAv1;

  candidates.sort((a, b) =>
    (parseInt(b.resolution || '0', 10) - parseInt(a.resolution || '0', 10))
  );

  return candidates[0] || null;
}

export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('mirrorUrl is required');
  const norm = normalizeUrl(mirrorUrl);

  const { html: initialHtml } = await fetchHtmlAbsolute(norm, cookie, DEFAULT_HOST + '/');

  const redirectedHtml = await followMetaRefreshIfAny(initialHtml, cookie, norm);

  const html = redirectedHtml || initialHtml;

  const scripts = extractAllScripts(html);

  const chainResult = deobfuscateByEvalChain(scripts);

  const codeCorpus = [
    ...scripts,
    ...chainResult.capturedEvalStrings,
    chainResult.combinedEvalOutput
  ].join('\n\n/* ---- */\n\n');
  
  const playlist = extractPlaylistFromCorpus(codeCorpus) ||
                   extractPlaylistFromCorpus(html) ||
                   scanBase64ForPlaylist(codeCorpus) ||
                   scanBase64ForPlaylist(html);

  if (!playlist) {
    if (DEBUG) {
      throw new Error(
        'Playlist not found after heuristics. Debug payload: ' +
        JSON.stringify({
          evalStages: chainResult.stagesMeta.slice(0, 6),
          evalCount: chainResult.capturedEvalStrings.length,
          sampleCode: codeCorpus.slice(0, 600)
        }, null, 2)
      );
    }
    throw new Error('Playlist source (.m3u8) not discovered in mirror scripts');
  }

  return {
    playlist,
    debug: DEBUG ? {
      totalScripts: scripts.length,
      evalChainDepth: chainResult.stagesMeta.length,
      evalCaptured: chainResult.capturedEvalStrings.length,
      sampleEvalLeaf: chainResult.capturedEvalStrings.slice(-1)[0]?.slice(0, 400),
    } : undefined
  };
}

function deobfuscateByEvalChain(scriptBodies) {
  const capturedEvalStrings = [];
  const stagesMeta = [];
  
  const queue = scriptBodies
    .filter(s => /eval\(/.test(s) || /source\s*=/.test(s))
    .slice();

  const seen = new Set();

  while (queue.length) {
    const original = queue.shift();
    if (!original || seen.has(original)) continue;
    seen.add(original);

    const stageLogs = [];
    const nestedCaptured = [];
    const sandbox = makeSandbox(nestedCaptured, stageLogs);
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
      if (!seen.has(nested) && /eval\(/.test(nested)) {
        queue.push(nested);
      }
    }
  }

  return {
    capturedEvalStrings,
    stagesMeta,
    combinedEvalOutput: capturedEvalStrings.join('\n')
  };
}

function makeSandbox(nestedCaptured, stageLogs) {
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
    location: { href: 'https://kwik.si/' },
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
    } catch {
    }
  }
  return null;
}

function sanitizeUrl(u) {
  if (!u) return u;
  return u.replace(/&quot;?$/,'').replace(/['")\\]+$/,'').trim();
}

/* ================= Script Collection ================= */
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
