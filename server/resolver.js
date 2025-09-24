import axios from 'axios';

const idToSession = new Map();
const sessionToTitle = new Map();
const API_BASE = 'https://animepahe.si/api';

async function searchRaw(q) {
  const url = `${API_BASE}?m=search&q=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'animepahe-web/1.0' }
  });
  return data?.data || data?.results || [];
}

export async function resolveSessionFromNumeric(numericId) {
  if (idToSession.has(numericId)) return idToSession.get(numericId);

  const results = await searchRaw(String(numericId));
  let match = results.find(r => String(r.id) === String(numericId));

  if (!match) {
    throw new Error('Unable to resolve numeric id to session via search.');
  }

  idToSession.set(String(numericId), match.session);
  sessionToTitle.set(match.session, match.title);
  return match.session;
}

export function cacheMapping(numericId, session, title) {
  if (numericId) idToSession.set(String(numericId), session);
  if (session && title) sessionToTitle.set(session, title);
}

export function hasSession(session) {
  return sessionToTitle.has(session);
}
