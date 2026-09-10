// Thin API layer over Open-Meteo. Two endpoints, no key required.
// Deliberately paranoid about the shape of the response: Open-Meteo omits
// fields it wasn't asked for, returns nulls for stations with gaps in their
// data, and will happily 200 with an "error" body on a bad request — none of
// that is unusual for a public API, so we treat all of it as expected input
// rather than something to crash on.

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

// Open-Meteo does not offer a reverse-geocoding endpoint. We use the forward
// geocoding API as a best-effort: query the nearest ~place~ by bbox isn't
// possible with their public API, so we simply label the result "Current
// location" and attach the raw coordinates. That keeps us key-free and honest
// rather than reaching for a paid service.
const GEO_TIMEOUT_MS = 8000; // navigator.geolocation timeout before we fall back

/** Typed error so the UI can tell "no results" from "the network is down"
 *  from "the API rejected our request", and word each one differently. */
export class StationError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'StationError';
    // 'network' | 'not-found' | 'bad-response' | 'malformed'
    // | 'geo-denied' | 'geo-unavailable' | 'geo-timeout'
    this.kind = kind;
    this.cause = cause;
  }
}

async function fetchJSON(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new StationError('network', 'The request timed out before the station answered.', err);
    }
    throw new StationError('network', 'Could not reach the weather station.', err);
  } finally {
    clearTimeout(timer);
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new StationError('malformed', 'The station replied with something that was not readable data.', err);
  }

  // Open-Meteo returns HTTP 200 with { error: true, reason: "..." } on bad params.
  if (!res.ok || body?.error) {
    throw new StationError(
      'bad-response',
      body?.reason || `The station rejected the request (${res.status}).`,
    );
  }

  return body;
}

/**
 * Search for a place by name. Returns a normalized array — never throws for
 * "no matches", only for actual transport/response failures, since an empty
 * result list is a legitimate outcome the UI should render, not an error.
 */
export async function searchPlaces(query) {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const url = `${GEOCODE_URL}?name=${encodeURIComponent(trimmed)}&count=6&language=en&format=json`;
  const body = await fetchJSON(url);

  const results = Array.isArray(body?.results) ? body.results : [];

  // Defensive normalization: geocoding results are missing admin1/country for
  // some small or disputed places, so every field is optional here.
  return results.map((r) => ({
    id: r.id ?? `${r.latitude},${r.longitude}`,
    name: r.name ?? 'Unnamed place',
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? 'auto',
  }));
}

/**
 * Fetch current + hourly + daily conditions for a coordinate pair.
 * Returns a normalized shape so the rest of the app never has to guard
 * against missing arrays or null values from the raw API response.
 */
export async function fetchConditions({ latitude, longitude, timezone = 'auto' }) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    throw new StationError('malformed', 'That place did not come with usable coordinates.');
  }

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone,
    current: [
      'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
      'weather_code', 'wind_speed_10m', 'wind_direction_10m',
      'surface_pressure', 'precipitation', 'is_day',
    ].join(','),
    hourly: ['temperature_2m', 'weather_code'].join(','),
    daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_probability_max'].join(','),
    forecast_days: '7',
    wind_speed_unit: 'kmh',
  });

  const body = await fetchJSON(`${FORECAST_URL}?${params.toString()}`);

  const current = body.current ?? {};
  const hourly = body.hourly ?? {};
  const daily = body.daily ?? {};

  // Some fields (e.g. surface_pressure on very old/rural stations) can come
  // back as null even inside a 200 response — fall back rather than let
  // downstream math produce NaN across the UI.
  const safe = (v, fallback = null) => (v === undefined || v === null || Number.isNaN(v) ? fallback : v);

  const nowIso = current.time;
  const hourlyTimes = Array.isArray(hourly.time) ? hourly.time : [];
  const startIdx = nowIso ? Math.max(0, hourlyTimes.indexOf(nowIso)) : 0;

  const hourlySeries = hourlyTimes
    .slice(startIdx, startIdx + 24)
    .map((t, i) => ({
      time: t,
      temperature: safe(hourly.temperature_2m?.[startIdx + i]),
      code: safe(hourly.weather_code?.[startIdx + i], 3),
    }))
    .filter((p) => p.temperature !== null);

  const dailyTimes = Array.isArray(daily.time) ? daily.time : [];
  const dailySeries = dailyTimes.map((t, i) => ({
    date: t,
    code: safe(daily.weather_code?.[i], 3),
    max: safe(daily.temperature_2m_max?.[i]),
    min: safe(daily.temperature_2m_min?.[i]),
    precipProbability: safe(daily.precipitation_probability_max?.[i], 0),
  }));

  return {
    fetchedAt: new Date().toISOString(),
    timezone: body.timezone ?? timezone,
    current: {
      time: nowIso ?? null,
      temperature: safe(current.temperature_2m),
      feelsLike: safe(current.apparent_temperature),
      humidity: safe(current.relative_humidity_2m),
      code: safe(current.weather_code, 3),
      windSpeed: safe(current.wind_speed_10m, 0),
      windDirection: safe(current.wind_direction_10m, 0),
      pressure: safe(current.surface_pressure),
      precipitation: safe(current.precipitation, 0),
      isDay: current.is_day ?? 1,
    },
    hourly: hourlySeries,
    daily: dailySeries,
  };
}

/**
 * Request the browser's geolocation and return a normalized place object
 * shaped identically to a searchPlaces() result so the rest of app.js can
 * treat it interchangeably.
 *
 * Throws typed StationErrors for every failure mode:
 *   'geo-denied'      — user blocked the permission prompt
 *   'geo-unavailable' — device has no location hardware / OS denied access
 *   'geo-timeout'     — position fix took longer than GEO_TIMEOUT_MS
 *   'geo-unavailable' — any other PositionError
 *
 * On success we try a best-effort reverse-geocode via Open-Meteo's forward
 * geocoding API: we search for the nearest-sounding place by querying a
 * small bounding-box… but that endpoint only accepts text queries, not
 * coordinates. So we return "Current location" as the name, and attach the
 * raw lat/lon. The coords line in the hero panel already shows the
 * numeric position, so the user always knows where the reading is from.
 */
export function getGeolocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new StationError(
        'geo-unavailable',
        'This device or browser does not support location services.',
      ));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        resolve({
          id: `geo-${latitude.toFixed(4)},${longitude.toFixed(4)}`,
          name: 'Current location',
          region: `${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°`,
          latitude,
          longitude,
          timezone: 'auto',
          isGeolocated: true,   // flag so app.js can show a dismissible note
        });
      },
      (err) => {
        // GeolocationPositionError codes: 1 = PERMISSION_DENIED,
        // 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
        const kindMap = {
          1: 'geo-denied',
          2: 'geo-unavailable',
          3: 'geo-timeout',
        };
        const msgMap = {
          1: 'Location access was denied. The panel will use the default station instead.',
          2: 'Your location could not be determined right now. The panel will use the default station instead.',
          3: 'Getting your location took too long. The panel will use the default station instead.',
        };
        reject(new StationError(
          kindMap[err.code] ?? 'geo-unavailable',
          msgMap[err.code] ?? 'Location is not available. The panel will use the default station instead.',
          err,
        ));
      },
      { timeout: GEO_TIMEOUT_MS, maximumAge: 60_000, enableHighAccuracy: false },
    );
  });
}
