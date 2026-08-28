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
    /* The front door is navy and white, and it must be that from the first
       frame rather than a moment later — otherwise a reload of the sign-in page
       paints the last owner's amber and then corrects itself, which is the
       flash this file exists to prevent. app.js sets the same attribute once it
       runs; this is only about being early. */
    var entry = { '': 1, signup: 1, signin: 1, forgot: 1, reset: 1 };
    if (!customer && Object.prototype.hasOwnProperty.call(entry, path[0])) {
      root.setAttribute('data-scope', 'entry');
      return;
    }
    root.setAttribute('data-scope', 'app');

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

  /* A way out, for a browser holding a version that will not let go.
   *
   * A worker that has cached a broken build can outlive every deploy meant to
   * replace it — the person keeps being served the application from a month
   * ago and there is nothing on the screen to say so. Visiting with ?reset
   * unregisters every worker, empties every cache, and reloads clean. It is the
   * one thing that always works, and it is worth having a name for:
   *
   *     https://diiwaan-so.vercel.app/?reset
   */
  try {
    if (location.search.indexOf('reset') !== -1 && 'serviceWorker' in navigator) {
      Promise.all([
        navigator.serviceWorker.getRegistrations().then(function (all) {
          return Promise.all(all.map(function (r) { return r.unregister(); }));
        }).catch(function () {}),
        (self.caches ? caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }) : Promise.resolve()).catch(function () {})
      ]).then(function () {
        location.replace(location.pathname);
      });
      return;
    }
  } catch (e) { /* nothing here is worth failing the boot over */ }

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

      /* A worker that takes over mid-visit has almost certainly just replaced
         the code this page is running. Reloading once hands the page a set of
         modules that agree with each other, instead of leaving it on the old
         ones until the person happens to refresh.

         Guarded twice: only when a worker was already in control (a first-ever
         install changes nothing that is running), and only once per page, so a
         worker that keeps re-claiming cannot put the tab in a reload loop. */
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloading || !navigator.serviceWorker.controller) return;
        reloading = true;
        location.reload();
      });
    }
  } catch (e) { /* the app works without it */ }
})();
