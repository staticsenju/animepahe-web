// Shared upstream axios instance with randomized cookie & browser-like headers
import axios from 'axios';

const API_ORIGIN = 'https://animepahe.si';
const API_BASE = API_ORIGIN + '/api';

function randomCookieValue(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// Random cookie each process start (mimics ap.sh style)
const cookie = `__ddg2_=${randomCookieValue()}`;

export const upstream = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:114.0) Gecko/20100101 Firefox/114.0',
    'Accept': 'application/json, text/plain, */*',
    'Referer': API_ORIGIN + '/',
    'Cookie': cookie
  }
});

// Generic GET helper for params object
export async function apiGet(params) {
  const qs = new URLSearchParams(params).toString();
  const { data } = await upstream.get('?' + qs);
  return data;
}

export { API_ORIGIN };
