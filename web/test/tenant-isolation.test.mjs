/* One browser, several companies, and nothing shared between them.
 *
 * A phone scans company A's code, joins A's queue, and later scans company B's.
 * Both queues live behind the same origin, the same localStorage and the same
 * module singletons, so the only thing keeping them apart is this file's
 * subject: that a response belonging to one company can never be written under
 * another's name.
 *
 * The failure it exists to prevent was not theoretical. `refreshCustomer` read
 * `customer.slug` again after its await, so a request begun for A and answered
 * after the person had moved to B wrote A's business name, logo and queue into
 * `diiwaan:cache:public:<B>` — where every later scan of B's code read it back
 * before any network call, from disk, surviving reloads.
 *
 * These drive state.js directly with a stubbed network whose responses are held
 * open deliberately, so the interleaving is chosen rather than raced.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

const store = new Map();
globalThis.localStorage = new Proxy({
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
  clear: () => store.clear(),
  key: i => [...store.keys()][i],
  get length() { return store.size; }
}, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });

globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '' };
globalThis.history = { replaceState() {} };
globalThis.document = { documentElement: { lang: 'en', dataset: {} }, querySelector: () => null };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.window = { addEventListener() {} };
globalThis.EventSource = class { constructor() {} close() {} };
if (!globalThis.navigator) globalThis.navigator = { onLine: true };

/* Responses are handed out by hand so a request for A can be left in flight
   across a switch to B — which is the whole point. */
const gate = { pending: new Map(), n: 0 };
const view = (slug, id, name) => ({ business: { id, name, slug }, queue: { status: 'open' }, ticket: null });

globalThis.fetch = async (url) => {
  const path = String(url);
  const id = ++gate.n;
  let release;
  const body = await new Promise(resolve => { release = resolve; gate.pending.set(id, { path, release }); });
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
};
const settle = () => new Promise(r => setTimeout(r, 20));

/* Waits for a request to actually be in flight before answering it, rather than
   assuming a fixed delay was long enough. Without this the test is racing the
   code it is meant to be holding still. */
const respond = async (match, body, ms = 1000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    for (const [id, entry] of gate.pending) {
      // A stream for the same slug is a different request; never answer it here.
      if (entry.path.includes(match) && !entry.path.includes('/stream')) {
        gate.pending.delete(id);
        entry.release(body);
        await settle();
        return;
      }
    }
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`nothing asked for ${match}`);
};

/** Answers whatever is still outstanding, so one section cannot hang the next. */
const drain = async (body = { business: {}, queue: {} }) => {
  for (const [id, entry] of gate.pending) { gate.pending.delete(id); entry.release(body); }
  await settle();
};

const bust = Math.random();
const state = await import(`../js/state.js?bust=${bust}`);

console.log('\nDiiwaan tenant isolation — company A, company B, one browser\n');

/* ---------- 1. a response for A that lands after the switch to B ---------- */

const openA = state.openCustomer('company-a');
await respond('/public/company-a', view('company-a', 'id-A', "Aamina's Clinic"));
await openA;

check('A resolves to A', () => assert.equal(state.customer.view.business.name, "Aamina's Clinic"));
check('A is cached under A', () => assert.ok(localStorage.getItem('diiwaan:cache:public:company-a')));

// Now scan B while a refresh for A is still in flight.
state.refreshCustomer();                      // asks for A
await settle();
const openB = state.openCustomer('company-b'); // the person scans B
await settle();
// A's answer arrives late.
await respond('/public/company-a', view('company-a', 'id-A', "Aamina's Clinic"));
await settle();

check("A's late answer does not become B's view",
  () => assert.notEqual(state.customer.view?.business?.name, "Aamina's Clinic"));
check("A's late answer is not written under B's cache key", () => {
  const cached = JSON.parse(localStorage.getItem('diiwaan:cache:public:company-b') || 'null');
  assert.ok(!cached || cached.business.id !== 'id-A');
});

await respond('/public/company-b', view('company-b', 'id-B', 'Barbershop B'));
await openB;

check('B resolves to B', () => assert.equal(state.customer.view.business.name, 'Barbershop B'));
check('B is cached under B', () => {
  assert.equal(JSON.parse(localStorage.getItem('diiwaan:cache:public:company-b')).business.id, 'id-B');
});
check("A's cache is untouched and still A's", () => {
  assert.equal(JSON.parse(localStorage.getItem('diiwaan:cache:public:company-a')).business.id, 'id-A');
});

/* ---------- 2. switching leaves nothing of the previous company on screen ---------- */

state.customer.pendingJoin = { slug: 'company-b', input: { name: 'Xasan' }, at: Date.now() };
state.customer.error = new Error('B was unreachable');
const openA2 = state.openCustomer('company-a');
check("B's pending join does not follow to A", () => assert.equal(state.customer.pendingJoin, null));
check("B's error does not follow to A", () => assert.equal(state.customer.error, null));
check('the slug is A immediately, not after the fetch', () => assert.equal(state.customer.slug, 'company-a'));
await settle();
await respond('/public/company-a', view('company-a', 'id-A', "Aamina's Clinic"));
await openA2;

/* ---------- 3. a ticket belongs to one queue only ---------- */

state.setTicketToken('company-a', 'ticket-for-A');
state.setTicketToken('company-b', 'ticket-for-B');
const openB2 = state.openCustomer('company-b');
await settle();
check('B presents B’s ticket, never A’s', () => assert.equal(state.customer.token, 'ticket-for-B'));
await respond('/public/company-b', view('company-b', 'id-B', 'Barbershop B'));
await openB2;
check('A’s ticket survives a visit to B',
  () => assert.equal(state.ticketToken('company-a'), 'ticket-for-A'));

/* ---------- 4. an offline join is held per queue ---------- */

localStorage.setItem('diiwaan:pending:company-a', JSON.stringify({ slug: 'company-a', input: { name: 'Hodan' }, at: Date.now() }));
const openB3 = state.openCustomer('company-b');
await settle();
check("A's held join does not appear on B's screen", () => assert.equal(state.customer.pendingJoin, null));
await respond('/public/company-b', view('company-b', 'id-B', 'Barbershop B'));
await openB3;
check("A's held join is still held, under A's own key",
  () => assert.ok(localStorage.getItem('diiwaan:pending:company-a')));
check('no globally-named pending key exists',
  () => assert.equal(localStorage.getItem('diiwaan:pending'), null));

/* ---------- 5. a slug handed from one company to another ---------- */

localStorage.setItem('diiwaan:known:reused', JSON.stringify({ name: 'Hodan' }));
localStorage.setItem('diiwaan:ticket:reused', JSON.stringify('ticket-from-the-old-owner'));
localStorage.setItem('diiwaan:cache:public:reused', JSON.stringify(view('reused', 'id-OLD', 'The Old Clinic')));

const openReused = state.openCustomer('reused');
await respond('/public/reused', view('reused', 'id-NEW', 'The New Clinic'));
await openReused;

check('the new company resolves as itself',
  () => assert.equal(state.customer.view.business.id, 'id-NEW'));
check("the previous holder's ticket is dropped, not offered to the new one",
  () => assert.equal(state.ticketToken('reused'), ''));
check("the name given to the previous holder is not handed to the new one",
  () => assert.equal(state.knownCustomer('reused'), ''));
check('the cache now holds the new company',
  () => assert.equal(JSON.parse(localStorage.getItem('diiwaan:cache:public:reused')).business.id, 'id-NEW'));

/* ---------- 6. owner side: a business switch discards the previous desk ---------- */

state.owner.business = { id: 'biz-A', name: "Aamina's Clinic" };
state.owner.analytics = { servedToday: 41 };
state.owner.members = [{ id: 'm1', name: 'Aamina' }];
state.owner.snapshot = { waiting: [{ name: 'Hodan' }] };

const openBiz = state.openBusiness('biz-B');
check("A's analytics are gone the moment B is opened", () => assert.equal(state.owner.analytics, null));
check("A's members are gone the moment B is opened", () => assert.deepEqual(state.owner.members, []));
check("A's queue snapshot is gone the moment B is opened", () => assert.equal(state.owner.snapshot, null));
await drain({ business: { id: 'biz-B', name: 'Barbershop B' }, snapshot: { waiting: [] }, services: [] });
await Promise.race([openBiz, settle()]);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
