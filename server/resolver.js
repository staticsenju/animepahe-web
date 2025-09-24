import { upstream } from './upstream.js';

const idToSession = new Map();
const sessionToTitle = new Map();

async function searchRaw(q, attempt = 1) {
  const url = `?m=search&q=${encodeURIComponent(q)}`;
  try {
    const { data } = await upstream.get(url);
    return data?.data || data?.results || [];
  } catch (err) {
    const status = err?.response?.status;
    if ((status === 403 || status === 429) && attempt < 3) {
      const delay = 250 * attempt;
      await new Promise(r => setTimeout(r, delay));
      return searchRaw(q, attempt + 1);
    }
    throw err;
  }
}

export async function resolveSessionFromNumeric(numericId) {
  const key = String(numericId);
  if (idToSession.has(key)) return idToSession.get(key);

  const results = await searchRaw(key);
  const match = results.find(r => String(r.id) === key);

  if (!match) {
    throw new Error('Could not resolve numeric id to session (search returned no matching entry).');
  }

  idToSession.set(key, match.session);
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
