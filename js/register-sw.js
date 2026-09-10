// Service worker registration — kept in its own file so it can be included
// as a classic (non-module) script if needed, and to keep app.js clean.
//
// Service workers only activate over HTTPS or on localhost/127.0.0.1.
// On a plain http:// address (other than localhost) the registration is
// silently skipped by the browser — all existing functionality still works,
// you just don't get offline/install support.

if ('serviceWorker' in navigator) {
  // Use the window load event so SW registration doesn't compete with the
  // initial page render — the app is fully interactive before we do this.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((registration) => {
        console.info('[SW] Registered, scope:', registration.scope);
      })
      .catch((err) => {
        // Registration failure is non-fatal — the app works without it.
        console.warn('[SW] Registration failed:', err);
      });
  });
}
