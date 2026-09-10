// Analog instrument faces, drawn as SVG. Every dial sweeps 270° (-135° to
// +135°) like a real panel gauge, with a needle whose rotation encodes value.
// Kept dependency-free and reusable for both the large hero gauge and the
// four small dials in the rail.

const START_ANGLE = -135;
const SWEEP = 270;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function valueToAngle(value, min, max) {
  const t = clamp((value - min) / (max - min), 0, 1);
  return START_ANGLE + t * SWEEP;
}

function polar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = polar(cx, cy, r, endAngle);
  const end = polar(cx, cy, r, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 0 ${end.x} ${end.y}`;
}

/**
 * Renders a full instrument face: track arc, value arc, tick marks, and a
 * needle. Returns an SVG string sized to a 200x200 viewBox regardless of the
 * element's rendered size, so it scales cleanly via CSS.
 */
export function renderGaugeSVG({ value, min, max, color = 'var(--brass)', ticks = 6, nullState = false }) {
  const cx = 100, cy = 100, r = 82;
  const trackArc = arcPath(cx, cy, r, START_ANGLE, START_ANGLE + SWEEP);

  if (nullState || value === null || value === undefined) {
    return `<svg viewBox="0 0 200 200">
      <path d="${trackArc}" fill="none" stroke="var(--hairline)" stroke-width="6" stroke-linecap="round"/>
      <circle cx="${cx}" cy="${cy}" r="3" fill="var(--ink-faint)"/>
      <text x="${cx}" y="${cy + 34}" text-anchor="middle" font-size="10" fill="var(--ink-faint)" font-family="var(--font-mono)">no reading</text>
    </svg>`;
  }

  const angle = valueToAngle(value, min, max);
  const valueArc = arcPath(cx, cy, r, START_ANGLE, angle);
  const needleEnd = polar(cx, cy, r - 16, angle);

  let tickMarks = '';
  for (let i = 0; i <= ticks; i++) {
    const a = START_ANGLE + (i / ticks) * SWEEP;
    const outer = polar(cx, cy, r + 8, a);
    const inner = polar(cx, cy, r + 1, a);
    tickMarks += `<line x1="${inner.x}" y1="${inner.y}" x2="${outer.x}" y2="${outer.y}" stroke="var(--hairline)" stroke-width="2" stroke-linecap="round"/>`;
  }

  return `<svg viewBox="0 0 200 200">
    <path d="${trackArc}" fill="none" stroke="var(--hairline)" stroke-width="6" stroke-linecap="round"/>
    <path d="${valueArc}" fill="none" stroke="${color}" stroke-width="6" stroke-linecap="round"/>
    ${tickMarks}
    <line class="needle sweep" x1="${cx}" y1="${cy}" x2="${needleEnd.x}" y2="${needleEnd.y}"
      stroke="${color}" stroke-width="2.4" stroke-linecap="round"
      style="transform: rotate(${angle}deg)"/>
    <circle cx="${cx}" cy="${cy}" r="4.5" fill="${color}"/>
  </svg>`;
}

/** Wind direction indicator: a compass-style needle pointing the direction
 *  the wind is blowing FROM, which is the meteorological convention. */
export function renderCompassSVG({ direction, speed, nullState = false }) {
  const cx = 42, cy = 42, r = 32;
  if (nullState || direction === null || direction === undefined) {
    return `<svg viewBox="0 0 84 84">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hairline)" stroke-width="2"/>
      <text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="9" fill="var(--ink-faint)" font-family="var(--font-mono)">calm</text>
    </svg>`;
  }
  const tip = polar(cx, cy, r - 6, direction);
  const tail = polar(cx, cy, r - 18, direction + 180);
  const labels = ['N', 'E', 'S', 'W'].map((l, i) => {
    const p = polar(cx, cy, r + 8, i * 90);
    return `<text x="${p.x}" y="${p.y + 3}" text-anchor="middle" font-size="7" fill="var(--ink-faint)" font-family="var(--font-mono)">${l}</text>`;
  }).join('');

  return `<svg viewBox="0 0 84 84">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--hairline)" stroke-width="2"/>
    ${labels}
    <line class="needle sweep" x1="${tail.x}" y1="${tail.y}" x2="${tip.x}" y2="${tip.y}"
      stroke="var(--glass-blue)" stroke-width="2.4" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="3" fill="var(--glass-blue)"/>
  </svg>`;
}
