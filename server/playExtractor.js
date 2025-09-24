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

  const { html: initialHtml } = await fetchHtmlAbsolute(norm, cookie, DEFAULT_HOST + '/');
  const redirectedHtml = await followMetaRefreshIfAny(initialHtml, cookie, norm);
  const html = redirectedHtml || initialHtml;

  const scripts = extractAllScripts(html);

  // Vanilla eval chain (existing approach)
  const chainResult = deobfuscateByEvalChain(scripts, origin);

  // Instrumentation pass: mimic the bash trick (capture raw eval argument)
  const evalLikeScripts = scripts.filter(s => /eval\(/.test(s));
  const instrumentedCandidates = instrumentEvalScripts(evalLikeScripts);

  // Aggregate corpus
  const codeCorpusPieces = [
    ...scripts,
    ...chainResult.capturedEvalStrings,
    chainResult.combinedEvalOutput,
    ...instrumentedCandidates.plainEvalBodies
  ];
  const codeCorpus = codeCorpusPieces.join('\n/* ---- */\n');

  // Gather candidates
  const candidates = new Set();
  // Regex global .m3u8 extraction
  collectAllM3u8s(codeCorpus).forEach(u => candidates.add(u));
  // Source= assignments (like shell method)
  extractSourceAssignments(codeCorpus).forEach(u => candidates.add(u));
  // Base64 scanning per piece
  for (const piece of codeCorpusPieces) {
    const b64 = scanBase64ForPlaylist(piece);
    if (b64) candidates.add(b64);
  }

  // Filter / normalize
  const normalized = [...candidates].map(sanitizeUrl).filter(Boolean);

  if (!normalized.length) {
    throw new Error('No .m3u8 candidates discovered');
  }

  // Evaluate & classify
  const evaluated = await evaluateCandidates(normalized.slice(0, 15));

  // Additional segment probing to demote image-only
  await probeFirstSegmentForEach(evaluated);

  const best = pickBestPlaylist(evaluated);

  if (!best) {
    if (DEBUG) {
      throw new Error('No viable video playlist. Evaluated=' + JSON.stringify(evaluated, null, 2));
    }
    throw new Error('No non-image playlist found');
  }

  return {
    playlist: best.url,
    classification: best.kind,
    evaluated: DEBUG ? evaluated : undefined,
    debug: DEBUG ? {
      totalScripts: scripts.length,
      evalChainDepth: chainResult.stagesMeta.length,
      evalCaptured: chainResult.capturedEvalStrings.length,
      instrumentationEvalBodies: instrumentedCandidates.plainEvalBodies.length
    } : undefined
  };
}

/* ===================== Eval Chain ===================== */

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
    let error = null;
    try {
      vm.runInNewContext(original, sandbox, { timeout: 2500 });
    } catch (e) {
      error = e;
    }
    stagesMeta.push({
      inputSnippet: original.slice(0, 120),
      logsSnippet: stageLogs.slice(0, 4).join('\n').slice(0, 300),
      nestedCount: nestedCaptured.length,
      error: error ? (error.message || String(error)) : null
    });
    for (const nested of nestedCaptured) {
      capturedEvalStrings.push(nested);
      if (!seen.has(nested) && /eval\(/.test(nested)) queue.push(nested);
    }
  }
  return { capturedEvalStrings, stagesMeta, combinedEvalOutput: capturedEvalStrings.join('\n') };
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
          return vm.runInNewContext(arg, sandbox, { timeout: 2000 });
        } catch (e) {
          stageLogs.push('[eval-error] ' + e.message);
        }
      }
      return arg;
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
    crypto: {},
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

/* ============ Instrumentation Like Shell Script ============ */

function instrumentEvalScripts(scripts) {
  const plainEvalBodies = [];
  for (const s of scripts) {
    // Capture argument of eval(...) like shell’s s/ eval(/ console.log( /
    // We do a light transform: replace eval(x) with collector(x)
    let transformed = s.replace(/\beval\s*\(/g, '___captureEval(');
    const captures = [];
    const sandbox = {
      ___captureEval: (arg) => {
        if (typeof arg === 'string') {
          captures.push(arg);
          // DO NOT execute nested code here; we just collect
        }
        return undefined;
      },
      console: { log: () => {} }
    };
    try {
      vm.runInNewContext(transformed, sandbox, { timeout: 2000 });
    } catch { /* ignore */ }
    captures.forEach(c => plainEvalBodies.push(c));
  }
  return { plainEvalBodies };
}

/* ============ Candidate Collection / Classification ============ */

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

function extractSourceAssignments(text) {
  if (!text) return [];
  const out = [];
  const re = /\b(?:const|let|var)?\s*source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(sanitizeUrl(m[1]));
  }
  return out;
}

function collectAllM3u8s(text) {
  if (!text) return [];
  return (text.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi) || [])
    .map(sanitizeUrl);
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

async function evaluateCandidates(urls) {
  const results = [];
  for (const url of urls) {
    let kind = 'error';
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
      kind = classifyPlaylistText(text);
      results.push({ url, kind, sample: text.slice(0, 1400) });
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

async function probeFirstSegmentForEach(evaluated) {
  for (const item of evaluated) {
    if (!item.kind || item.kind.startsWith('error') || item.kind === 'not-playlist') continue;
    if (item.kind === 'image-media' || item.kind === 'video-media') continue; // already classified
    // For unknown-media or master we skip (master doesn't list segments)
    if (item.kind === 'unknown-media') {
      // Optionally try to look inside sample for potential segment lines (skipped here)
    }
  }
}

function pickBestPlaylist(evaluated) {
  // Remove plain image-media unless nothing else
  const master = evaluated.find(e => e.kind === 'master');
  if (master) return master;
  const video = evaluated.find(e => e.kind === 'video-media');
  if (video) return video;
  // If only image-media exists, return null to force fallback logic
  const nonImage = evaluated.find(e => e.kind !== 'image-media' && !e.kind.startsWith('error'));
  if (nonImage) return nonImage;
  return null;
}

/* ============ HTML Helpers ============ */

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
