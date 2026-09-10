// Market data API layer — parallel to api.js in structure and error philosophy.
//
// Live quote  → Finnhub /quote (https://finnhub.io) — free tier, 60 req/min,
//               requires an API key in js/config.js.
//
// Price history → built from successive /quote poll snapshots, stored in
//               localStorage. Each poll appends { time, close } to a rolling
//               buffer (capped at HISTORY_MAX points per symbol). This avoids
//               every third-party history source's CORS restrictions:
//               - Stooq CSV: no Access-Control-Allow-Origin header → blocked
//               - Yahoo Finance: same
//               - Finnhub /stock/candle: 403 on free tier
//               The trace starts sparse and fills in over time, which is honest
//               about what the free tier actually provides.
//
// Rate-limit strategy: free-tier Finnhub sends HTTP 429 when the per-minute
// limit is exceeded. We treat that as a first-class StationError kind
// ('rate-limit') so the UI can word it differently ("the ticker tape jammed")
// rather than showing a generic network error. The caller is responsible for
// backing off — see the MARKETS_POLL_MS constant in app.js.
//
// All functions are paranoid about response shape: Finnhub returns 200 with
// an empty object {} for an unrecognised symbol rather than a 404; neither
// case is a crash — both are handled as typed StationErrors.

import { FINNHUB_API_KEY } from './config.js';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// Maximum price-history snapshots kept per symbol in localStorage.
// At a 60-second poll interval that's 30 minutes of intraday trace on first
// visit, growing toward ~8 hours over a longer session. Old points are evicted
// from the front as new ones arrive.
export const HISTORY_MAX  = 60;
export const HISTORY_KEY  = 'station:price-history'; // localStorage key

// Re-export so app.js only needs one import for errors across both panels.
export class StationError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'StationError';
    // 'network' | 'not-found' | 'bad-response' | 'malformed' | 'rate-limit'
    // | 'no-key'
    this.kind = kind;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Finnhub JSON fetcher — used only for /quote
// ---------------------------------------------------------------------------

async function fetchJSON(url, { timeoutMs = 10000 } = {}) {
  if (!FINNHUB_API_KEY) {
    throw new StationError(
      'no-key',
      'No Finnhub API key is configured. Add your key to js/config.js to enable the markets panel.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new StationError('network', 'The ticker feed timed out before it answered.', err);
    }
    throw new StationError('network', 'Could not reach the market data feed.', err);
  } finally {
    clearTimeout(timer);
  }

  // 429 = rate limit exceeded on Finnhub free tier
  if (res.status === 429) {
    throw new StationError('rate-limit', 'The ticker tape jammed — too many requests. The panel will retry shortly.');
  }

  if (!res.ok) {
    throw new StationError('bad-response', `The market feed rejected the request (${res.status}).`);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new StationError('malformed', 'The market feed replied with unreadable data.', err);
  }

  return body;
}

// ---------------------------------------------------------------------------
// Price history — localStorage snapshot store
// ---------------------------------------------------------------------------

/**
 * Load the full history store from localStorage.
 * Shape: { [SYMBOL]: Array<{ time: ms, close: number }> }
 */
function loadHistoryStore() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted — start fresh */ }
  return {};
}

/**
 * Persist the history store back to localStorage. Silently swallows
 * QuotaExceededError — the trace just won't persist that cycle.
 */
function saveHistoryStore(store) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(store));
  } catch { /* storage full — non-fatal */ }
}

/**
 * Append a new price snapshot for `symbol` and return the updated series.
 * Exported so app.js can call this after every successful fetchQuote().
 */
export function recordSnapshot(symbol, price) {
  const s = symbol.toUpperCase();
  const store = loadHistoryStore();
  if (!store[s]) store[s] = [];
  store[s].push({ time: Date.now(), close: price });
  // Keep only the most recent HISTORY_MAX points
  if (store[s].length > HISTORY_MAX) store[s] = store[s].slice(-HISTORY_MAX);
  saveHistoryStore(store);
  return store[s];
}

/**
 * Read stored price history for `symbol`. Returns an array of
 * { time: ms, close: number }, oldest first — the same shape the old
 * fetchCandles() returned, so drawMarketMiniChart() needs no changes.
 * Returns an empty array (never throws) when no history exists yet.
 */
export function readHistory(symbol) {
  const store = loadHistoryStore();
  return store[symbol.toUpperCase()] ?? [];
}

/**
 * Remove all stored history for `symbol` (called when the user removes a
 * symbol from the watchlist so stale data doesn't accumulate).
 */
export function clearHistory(symbol) {
  const store = loadHistoryStore();
  delete store[symbol.toUpperCase()];
  saveHistoryStore(store);
}

/**
 * Fetch the latest quote for a single ticker symbol.
 * Finnhub /quote returns: c (current), h (high), l (low), o (open),
 * pc (prev close), dp (% change), d (change in $).
 * Returns null fields gracefully rather than throwing for unknown symbols —
 * an unrecognised symbol returns {c:0,d:0,dp:0,...} which we normalize to
 * a not-found rather than render as live zeros.
 */
export async function fetchQuote(symbol) {
  const s = symbol.toUpperCase().trim();
  if (!s) throw new StationError('malformed', 'Symbol cannot be empty.');

  const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(s)}&token=${FINNHUB_API_KEY}`;
  const body = await fetchJSON(url);

  const safe = (v, fallback = null) =>
    v === undefined || v === null || Number.isNaN(v) || v === 0 ? fallback : v;

  // Finnhub returns all-zeros for an unrecognised symbol — treat that as not-found.
  if (!body.c && !body.pc) {
    throw new StationError('not-found', `"${s}" did not return a valid quote. Check the symbol.`);
  }

  return {
    symbol: s,
    price:     safe(body.c),
    change:    safe(body.d, 0),
    changePct: safe(body.dp, 0),
    high:      safe(body.h),
    low:       safe(body.l),
    open:      safe(body.o),
    prevClose: safe(body.pc),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Fetch quote + history for every symbol in the watchlist.
 * Runs all quote fetches in parallel (Promise.allSettled) so one bad symbol
 * or a single rate-limit hit does not blank the whole panel. History is read
 * synchronously from localStorage — no extra network call needed.
 *
 * After each successful quote fetch, the price is appended to the symbol's
 * history buffer via recordSnapshot() so the trace grows with each poll.
 *
 * Returns an array of:
 *   { symbol, status: 'ok',    quote, candles }
 *   { symbol, status: 'error', error: StationError }
 */
export async function fetchWatchlist(symbols) {
  if (!Array.isArray(symbols) || symbols.length === 0) return [];

  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const quote = await fetchQuote(sym);
      // Append this poll's price to the history buffer, then read it back
      const candles = recordSnapshot(sym, quote.price);
      return { symbol: sym.toUpperCase(), status: 'ok', quote, candles };
    }),
  );

  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    const err = r.reason instanceof StationError
      ? r.reason
      : new StationError('bad-response', r.reason?.message ?? 'Unknown error');
    return { symbol: symbols[i].toUpperCase(), status: 'error', error: err };
  });
}
