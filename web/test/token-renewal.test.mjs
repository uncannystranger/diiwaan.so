/* A tab that has been asleep must not look signed out.
 *
 * The access token is good for an hour and was replaced by a setTimeout set a
 * minute before it ran out. Timers are the wrong thing to trust: a browser
 * throttles or drops them in a backgrounded tab, and a laptop that sleeps takes
 * the clock with it. The tab woke holding a token that had expired hours
 * earlier, every request came back 401, and nothing anywhere renewed anything —
 * the API layer simply threw. The desk stopped working, and the only way back
 * was a reload, which is how an expired token came to look like a logout.
 *
 * Seen in production: GET /queue refused 401, then the stream refused twice and
 * gave up.
 *
 * Two things hold it shut now. Expiry is checked against the clock at the
 * moment of use, so a spent token is replaced before the request goes out; and
 * a 401 on a request we believed was authenticated is retried once with a
 * freshly minted token, because the cookie is the authority and it is still
 * there. Neither may turn a real refusal into a loop.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, clear() {}, key: () => null, length: 0 };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '' };
globalThis.history = { replaceState() {} };
globalThis.document = { documentElement: { lang: 'en', dataset: {} }, querySelector: () => null };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = { addEventListener() {} };
if (!globalThis.navigator) globalThis.navigator = { onLine: true };

/* The server: a cookie that still works, and an API that refuses stale tokens. */
const server = { cookieValid: true, issued: 0, calls: [] };
const VALID = () => 'token-' + server.issued;

globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const auth = (init.headers || {}).Authorization || '';
  server.calls.push({ path, auth });

  if (path.includes('/api/config')) {
    return { ok: true, status: 200, json: async () => ({
      firebase: { projectId: 'p', apiKey: 'k', authDomain: 'p.firebaseapp.com', appId: 'a' },
      appUrl: 'http://localhost:4173', env: 'test', googleAuth: false, googleAuthReason: 'turned_off' }) };
  }

  if (path.includes('/api/auth/session')) {
    if (init.method === 'DELETE') { server.cookieValid = false; return { ok: true, status: 204, json: async () => ({}) }; }
    if (!server.cookieValid) return { ok: false, status: 204, json: async () => ({}) };
    server.issued += 1;
    return { ok: true, status: 200, json: async () => ({
      accessToken: VALID(), expiresIn: 3600, user: { id: 'uid-a', email: 'owner@example.com' } }) };
  }

  // Any other endpoint: only the token most recently issued is accepted.
  const ok = auth === `Bearer ${VALID()}`;
  return ok
    ? { ok: true, status: 200, text: async () => JSON.stringify({ counts: { waiting: 4 } }) }
    : { ok: false, status: 401, text: async () => JSON.stringify({ error: 'Sign in to continue.' }) };
};

const session = await import('../js/session.js');
const { api, ApiError } = await import('../js/api.js');

console.log('\nA token that expired while the tab slept\n');

await session.boot();
check('starts authenticated', () => assert.equal(session.state.phase, 'authenticated'));

/* ---------- the token is spent, and the clock says so ---------- */
{
  const issuedBefore = server.issued;
  session.state.session.expiresAt = Math.floor(Date.now() / 1000) - 3600;

  const snapshot = await api.queue('biz-a');
  check('the call goes through rather than failing', () => assert.equal(snapshot.counts.waiting, 4));
  check('and a new token was minted for it', () => assert.ok(server.issued > issuedBefore));
  check('the session is intact', () => assert.equal(session.isSignedIn(), true));
  check('nobody was signed out', () => assert.equal(session.state.phase, 'authenticated'));
}

/* ---------- the token dies between minting and using it ---------- */
{
  // Not expired by the clock, but the server has moved on — a revoked token, or
  // one issued before a clock jump. Only the 401 retry can save this.
  server.issued += 1;
  const issuedBefore = server.issued;

  const snapshot = await api.queue('biz-a');
  check('a surprise 401 is retried with a fresh token', () => assert.equal(snapshot.counts.waiting, 4));
  check('which required minting one', () => assert.ok(server.issued > issuedBefore));
  check('and did not sign anybody out', () => assert.equal(session.isSignedIn(), true));
}

/* ---------- the session really is over ---------- */
{
  server.cookieValid = false;
  session.state.session.accessToken = 'stale';
  session.state.session.expiresAt = Math.floor(Date.now() / 1000) - 3600;
  const callsBefore = server.calls.length;

  let refused = null;
  try { await api.queue('biz-a'); } catch (error) { refused = error; }

  check('a genuine refusal still refuses', () => assert.ok(refused instanceof ApiError));
  check('with 401, not a hang', () => assert.equal(refused.status, 401));
  check('and does not retry forever', () => assert.ok(server.calls.length - callsBefore < 6));
}

/* ---------- the session endpoint itself is never retried with a token ---------- */
{
  const authed = server.calls.filter(c => c.path.includes('/api/auth/session') && c.auth);
  check('session requests carry no bearer token', () => assert.equal(authed.length, 0));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
