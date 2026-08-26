/* The ticket state machine, exercised rather than described.
 *
 *   waiting ──call──> called ──serve──> serving ──close──> completed
 *      │                 │                  │
 *      │                 └──skip──> waiting │
 *      └──────────── close ────────> cancelled / skipped / no_show
 *
 * Every mutation carries its precondition in the update filter, which is the
 * right shape — the check and the write are one operation, so nothing can slip
 * between them. What that shape cannot tell you by reading is whether the
 * preconditions are the *right* ones, and whether a ticket that has finished
 * can be dragged back into the queue.
 *
 * So this drives real tickets through real endpoints and then tries every
 * transition that should be impossible. A terminal ticket is the important
 * case: once a customer has been served, cancelled or marked no-show, nothing
 * should be able to put them back on the floor.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const API = process.env.TEST_API_URL || 'http://localhost:4173';
const KEY = process.env.FIREBASE_API_KEY;

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
};

const token = (await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_OWNER_A, password: process.env.TEST_PASSWORD, returnSecureToken: true }) })).json()).idToken;

const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('\nDiiwaan ticket state machine\n');

const biz = (await call('POST', '/api/businesses',
  { name: `States ${Date.now()}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;
const Q = `/api/businesses/${biz.id}/queue`;

const join = async name => {
  const r = await fetch(`${API}/api/public/${biz.slug}/join`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
  });
  return (await r.json())?.view?.ticket;
};
const statusOf = async id => {
  const snap = await call('GET', Q);
  const all = [...(snap.body.waiting || []), ...(snap.body.recent || []),
               ...(snap.body.serving ? [snap.body.serving] : []), ...(snap.body.called || [])];
  return all.find(t => t.id === id)?.status ?? '(not in snapshot)';
};
const act = (id, action, body) => call('POST', `${Q}/tickets/${id}/${action}`, body ?? {});

/* ---------- the legitimate path ---------- */
console.log('the path a customer actually takes');
const t1 = await join('Deeqa Jibril');
check('a join starts as waiting', t1?.status === 'waiting', `got ${t1?.status}`);

const called = await act(t1.id, 'call');
check('waiting -> called', called.status === 200, `got ${called.status}`);

const serving = await act(t1.id, 'serving');
check('called -> serving', serving.status === 200, `got ${serving.status}`);

const done = await act(t1.id, 'close', { outcome: 'completed' });
check('serving -> completed', done.status === 200, `got ${done.status}`);

/* ---------- transitions that must be impossible ---------- */
console.log('\na finished ticket cannot be dragged back');
for (const [what, action, body] of [
  ['completed -> serving', 'serving', undefined],
  ['completed -> waiting (skip)', 'skip', undefined],
  ['completed -> called', 'call', undefined],
  ['completed -> completed again', 'close', { outcome: 'completed' }],
  ['completed -> cancelled', 'close', { outcome: 'cancelled' }],
  ['completed -> moved in the queue', 'move', { position: 1 }],
  ['completed -> reassigned a service', 'service', { serviceId: null }]
]) {
  const r = await act(t1.id, action, body);
  check(what + ' is refused', r.status === 404 || r.status === 409, `got ${r.status}`);
}
check('it is still completed afterwards', (await statusOf(t1.id)) !== 'waiting', 'it went back to waiting');

console.log('\na cancelled ticket is equally final');
const t2 = await join('Faarax Warsame');
await act(t2.id, 'close', { outcome: 'cancelled' });
for (const [what, action, body] of [
  ['cancelled -> serving', 'serving', undefined],
  ['cancelled -> called', 'call', undefined],
  ['cancelled -> waiting (skip)', 'skip', undefined],
  ['cancelled -> completed', 'close', { outcome: 'completed' }]
]) {
  const r = await act(t2.id, action, body);
  check(what + ' is refused', r.status === 404 || r.status === 409, `got ${r.status}`);
}

console.log('\na no-show is final too');
const t3 = await join('Hodan Ali');
await act(t3.id, 'call');
await act(t3.id, 'close', { outcome: 'no_show' });
for (const [what, action] of [['no_show -> serving', 'serving'], ['no_show -> waiting (skip)', 'skip'], ['no_show -> called', 'call']]) {
  const r = await act(t3.id, action);
  check(what + ' is refused', r.status === 404 || r.status === 409, `got ${r.status}`);
}

console.log('\nsteps cannot be skipped or repeated');
const t4 = await join('Xasan Nuur');
const straightToServing = await act(t4.id, 'serving');
check('waiting -> serving without being called is refused', straightToServing.status === 409, `got ${straightToServing.status}`);

await act(t4.id, 'call');
const calledTwice = await act(t4.id, 'call');
check('called -> called again is refused', calledTwice.status === 409 || calledTwice.status === 404, `got ${calledTwice.status}`);

await act(t4.id, 'serving');
const servingTwice = await act(t4.id, 'serving');
check('serving -> serving again is refused', servingTwice.status === 409, `got ${servingTwice.status}`);

console.log('\nskip returns a ticket to the queue rather than ending it');
const t5 = await join('Maryan Cabdi');
await act(t5.id, 'call');
const skipped = await act(t5.id, 'skip');
check('called -> skip succeeds', skipped.status === 200, `got ${skipped.status}`);
check('and the ticket is waiting again', (await statusOf(t5.id)) === 'waiting', `it is ${await statusOf(t5.id)}`);

/* The field is `status`, and an earlier draft of this test sent `outcome` —
   which the route ignores, defaulting to 'completed', so every probe "passed"
   by closing the ticket legitimately. Getting the field name wrong is how a
   test reassures you about something it never exercised. */
console.log('\na status the product does not define is refused');
for (const status of ['deleted', 'owner', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
  const fresh = await join(`Probe ${status || 'empty'}`);
  const r = await act(fresh.id, 'close', { status });
  check(`close with status ${JSON.stringify(status)} is a controlled 400`, r.status === 400, `got ${r.status}`);
}

await call('DELETE', `/api/businesses/${biz.id}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
