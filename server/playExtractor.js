import axios from 'axios';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import vm from 'vm';

const DEFAULT_HOST = process.env.ANIMEPAHE_HOST || 'https://animepahe.si';

export function generateCookie() {
  const raw = crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `__ddg2_=${raw}`;
}

function makeHttp(cookie) {
  return axios.create({
    baseURL: DEFAULT_HOST,
    headers: {
      'User-Agent': process.env.USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': DEFAULT_HOST + '/',
      'Cookie': cookie
    },
    
    decompress: true,
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 400
  });
}

export async function fetchPlayPage(slug, episodeSession, cookie) {
  const http = makeHttp(cookie);
  const urlPath = `/play/${slug}/${episodeSession}`;
  const { data: html } = await http.get(urlPath);
  return html;
}

export function extractButtons(html) {
  const $ = cheerio.load(html);
  const buttons = [];
  $('button[data-src]').each((_, el) => {
    const attribs = el.attribs || {};
    buttons.push({
      src: attribs['data-src'],
      resolution: attribs['data-resolution'] || '',
      audio: attribs['data-audio'] || '',
      av1: attribs['data-av1'] || '',
      rawAttributes: attribs
    });
  });
  return buttons;
}

export function chooseButton(buttons, { audio, resolution }) {
  if (!buttons.length) return null;

  let candidates = buttons;

  if (audio) {
    const byAudio = candidates.filter(b => b.audio === audio);
    if (byAudio.length) candidates = byAudio;
  }

  if (resolution) {
    const byRes = candidates.filter(b => b.resolution === resolution);
    if (byRes.length) candidates = byRes;
  }

  const nonAv1 = candidates.filter(b => b.av1 === '0');
  if (nonAv1.length) candidates = nonAv1;
  
  candidates.sort((a, b) => {
    const ra = parseInt(a.resolution || '0', 10);
    const rb = parseInt(b.resolution || '0', 10);
    return rb - ra;
  });

  return candidates[0];
}
export async function fetchPlaylistFromMirror(mirrorUrl, cookie) {
  if (!mirrorUrl) throw new Error('Missing mirror URL');
  const absoluteUrl = mirrorUrl.startsWith('http') ? mirrorUrl : mirrorUrl.startsWith('//')
    ? 'https:' + mirrorUrl
    : mirrorUrl;

  const headers = {
    'User-Agent': process.env.USER_AGENT ||
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Referer': DEFAULT_HOST + '/',
    'Cookie': cookie
  };

  const { data: html } = await axios.get(absoluteUrl, {
    headers,
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 400
  });

  const scriptMatch = html.match(/<script[^>]*>([\s\S]*?eval\([\s\S]*?)<\/script>/i);
  if (!scriptMatch) {
    throw new Error('Obfuscated script not found in mirror page');
  }

  let scriptBody = scriptMatch[1];

  scriptBody = scriptBody
    .replace(/document/g, 'process')
    .replace(/querySelector/g, 'exit')
    .replace(/eval\(/g, 'console.log(');

  const logs = [];
  const sandbox = {
    console: {
      log: (...args) => logs.push(args.join(' '))
    },
    process: {}
    exit: () => { /* ignore */ }
  };

  try {
    vm.runInNewContext(scriptBody, sandbox, { timeout: 3000 });
  } catch (e) {
  }

  const allOutput = logs.join('\n');
  const sourceMatch = allOutput.match(/source='([^']+\.m3u8)'/);
  if (!sourceMatch) {
    throw new Error('Playlist source not found after deobfuscation');
  }

  return {
    playlist: sourceMatch[1],
    debug: process.env.DEBUG_PLAYLIST_EXTRACTION ? {
      logsSnippet: allOutput.slice(0, 500),
      scriptSnippet: scriptBody.slice(0, 500)
    } : undefined
  };
}
