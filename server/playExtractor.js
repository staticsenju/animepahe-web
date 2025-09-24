import axios from 'axios';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import vm from 'vm';

const DEFAULT_HOST = process.env.ANIMEPAHE_HOST || 'https://animepahe.si';
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export function generateCookie() {
  // 16 random URL‑safe alnum characters
  const raw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `__ddg2_=${raw}`;
}

function makeHttp(cookie) {
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

export async function fetchPlayPage(slug, episodeSession, cookie) {
  const http = makeHttp(cookie);
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
    const aud = candidates.filter(b => b.audio === audio);
    if (aud.length) candidates = aud;
  }
  if (resolution) {
    const res = candidates.filter(b => b.resolution === resolution);
    if (res.length) candidates = res;
  }

  // Prefer non-AV1 if available
  const nonAv1 = candidates.filter(b => b.av1 === '0');
  if (nonAv1.length) candidates = nonAv1;

  // Sort by numeric resolution desc
  candidates.sort((a, b) =>
    (parseInt(b.resolution || '0', 10) - parseInt(a.resolution || '0', 10))
  );

  return candidates[0] || null;
}

/**
 * Attempts to extract a playlist (m3u8) URL from a mirror (kwik-like) page.
 * Strategy:
 *  1. Fetch mirror HTML (with Referer + Cookie).
 *  2. Find all <script> tags containing "eval(".
 *  3. For each, transform: eval( => __AP_LOG__(
 *  4. vm.runInNewContext with sandbox capturing logged code.
 *  5. Search captured outputs for source='...m3u8'
 */
export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('mirrorUrl is required');

  const normalized = normalizeUrl(mirrorUrl);

  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': DEFAULT_HOST + '/',
    'Cookie': cookie
  };

  let html;
  try {
    const resp = await axios.get(normalized, {
      headers,
      timeout: 15000,
      validateStatus: s => s >= 200 && s < 400
    });
    html = resp.data;
  } catch (e) {
    throw new Error(`Mirror fetch failed: ${e.message}`);
  }

  const scripts = extractEvalScripts(html);
  if (!scripts.length) {
    throw new Error('No eval() scripts found in mirror page (obfuscation changed?)');
  }

  const logsAll = [];
  let foundSource = '';

  for (const original of scripts) {
    const transformed = transformEvalScript(original);
    const { logs, error } = runInSandbox(transformed);
    logsAll.push({ originalSnippet: original.slice(0, 160), logsSnippet: logs.join('\n').slice(0, 300), error: error?.message });
    const joined = logs.join('\n');
    const match = joined.match(/source=['"]([^'"]+\\.m3u8)['"]/);
    if (match) {
      foundSource = match[1];
      break;
    }
  }

  if (!foundSource) {
    throw new Error('Playlist source=.m3u8 not discovered in any eval script output');
  }

  return {
    playlist: foundSource,
    debug: process.env.DEBUG_PLAYLIST_EXTRACTION ? { attempts: logsAll } : undefined
  };
}

/* ---------- Helpers ---------- */

function normalizeUrl(u) {
  if (u.startsWith('//')) return 'https:' + u;
  if (!/^https?:/i.test(u)) return u.replace(/^\/+/, 'https://');
  return u;
}

function extractEvalScripts(html) {
  // Grab script tag bodies that contain eval(
  const matches = [];
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRegex.exec(html)) !== null) {
    const body = m[1] || '';
    if (body.includes('eval(')) {
      matches.push(body.trim());
    }
  }
  // Prefer longer scripts first (often the main obfuscation)
  matches.sort((a, b) => b.length - a.length);
  return matches;
}

function transformEvalScript(code) {
  // DO NOT aggressively replace document or querySelector; only intercept eval.
  // Replace eval( occurrences with our logger function.
  return code.replace(/eval\(/g, '__AP_LOG__(');
}

function runInSandbox(code) {
  const logs = [];
  const sandbox = {
    __AP_LOG__: (arg) => {
      try {
        // Many obfuscated wrappers call eval on a string. We just log it.
        if (typeof arg === 'string') logs.push(arg);
        else logs.push(String(arg));
      } catch {
        logs.push('[unstringifiable]');
      }
    },
    console: {
      log: (...a) => logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
    },
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
    // Provide minimal global objects
    window: {},
    document: {},
    navigator: { userAgent: UA },
    globalThis: {}
  };
  sandbox.globalThis = sandbox;

  let error = null;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 3000 });
  } catch (e) {
    error = e;
  }
  return { logs, error };
}
