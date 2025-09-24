import axios from 'axios';
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
  const resp = await axios.get(`${DEFAULT_HOST}/play/${slug}/${episodeSession}`, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': DEFAULT_HOST + '/',
      'Cookie': cookie
    },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 400
  });
  return resp.data;
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
    const aud = candidates.filter(b => b.audio === audio);
    if (aud.length) candidates = aud;
  }
  if (resolution) {
    const res = candidates.filter(b => b.resolution === resolution);
    if (res.length) candidates = res;
  }
  const nonAv1 = candidates.filter(b => b.av1 === '0');
  if (nonAv1.length) candidates = nonAv1;
  candidates.sort((a, b) => (parseInt(b.resolution || '0', 10) - parseInt(a.resolution || '0', 10)));
  return candidates[0];
}

/* ===================== Core Extraction ===================== */

export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('mirrorUrl is required');
  const normalizedMirror = normalizeUrl(mirrorUrl);
  const origin = new URL(normalizedMirror).origin;

  const { html: initialHtml } = await fetchHtmlAbsolute(normalizedMirror, cookie, DEFAULT_HOST + '/');
  const redirectedHtml = await followMetaRefreshIfAny(initialHtml, cookie, normalizedMirror);
  const pageHtml = redirectedHtml || initialHtml;

  const scripts = extractAllScripts(pageHtml);

  // 1. Static packer unpack pass (inspiration from bash script)
  const unpackedPieces = scripts.flatMap(s => unpackAllPacker(s));

  // 2. Collect candidates from unpacked static code first
  const staticCorpus = unpackedPieces.join('\n/* --- */\n');
  const fromStatic = collectAllCandidates(staticCorpus);

  // 3. Dynamic eval-chain (fallback / augment)
  const chainResult = deobfuscateByEvalChain(scripts, origin);
  const dynamicCorpus = [
    ...chainResult.capturedEvalStrings,
    chainResult.combinedEvalOutput
  ].join('\n/* DYN */\n');

  const fromDynamic = collectAllCandidates(dynamicCorpus);

  // 4. Total candidate set
  const allCandidatesSet = new Set([...fromStatic, ...fromDynamic]);
  if (DEBUG) console.log('[EXTRACT] rawCandidates', [...allCandidatesSet]);

  if (!allCandidatesSet.size) {
    throw new Error('no_candidates_found');
  }

  // 5. Deduplicate & normalize
  const candidates = [...allCandidatesSet]
    .map(sanitizeUrl)
    .filter(u => u && /\.m3u8/i.test(u));

  if (!candidates.length) throw new Error('no_m3u8_candidates');

  // 6. Evaluate & classify
  const evaluated = await evaluateCandidates(candidates.slice(0, 18));

  if (DEBUG) {
    console.log('[EXTRACT] evaluatedKinds',
      evaluated.map(e => ({ kind: e.kind, url: e.url.slice(0, 90) })));
  }

  const best = pickBestPlaylist(evaluated);

  if (!best) {
    if (DEBUG) console.log('[EXTRACT] no non-image playlist found');
    throw new Error('no_viable_video_playlist');
  }

  return {
    playlist: best.url,
    classification: best.kind,
    evaluated: DEBUG ? evaluated : undefined,
    debug: DEBUG ? {
      totalScripts: scripts.length,
      unpackedCount: unpackedPieces.length,
      evalChainDepth: chainResult.stagesMeta.length,
      evalCaptured: chainResult.capturedEvalStrings.length
    } : undefined
  };
}

/* ===================== Packer Unpacker ===================== */

const PACKER_RE = /eval\(function\(p,a,c,k,e,d\)\{([\s\S]*?)\}\((['"])(.*?)\2\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])(.*?)\6\.split\('\|'\)\s*,\s*0\s*,\s*\{\}\)\);?/g;

function unpackSinglePacker(match, body, pQuote, pPayload, aVal, cVal, kQuote, kList) {
  try {
    const a = parseInt(aVal, 10);
    const c = parseInt(cVal, 10);
    const k = kList.split('|');
    // Basic guard
    if (!pPayload || !k.length || isNaN(a) || isNaN(c)) return null;
    // Replace tokens
    let decoded = pPayload;
    // Some packers escape backslashes; unescape common sequences
    decoded = decoded.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    // Token replacement function replicating base conversion
    for (let i = c; i >= 0; i--) {
      const baseToken = i.toString(a);
      if (k[i]) {
        const rx = new RegExp(`\\b${baseToken}\\b`, 'g');
        decoded = decoded.replace(rx, k[i]);
      }
    }
    return decoded;
  } catch {
    return null;
  }
}

function unpackAllPacker(src) {
  const outputs = [src];
  let last = src;
  let changed = true;
  while (changed) {
    changed = false;
    const nextFragments = [];
    last.replace(PACKER_RE, (...args) => {
      const unpacked = unpackSinglePacker(...args);
      if (unpacked && unpacked !== last) {
        changed = true;
        nextFragments.push(unpacked);
      }
      return '';
    });
    if (changed) {
      nextFragments.forEach(f => {
        outputs.push(f);
        last = f;
      });
    }
  }
  return outputs;
}

/* ===================== Dynamic Eval Chain ===================== */

function deobfuscateByEvalChain(scriptBodies, originHref) {
  const capturedEvalStrings = [];
  const stagesMeta = [];
  const queue = scriptBodies.filter(s => /eval\(/.test(s)).slice();
  const seen = new Set();
  while (queue.length) {
    const original = queue.shift();
    if (!original || seen.has(original)) continue;
    seen.add(original);
    const stageLogs = [];
    const nestedCaptured = [];
    const sandbox = makeSandbox(nestedCaptured, stageLogs, originHref);
    let error = null;
    try {
      vm.runInNewContext(original, sandbox, { timeout: 2500 });
    } catch (e) {
      error = e;
    }
    stagesMeta.push({
      snippet: original.slice(0, 140),
      logs: stageLogs.slice(0, 3),
      nested: nestedCaptured.length,
      error: error ? (error.message || String(error)) : null
    });
    for (const nested of nestedCaptured) {
      capturedEvalStrings.push(nested);
      if (/eval\(/.test(nested) && !seen.has(nested)) queue.push(nested);
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
      if (typeof arg === 'string') {
        nestedCaptured.push(arg);
        try {
          return vm.runInNewContext(arg, sandbox, { timeout: 1500 });
        } catch (e) {
          stageLogs.push('[eval-error] ' + e.message);
        }
      }
      return undefined;
    },
    window: {},
    document: {
      querySelector: () => ({ click: () => {}, remove: () => {} }),
      createElement: () => ({ style: {}, appendChild: () => {} }),
      body: { appendChild: () => {} }
    },
    navigator: { userAgent: UA },
    atob: (b64) => Buffer.from(b64, 'base64').toString('utf8'),
    btoa: (str) => Buffer.from(str, 'utf8').toString('base64'),
    location: { href: originHref },
    setTimeout: (fn) => { try { fn(); } catch {} },
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  return sandbox;
}

/* ===================== Candidate Harvest ===================== */

function collectAllCandidates(text) {
  if (!text) return [];
  const out = new Set();

  // 1. Raw .m3u8 URLs
  (text.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi) || [])
    .forEach(u => out.add(sanitizeUrl(u)));

  // 2. source= / q= assignments
  (text.match(/\b(?:var|let|const)?\s*(?:source|q)\s*=\s*['"][^'"]+\.m3u8[^'"]*['"]/gi) || [])
    .forEach(line => {
      const m = line.match(/['"]([^'"]+\.m3u8[^'"]*)['"]/);
      if (m && m[1]) out.add(sanitizeUrl(m[1]));
    });

  // 3. Base64 decode scan
  const candidates = text.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const c of candidates.slice(0, 150)) {
    try {
      const decoded = Buffer.from(c, 'base64').toString('utf8');
      if (/\.m3u8/i.test(decoded)) {
        const u = decoded.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/i)?.[0];
        if (u) out.add(sanitizeUrl(u));
      }
    } catch {}
  }

  return [...out];
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
      const text = data.toString();
      const kind = classifyPlaylistText(text);
      results.push({
        url,
        kind,
        firstLines: DEBUG ? text.split(/\r?\n/).slice(0, 6).join('\n') : undefined
      });
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
  const segs = lines.map(l => l.split(/[?#]/)[0].toLowerCase());
  const hasVideo = segs.some(s => /\.(ts|m4s|mp4|aac)$/.test(s));
  const hasImages = segs.some(s => /\.(jpe?g|png|webp)$/.test(s));
  if (hasVideo) return 'video-media';
  if (hasImages && !hasVideo) return 'image-media';
  return 'unknown-media';
}

function pickBestPlaylist(evaluated) {
  const master = evaluated.find(e => e.kind === 'master');
  if (master) return master;
  const video = evaluated.find(e => e.kind === 'video-media');
  if (video) return video;
  // If only image-media, return null -> signals failure (we avoid thumbnails)
  return null;
}

/* ===================== Utilities ===================== */

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
  let target = urlMatch[1];
  if (!/^https?:/i.test(target)) {
    const base = refererUrl.split('/').slice(0, 3).join('/');
    target = base + (target.startsWith('/') ? target : '/' + target);
  }
  const { html: followHtml } = await fetchHtmlAbsolute(target, cookie, refererUrl);
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

function sanitizeUrl(u) {
  if (!u) return u;
  return u.replace(/&quot;?$/,'').replace(/['")\\]+$/,'').trim();
}
