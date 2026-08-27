/* Refreshing the dashboard must not sign anybody out.
 *
 * The bug this exists for: a restore that failed for any reason at all was read
 * as "there is nobody signed in". Our API answers 503 and keeps the cookie when
 * it cannot reach Google — a rate limit, a bad minute in one region, a socket
 * that never opened — and the browser turned that into `unauthenticated` and
 * rendered the landing page. An owner refreshed their desk and were told, with
 * no explanation, that they had no account.
 *
 * Three answers, three meanings, and they must stay apart:
 *
 *   200  this is who is signed in
 *   204  nobody is signed in on this device
 *   else we could not find out
 *
 * Only the middle one is the landing page. The last is a screen that says so
 * and offers to try again, because the session is probably still there.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k),
  clear: () => store.clear(), key: i => [...store.keys()][i], get length() { return store.size; }
};
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '#/queue' };
globalThis.history = { replaceState() {} };
globalThis.document = { documentElement: { lang: 'en', dataset: {} }, querySelector: () => null };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = { addEventListener() {} };
if (!globalThis.navigator) globalThis.navigator = { onLine: true };

/* What the session endpoint answers this time round. */
const api = { sessionStatus: 200 };

globalThis.fetch = async (url) => {
  const path = String(url);
  if (path.includes('/api/config')) {
    return { ok: true, status: 200, json: async () => ({
      firebase: { projectId: 'p', apiKey: 'k', authDomain: 'p.firebaseapp.com', appId: 'a' },
      appUrl: 'http://localhost:4173', env: 'test', googleAuth: false, googleAuthReason: 'turned_off'
    }) };
  }
  if (path.includes('/api/auth/session')) {
    const s = api.sessionStatus;
    if (s === 'network') throw new TypeError('Failed to fetch');
    if (s === 204) return { ok: true, status: 204, json: async () => ({}) };
    if (s !== 200) return { ok: false, status: s, json: async () => ({ error: 'nope' }) };
    return { ok: true, status: 200, json: async () => ({
      accessToken: 'token', expiresIn: 3600, user: { id: 'uid-a', email: 'owner@example.com' }
    }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

const session = await import('../js/session.js');

console.log('\nRestoring a session on refresh\n');

/* ---------- the cookie is good ---------- */
{
  api.sessionStatus = 200;
  await session.boot();
  check('a restored session is authenticated', () => assert.equal(session.state.phase, 'authenticated'));
  check('and is signed in', () => assert.equal(session.isSignedIn(), true));
  check('and the restore was conclusive', () => assert.equal(session.restoreWasInconclusive(), false));
}

/* ---------- nobody is signed in ---------- */
{
  api.sessionStatus = 204;
  await session.signOut();
  await session.boot();
  check('204 means nobody, and settles unauthenticated', () => assert.equal(session.state.phase, 'unauthenticated'));
  check('which is the one case the landing page is right for',
    () => assert.equal(session.restoreWasInconclusive(), false));
}

/* ---------- our API could not reach Google ---------- */
{
  api.sessionStatus = 503;
  await session.signOut();
  await session.boot();
  check('503 does NOT claim the person is signed out',
    () => assert.notEqual(session.state.phase, 'unauthenticated'));
  check('it settles to error, which is the screen that says so',
    () => assert.equal(session.state.phase, 'error'));
  check('and it is reported as inconclusive', () => assert.equal(session.restoreWasInconclusive(), true));
  check('with something to tell the person', () => assert.ok(session.state.backendError.length > 0));
}

/* ---------- the network never reached us ---------- */
{
  api.sessionStatus = 'network';
  await session.signOut();
  await session.boot();
  check('a failed fetch is not a sign-out either', () => assert.equal(session.state.phase, 'error'));
  check('and is inconclusive', () => assert.equal(session.restoreWasInconclusive(), true));
}

/* ---------- Google really did reject the token ---------- */
{
  api.sessionStatus = 401;
  await session.signOut();
  await session.boot();
  check('401 is a real sign-out, and does not pretend otherwise',
    () => assert.equal(session.state.phase, 'unauthenticated'));
  check('so the landing page is correct here',
    () => assert.equal(session.restoreWasInconclusive(), false));
}

/* ---------- refreshing repeatedly must be stable ---------- */
{
  api.sessionStatus = 200;
  for (let i = 0; i < 5; i++) {
    await session.signOut();
    await session.boot();
  }
  check('five refreshes in a row all end authenticated',
    () => assert.equal(session.state.phase, 'authenticated'));
  check('and still signed in', () => assert.equal(session.isSignedIn(), true));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
