// Steam player-count API layer — parallel to markets-api.js in structure.
//
// Live player count → Cloudflare Worker relay (see "Steam relay" section below):
//   https://steam-relay.kavitachy702.workers.dev/?appid=APPID
//   Returns the same JSON Steam's own API returns:
//   { "response": { "player_count": number, "result": 1 } }
//   result === 1 means success; anything else is treated as malformed.
//
// Game search → Steam store suggest endpoint (no key, CORS-enabled):
//   https://store.steampowered.com/search/suggest?term=QUERY&f=games&cc=US&l=en
//   Returns HTML fragments — we parse <a> tags for appid + name.
//   If this proves unreliable the caller falls back to POPULAR_GAMES below.
//
// History → client-side rolling buffer in localStorage, same pattern as
//   markets-api.js price snapshots. Each poll appends { time, count }.
//   Points older than GAMES_HISTORY_WINDOW_MS are evicted so the chart
//   always shows the last 6 hours regardless of session length.

export class StationError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'StationError';
    // 'network' | 'not-found' | 'bad-response' | 'malformed'
    this.kind  = kind;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Steam's public API (api.steampowered.com) does not send an
// Access-Control-Allow-Origin header, so direct browser fetches are blocked
// by the same-origin policy. This is a permanent limitation — Steam's API is
// designed for server-to-server calls only.
//
// We route player-count requests through a self-hosted Cloudflare Worker that
// calls Steam server-side and re-serves the response with CORS headers.
// The Worker code is a single fetch handler; see the README for the snippet
// to deploy your own if you fork this project, since this URL is tied to one
// Cloudflare account.
const STEAM_RELAY_URL = 'https://steam-relay.kavitachy702.workers.dev/';

const SUGGEST_URL = 'https://store.steampowered.com/search/suggest';

// Rolling window kept per game in localStorage (6 hours in ms)
export const GAMES_HISTORY_WINDOW_MS = 6 * 60 * 60 * 1000;
export const GAMES_HISTORY_KEY       = 'station:games-history';
export const GAMES_PEAK_KEY          = 'station:games-peak';   // { [appid]: number }

// Fallback list shown when the suggest endpoint is unavailable or the query
// is too short. Appids are stable Steam identifiers.
export const POPULAR_GAMES = [
  { appid: '730',    name: 'Counter-Strike 2'   },
  { appid: '570',    name: 'Dota 2'             },
  { appid: '1172470',name: 'Apex Legends'       },
  { appid: '578080', name: 'PUBG'               },
  { appid: '1086940',name: 'Baldur\'s Gate 3'   },
  { appid: '1091500',name: 'Cyberpunk 2077'     },
  { appid: '271590', name: 'GTA V'              },
  { appid: '2767030',name: 'Marvel Rivals'      },
];

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

async function fetchRaw(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new StationError('network', 'The Steam relay timed out. Try again in a moment.', err);
    }
    throw new StationError('network', 'The Steam relay is unreachable. Check your connection.', err);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new StationError('bad-response', `The Steam relay returned an error (${res.status}).`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// fetchPlayerCount
// ---------------------------------------------------------------------------

/**
 * Fetch the current concurrent player count for a Steam appid.
 * Returns a normalized object: { appid, playerCount, fetchedAt }.
 * Throws typed StationErrors for every failure mode.
 */
export async function fetchPlayerCount(appid) {
  const id = String(appid).trim();
  if (!id || !/^\d+$/.test(id)) {
    throw new StationError('malformed', 'Steam appid must be a numeric string.');
  }

  const url = `${STEAM_RELAY_URL}?appid=${encodeURIComponent(id)}`;
  const res = await fetchRaw(url);

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new StationError('malformed', 'Steam returned data the panel could not parse.', err);
  }

  const r = body?.response;
  // result === 1 is the Steam API's own success signal
  if (!r || r.result !== 1) {
    throw new StationError(
      'not-found',
      `No player data found for appid ${id}. The game may be delisted or the appid is wrong.`,
    );
  }

  const count = r.player_count;
  if (typeof count !== 'number' || Number.isNaN(count)) {
    throw new StationError('malformed', `The Steam feed returned an unreadable player count for appid ${id}.`);
  }

  return { appid: id, playerCount: count, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// searchGames
// ---------------------------------------------------------------------------

/**
 * Search Steam's store suggest endpoint for games matching `query`.
 * Returns an array of { appid, name } objects, up to ~5 results.
 *
 * The suggest endpoint returns HTML, not JSON — we parse <a> tags whose
 * href contains /app/APPID/. If the endpoint fails for any reason (CORS,
 * network, parsing) we fall back to filtering POPULAR_GAMES by name so the
 * UI always has something usable to show.
 *
 * Never throws — returns an empty array on complete failure so callers can
 * fall through to the hardcoded list gracefully.
 */
export async function searchGames(query) {
  const q = query.trim();
  if (q.length < 2) return [];

  // If the input looks like a raw appid, skip the search entirely
  if (/^\d{4,}$/.test(q)) {
    return [{ appid: q, name: `App ${q}` }];
  }

  // Try the suggest endpoint first
  try {
    const url = `${SUGGEST_URL}?term=${encodeURIComponent(q)}&f=games&cc=US&l=en`;
    const res  = await fetchRaw(url, { timeoutMs: 6000 });
    const html = await res.text();

    // Parse <a ... href="https://store.steampowered.com/app/APPID/...">
    // Each result block has class="match" with a data-ds-appid attribute
    // or an href containing /app/APPID/.
    const results = [];
    const re = /href="[^"]*\/app\/(\d+)\/[^"]*"[^>]*>[\s\S]*?<span[^>]*class="[^"]*match_name[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;
    let m;
    while ((m = re.exec(html)) !== null && results.length < 6) {
      const appid = m[1];
      const name  = m[2].replace(/<[^>]+>/g, '').trim();
      if (appid && name) results.push({ appid, name });
    }

    if (results.length > 0) return results;
  } catch { /* fall through */ }

  // Fallback: filter the hardcoded popular list by name substring
  const lower = q.toLowerCase();
  return POPULAR_GAMES.filter((g) => g.name.toLowerCase().includes(lower));
}

// ---------------------------------------------------------------------------
// Player-count history — localStorage rolling buffer (per appid)
// ---------------------------------------------------------------------------

function loadGameHistoryStore() {
  try {
    const raw = localStorage.getItem(GAMES_HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted */ }
  return {};
}

function saveGameHistoryStore(store) {
  try {
    localStorage.setItem(GAMES_HISTORY_KEY, JSON.stringify(store));
  } catch { /* quota — non-fatal */ }
}

/**
 * Append a player-count snapshot for `appid` and return the pruned series.
 * Points older than GAMES_HISTORY_WINDOW_MS are evicted automatically.
 * Returns { time: ms, count: number }[] oldest-first.
 */
export function recordGameSnapshot(appid, playerCount) {
  const id    = String(appid);
  const store = loadGameHistoryStore();
  if (!store[id]) store[id] = [];

  const now    = Date.now();
  const cutoff = now - GAMES_HISTORY_WINDOW_MS;

  store[id].push({ time: now, count: playerCount });
  // Evict points outside the rolling window
  store[id] = store[id].filter((p) => p.time >= cutoff);

  saveGameHistoryStore(store);
  return store[id];
}

/**
 * Read stored history for `appid`.
 * Returns { time: ms, count: number }[] oldest-first, or [] if none.
 */
export function readGameHistory(appid) {
  const store = loadGameHistoryStore();
  const id    = String(appid);
  const cutoff = Date.now() - GAMES_HISTORY_WINDOW_MS;
  return (store[id] ?? []).filter((p) => p.time >= cutoff);
}

/**
 * Remove history for `appid` (called on watchlist removal).
 */
export function clearGameHistory(appid) {
  const store = loadGameHistoryStore();
  delete store[String(appid)];
  saveGameHistoryStore(store);
}

// ---------------------------------------------------------------------------
// Rolling peak tracker — persisted per appid in localStorage
// ---------------------------------------------------------------------------

function loadPeakStore() {
  try {
    const raw = localStorage.getItem(GAMES_PEAK_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted */ }
  return {};
}

function savePeakStore(store) {
  try {
    localStorage.setItem(GAMES_PEAK_KEY, JSON.stringify(store));
  } catch { /* quota — non-fatal */ }
}

/**
 * Update the stored peak for `appid` if `count` exceeds it.
 * Returns the current (possibly updated) peak value.
 */
export function updatePeak(appid, count) {
  const id    = String(appid);
  const store = loadPeakStore();
  if (store[id] === undefined || count > store[id]) {
    store[id] = count;
    savePeakStore(store);
  }
  return store[id];
}

/**
 * Read the stored peak for `appid`, or `fallback` if none recorded yet.
 */
export function readPeak(appid, fallback = null) {
  const store = loadPeakStore();
  const v = store[String(appid)];
  return v !== undefined ? v : fallback;
}

/**
 * Remove peak data for `appid`.
 */
export function clearPeak(appid) {
  const store = loadPeakStore();
  delete store[String(appid)];
  savePeakStore(store);
}

// ---------------------------------------------------------------------------
// fetchGameWatchlist
// ---------------------------------------------------------------------------

/**
 * Fetch player counts for every game in the watchlist in parallel.
 * Uses Promise.allSettled so one failing appid doesn't blank the panel.
 * Each successful fetch records a snapshot and updates the rolling peak.
 *
 * Returns:
 *   { appid, name, status: 'ok',    playerCount, peak, history }
 *   { appid, name, status: 'error', error: StationError }
 */
export async function fetchGameWatchlist(games) {
  if (!Array.isArray(games) || games.length === 0) return [];

  const results = await Promise.allSettled(
    games.map(async ({ appid, name }) => {
      const data    = await fetchPlayerCount(appid);
      const history = recordGameSnapshot(appid, data.playerCount);
      const peak    = updatePeak(appid, data.playerCount);
      return { appid, name, status: 'ok', playerCount: data.playerCount, peak, history };
    }),
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const err = r.reason instanceof StationError
      ? r.reason
      : new StationError('bad-response', r.reason?.message ?? 'Unknown error');
    return { appid: games[i].appid, name: games[i].name, status: 'error', error: err };
  });
}
