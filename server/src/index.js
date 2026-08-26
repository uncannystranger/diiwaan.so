/* Diiwaan API + static frontend. */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { config, assertConfig, ROOT } from './config.js';
import { googleSignInReady, googleSignInReason } from './lib/firebase.js';
import { connect, disconnect } from './db.js';
import { withUser } from './middleware/auth.js';
import { errorHandler, notFound } from './lib/errors.js';
import authRoutes from './routes/auth.js';
import businessRoutes from './routes/businesses.js';
import publicRoutes from './routes/public.js';
import uploadRoutes from './routes/uploads.js';

export async function createApp() {
  assertConfig();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  /* In production every request must be HTTPS: the session cookie is marked
     Secure, so a plain-HTTP request cannot carry one anyway, and redirecting is
     kinder than silently signing someone out. Health checks are exempt so a load
     balancer probing over HTTP does not mark the service down. */
  if (config.env === 'production') {
    app.use((req, res, next) => {
      if (req.secure || req.path === '/api/health') return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return res.status(403).json({ error: 'This API requires HTTPS.' });
      }
      return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
    });
  }

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // The design's Poppins/Lora come from Google Fonts; logos are served by this app itself.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        /* Both providers are talked to straight from the browser over their
           REST APIs, so both need naming here. Firebase's sign-in calls go to
           identitytoolkit; its token refresh goes to securetoken. */
        connectSrc: [
          "'self'",
          'https://identitytoolkit.googleapis.com',
          'https://securetoken.googleapis.com'
        ],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        // Nothing here is meant to be framed, and nothing here posts to another
        // origin. Both are clickjacking and exfiltration routes otherwise.
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // Only in production: in development the app is served over plain HTTP.
        ...(config.env === 'production' ? { upgradeInsecureRequests: [] } : {})
      }
    },
    // A year of HSTS, including subdomains, once a browser has seen us on HTTPS.
    hsts: config.env === 'production'
      ? { maxAge: 31536000, includeSubDomains: true, preload: true }
      : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  app.use(cors({
    // With credentials enabled, reflecting any origin would hand the session
    // cookie to any site. No list configured means same-origin only.
    origin: config.cors.origins.length ? config.cors.origins : false,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Diiwaan-Client', 'Last-Event-ID'],
    maxAge: 600
  }));

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  /* Caching policy, set once and deliberately:
     · queue state and anything tenant-private is never cached — a stale number
       at the desk is worse than a slow one;
     · the public customer view may be held for a few seconds and revalidated
       with an ETag, which absorbs a rush of scans without going stale;
     · static assets are content-addressed by mtime and cached for an hour in
       production. */
  app.set('etag', 'strong');
  app.use('/api', (req, res, next) => {
    res.setHeader('Vary', 'Authorization');
    if (req.method !== 'GET') return next();
    const publicRead = req.path.startsWith('/public/') && !req.path.endsWith('/stream');
    res.setHeader('Cache-Control', publicRead
      ? 'public, max-age=5, stale-while-revalidate=25'
      : 'no-store');
    next();
  });
  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests — give it a moment.' }
  }));

  /* Public runtime configuration. Every value here is one the browser is meant
     to hold. The Firebase web api key is
     published by Firebase itself and identifies the project rather than
     authorising anything — access is decided by Firebase's own rules and by this
     server verifying the signed token. No server credential is ever included. */
  app.get('/api/config', (req, res) => {
    res.json({
      googleAuth: googleSignInReady(),
      /* Only in development. In production this is nobody's business but ours,
         and a customer signing in should never read a configuration note. */
      ...(config.env === 'production' ? {} : { googleAuthReason: googleSignInReason() }),
      firebase: config.firebase.projectId && config.firebase.apiKey
        ? {
            projectId: config.firebase.projectId,
            apiKey: config.firebase.apiKey,
            authDomain: config.firebase.authDomain,
            appId: config.firebase.appId
          }
        : null,
      appUrl: config.appUrl,
      env: config.env
    });
  });

  app.get('/api/health', async (req, res) => {
    res.json({ ok: true, at: new Date().toISOString() });
  });

  /* The database is opened on the first request that needs it, not at boot.
     /api/config is what the browser waits on before it can render anything, and
     it is answered entirely from memory — so a cold start no longer holds the
     loading screen open while a cluster handshake completes. */
  app.use('/api', async (req, res, next) => {
    try {
      await connect();
      next();
    } catch (error) { next(error); }
  });

  app.use('/api', withUser);
  app.use('/api/auth', authRoutes);
  app.use('/api/businesses', businessRoutes);
  app.use('/api/public', publicRoutes);
  /* Mounted at the root of the API rather than under a prefix of its own: it
     owns POST /api/businesses/:id/logo, which belongs beside the business it
     changes, and GET /api/branding/:asset, which is the public URL every stored
     logo is served from. Express falls through to the next router on no match,
     so sharing the /api/businesses prefix is fine. */
  app.use('/api', uploadRoutes);
  app.use('/api', notFound);

  /* Frontend. Every non-API path serves the app shell so /j/<slug> deep links work. */
  const web = path.join(ROOT, 'web');
  app.use(express.static(web, {
    index: false,
    maxAge: config.env === 'production' ? '1h' : 0,
    setHeaders: (res, filePath) => {
      // In development the browser must never hold on to an old module.
      if (config.env !== 'production') return res.setHeader('Cache-Control', 'no-store');

      /* These matter wherever this server does serve the frontend — a single
         process, a container, a laptop. On Vercel the static files are answered
         by the edge and never reach Express, so the same rules are declared in
         vercel.json; the two are kept deliberately identical.

         The worker is the one file that decides how every other file is
         fetched, so it must never be answered from a stale copy: an hour-old
         sw.js is an hour of the previous deploy's caching rules, and the update
         that would have fixed it is the thing being cached. Browsers already
         bypass their HTTP cache for worker scripts, but intermediaries do not.

         The modules themselves are revalidated rather than trusted for an hour,
         because they are only correct as a set — the same reason the worker
         stopped preferring its cached copies of them. `no-cache` still allows a
         304, so an unchanged file costs a round trip and no bytes. */
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(web, 'index.html')));

  app.use(errorHandler);
  return app;
}

const isDirectRun = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isDirectRun) {
  const app = await createApp();
  const server = app.listen(config.port, () => {
    console.log(`[diiwaan] ${config.env} server on ${config.appUrl}`);
  });
  const shutdown = async () => {
    server.close();
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
