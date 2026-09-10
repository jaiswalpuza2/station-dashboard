// Custom line-drawn condition glyphs. No emoji, no icon-font — each glyph is
// drawn to sit comfortably next to the mono/serif type and brass accent.
// WMO weather codes: https://open-meteo.com/en/docs (see "weathercode")

const GLYPHS = {
  clearDay: `<circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
      <line x1="12" y1="2" x2="12" y2="4.6"/><line x1="12" y1="19.4" x2="12" y2="22"/>
      <line x1="2" y1="12" x2="4.6" y2="12"/><line x1="19.4" y1="12" x2="22" y2="12"/>
      <line x1="4.9" y1="4.9" x2="6.7" y2="6.7"/><line x1="17.3" y1="17.3" x2="19.1" y2="19.1"/>
      <line x1="4.9" y1="19.1" x2="6.7" y2="17.3"/><line x1="17.3" y1="6.7" x2="19.1" y2="4.9"/>
    </g>`,
  clearNight: `<path d="M15.5 3.5a8 8 0 1 0 5 14.2 9 9 0 0 1-5-14.2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  cloud: `<path d="M6.5 17.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.7-1.7A4.3 4.3 0 0 1 17.5 17.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  cloudSun: `<circle cx="7.5" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="7.5" y1="1.8" x2="7.5" y2="3.4"/><line x1="1.8" y1="8" x2="3.4" y2="8"/><line x1="3.2" y1="3.7" x2="4.3" y2="4.8"/></g>
    <path d="M9 18.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.4-1.3A4.3 4.3 0 0 1 20 18.5H9z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
  fog: `<path d="M4 9.5h13M2 13h16M4 16.5h13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
    <path d="M6.5 6.3a4 4 0 0 1 .3-2.6 5 5 0 0 1 9.4 1.1" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>`,
  drizzle: `<path d="M6.5 12.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.7-1.7A4.3 4.3 0 0 1 17.5 12.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <g stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><line x1="8" y1="16" x2="7.2" y2="19"/><line x1="12" y1="16" x2="11.2" y2="19"/><line x1="16" y1="16" x2="15.2" y2="19"/></g>`,
  rain: `<path d="M6.5 11.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.7-1.7A4.3 4.3 0 0 1 17.5 11.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="7.5" y1="15" x2="6.3" y2="20"/><line x1="12" y1="15" x2="10.8" y2="20"/><line x1="16.5" y1="15" x2="15.3" y2="20"/></g>`,
  snow: `<path d="M6.5 11.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.7-1.7A4.3 4.3 0 0 1 17.5 11.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
      <line x1="8" y1="15.5" x2="8" y2="20.5"/><line x1="5.8" y1="16.8" x2="10.2" y2="19.2"/><line x1="10.2" y1="16.8" x2="5.8" y2="19.2"/>
      <line x1="15" y1="15.5" x2="15" y2="20.5"/><line x1="12.8" y1="16.8" x2="17.2" y2="19.2"/><line x1="17.2" y1="16.8" x2="12.8" y2="19.2"/>
    </g>`,
  storm: `<path d="M6.5 11.5a4 4 0 0 1 .3-8 5 5 0 0 1 9.7-1.7A4.3 4.3 0 0 1 17.5 11.5h-11z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M12.5 14.5 9.5 19h3l-1.5 4 4-5.5h-3l1.5-3z" fill="currentColor" stroke="none"/>`,
};

// Maps Open-Meteo WMO weather codes to a glyph key + short label.
// https://open-meteo.com/en/docs — "WMO Weather interpretation codes"
export function conditionFromCode(code, isDay = 1) {
  const map = {
    0: { glyph: isDay ? 'clearDay' : 'clearNight', label: 'Clear sky' },
    1: { glyph: isDay ? 'clearDay' : 'clearNight', label: 'Mainly clear' },
    2: { glyph: isDay ? 'cloudSun' : 'cloud', label: 'Partly cloudy' },
    3: { glyph: 'cloud', label: 'Overcast' },
    45: { glyph: 'fog', label: 'Fog' },
    48: { glyph: 'fog', label: 'Depositing rime fog' },
    51: { glyph: 'drizzle', label: 'Light drizzle' },
    53: { glyph: 'drizzle', label: 'Drizzle' },
    55: { glyph: 'drizzle', label: 'Dense drizzle' },
    56: { glyph: 'drizzle', label: 'Freezing drizzle' },
    57: { glyph: 'drizzle', label: 'Freezing drizzle' },
    61: { glyph: 'rain', label: 'Slight rain' },
    63: { glyph: 'rain', label: 'Rain' },
    65: { glyph: 'rain', label: 'Heavy rain' },
    66: { glyph: 'rain', label: 'Freezing rain' },
    67: { glyph: 'rain', label: 'Freezing rain' },
    71: { glyph: 'snow', label: 'Slight snow' },
    73: { glyph: 'snow', label: 'Snow' },
    75: { glyph: 'snow', label: 'Heavy snow' },
    77: { glyph: 'snow', label: 'Snow grains' },
    80: { glyph: 'rain', label: 'Rain showers' },
    81: { glyph: 'rain', label: 'Rain showers' },
    82: { glyph: 'rain', label: 'Violent rain showers' },
    85: { glyph: 'snow', label: 'Snow showers' },
    86: { glyph: 'snow', label: 'Heavy snow showers' },
    95: { glyph: 'storm', label: 'Thunderstorm' },
    96: { glyph: 'storm', label: 'Thunderstorm, hail' },
    99: { glyph: 'storm', label: 'Thunderstorm, heavy hail' },
  };
  return map[code] ?? { glyph: 'cloud', label: 'Conditions unknown' };
}

export function glyphMarkup(key) {
  return GLYPHS[key] ?? GLYPHS.cloud;
}

export function glyphSVG(key, extraClass = '') {
  return `<svg class="glyph ${extraClass}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${glyphMarkup(key)}</svg>`;
}
