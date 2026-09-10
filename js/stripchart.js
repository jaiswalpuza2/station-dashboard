// Draws a trace onto a graph-paper canvas, styled like an old strip-chart
// recorder: a single continuous ink line over a ruled grid, with a beveled
// current-reading marker at the latest point.
//
// Canvas 2D ignores CSS custom properties — we can't do ctx.fillStyle =
// 'var(--brass)'. Instead, we read the computed value from a known DOM
// element at draw time using getComputedStyle(). This means the canvas
// always matches whatever theme (light/dark) is currently active, including
// mid-session theme switches, without a separate JS constant to keep in sync.

/**
 * Read a CSS custom property value from the document root at the moment of
 * the call, so we always get the current theme's tokens.
 */
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a named theme role to its current hex/rgb value.
 * Rather than hard-coding hex fallbacks here, we fall back to a safe neutral
 * so a misconfigured theme never crashes the draw call.
 */
function themeColors() {
  return {
    trace:        cssVar('--brass')        || '#C9A66B',
    traceGlow:    cssVar('--brass')        || '#C9A66B',
    label:        cssVar('--ink-muted')    || '#9AA5B1',
    marker:       cssVar('--brass')        || '#C9A66B',
    markerHalo:   cssVar('--brass')        || '#C9A66B',
    noData:       cssVar('--ink-muted')    || '#9AA5B1',
    // For up/down market traces a different token pair is used
    up:           cssVar('--moss')         || '#7A9E7E',
    down:         cssVar('--ember')        || '#C15A3E',
  };
}

/**
 * Draw the temperature (or any single-value) strip-chart trace.
 * `points` — array of { time: ISOString, temperature: number }
 */
export function drawStripChart(canvas, points, { unit = 'metric' } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width = Math.max(rect.width - 32, 100);
  const height = Math.max(rect.height - 32, 100);

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const c = themeColors();

  if (!points || points.length < 2) {
    ctx.fillStyle = c.noData;
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('not enough data to trace yet', width / 2, height / 2);
    return;
  }

  const temps = points.map((p) => p.temperature);
  const min = Math.min(...temps);
  const max = Math.max(...temps);
  const pad = (max - min) * 0.2 || 2;
  const yMin = min - pad;
  const yMax = max + pad;

  const marginX = 8;
  const plotW = width - marginX * 2;

  const xFor = (i) => marginX + (i / (points.length - 1)) * plotW;
  const yFor = (t) => height - ((t - yMin) / (yMax - yMin)) * height;

  // filled area under the trace, faint
  ctx.beginPath();
  ctx.moveTo(xFor(0), height);
  points.forEach((p, i) => ctx.lineTo(xFor(i), yFor(p.temperature)));
  ctx.lineTo(xFor(points.length - 1), height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  // derive rgba from the trace color; keep fill subtle in both themes
  gradient.addColorStop(0, hexToRgba(c.trace, 0.16));
  gradient.addColorStop(1, hexToRgba(c.trace, 0));
  ctx.fillStyle = gradient;
  ctx.fill();

  // the ink trace itself
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(i);
    const y = yFor(p.temperature);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = c.trace;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // hour tick labels, sparse
  ctx.fillStyle = c.label;
  ctx.font = '9px "IBM Plex Mono", monospace';
  ctx.textAlign = 'center';
  const labelEvery = Math.ceil(points.length / 6);
  points.forEach((p, i) => {
    if (i % labelEvery !== 0) return;
    const d = new Date(p.time);
    const label = d.toLocaleTimeString([], { hour: 'numeric' });
    ctx.fillText(label, xFor(i), height - 4);
  });

  // current point marker
  const lastIdx = points.length - 1;
  const lx = xFor(lastIdx);
  const ly = yFor(points[lastIdx].temperature);
  ctx.beginPath();
  ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = c.marker;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx, ly, 6.5, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(c.markerHalo, 0.5);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/**
 * Draw a price-history trace for a stock ticker card's mini chart.
 * `candles` — array of { time: ms, close: number }
 * `direction` — 'up' | 'down' | 'flat' — controls the trace color
 */
export function drawMarketMiniChart(canvas, candles, direction = 'flat') {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  const width  = Math.max(rect.width, 40);
  const height = Math.max(rect.height, 40);

  canvas.width  = width  * dpr;
  canvas.height = height * dpr;
  canvas.style.width  = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const c = themeColors();

  if (!candles || candles.length < 2) {
    ctx.fillStyle = c.noData;
    ctx.font = '9px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('building trace…', width / 2, height / 2 + 3);
    return;
  }

  const closes = candles.map((d) => d.close).filter((v) => v !== null);
  const minV = Math.min(...closes);
  const maxV = Math.max(...closes);
  const pad  = (maxV - minV) * 0.15 || 0.5;
  const yMin = minV - pad;
  const yMax = maxV + pad;

  const mX = 4;
  const plotW = width - mX * 2;
  const xFor = (i) => mX + (i / (candles.length - 1)) * plotW;
  const yFor = (v) => height - 4 - ((v - yMin) / (yMax - yMin)) * (height - 8);

  const traceColor = direction === 'up' ? c.up : direction === 'down' ? c.down : c.label;

  // fill under trace
  ctx.beginPath();
  ctx.moveTo(xFor(0), height);
  candles.forEach((d, i) => { if (d.close !== null) ctx.lineTo(xFor(i), yFor(d.close)); });
  ctx.lineTo(xFor(candles.length - 1), height);
  ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, hexToRgba(traceColor, 0.18));
  g.addColorStop(1, hexToRgba(traceColor, 0));
  ctx.fillStyle = g;
  ctx.fill();

  // trace line
  ctx.beginPath();
  candles.forEach((d, i) => {
    if (d.close === null) return;
    const x = xFor(i), y = yFor(d.close);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = traceColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // end marker
  const last = candles[candles.length - 1];
  if (last.close !== null) {
    const lx = xFor(candles.length - 1);
    const ly = yFor(last.close);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = traceColor;
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 3- or 6-digit hex color to rgba(...) with the given alpha.
 * Falls back gracefully if the input is already an rgb/rgba string or a
 * CSS variable reference (shouldn't happen since we resolve via getComputedStyle,
 * but guards against edge cases).
 */
function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#')) {
    // Already rgb/rgba or something else — just use as-is with global alpha
    // by wrapping in a canvas globalAlpha call is cleaner, but we can't do
    // that easily here, so return the color unchanged and accept full opacity.
    return hex || 'rgba(0,0,0,0)';
  }
  let h = hex.slice(1);
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const r = parseInt(h.slice(0,2), 16);
  const g = parseInt(h.slice(2,4), 16);
  const b = parseInt(h.slice(4,6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Draw a player-count history trace for a game card's mini chart.
 * `points` — array of { time: ms, count: number } (from recordGameSnapshot)
 * The trace is always drawn in brass — player count has no up/down polarity.
 */
export function drawGameMiniChart(canvas, points) {
  // Map { time, count } → { time, close } so we can reuse drawMarketMiniChart
  const candles = (points ?? []).map((p) => ({ time: p.time, close: p.count }));
  drawMarketMiniChart(canvas, candles, 'flat');
}
