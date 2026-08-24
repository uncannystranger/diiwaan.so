/* Runs before the first frame, as a classic blocking script in <head>.

   Everything else in the app is a module, which means it runs after the document
   is parsed — too late to decide what colour the page is. Without this, a reload
   spends the whole account round-trip painted in the default palette and then
   jumps to the business's own colours.

   These values are only what this device last saw. The server stays the source
   of truth and corrects them a moment later if they ever disagree. */
(function () {
  var root = document.documentElement;

  try {
    var lang = localStorage.getItem('diiwaan:lang');
    if (lang === 'so' || lang === 'en') root.lang = lang;

    var theme = localStorage.getItem('diiwaan:theme') || 'system';
    root.setAttribute('data-theme', theme === 'system'
      ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme);

    // The customer page for one business must not borrow another's colours, so
    // the remembered paint is filed under the queue it belongs to.
    var path = (location.hash.replace(/^#\/?/, '') || location.pathname.slice(1)).split('/');
    var customer = (path[0] === 'j' || path[0] === 't') && path[1];

    /* The signed-out screens are Diiwaan's own, not a business's. Restoring the
       last account's colours here painted the landing page in whatever palette
       that owner had chosen. */
    var entry = { '': 1, signup: 1, signin: 1, forgot: 1, reset: 1 };
    if (!customer && entry[path[0]]) return;

    var key = customer ? 'q:' + path[1] : 'owner';

    var saved = JSON.parse(localStorage.getItem('diiwaan:paint:' + key) || 'null');
    if (saved && typeof saved.style === 'string') {
      root.setAttribute('style', saved.style);
      root.setAttribute('data-surface', saved.surface || 'aurora');
      root.setAttribute('data-brand', '');
    }
  } catch (e) {
    /* Private mode, a corrupt value, or storage turned off: the stylesheet's
       own defaults still render a complete page. */
  }

  /* Registered here rather than from the app, because the worker's job is to
     serve the app when the network will not. Waiting for app.js to arrive
     before installing the thing that rescues app.js is the wrong order. */
  try {
    var secure = location.protocol === 'https:'
      || location.hostname === 'localhost'
      || location.hostname === '127.0.0.1';
    if ('serviceWorker' in navigator && secure) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').catch(function () {});
      });
    }
  } catch (e) { /* the app works without it */ }
})();
