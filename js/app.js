import { searchPlaces, fetchConditions, getGeolocation, StationError } from './api.js';
import { conditionFromCode, glyphSVG } from './icons.js';
import { renderGaugeSVG, renderCompassSVG } from './gauges.js';
import { drawStripChart, drawMarketMiniChart, drawGameMiniChart } from './stripchart.js';
import { fetchWatchlist, recordSnapshot, clearHistory, StationError as MarketError } from './markets-api.js';
import {
  fetchGameWatchlist, searchGames, clearGameHistory, clearPeak,
  readGameHistory, readPeak, POPULAR_GAMES,
  StationError as GameError,
} from './games-api.js';
import {
  recordObservation, readLog, clearLog,
  checkWeatherEvents, checkMarketEvents, checkGamesEvents,
} from './logbook.js';

// ---------------------------------------------------------------------------
// Offline / stale-data detection
// ---------------------------------------------------------------------------
// The service worker attaches X-Station-Stale: 1 to any response it serves
// from cache because the network was unreachable. We intercept all fetch()
// calls at the module level so we can detect that header on any API response
// without modifying the individual API modules.
//
// A stale response is NOT an error — it has real data, just not live data.
// We track how many in-flight requests returned stale vs fresh, and show a
// persistent banner when any request is stale, hiding it once all pending
// requests come back fresh.

let staleCount = 0; // number of currently-active stale responses across all tracks

function markStale() {
  staleCount++;
  showOfflineBanner();
}

function markFresh() {
  // Only decrement if something was previously stale
  if (staleCount > 0) staleCount--;
  if (staleCount === 0) hideOfflineBanner();
}

const _originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async function stationFetch(...args) {
  const response = await _originalFetch(...args);
  if (response.headers.get('X-Station-Stale') === '1') {
    markStale();
  } else {
    // A successful fresh network response: clear any stale flag for this track
    markFresh();
  }
  return response;
};

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEY      = 'station:last-place';
const UNIT_KEY         = 'station:unit';
const THEME_KEY        = 'station:theme';
const WATCHLIST_KEY    = 'station:watchlist';
const GAMES_LIST_KEY   = 'station:games-list';  // [{ appid, name }]
const PANEL_KEY        = 'station:panel';        // 'weather' | 'markets' | 'games'

// ---------------------------------------------------------------------------
// Poll intervals — all three tracks are fully independent
// ---------------------------------------------------------------------------

const WEATHER_POLL_MS  = 5 * 60 * 1000;   //  5 minutes
const MARKETS_POLL_MS  = 60 * 1000;        //  1 minute (Finnhub free: 60 req/min)
const GAMES_POLL_MS    = 5 * 60 * 1000;    //  5 minutes (Steam rate-limit friendly)

// ---------------------------------------------------------------------------
// Default watchlists
// ---------------------------------------------------------------------------

const DEFAULT_WATCHLIST  = ['AAPL', 'MSFT', 'TSLA', 'AMZN'];
const DEFAULT_GAMES_LIST = [
  { appid: '730',     name: 'Counter-Strike 2' },
  { appid: '570',     name: 'Dota 2'           },
  { appid: '578080',  name: 'PUBG'             },
  { appid: '1172470', name: 'Apex Legends'     },
];

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const el = {
  // Weather panel
  heroPanel:        document.getElementById('panel-hero'),
  dialRail:         document.getElementById('dial-rail'),
  forecastRail:     document.getElementById('forecast-rail'),
  chart:            document.getElementById('strip-chart'),
  chartStatus:      document.getElementById('recorder-status'),
  recorderRange:    document.getElementById('recorder-range'),
  footerUpdated:    document.getElementById('footer-updated'),

  // Controls
  unitToggle:       document.getElementById('unit-toggle'),
  themeToggle:      document.getElementById('theme-toggle'),
  searchForm:       document.getElementById('search-form'),
  searchInput:      document.getElementById('search-input'),
  searchResults:    document.getElementById('search-results'),
  panelTabWeather:  document.getElementById('tab-weather'),
  panelTabMarkets:  document.getElementById('tab-markets'),
  panelTabGames:    document.getElementById('tab-games'),

  // Panels
  weatherPanel:     document.getElementById('weather-panel'),
  marketsPanel:     document.getElementById('markets-panel'),
  gamesPanel:       document.getElementById('games-panel'),

  // Geo note
  geoNote:          document.getElementById('geo-note'),

  // Offline banner
  offlineBanner:    document.getElementById('offline-banner'),

  // Markets panel
  tickerRail:       document.getElementById('ticker-rail'),
  marketsUpdated:   document.getElementById('markets-updated'),
  watchlistForm:    document.getElementById('watchlist-form'),
  watchlistInput:   document.getElementById('watchlist-input'),

  // Games panel
  gameRail:         document.getElementById('game-rail'),
  gamesUpdated:     document.getElementById('games-updated'),
  gameSearchForm:   document.getElementById('game-search-form'),
  gameSearchInput:  document.getElementById('game-search-input'),
  gameSearchResults:document.getElementById('game-search-results'),

  // Logbook strip
  logbookStrip:     document.getElementById('logbook-strip'),
  logbookPeek:      document.getElementById('logbook-peek'),
  logbookPeekInner: document.getElementById('logbook-peek-inner'),
  logbookEntries:   document.getElementById('logbook-entries'),
};

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

const state = {
  // Weather
  place:       null,
  data:        null,
  wxStatus:    'idle',
  wxError:     null,
  wxPollTimer: null,

  // Markets
  watchlist:    loadWatchlist(),
  marketData:   [],
  mktStatus:    'idle',
  mktError:     null,
  mktPollTimer: null,

  // Games
  gamesList:    loadGamesList(),   // [{ appid, name }]
  gamesData:    [],                // results from fetchGameWatchlist
  gamesStatus:  'idle',
  gamesError:   null,
  gamesPollTimer: null,

  // UI
  unit:    localStorage.getItem(UNIT_KEY) === 'imperial' ? 'imperial' : 'metric',
  theme:   resolveInitialTheme(),
  panel:   resolveInitialPanel(),

  // Logbook: previous-state snapshots for change detection
  prevWeatherSnapshot: null,       // { placeId, data } — null until first successful poll
  prevPriceMap:        new Map(),  // symbol → last known price (cleared on symbol removal)
  prevPeakMap:         new Map(),  // appid  → last known peak  (cleared on game removal)
};

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

function resolveInitialTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolveInitialPanel() {
  const stored = localStorage.getItem(PANEL_KEY);
  if (stored === 'markets' || stored === 'games') return stored;
  return 'weather';
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.style.colorScheme = theme;
  if (el.themeToggle) {
    el.themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
    el.themeToggle.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    el.themeToggle.querySelector('.theme-toggle__label').textContent =
      theme === 'light' ? 'Dark' : 'Light';
    const icon = el.themeToggle.querySelector('.theme-toggle__icon');
    if (icon) icon.innerHTML = theme === 'light' ? moonIcon() : sunIcon();
  }
  if (state.wxStatus    === 'ready') renderChart();
  if (state.mktStatus   === 'ready') renderMarketCards();
  if (state.gamesStatus === 'ready') renderGameCards();
}

function sunIcon() {
  return `<circle cx="6.5" cy="6.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.2"/>
    <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
      <line x1="6.5" y1="1" x2="6.5" y2="2.4"/>
      <line x1="6.5" y1="10.6" x2="6.5" y2="12"/>
      <line x1="1" y1="6.5" x2="2.4" y2="6.5"/>
      <line x1="10.6" y1="6.5" x2="12" y2="6.5"/>
      <line x1="2.7" y1="2.7" x2="3.7" y2="3.7"/>
      <line x1="9.3" y1="9.3" x2="10.3" y2="10.3"/>
      <line x1="2.7" y1="10.3" x2="3.7" y2="9.3"/>
      <line x1="9.3" y1="3.7" x2="10.3" y2="2.7"/>
    </g>`;
}

function moonIcon() {
  return `<path d="M9 2a6 6 0 1 0 3 11.2A7 7 0 0 1 6 4a7 7 0 0 1 3-2z"
    fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>`;
}

applyTheme(state.theme);

// ---------------------------------------------------------------------------
// Unit conversion
// ---------------------------------------------------------------------------

const convert = {
  temp:     (c)   => (state.unit === 'imperial' ? (c * 9) / 5 + 32 : c),
  tempUnit: ()    => (state.unit === 'imperial' ? '°F' : '°C'),
  wind:     (kmh) => (state.unit === 'imperial' ? kmh * 0.621371 : kmh),
  windUnit: ()    => (state.unit === 'imperial' ? 'mph' : 'km/h'),
  pressure: (hpa) => hpa,
};

function fmt(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

function fmtPrice(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCount(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString();
}

// ---------------------------------------------------------------------------
// Geo note
// ---------------------------------------------------------------------------

function showGeoNote(message, isError = false) {
  if (!el.geoNote) return;
  el.geoNote.innerHTML = `
    <div class="geo-note__inner${isError ? ' is-error' : ''}">
      <span>${message}</span>
      <button class="geo-note__dismiss" aria-label="Dismiss">✕</button>
    </div>`;
  el.geoNote.hidden = false;
  el.geoNote.querySelector('.geo-note__dismiss').addEventListener('click', hideGeoNote);
}

function hideGeoNote() {
  if (!el.geoNote) return;
  el.geoNote.hidden = true;
  el.geoNote.innerHTML = '';
}

// ---------------------------------------------------------------------------
// Offline banner — shown when the SW serves a stale cached API response
// ---------------------------------------------------------------------------

function showOfflineBanner() {
  if (el.offlineBanner) el.offlineBanner.hidden = false;
}

function hideOfflineBanner() {
  if (el.offlineBanner) el.offlineBanner.hidden = true;
}

// ---------------------------------------------------------------------------
// Logbook — render strip and wire expand/collapse
// ---------------------------------------------------------------------------

function formatLogTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function renderLogbook() {
  const entries = readLog();              // oldest first
  const strip   = el.logbookStrip;
  const peek    = el.logbookPeekInner;
  const list    = el.logbookEntries;
  if (!strip || !peek || !list) return;

  if (entries.length === 0) {
    peek.innerHTML = `<span class="logbook__empty-label">No entries yet.</span>
      <span class="logbook__chevron" aria-hidden="true">▾</span>`;
    list.innerHTML = '';
    strip.setAttribute('aria-expanded', 'false');
    return;
  }

  const latest = entries[entries.length - 1];

  // Peek row: tag + timestamp + truncated message + clear button + chevron
  peek.innerHTML = `
    <span class="logbook__tag logbook__tag--${latest.track}">${latest.track}</span>
    <span class="logbook__peek-time">${formatLogTime(latest.timestamp)}</span>
    <span class="logbook__peek-msg">${latest.message}</span>
    <button class="logbook__clear" aria-label="Clear logbook" title="Clear logbook">✕</button>
    <span class="logbook__chevron" aria-hidden="true">▾</span>`;

  peek.querySelector('.logbook__clear')?.addEventListener('click', (e) => {
    e.stopPropagation();   // don't toggle expand when clicking clear
    clearLog();
    renderLogbook();
  });

  // Full list: newest first (reverse iteration)
  list.innerHTML = [...entries].reverse().map((entry) => `
    <div class="logbook__entry">
      <span class="logbook__tag logbook__tag--${entry.track}">${entry.track}</span>
      <span class="logbook__entry-time">${formatLogTime(entry.timestamp)}</span>
      <span class="logbook__entry-msg">${entry.message}</span>
    </div>`).join('');
}

// Toggle expand/collapse
function toggleLogbook() {
  const strip = el.logbookStrip;
  if (!strip) return;
  const expanded = strip.getAttribute('aria-expanded') === 'true';
  strip.setAttribute('aria-expanded', String(!expanded));
}

if (el.logbookPeek) {
  el.logbookPeek.addEventListener('click', toggleLogbook);
  el.logbookPeek.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLogbook(); }
  });
}

// ---------------------------------------------------------------------------
// Panel tab switching — Weather / Markets / Games
// ---------------------------------------------------------------------------

function switchPanel(name) {
  state.panel = name;
  localStorage.setItem(PANEL_KEY, name);

  const panels = { weather: el.weatherPanel, markets: el.marketsPanel, games: el.gamesPanel };
  const tabs   = { weather: el.panelTabWeather, markets: el.panelTabMarkets, games: el.panelTabGames };

  Object.entries(panels).forEach(([key, panel]) => {
    panel.hidden = key !== name;
  });
  Object.entries(tabs).forEach(([key, tab]) => {
    tab.setAttribute('aria-selected', String(key === name));
  });

  // Place search is only relevant on Weather
  el.searchForm.hidden = name !== 'weather';

  // Lazy-load data on first switch to each panel
  if (name === 'markets' && state.mktStatus   === 'idle') refreshMarkets();
  if (name === 'games'   && state.gamesStatus === 'idle') refreshGames();

  // Redraw canvases after unhiding (container size was zero while hidden)
  requestAnimationFrame(() => {
    if (name === 'weather' && state.wxStatus    === 'ready') renderChart();
    if (name === 'markets' && state.mktStatus   === 'ready') renderMarketCards();
    if (name === 'games'   && state.gamesStatus === 'ready') renderGameCards();
  });
}

el.panelTabWeather.addEventListener('click', () => switchPanel('weather'));
el.panelTabMarkets.addEventListener('click', () => switchPanel('markets'));
el.panelTabGames.addEventListener('click',   () => switchPanel('games'));

// ---------------------------------------------------------------------------
// Weather rendering
// ---------------------------------------------------------------------------

function renderLoading() {
  el.heroPanel.innerHTML = `
    <div class="state-block">
      <p class="state-title">Reading the instruments…</p>
      <p class="state-body">Contacting the station and waiting on a fresh reading.</p>
    </div>`;
  el.dialRail.innerHTML = '';
  el.forecastRail.innerHTML = '';
  el.chartStatus.textContent = '';
}

function renderError(err) {
  const copy = {
    'network':      { title: 'The station is not answering',         body: 'The connection to the weather service failed. Check your connection and try again.' },
    'not-found':    { title: 'No place matches that',                body: 'Try a broader search — a city or town name usually works better than a landmark.' },
    'bad-response': { title: 'The station rejected the request',     body: err.message || 'The weather service returned an error for this request.' },
    'malformed':    { title: 'The reading came back unreadable',     body: 'The station sent back data in a shape this panel does not recognize.' },
  }[err.kind] ?? { title: 'Something went wrong reading the instruments', body: err.message || 'An unexpected error occurred.' };

  el.heroPanel.innerHTML = `
    <div class="state-block is-error">
      <p class="state-title">${copy.title}</p>
      <p class="state-body">${copy.body}</p>
      <button type="button" id="retry-btn">Try again</button>
    </div>`;
  document.getElementById('retry-btn')?.addEventListener('click', () => refresh());
  el.chartStatus.textContent = 'No trace available.';
}

function renderHero() {
  const { current } = state.data;
  const cond     = conditionFromCode(current.code, current.isDay);
  const tempVal  = fmt(convert.temp(current.temperature));
  const feelsVal = fmt(convert.temp(current.feelsLike));

  el.heroPanel.innerHTML = `
    <div class="hero-card">
      <div class="gauge-wrap">
        ${renderGaugeSVG({
          value: current.temperature,
          min: -20, max: 45,
          color: current.temperature !== null && current.temperature < 10
            ? 'var(--glass-blue)' : 'var(--brass)',
        })}
        <div class="gauge-readout">
          <div class="temp">${tempVal}<sup>${convert.tempUnit()}</sup></div>
          <div class="feels">feels like ${feelsVal}${convert.tempUnit()}</div>
        </div>
      </div>
      <div class="hero-detail">
        <h2>${state.place.name}</h2>
        <p class="coords">${state.place.region || '—'} · ${state.place.latitude.toFixed(2)}, ${state.place.longitude.toFixed(2)}</p>
        <div class="condition-row">
          ${glyphSVG(cond.glyph)}
          <span class="label">${cond.label}</span>
        </div>
        <div class="hero-stats">
          <div><div class="k">humidity</div><div class="v">${fmt(current.humidity)}%</div></div>
          <div><div class="k">wind</div><div class="v">${fmt(convert.wind(current.windSpeed))} ${convert.windUnit()}</div></div>
          <div><div class="k">pressure</div><div class="v">${current.pressure ? fmt(current.pressure) + ' hPa' : '—'}</div></div>
          <div><div class="k">precipitation</div><div class="v">${fmt(current.precipitation, 1)} mm</div></div>
        </div>
      </div>
    </div>`;
}

function renderDials() {
  const { current } = state.data;
  el.dialRail.innerHTML = `
    <div class="dial">
      ${renderGaugeSVG({ value: current.humidity, min: 0, max: 100, color: 'var(--glass-blue)', ticks: 4 })}
      <div class="dial-value">${fmt(current.humidity)}%</div>
      <div class="dial-label">humidity</div>
    </div>
    <div class="dial">
      ${renderCompassSVG({ direction: current.windDirection, speed: current.windSpeed })}
      <div class="dial-value">${fmt(convert.wind(current.windSpeed))} ${convert.windUnit()}</div>
      <div class="dial-label">wind, from ${bearingLabel(current.windDirection)}</div>
    </div>
    <div class="dial">
      ${renderGaugeSVG({ value: current.pressure, min: 980, max: 1050, color: 'var(--brass)', ticks: 4, nullState: current.pressure === null })}
      <div class="dial-value">${current.pressure ? fmt(current.pressure) + ' hPa' : '—'}</div>
      <div class="dial-label">pressure</div>
    </div>
    <div class="dial">
      ${renderGaugeSVG({ value: current.precipitation, min: 0, max: 20, color: 'var(--moss)', ticks: 4 })}
      <div class="dial-value">${fmt(current.precipitation, 1)} mm</div>
      <div class="dial-label">precipitation</div>
    </div>`;
}

function bearingLabel(deg) {
  if (deg === null || deg === undefined) return '—';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function renderChart() {
  const points = state.data.hourly;
  if (!points || points.length === 0) {
    el.chartStatus.textContent = 'The station did not report an hourly trace for this place.';
    return;
  }
  el.chartStatus.textContent = '';
  const displayPoints = points.map((p) => ({ ...p, temperature: convert.temp(p.temperature) }));
  drawStripChart(el.chart, displayPoints, { unit: state.unit });
  el.recorderRange.textContent = `next ${points.length} hours`;
}

function renderForecast() {
  const days = state.data.daily;
  if (!days || days.length === 0) {
    el.forecastRail.innerHTML = `<p class="state-body">No multi-day forecast was returned for this place.</p>`;
    return;
  }
  el.forecastRail.innerHTML = days.map((d, i) => {
    const cond  = conditionFromCode(d.code, 1);
    const label = i === 0 ? 'Today' : new Date(d.date).toLocaleDateString([], { weekday: 'short' });
    return `
      <div class="ticket">
        <div class="day">${label}</div>
        ${glyphSVG(cond.glyph)}
        <div class="range">
          <span class="hi">${fmt(convert.temp(d.max))}°</span>
          <span class="lo">${fmt(convert.temp(d.min))}°</span>
        </div>
      </div>`;
  }).join('');
}

function renderAll() {
  renderHero();
  renderDials();
  renderChart();
  renderForecast();
  el.footerUpdated.textContent = `last read ${new Date(state.data.fetchedAt).toLocaleTimeString()}`;
}

// ---------------------------------------------------------------------------
// Weather data flow
// ---------------------------------------------------------------------------

async function refresh() {
  if (!state.place) return;
  state.wxStatus = 'loading';
  renderLoading();
  try {
    const data = await fetchConditions(state.place);
    // Build a snapshot pairing the data with the place it came from.
    // checkWeatherEvents compares placeIds first — if they differ (place was
    // just switched) all delta rules are skipped for this cycle and the new
    // snapshot becomes the baseline for the next poll.
    const nextSnapshot = { placeId: state.place.id, data };
    checkWeatherEvents(state.prevWeatherSnapshot, nextSnapshot, state.unit);
    state.prevWeatherSnapshot = nextSnapshot;
    state.data     = data;
    state.wxStatus = 'ready';
    renderAll();
    renderLogbook();
  } catch (err) {
    state.wxStatus = 'error';
    state.wxError  = err instanceof StationError ? err : new StationError('bad-response', err.message);
    renderError(state.wxError);
  }
}

function selectPlace(place) {
  state.place = place;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(place));
  el.searchInput.value = place.name;
  closeResults();
  restartWeatherPolling();
  refresh();
}

function restartWeatherPolling() {
  if (state.wxPollTimer) clearInterval(state.wxPollTimer);
  state.wxPollTimer = setInterval(refresh, WEATHER_POLL_MS);
}

// ---------------------------------------------------------------------------
// Markets rendering
// ---------------------------------------------------------------------------

function renderMarketsLoading() {
  if (!el.tickerRail) return;
  el.tickerRail.innerHTML = `
    <div class="state-block" style="grid-column:1/-1">
      <p class="state-title">Listening to the ticker tape…</p>
      <p class="state-body">Reaching the market feed. This may take a moment.</p>
    </div>`;
}

function renderMarketsError(err) {
  if (!el.tickerRail) return;
  const copy = {
    'no-key':     { title: 'No market feed configured',    body: 'Add your Finnhub API key to js/config.js to enable the markets panel. See js/config.example.js for instructions.' },
    'rate-limit': { title: 'The ticker tape jammed',        body: 'Too many requests were sent to the market feed. The panel will retry shortly.' },
    'network':    { title: 'The market feed is not answering', body: 'Could not reach the data provider. Check your connection.' },
  }[err?.kind] ?? { title: 'The market feed returned an error', body: err?.message || 'An unexpected error occurred.' };

  el.tickerRail.innerHTML = `
    <div class="state-block is-error" style="grid-column:1/-1">
      <p class="state-title">${copy.title}</p>
      <p class="state-body">${copy.body}</p>
      ${err?.kind !== 'no-key' ? '<button type="button" id="markets-retry-btn">Try again</button>' : ''}
    </div>`;
  document.getElementById('markets-retry-btn')?.addEventListener('click', refreshMarkets);
}

function changeColor(pct) {
  if (pct === null || pct === 0) return 'var(--brass)';
  return pct > 0 ? 'var(--moss)' : 'var(--ember)';
}

function changeDirection(pct) {
  if (!pct || pct === 0) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

function changePctClamped(pct) {
  return Math.max(-10, Math.min(10, pct ?? 0));
}

function renderMarketCards() {
  if (!el.tickerRail) return;
  if (!state.marketData || state.marketData.length === 0) {
    el.tickerRail.innerHTML = `
      <div class="state-block" style="grid-column:1/-1">
        <p class="state-title">No symbols on the watchlist</p>
        <p class="state-body">Add a ticker symbol above to start tracking it.</p>
      </div>`;
    return;
  }

  el.tickerRail.innerHTML = state.marketData.map((item) => {
    if (item.status === 'error') {
      return `
        <div class="ticker-card is-error" data-symbol="${item.symbol}">
          <div class="ticker-card__head">
            <span class="ticker-card__symbol">${item.symbol}</span>
            <button class="ticker-card__remove" aria-label="Remove ${item.symbol}" data-remove="${item.symbol}">✕</button>
          </div>
          <p class="ticker-card__error-msg">${item.error.message}</p>
        </div>`;
    }
    const { quote, candles } = item;
    const pct   = quote.changePct ?? 0;
    const dir   = changeDirection(pct);
    const color = changeColor(pct);
    const sign  = pct > 0 ? '+' : '';
    const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '—';
    const dialValue = 5 + changePctClamped(pct) / 2;
    const dialSVG   = renderGaugeSVG({ value: dialValue, min: 0, max: 10, color, ticks: 4 });
    return `
      <div class="ticker-card" data-symbol="${item.symbol}">
        <div class="ticker-card__head">
          <span class="ticker-card__symbol">${item.symbol}</span>
          <button class="ticker-card__remove" aria-label="Remove ${item.symbol}" data-remove="${item.symbol}">✕</button>
        </div>
        <div class="ticker-card__dial">${dialSVG}</div>
        <div class="ticker-card__readout">
          <div class="ticker-card__price">$${fmtPrice(quote.price)}</div>
          <div class="ticker-card__change is-${dir}">${arrow} ${sign}${fmt(pct, 2)}%</div>
        </div>
        <div class="ticker-card__chart-wrap">
          <canvas aria-hidden="true" data-chart="${item.symbol}"></canvas>
        </div>
      </div>`;
  }).join('');

  state.marketData.forEach((item) => {
    if (item.status !== 'ok') return;
    const canvas = el.tickerRail.querySelector(`canvas[data-chart="${item.symbol}"]`);
    if (!canvas) return;
    drawMarketMiniChart(canvas, item.candles, changeDirection(item.quote.changePct));
  });

  el.tickerRail.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => removeSymbol(btn.dataset.remove));
  });
}

// ---------------------------------------------------------------------------
// Markets data flow
// ---------------------------------------------------------------------------

async function refreshMarkets() {
  if (state.watchlist.length === 0) {
    state.marketData = [];
    state.mktStatus  = 'ready';
    renderMarketCards();
    return;
  }
  state.mktStatus = 'loading';
  renderMarketsLoading();
  try {
    const results    = await fetchWatchlist(state.watchlist);
    checkMarketEvents(state.prevPriceMap, results);
    state.marketData = results;
    state.mktStatus  = 'ready';
    renderMarketCards();
    renderLogbook();
    if (el.marketsUpdated) el.marketsUpdated.textContent = `last read ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    state.mktStatus = 'error';
    state.mktError  = err instanceof MarketError ? err : new MarketError('bad-response', err.message);
    renderMarketsError(state.mktError);
  }
}

function restartMarketsPolling() {
  if (state.mktPollTimer) clearInterval(state.mktPollTimer);
  state.mktPollTimer = setInterval(() => {
    if (state.panel === 'markets') refreshMarkets();
  }, MARKETS_POLL_MS);
}

// ---------------------------------------------------------------------------
// Markets watchlist management
// ---------------------------------------------------------------------------

function loadWatchlist() {
  try {
    const stored = localStorage.getItem(WATCHLIST_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map((s) => s.toUpperCase());
    }
  } catch { /* ignore */ }
  return [...DEFAULT_WATCHLIST];
}

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(state.watchlist));
}

function addSymbol(rawSymbol) {
  const sym = rawSymbol.toUpperCase().trim().replace(/[^A-Z0-9.^-]/g, '');
  if (!sym || state.watchlist.includes(sym)) return;
  state.watchlist.push(sym);
  saveWatchlist();
  refreshMarkets();
}

function removeSymbol(sym) {
  state.watchlist  = state.watchlist.filter((s) => s !== sym);
  saveWatchlist();
  clearHistory(sym);
  state.prevPriceMap.delete(sym);   // clear logbook baseline so re-add starts fresh
  state.marketData = state.marketData.filter((d) => d.symbol !== sym);
  renderMarketCards();
}

if (el.watchlistForm) {
  el.watchlistForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = el.watchlistInput?.value ?? '';
    if (val.trim()) { addSymbol(val.trim()); el.watchlistInput.value = ''; }
  });
}

// ---------------------------------------------------------------------------
// Games rendering
// ---------------------------------------------------------------------------

function renderGamesLoading() {
  if (!el.gameRail) return;
  el.gameRail.innerHTML = `
    <div class="state-block" style="grid-column:1/-1">
      <p class="state-title">Querying the servers…</p>
      <p class="state-body">Fetching live player counts from Steam.</p>
    </div>`;
}

function renderGamesError(err) {
  if (!el.gameRail) return;
  const copy = {
    'network':    { title: 'Steam is not answering',    body: 'Could not reach the Steam data feed. Check your connection.' },
    'not-found':  { title: 'Game not found',            body: err?.message || 'The appid may be wrong or the game is delisted.' },
    'malformed':  { title: 'Unreadable server response', body: 'Steam returned data this panel could not parse.' },
    'bad-response':{ title: 'Steam rejected the request', body: err?.message || 'An unexpected error from Steam.' },
  }[err?.kind] ?? { title: 'Could not fetch player counts', body: err?.message || 'An unexpected error occurred.' };

  el.gameRail.innerHTML = `
    <div class="state-block is-error" style="grid-column:1/-1">
      <p class="state-title">${copy.title}</p>
      <p class="state-body">${copy.body}</p>
      <button type="button" id="games-retry-btn">Try again</button>
    </div>`;
  document.getElementById('games-retry-btn')?.addEventListener('click', refreshGames);
}

function renderGameCards() {
  if (!el.gameRail) return;
  if (!state.gamesData || state.gamesData.length === 0) {
    el.gameRail.innerHTML = `
      <div class="state-block" style="grid-column:1/-1">
        <p class="state-title">No games on the watchlist</p>
        <p class="state-body">Search for a game above or paste a Steam appid to start tracking it.</p>
      </div>`;
    return;
  }

  el.gameRail.innerHTML = state.gamesData.map((item) => {
    if (item.status === 'error') {
      return `
        <div class="game-card is-error" data-appid="${item.appid}">
          <div class="game-card__head">
            <span class="game-card__name" title="${item.name}">${item.name}</span>
            <button class="game-card__remove" aria-label="Remove ${item.name}" data-remove-appid="${item.appid}">✕</button>
          </div>
          <p class="game-card__error-msg">${item.error.message}</p>
        </div>`;
    }

    const { playerCount, peak, history, name, appid } = item;
    // Dial: player count vs rolling peak. Use peak as max; if peak is 0 or
    // equal to count, set max to count * 1.2 so the needle isn't pinned.
    const dialMax = peak > playerCount ? peak : Math.max(playerCount * 1.2, 1);
    const dialSVG = renderGaugeSVG({
      value: playerCount,
      min:   0,
      max:   dialMax,
      color: 'var(--glass-blue)',
      ticks: 4,
    });

    return `
      <div class="game-card" data-appid="${appid}">
        <div class="game-card__head">
          <span class="game-card__name" title="${name}">${name}</span>
          <button class="game-card__remove" aria-label="Remove ${name}" data-remove-appid="${appid}">✕</button>
        </div>
        <div class="game-card__dial">${dialSVG}</div>
        <div class="game-card__readout">
          <div class="game-card__count">${fmtCount(playerCount)}</div>
          <div class="game-card__peak">peak tracked: <span>${fmtCount(peak)}</span></div>
        </div>
        <div class="game-card__chart-wrap">
          <canvas aria-hidden="true" data-game-chart="${appid}"></canvas>
        </div>
      </div>`;
  }).join('');

  // Draw mini charts
  state.gamesData.forEach((item) => {
    if (item.status !== 'ok') return;
    const canvas = el.gameRail.querySelector(`canvas[data-game-chart="${item.appid}"]`);
    if (!canvas) return;
    drawGameMiniChart(canvas, item.history);
  });

  // Wire remove buttons
  el.gameRail.querySelectorAll('[data-remove-appid]').forEach((btn) => {
    btn.addEventListener('click', () => removeGame(btn.dataset.removeAppid));
  });
}

// ---------------------------------------------------------------------------
// Games data flow
// ---------------------------------------------------------------------------

async function refreshGames() {
  if (state.gamesList.length === 0) {
    state.gamesData   = [];
    state.gamesStatus = 'ready';
    renderGameCards();
    return;
  }
  state.gamesStatus = 'loading';
  renderGamesLoading();
  try {
    const results     = await fetchGameWatchlist(state.gamesList);
    checkGamesEvents(state.prevPeakMap, results);
    state.gamesData   = results;
    state.gamesStatus = 'ready';
    renderGameCards();
    renderLogbook();
    if (el.gamesUpdated) el.gamesUpdated.textContent = `last read ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    state.gamesStatus = 'error';
    state.gamesError  = err instanceof GameError ? err : new GameError('bad-response', err.message);
    renderGamesError(state.gamesError);
  }
}

function restartGamesPolling() {
  if (state.gamesPollTimer) clearInterval(state.gamesPollTimer);
  state.gamesPollTimer = setInterval(() => {
    if (state.panel === 'games') refreshGames();
  }, GAMES_POLL_MS);
}

// ---------------------------------------------------------------------------
// Games watchlist management
// ---------------------------------------------------------------------------

function loadGamesList() {
  try {
    const stored = localStorage.getItem(GAMES_LIST_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch { /* ignore */ }
  return DEFAULT_GAMES_LIST.map((g) => ({ ...g }));
}

function saveGamesList() {
  localStorage.setItem(GAMES_LIST_KEY, JSON.stringify(state.gamesList));
}

function addGame(appid, name) {
  const id = String(appid).trim();
  if (!id || state.gamesList.some((g) => g.appid === id)) return;
  state.gamesList.push({ appid: id, name: name || `App ${id}` });
  saveGamesList();
  refreshGames();
}

function removeGame(appid) {
  const id = String(appid);
  state.gamesList = state.gamesList.filter((g) => g.appid !== id);
  saveGamesList();
  clearGameHistory(id);
  clearPeak(id);
  state.prevPeakMap.delete(id);     // clear logbook baseline so re-add starts fresh
  state.gamesData = state.gamesData.filter((d) => d.appid !== id);
  renderGameCards();
}

// ---------------------------------------------------------------------------
// Game search UI — mirrors the weather place search
// ---------------------------------------------------------------------------

let gameSearchDebounce = null;
let gameSearchResults  = [];
let gameActiveIndex    = -1;

function closeGameResults() {
  el.gameSearchResults.hidden = true;
  el.gameSearchResults.innerHTML = '';
  el.gameSearchInput.setAttribute('aria-expanded', 'false');
  gameActiveIndex = -1;
}

function openGameResults(results) {
  gameSearchResults = results;
  gameActiveIndex   = -1;
  if (results.length === 0) {
    // Show popular games as a hint when the query is short/empty
    const hint = POPULAR_GAMES.slice(0, 5);
    el.gameSearchResults.innerHTML = hint.map((g, i) => `
      <li role="option" data-index="${i}" data-appid="${g.appid}" data-name="${g.name}">
        <span>${g.name}</span>
        <span class="game-appid">${g.appid}</span>
      </li>`).join('');
    el.gameSearchResults.hidden = false;
    el.gameSearchResults.querySelectorAll('li').forEach((li) => {
      li.addEventListener('click', () => {
        addGame(li.dataset.appid, li.dataset.name);
        el.gameSearchInput.value = '';
        closeGameResults();
      });
    });
    return;
  }
  el.gameSearchResults.innerHTML = results.map((r, i) => `
    <li role="option" data-index="${i}">
      <span>${r.name}</span>
      <span class="game-appid">${r.appid}</span>
    </li>`).join('');
  el.gameSearchResults.hidden = false;
  el.gameSearchInput.setAttribute('aria-expanded', 'true');
  el.gameSearchResults.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => {
      const r = results[Number(li.dataset.index)];
      addGame(r.appid, r.name);
      el.gameSearchInput.value = '';
      closeGameResults();
    });
  });
}

el.gameSearchInput.addEventListener('focus', () => {
  if (el.gameSearchInput.value.trim().length < 2) openGameResults([]);
});

el.gameSearchInput.addEventListener('input', () => {
  const q = el.gameSearchInput.value;
  clearTimeout(gameSearchDebounce);
  gameSearchDebounce = setTimeout(async () => {
    if (q.trim().length < 2) { openGameResults([]); return; }
    try {
      const results = await searchGames(q);
      openGameResults(results);
    } catch {
      closeGameResults();
    }
  }, 280);
});

el.gameSearchInput.addEventListener('keydown', (e) => {
  if (el.gameSearchResults.hidden) return;
  const items = el.gameSearchResults.querySelectorAll('li');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    gameActiveIndex = Math.min(gameActiveIndex + 1, items.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    gameActiveIndex = Math.max(gameActiveIndex - 1, 0);
  } else if (e.key === 'Enter') {
    if (gameActiveIndex >= 0) {
      e.preventDefault();
      const r = gameSearchResults[gameActiveIndex];
      if (r) { addGame(r.appid, r.name); el.gameSearchInput.value = ''; closeGameResults(); }
    }
    return;
  } else if (e.key === 'Escape') {
    closeGameResults(); return;
  } else { return; }
  items.forEach((li, i) => li.toggleAttribute('data-active', i === gameActiveIndex));
  items[gameActiveIndex]?.scrollIntoView({ block: 'nearest' });
});

el.gameSearchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = el.gameSearchInput.value.trim();
  if (!q) return;
  // If input is a raw appid, add it directly; otherwise use first search result
  if (/^\d{4,}$/.test(q)) {
    addGame(q, `App ${q}`);
    el.gameSearchInput.value = '';
    closeGameResults();
  } else if (gameSearchResults.length > 0) {
    const r = gameSearchResults[Math.max(0, gameActiveIndex)];
    addGame(r.appid, r.name);
    el.gameSearchInput.value = '';
    closeGameResults();
  }
});

document.addEventListener('click', (e) => {
  if (!el.gameSearchForm.contains(e.target)) closeGameResults();
});

// ---------------------------------------------------------------------------
// Weather search UI
// ---------------------------------------------------------------------------

let debounceTimer  = null;
let activeIndex    = -1;
let currentResults = [];

function closeResults() {
  el.searchResults.hidden = true;
  el.searchResults.innerHTML = '';
  el.searchInput.setAttribute('aria-expanded', 'false');
  activeIndex = -1;
}

function openResults(results) {
  currentResults = results;
  activeIndex = -1;
  if (results.length === 0) { el.searchResults.hidden = true; return; }
  el.searchResults.innerHTML = results.map((r, i) => `
    <li role="option" data-index="${i}">
      <span>${r.name}</span>
      <span class="place-region">${r.region}</span>
    </li>`).join('');
  el.searchResults.hidden = false;
  el.searchInput.setAttribute('aria-expanded', 'true');
  el.searchResults.querySelectorAll('li').forEach((li) => {
    li.addEventListener('click', () => selectPlace(results[Number(li.dataset.index)]));
  });
}

el.searchInput.addEventListener('input', () => {
  const q = el.searchInput.value;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try { openResults(await searchPlaces(q)); } catch { closeResults(); }
  }, 280);
});

el.searchInput.addEventListener('keydown', (e) => {
  if (el.searchResults.hidden) return;
  const items = el.searchResults.querySelectorAll('li');
  if (e.key === 'ArrowDown')       { e.preventDefault(); activeIndex = Math.min(activeIndex + 1, items.length - 1); }
  else if (e.key === 'ArrowUp')    { e.preventDefault(); activeIndex = Math.max(activeIndex - 1, 0); }
  else if (e.key === 'Enter')      { if (activeIndex >= 0) { e.preventDefault(); selectPlace(currentResults[activeIndex]); } return; }
  else if (e.key === 'Escape')     { closeResults(); return; }
  else                             { return; }
  items.forEach((li, i) => li.toggleAttribute('data-active', i === activeIndex));
  items[activeIndex]?.scrollIntoView({ block: 'nearest' });
});

el.searchForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (currentResults.length > 0) selectPlace(currentResults[0]);
});

document.addEventListener('click', (e) => {
  if (!el.searchForm.contains(e.target)) closeResults();
});

// ---------------------------------------------------------------------------
// Unit toggle
// ---------------------------------------------------------------------------

el.unitToggle.addEventListener('click', () => {
  state.unit = state.unit === 'metric' ? 'imperial' : 'metric';
  localStorage.setItem(UNIT_KEY, state.unit);
  el.unitToggle.setAttribute('aria-pressed', String(state.unit === 'imperial'));
  if (state.wxStatus === 'ready') renderAll();
});
el.unitToggle.setAttribute('aria-pressed', String(state.unit === 'imperial'));

// ---------------------------------------------------------------------------
// Theme toggle
// ---------------------------------------------------------------------------

if (el.themeToggle) {
  el.themeToggle.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, state.theme);
    applyTheme(state.theme);
  });
}

// ---------------------------------------------------------------------------
// Resize
// ---------------------------------------------------------------------------

let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.wxStatus    === 'ready') renderChart();
    if (state.mktStatus   === 'ready') renderMarketCards();
    if (state.gamesStatus === 'ready') renderGameCards();
  }, 150);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  switchPanel(state.panel);
  el.unitToggle.setAttribute('aria-pressed', String(state.unit === 'imperial'));
  applyTheme(state.theme);
  renderLogbook();   // show any persisted entries before first poll

  // Start all three polling loops immediately
  restartMarketsPolling();
  restartGamesPolling();

  // Weather: geolocation or stored place
  let initial = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) initial = JSON.parse(stored);
  } catch { initial = null; }

  const fallback = {
    id: 'default-kathmandu', name: 'Kathmandu',
    region: 'Bagmati Province, Nepal',
    latitude: 27.7172, longitude: 85.324, timezone: 'auto',
  };

  if (initial) {
    state.place = initial;
    el.searchInput.value = state.place.name;
  } else {
    try {
      const geoPlace = await getGeolocation();
      state.place = geoPlace;
      el.searchInput.value = geoPlace.name;
      showGeoNote('Using your current location. Search above to change it.');
    } catch (err) {
      state.place = fallback;
      el.searchInput.value = fallback.name;
      const noteMsg = {
        'geo-denied':      'Location access was not granted — showing the default station (Kathmandu). Search above to change it.',
        'geo-unavailable': 'Location is not available on this device — showing the default station (Kathmandu).',
        'geo-timeout':     'Getting your location timed out — showing the default station (Kathmandu). Search above to change it.',
      }[err.kind] ?? 'Location could not be determined — showing the default station (Kathmandu).';
      showGeoNote(noteMsg, true);
    }
  }

  restartWeatherPolling();
  refresh();

  // Kick off whichever non-weather panel was active on last visit
  if (state.panel === 'markets') refreshMarkets();
  if (state.panel === 'games')   refreshGames();
}

boot();
