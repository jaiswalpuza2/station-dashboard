// Station — local configuration
// This file is gitignored. Copy it from config.example.js and fill in your key.
//
// Stock data: Finnhub (https://finnhub.io) — free tier, 60 calls/minute.
// Sign up at https://finnhub.io/register to get a key.
// Alpha Vantage (https://www.alphavantage.co/support/#api-key) is an
// alternative (25 calls/day on the free tier — much tighter, so Finnhub is
// recommended). Either way: do NOT commit a real key to version control.
//
// Rate-limit note (Finnhub free tier):
//   60 API calls / minute, ~30 calls/month per symbol for EOD candles.
//   The market panel polls once per minute at most, so a 5-symbol watchlist
//   uses ≤ 5 calls/poll — well within the limit during a normal session.
//   The app backs off automatically on a 429 response (see markets-api.js).

export const FINNHUB_API_KEY = 'dah35q1r01qomffmhka0dah35q1r01qomffmhkag';   // ← paste your Finnhub key here
