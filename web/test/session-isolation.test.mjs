/* Issue #14 — one device, two accounts, nothing shared between them.
 *
 * The desk keeps a great deal about whoever is signed in: the business, the
 * queue snapshot with waiting customers by name, the services, the members, and
 * a read-through copy of all of it in localStorage so a reconnecting device is
 * not blank. None of it is the next account's to see.
 *
 * The teardown used to live inside the sign-out button's handler, so it ran only
 * when somebody clicked. A session that ended any other way — a refresh token
 * that would not renew, a revoked cookie, a second account adopted in the same
 * tab — left all of it standing. This drives session.js and state.js directly,
 * with a stubbed network, and asserts what survives an account switch and what
 * must not.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

/* A DOM thin enough for session.js and state.js. */
function stubEnvironment() {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
    clear: () => store.clear(),
    key: i => [...store.keys()][i],
    get length() { return store.size; }
  };
  /* Object.keys() over the stub is what clearOwnerStorage walks; the real thing
     enumerates its keys, so the stub has to as well. */
  globalThis.localStorage = new Proxy(globalThis.localStorage, {
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
  });
  globalThis.sessionStorage = {
    getItem: () => null, setItem() {}, removeItem() {}
  };
  globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '#/queue' };
  globalThis.history = { replaceState() {} };
  globalThis.document = { documentElement: { lang: 'en', dataset: {} }, querySelector: () => null };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.window = { addEventListener() {} };
  // Node supplies its own navigator, and it is read-only.
  if (!globalThis.navigator) globalThis.navigator = { onLine: true };
  globalThis.EventSource = class { constructor() {} close() {} };

  /* Which account the session endpoint is currently holding. */
  const network = { user: { id: 'uid-a', email: 'a@example.com' }, hasSession: true };

  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({
        firebase: { projectId: 'p', apiKey: 'k', authDomain: 'd', appId: 'a' },
        appUrl: 'http://localhost:4173', env: 'test', googleAuth: false
      }) };
    }
    if (path.includes('/api/auth/session')) {
      if (!network.hasSession) return { ok: true, status: 204, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({
        accessToken: 'token-' + network.user.id, expiresIn: 3600, user: network.user
      }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { network, store };
}

const bust = Math.random();
const { network, store } = stubEnvironment();
const session = await import(`../js/session.js?bust=${bust}`);
const state = await import(`../js/state.js?bust=${bust}`);

console.log('\nDiiwaan session isolation — user A, sign out, user B\n');

/* ---------- user A signs in and works ---------- */

await session.boot();
check('A is signed in after boot', () => assert.equal(session.isSignedIn(), true));
check('and the session names A', () => assert.equal(session.userId(), 'uid-a'));

session.setAccount({
  user: { id: 'uid-a', email: 'a@example.com', name: 'Aamina' },
  businesses: [{ id: 'biz-a', name: "Aamina's Clinic" }]
});
Object.assign(state.owner, {
  business: { id: 'biz-a', name: "Aamina's Clinic" },
  businesses: [{ id: 'biz-a' }],
  snapshot: { waiting: [{ name: 'Hodan', position: 1 }] },
  services: [{ id: 's1', name: 'Consultation' }],
  members: [{ id: 'm1', name: 'Aamina' }],
  analytics: { servedToday: 12 }
});
state.owner.busy.add('call-next');
localStorage.setItem('diiwaan:business', 'biz-a');
localStorage.setItem('diiwaan:cache:biz-a', JSON.stringify({
  business: { id: 'biz-a' }, snapshot: { waiting: [{ name: 'Hodan' }] }, services: []
}));
localStorage.setItem('diiwaan:paint:owner', '{"primary":"#B4700F"}');

/* The customer's own keys, on the same device. They are not the owner's. */
localStorage.setItem('diiwaan:ticket:hodan-clinic', '"tok"');
localStorage.setItem('diiwaan:known:hodan-clinic', '{"name":"Hodan"}');
localStorage.setItem('diiwaan:cache:public:hodan-clinic', '{"queue":[]}');

/* ---------- A signs out ---------- */

network.hasSession = false;
await session.signOut();
state.resetOwner();          // what forgetTenant() calls for us in the app
session.forgetAccount();

check('signing out leaves nobody signed in', () => assert.equal(session.isSignedIn(), false));
check('and no user id to route on', () => assert.equal(session.userId(), null));
check("A's profile is gone from the session", () => assert.equal(session.state.user, null));
check("A's businesses are gone from the session", () => assert.deepEqual(session.state.businesses, []));

check("A's business is gone from memory", () => assert.equal(state.owner.business, null));
check("A's queue snapshot is gone", () => assert.equal(state.owner.snapshot, null));
check("A's services are gone", () => assert.deepEqual(state.owner.services, []));
check("A's members are gone", () => assert.deepEqual(state.owner.members, []));
check("A's analytics are gone", () => assert.equal(state.owner.analytics, null));
check("A's business list is gone", () => assert.deepEqual(state.owner.businesses, []));
check('no action is left marked busy', () => assert.equal(state.owner.busy.size, 0));
check('the stream is closed', () => assert.equal(state.owner.connection, 'idle'));

check('the remembered business is forgotten',
  () => assert.equal(localStorage.getItem('diiwaan:business'), null));
check("the cached queue — customers by name — is gone from storage",
  () => assert.equal(localStorage.getItem('diiwaan:cache:biz-a'), null));
check("A's brand paint is gone, so the next boot does not wear it",
  () => assert.equal(localStorage.getItem('diiwaan:paint:owner'), null));

check("the customer's ticket on this device survives",
  () => assert.equal(localStorage.getItem('diiwaan:ticket:hodan-clinic'), '"tok"'));
check("the customer's remembered name survives",
  () => assert.equal(localStorage.getItem('diiwaan:known:hodan-clinic'), '{"name":"Hodan"}'));
check("the public queue's own cache survives",
  () => assert.equal(localStorage.getItem('diiwaan:cache:public:hodan-clinic'), '{"queue":[]}'));

/* ---------- user B signs in ---------- */

network.user = { id: 'uid-b', email: 'b@example.com' };
network.hasSession = true;
await session.restore();

check('B is signed in', () => assert.equal(session.isSignedIn(), true));
check('and the session names B, not A', () => assert.equal(session.userId(), 'uid-b'));
check("B does not inherit A's access token",
  () => assert.equal(session.accessToken(), 'token-uid-b'));
check("B's screen has no profile until the API supplies one",
  () => assert.equal(session.state.user, null));
check("nothing of A's is on the desk for B",
  () => assert.equal(state.owner.business, null));

/* ---------- a session that ends without anybody clicking ---------- */

check('a signed-out session reports the unauthenticated phase, not error',
  () => { session.signOut(); assert.equal(session.state.phase, 'unauthenticated'); });

const leftover = Object.keys(localStorage).filter(k => /^diiwaan:(business$|cache:(?!public:)|paint:owner$)/.test(k));
check('no owner-scoped key is left on the device at all',
  () => assert.deepEqual(leftover, []));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
