import axios from 'axios';

const BASE = 'https://animepahe.si';
const API_BASE = BASE + '/api';

function randomCookieValue(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

const cookie = `__ddg2_=${randomCookieValue()}`;

export const upstream = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: {
    'User-Agent': 'animepahe-web/1.0',
    'Accept': 'application/json',
    'Cookie': cookie
  }
});

export async function apiGet(params) {
  const qp = new URLSearchParams(params).toString();
  const { data } = await upstream.get('?' + qp);
  return data;
}

export const HOST = BASE;
