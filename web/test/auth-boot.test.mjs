/* The boot state machine, including the case that put an owner on the landing
 * page while they were signed in.
 *
 * A session restore slower than boot's deadline used to end with the phase
 * declared 'unauthenticated' — giving up waiting treated as having found out —
 * and the public landing page rendered. When the restore landed a moment later
 * the phase flipped, but nothing re-resolved the route, so the landing page
 * stayed until the person clicked something. Measured in a browser against an
 * 11-second restore: landing from 11.3s to 20s while /api/auth/session answered
 * 200.
 *
 * This drives session.js directly with a stubbed network, so the timing is
 * controlled rather than raced, and asserts the phase at each step. It needs no
 * browser and no credentials.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

/* A DOM thin enough for session.js: it touches localStorage, location and fetch. */
function stubEnvironment({ configDelay = 0, sessionDelay = 0, sessionStatus = 200 } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i],
    get length() { return store.size; }
  };
  globalThis.sessionStorage = { ...globalThis.localStorage };
  globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '#/queue', href: '' };
  globalThis.history = { replaceState() {} };
  globalThis.document = { documentElement: { lang: 'en', dataset: {} }, querySelector: () => null };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });

  // unref'd, so a stub that is still "in flight" cannot keep the process alive
  const wait = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.includes('/api/config')) {
      await wait(configDelay);
      return { ok: true, status: 200, json: async () => ({
        firebase: { projectId: 'p', apiKey: 'k', authDomain: 'd', appId: 'a' },
        appUrl: 'http://localhost:4173', env: 'test', googleAuth: false
      }) };
    }
    if (path.includes('/api/auth/session')) {
      await wait(sessionDelay);
      if (sessionStatus === 204) return { ok: true, status: 204, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({
        accessToken: 'token', expiresIn: 3600, user: { id: 'uid', email: 'owner@example.com' }
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

const freshSession = async () => import(`../js/session.js?bust=${Math.random()}`);

console.log('\nDiiwaan boot state machine\n');

/* ---------- 1. a session that restores promptly ---------- */
{
  stubEnvironment({ sessionDelay: 10 });
  const session = await freshSession();
  check('starts as initializing', () => assert.equal(session.state.phase, 'initializing'));
  await session.boot();
  check('a prompt restore ends authenticated', () => assert.equal(session.state.phase, 'authenticated'));
  check('and reports being signed in', () => assert.equal(session.isSignedIn(), true));
}

/* ---------- 2. genuinely no session ---------- */
{
  stubEnvironment({ sessionDelay: 10, sessionStatus: 204 });
  const session = await freshSession();
  await session.boot();
  check('a 204 ends unauthenticated', () => assert.equal(session.state.phase, 'unauthenticated'));
  check('and not signed in', () => assert.equal(session.isSignedIn(), false));
}

/* ---------- 3. the regression: a restore slower than the deadline ---------- */
{
  stubEnvironment({ sessionDelay: 9500 });   // boot waits 8000
  const session = await freshSession();
  const booted = session.boot();

  await new Promise(r => setTimeout(r, 8600));
  check('while the restore is still in flight the phase stays initializing',
    () => assert.equal(session.state.phase, 'initializing'));
  check('and it says so, rather than claiming nobody is signed in',
    () => assert.equal(session.isRestoring(), true));

  await booted;
  check('boot returns without having decided', () => assert.equal(session.state.phase, 'initializing'));

  await new Promise(r => setTimeout(r, 2000));
  check('the late restore settles the phase to authenticated',
    () => assert.equal(session.state.phase, 'authenticated'));
  check('and the session is there', () => assert.equal(session.isSignedIn(), true));
}

/* ---------- 4. a late restore that finds nothing ---------- */
{
  stubEnvironment({ sessionDelay: 9500, sessionStatus: 204 });
  const session = await freshSession();
  await session.boot();
  await new Promise(r => setTimeout(r, 2000));
  check('a late 204 settles to unauthenticated, not error',
    () => assert.equal(session.state.phase, 'unauthenticated'));
}

/* ---------- 5. abandonBoot is the ceiling, and it fails closed ---------- */
{
  stubEnvironment({ sessionDelay: 30000 });
  const session = await freshSession();
  session.boot();
  await new Promise(r => setTimeout(r, 200));
  session.abandonBoot();
  check('abandoning an unresolved boot lands in error, never authenticated',
    () => assert.equal(session.state.phase, 'error'));
  check('and never claims a session it does not have',
    () => assert.equal(session.isSignedIn(), false));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
// A stub deliberately left in flight would otherwise hold the event loop open.
process.exit(0);
