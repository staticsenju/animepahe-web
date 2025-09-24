import axios from 'axios';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import vm from 'vm';

const DEFAULT_HOST = process.env.ANIMEPAHE_HOST || 'https://animepahe.si';
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';
const DEBUG = !!process.env.DEBUG_PLAYLIST_EXTRACTION;

/* ===================== Public API ===================== */

export function generateCookie() {
  const raw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `__ddg2_=${raw}`;
}

export async function fetchPlayPage(slug, episodeSession, cookie) {
  const url = `${DEFAULT_HOST}/play/${slug}/${episodeSession}`;
  const resp = await axios.get(url, {
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
  let list = buttons.slice();
  if (audio) {
    const filtered = list.filter(b => b.audio === audio);
    if (filtered.length) list = filtered;
  }
  if (resolution) {
    const filtered = list.filter(b => b.resolution === resolution);
    if (filtered.length) list = filtered;
  }
  const nonAv1 = list.filter(b => b.av1 === '0');
  if (nonAv1.length) list = nonAv1;
  list.sort((a, b) => (parseInt(b.resolution || '0', 10) - parseInt(a.resolution || '0', 10)));
  return list[0] || null;
}
export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('mirrorUrl is required');
  const norm = normalizeUrl(mirrorUrl);
  const origin = new URL(norm).origin;

  const { html: initialHtml } = await fetchHtmlAbsolute(norm, cookie, DEFAULT_HOST + '/');
  const redirectedHtml = await followMetaRefreshIfAny(initialHtml, cookie, norm);
  const pageHtml = redirectedHtml || initialHtml;

  const scripts = extractAllScripts(pageHtml);

  const heuristicCandidates = extractKwikCandidatesRaw(pageHtml);
  if (DEBUG) console.log('[EXTRACT] heuristicCandidates', heuristicCandidates);

  const unpackedPieces = scripts.flatMap(s => unpackAllPacker(s));
  const staticCorpus = unpackedPieces.join('\n/* ---UNPACKED--- */\n');
  const staticCandidates = collectAllCandidates(staticCorpus);

  const chainResult = deobfuscateByEvalChain(scripts, origin);
  const dynamicCorpus = [
    ...chainResult.capturedEvalStrings,
    chainResult.combinedEvalOutput
  ].join('\n/* ---DYNAMIC--- */\n');
  const dynamicCandidates = collectAllCandidates(dynamicCorpus);
  const htmlCandidates = collectAllCandidates(pageHtml);

  const allSet = new Set([
    ...heuristicCandidates,
    ...staticCandidates,
    ...dynamicCandidates,
    ...htmlCandidates
  ]);

  if (DEBUG) console.log('[EXTRACT] rawCombinedCandidates', [...allSet]);

  if (!allSet.size) throw new Error('no_candidates_found');

  const candidates = [...allSet]
    .map(sanitizeUrl)
    .filter(Boolean)
    .filter(u => /\.m3u8/i.test(u));

  if (!candidates.length) throw new Error('no_m3u8_candidates');

  const evaluated = await evaluateCandidates(candidates.slice(0, 24));

  if (DEBUG) {
    console.log('[EXTRACT] evaluated',
      evaluated.map(e => ({ kind: e.kind, url: e.url.slice(0, 90) })));
  }

  const best = pickBestPlaylist(evaluated);
  if (!best) throw new Error('no_viable_video_playlist');

  return {
    playlist: best.url,
    classification: best.kind,
    evaluated: DEBUG ? evaluated : undefined,
    debug: DEBUG ? {
      heuristicCount: heuristicCandidates.length,
      unpackedCount: unpackedPieces.length,
      evalChainDepth: chainResult.stagesMeta.length,
      evalCaptured: chainResult.capturedEvalStrings.length
    } : undefined
  };
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

function extractKwikCandidatesRaw(html) {
  const scripts = getInlineEvalScripts(html);
  const capturedBodies = breadthEvalCapture(scripts, 4);
  const out = new Set();

  for (const code of capturedBodies) {
    // Look for source= or q=
    const assignMatches = code.match(/\b(?:const|var|let)?\s*(?:source|q)\s*=\s*['"][^'"]+\.m3u8[^'"]*['"]/gi) || [];
    assignMatches.forEach(line => {
      const m = line.match(/['"]([^'"]+\.m3u8[^'"]*)['"]/);
      if (m && m[1]) out.add(m[1]);
    });

    // Raw .m3u8 occurrences
    const urlMatches = code.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi) || [];
    urlMatches.forEach(u => out.add(u));
  }
  return [...out];
}

function getInlineEvalScripts(html) {
  const scripts = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = (m[1] || '').trim();
    if (!body) continue;
    if (/eval\(function\(p,a,c,k,e,d\)\{/.test(body) || /^eval\(/.test(body)) {
      scripts.push(body);
    }
  }
  return scripts;
}

function breadthEvalCapture(scriptBodies, maxDepth = 3) {
  const queue = scriptBodies.slice();
  const seen = new Set();
  const collected = [];
  let depth = 0;
  while (queue.length && depth < maxDepth) {
    const code = queue.shift();
    if (!code || seen.has(code)) continue;
    seen.add(code);

    const nested = runEvalIntercept(code);
    nested.forEach(n => {
      if (!seen.has(n)) queue.push(n);
      collected.push(n);
    });
    depth++;
  }
  return collected;
}

function runEvalIntercept(code) {
  const captured = [];
  // Replace explicit "eval(" with "__CAPTURE__(" to avoid executing ambiguous code chunks
  // but keep original too for fallback if needed
  let transformed = code.replace(/\beval\s*\(/g, '__CAPTURE__(');
  const sandbox = {
    __CAPTURE__: (arg) => {
      if (typeof arg === 'string') captured.push(arg);
      return undefined;
    },
    console: { log: () => {} },
    document: {},
    window: {},
    navigator: { userAgent: UA },
    atob: (b64) => Buffer.from(b64, 'base64').toString('utf8'),
    btoa: (s) => Buffer.from(s, 'utf8').toString('base64'),
    setTimeout: () => {},
    clearTimeout: () => {},
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(transformed, sandbox, { timeout: 1500 });
  } catch {
    // ignore errors from partial code
  }
  return captured;
}


const PACKER_RE = /eval\(function\(p,a,c,k,e,d\)\{([\s\S]*?)\}\((['"])(.*?)\2\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])(.*?)\6\.split\('\|'\)\s*,\s*0\s*,\s*\{\}\)\);?/g;

function unpackAllPacker(src) {
  const outputs = [src];
  let changed = true;
  let current = src;

  while (changed) {
    changed = false;
    const newFragments = [];
    current.replace(PACKER_RE, (...args) => {
      const unpacked = unpackSinglePacker(...args);
      if (unpacked && unpacked !== current) {
        newFragments.push(unpacked);
        changed = true;
      }
      return '';
    });
    if (changed) {
      newFragments.forEach(f => {
        outputs.push(f);
        current = f;
      });
    }
  }
  return outputs;
}

function unpackSinglePacker(_match, _body, _pQuote, payload, aVal, cVal, _kQuote, kList) {
  try {
    const a = parseInt(aVal, 10);
    const c = parseInt(cVal, 10);
    const k = kList.split('|');
    if (!payload || isNaN(a) || isNaN(c) || !k.length) return null;
    let decoded = payload
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');

    for (let i = c; i >= 0; i--) {
      const token = i.toString(a);
      if (k[i]) {
        const rx = new RegExp(`\\b${token}\\b`, 'g');
        decoded = decoded.replace(rx, k[i]);
      }
    }
    return decoded;
  } catch {
    return null;
  }
}

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
    const nested = [];
    const sandbox = makeSandbox(nested, stageLogs, originHref);

    let error = null;
    try {
      vm.runInNewContext(original, sandbox, { timeout: 2500 });
    } catch (e) {
      error = e;
    }

    stagesMeta.push({
      snippet: original.slice(0, 140),
      logs: stageLogs.slice(0, 3),
      nested: nested.length,
      error: error ? (error.message || String(error)) : null
    });

    for (const n of nested) {
      capturedEvalStrings.push(n);
      if (/eval\(/.test(n) && !seen.has(n)) queue.push(n);
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
    btoa: (s) => Buffer.from(s, 'utf8').toString('base64'),
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

function collectAllCandidates(text) {
  if (!text) return [];
  const out = new Set();

  (text.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi) || [])
    .forEach(u => out.add(sanitizeUrl(u)));


  (text.match(/\b(?:const|let|var)?\s*(?:source|q)\s*=\s*['"][^'"]+\.m3u8[^'"]*['"]/gi) || [])
    .forEach(line => {
      const m = line.match(/['"]([^'"]+\.m3u8[^'"]*)['"]/);
      if (m && m[1]) out.add(sanitizeUrl(m[1]));
    });

  const b64Chunks = text.match(/[A-Za-z0-9+/=]{40,}/g) || [];
  for (const c of b64Chunks.slice(0, 200)) {
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
            // Use the playlist host as referer to preserve some mirrors' checks
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
  // We explicitly reject image-only (thumbnail) playlists
  return null;
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

export const _internal = {
  extractKwikCandidatesRaw,
  unpackAllPacker,
  deobfuscateByEvalChain,
  collectAllCandidates,
  classifyPlaylistText
};
