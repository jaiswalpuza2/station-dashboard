// The Logbook — auto-written running log of notable events across all tracks.
//
// Philosophy: threshold-based observation, not AI commentary. Every rule is a
// simple numeric comparison or a code/state transition. The log writes itself;
// the user never interacts with the rules, only the output.
//
// Entries are persisted in localStorage, capped at LOG_MAX_ENTRIES so the
// store never grows unbounded. Oldest entries are evicted first.

export const LOG_KEY        = 'station:logbook';
export const LOG_MAX_ENTRIES = 50;

// ---------------------------------------------------------------------------
// Core log store
// ---------------------------------------------------------------------------

function loadLog() {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* corrupted */ }
  return [];
}

function saveLog(entries) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(entries));
  } catch { /* quota — non-fatal */ }
}

/**
 * Append one entry to the log and persist it.
 * Returns the full updated log array (most-recent last).
 *
 * @param {'weather'|'markets'|'games'} track
 * @param {string} message
 * @param {number} [timestamp] - ms since epoch; defaults to Date.now()
 */
export function recordObservation(track, message, timestamp = Date.now()) {
  const entries = loadLog();
  entries.push({
    id:        `${track}-${timestamp}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp,
    track,
    message,
  });
  // Evict oldest entries beyond the cap
  const trimmed = entries.length > LOG_MAX_ENTRIES
    ? entries.slice(entries.length - LOG_MAX_ENTRIES)
    : entries;
  saveLog(trimmed);
  return trimmed;
}

/**
 * Read the full log. Returns entries oldest-first so the UI can reverse them
 * for newest-on-top display if it wants.
 */
export function readLog() {
  return loadLog();
}

/**
 * Clear all log entries (used if the user explicitly resets).
 */
export function clearLog() {
  saveLog([]);
}

// ---------------------------------------------------------------------------
// Weather observations
// ---------------------------------------------------------------------------

// WMO codes that represent precipitation-class conditions
const PRECIP_CODES = new Set([
  51, 53, 55, 56, 57,          // drizzle
  61, 63, 65, 66, 67,          // rain
  71, 73, 75, 77,              // snow
  80, 81, 82, 85, 86,          // showers
  95, 96, 99,                  // storm
]);

function isPrecip(code) {
  return PRECIP_CODES.has(code);
}

/**
 * Compare two weather data snapshots and record notable changes.
 *
 * `prevSnapshot` and `nextSnapshot` are objects shaped as:
 *   { placeId: string, data: <normalized fetchConditions result> }
 *
 * The `placeId` field is checked first. If the two snapshots belong to
 * different places (user switched cities between polls) every delta-based
 * rule is skipped for this cycle and the new snapshot is used as the
 * baseline for next time — comparing Kathmandu's pressure against Butwal's
 * is meaningless and must never produce a log entry.
 *
 * Delta rules are also skipped on the very first call after page load, when
 * `prevSnapshot` is null (no genuine prior reading exists yet).
 *
 * Sanity bounds are a second layer of defense against stale or corrupt data
 * slipping through any remaining edge cases.
 *
 * @param {{ placeId: string, data: object }|null} prevSnapshot
 * @param {{ placeId: string, data: object }}      nextSnapshot
 * @param {'metric'|'imperial'} unit
 */
export function checkWeatherEvents(prevSnapshot, nextSnapshot, unit = 'metric') {
  // No previous reading at all (first load) — store as baseline, nothing to compare
  if (!prevSnapshot || !nextSnapshot) return;

  // Place changed — new city's first reading is the baseline, not a delta
  if (prevSnapshot.placeId !== nextSnapshot.placeId) {
    console.info(`[logbook] Place changed (${prevSnapshot.placeId} → ${nextSnapshot.placeId}), resetting weather baseline.`);
    return;
  }

  const pc = prevSnapshot.data?.current;
  const nc = nextSnapshot.data?.current;
  if (!pc || !nc) return;

  // Returns true only for a finite, non-zero number.
  // Open-Meteo uses 0 as a placeholder for missing station fields; treating
  // genuine 0 as invalid is a deliberate false-negative trade-off — far better
  // than a bogus delta from comparing a real value against a zero placeholder.
  const valid = (v) => typeof v === 'number' && Number.isFinite(v) && v !== 0;

  // --- Temperature change ≥ 3 °C (≈ 5 °F) between polls ---
  // Sanity bound: > 10 °C in one 5-minute interval is physically impossible
  // for a surface station — treat as stale/corrupt data and skip.
  if (valid(pc.temperature) && valid(nc.temperature)) {
    const diffC = nc.temperature - pc.temperature;
    if (Math.abs(diffC) > 10) {
      console.warn(`[logbook] Skipping implausible temperature delta: ${diffC.toFixed(1)}°C`);
    } else if (Math.abs(diffC) >= 3) {
      const direction = diffC > 0 ? 'rose' : 'dropped';
      if (unit === 'imperial') {
        const diffF = Math.round(Math.abs(diffC * 9 / 5));
        recordObservation('weather', `Temperature ${direction} ${diffF}°F in the last interval.`);
      } else {
        recordObservation('weather', `Temperature ${direction} ${Math.abs(diffC).toFixed(1)}°C in the last interval.`);
      }
    }
  }

  // --- Pressure drop ≥ 2 hPa ---
  // Sanity bound: > 15 hPa in one interval is physically implausible for a
  // surface weather station — treat as a sensor gap or stale data and skip.
  if (valid(pc.pressure) && valid(nc.pressure)) {
    const diffHpa = nc.pressure - pc.pressure;
    if (Math.abs(diffHpa) > 15) {
      console.warn(`[logbook] Skipping implausible pressure delta: ${diffHpa.toFixed(1)} hPa`);
    } else if (diffHpa <= -2) {
      recordObservation('weather', `Pressure fell ${Math.abs(diffHpa).toFixed(1)} hPa — conditions may be deteriorating.`);
    }
  }

  // --- Condition code crossed into or out of precipitation ---
  // Categorical, not delta-based — no sanity bound, but both codes must exist.
  if (typeof pc.code === 'number' && typeof nc.code === 'number') {
    const prevPrecip = isPrecip(pc.code);
    const nextPrecip = isPrecip(nc.code);
    if (!prevPrecip && nextPrecip) {
      recordObservation('weather', `Conditions changed to ${conditionLabel(nc.code)}.`);
    } else if (prevPrecip && !nextPrecip) {
      recordObservation('weather', `Precipitation cleared. Conditions now ${conditionLabel(nc.code).toLowerCase()}.`);
    }
  }
}

function conditionLabel(code) {
  const map = {
    0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
    45: 'fog', 48: 'rime fog',
    51: 'light drizzle', 53: 'drizzle', 55: 'dense drizzle',
    56: 'freezing drizzle', 57: 'freezing drizzle',
    61: 'slight rain', 63: 'rain', 65: 'heavy rain',
    66: 'freezing rain', 67: 'freezing rain',
    71: 'slight snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains',
    80: 'rain showers', 81: 'rain showers', 82: 'violent showers',
    85: 'snow showers', 86: 'heavy snow showers',
    95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
  };
  return map[code] ?? 'unknown conditions';
}

// ---------------------------------------------------------------------------
// Market observations
// ---------------------------------------------------------------------------

// Round-number thresholds to watch for crossings ($50 increments up to $2000,
// plus a few extra memorable levels). Sorted ascending.
const ROUND_LEVELS = (() => {
  const levels = [];
  for (let v = 50; v <= 2000; v += 50) levels.push(v);
  return levels;
})();

/**
 * Check whether a price moved from one side of a round level to the other.
 * Returns the crossed level, or null if no crossing occurred.
 */
function findRoundCrossing(prevPrice, nextPrice) {
  if (prevPrice === null || nextPrice === null) return null;
  for (const level of ROUND_LEVELS) {
    const crossed =
      (prevPrice < level && nextPrice >= level) ||
      (prevPrice > level && nextPrice <= level);
    if (crossed) return level;
  }
  return null;
}

/**
 * Compare previous and new market data arrays and record notable changes.
 *
 * `prevPriceMap` starts empty on boot. On the first poll for any symbol,
 * `prevPrice` is null and all delta rules are skipped — the price is stored
 * as a baseline for the next poll. This handles both initial load and
 * newly-added symbols correctly.
 *
 * When a symbol is removed from the watchlist, its entry must be deleted
 * from `prevPriceMap` (handled in app.js `removeSymbol`) so that if it is
 * re-added later the first reading is treated as a fresh baseline rather than
 * compared against a potentially months-old stale price.
 *
 * Sanity bound: a single-interval move > 50% is treated as suspect (free-tier
 * data hiccup or stock split) and skipped with a console warning.
 *
 * @param {Map<string, number>} prevPriceMap  - symbol → price from last poll
 * @param {Array}               nextData      - new state.marketData
 */
export function checkMarketEvents(prevPriceMap, nextData) {
  if (!Array.isArray(nextData)) return;

  for (const item of nextData) {
    if (item.status !== 'ok' || !item.quote) continue;

    const sym       = item.symbol;
    const nextPrice = item.quote.price;

    // Skip if the new price itself is not a usable number
    if (typeof nextPrice !== 'number' || !Number.isFinite(nextPrice) || nextPrice <= 0) {
      continue;
    }

    const prevPrice = prevPriceMap.get(sym) ?? null;

    // Only run delta rules when we have a genuine prior reading
    if (prevPrice !== null && prevPrice > 0) {
      // Round-number crossing
      const crossed = findRoundCrossing(prevPrice, nextPrice);
      if (crossed !== null) {
        const dir = nextPrice >= crossed ? 'crossed' : 'fell through';
        recordObservation('markets', `${sym} ${dir} $${crossed}.`);
      }

      // Single-interval move ≥ 2%
      // Sanity bound: > 50% in one ~60-second interval is implausible for a
      // normal equity — likely a bad tick or free-tier data artifact.
      const movePct = ((nextPrice - prevPrice) / prevPrice) * 100;
      if (Math.abs(movePct) > 50) {
        console.warn(`[logbook] Skipping implausible market move for ${sym}: ${movePct.toFixed(1)}%`);
      } else if (Math.abs(movePct) >= 2) {
        const dir = movePct > 0 ? 'up' : 'down';
        recordObservation('markets', `${sym} moved ${dir} ${Math.abs(movePct).toFixed(1)}% in the last interval.`);
      }
    }

    // Always update the map — establishes baseline on first poll, refreshes on subsequent ones
    prevPriceMap.set(sym, nextPrice);
  }
}

// ---------------------------------------------------------------------------
// Games observations
// ---------------------------------------------------------------------------

/**
 * Compare previous and new games data and record notable peak events.
 * Reuses the peak values already computed by fetchGameWatchlist.
 *
 * On the first poll for a given appid, `prevPeakMap` has no entry — the
 * baseline is established silently. Logging only happens from the second
 * poll onward when a confirmed new high is observed.
 *
 * When a game is removed from the watchlist, its entry must be deleted from
 * `prevPeakMap` (handled in app.js `removeGame`) so that if it is re-added
 * later the first reading is treated as a fresh baseline rather than compared
 * against a potentially stale peak from a previous session.
 *
 * Sanity bound: a peak jump > 10× the previous value in one interval is
 * treated as a relay artifact and skipped with a console warning.
 *
 * @param {Map<string, number>} prevPeakMap  - appid → peak seen last poll
 * @param {Array}               nextData     - new state.gamesData
 */
export function checkGamesEvents(prevPeakMap, nextData) {
  if (!Array.isArray(nextData)) return;

  for (const item of nextData) {
    if (item.status !== 'ok') continue;

    const newPeak  = item.peak;
    const prevPeak = prevPeakMap.get(item.appid) ?? null;

    // Skip if the new peak is not a usable number
    if (typeof newPeak !== 'number' || !Number.isFinite(newPeak) || newPeak <= 0) continue;

    if (prevPeak === null) {
      // First reading — establish baseline silently, no log entry
      prevPeakMap.set(item.appid, newPeak);
    } else if (newPeak > prevPeak) {
      // Sanity bound: a 10× jump in one polling interval is implausible for
      // any established game — most likely a bad relay response.
      if (newPeak > prevPeak * 10) {
        console.warn(`[logbook] Skipping implausible peak jump for ${item.name}: ${prevPeak} → ${newPeak}`);
      } else {
        recordObservation(
          'games',
          `${item.name} hit a new tracked peak: ${newPeak.toLocaleString()} players.`,
        );
      }
      prevPeakMap.set(item.appid, newPeak);
    }
  }
}
