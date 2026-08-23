/* The Vercel entry point.

   Everything under /api is routed here and handed to the same Express app the
   server runs locally — one code path, so a route cannot work in development
   and quietly differ in production. The static frontend is served by Vercel
   directly from web/ rather than through this function; see vercel.json.

   The app is built once per warm instance and reused. createApp() opens the
   Mongo connection, and db.connect() caches its client, so a warm invocation
   reuses the pool instead of opening a new one per request. */

import { createApp } from '../server/src/index.js';

let appPromise = null;

export default async function handler(request, response) {
  try {
    appPromise ??= createApp();
    const app = await appPromise;
    return app(request, response);
  } catch (error) {
    // A failure here is almost always configuration — a missing environment
    // variable, or a database that will not accept the connection. Say so
    // plainly rather than leaving the browser with an opaque 500.
    appPromise = null;
    console.error('[diiwaan] the API could not start', error);
    response.status(500).json({
      error: 'The API is not configured yet.',
      detail: error?.message || String(error)
    });
  }
}
