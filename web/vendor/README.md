# Vendored third-party code

Not written here, and not edited beyond the one change noted below.

## firebase-app.js, firebase-auth.js

- **Version:** Firebase JS SDK 10.14.1
- **Source:** `https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js`
  and `.../firebase-auth.js`
- **Why it is here rather than on a CDN:** the content-security policy allows
  scripts from this origin only. Loading the SDK from gstatic would mean adding
  a script origin to that policy for every visitor, including the ones who never
  press the Google button. Serving it from here keeps `script-src 'self'`.
- **Why it is here at all:** Google's OAuth client for this project accepts
  Firebase's own `/__/auth/handler` as a redirect URI and nothing else, unless
  somebody registers each of the app's origins by hand in the Google Cloud
  Console. Driving that handler is what the SDK does; reimplementing its
  contract on guesswork is not something to do in the sign-in path.
- **The one edit:** the bundles import each other by absolute gstatic URL. Those
  are rewritten to `./firebase-app.js` so they resolve against this directory.
  Nothing else is changed.

Only `firebase-auth.js` is imported by the app, and only when somebody actually
presses the Google button.

## Updating

Download both files from the same version directory, rewrite the absolute
`https://www.gstatic.com/firebasejs/<version>/` imports to `./`, and confirm
nothing external remains:

```bash
grep -o 'from"https://[^"]*"' web/vendor/firebase-*.js   # expect no output
```

These files are excluded from the repository's parse check, which reads them as
minified vendor output rather than code this project maintains.
