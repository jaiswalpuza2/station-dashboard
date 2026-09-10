// Station — local configuration template
// Copy this file to js/config.js and fill in your key.
// config.js is gitignored; this example file is tracked so new contributors
// know what they need.
//
// Stock data: Finnhub (https://finnhub.io) — free tier, 60 calls/minute.
// Sign up at https://finnhub.io/register to get a key.
//
// Rate-limit note (Finnhub free tier):
//   60 API calls / minute. The market panel polls once per minute at most,
//   so a 5-symbol watchlist uses ≤ 5 calls/poll — well within the limit
//   during a normal session. The app backs off on a 429 automatically.

export const FINNHUB_API_KEY = 'your_finnhub_key_here';
