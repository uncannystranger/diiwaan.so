/* Queue races.

   The desk is the one place in this product where two people act on the same
   row at the same instant: two staff pressing NEXT together, or one person
   whose tap registered twice. If the claim is not atomic, both get the same
   customer, that customer is called once and served twice, and the queue
   silently loses a position.

   These tests fire genuinely simultaneous requests — built first, awaited
   together — rather than sequentially with a gap, because a sequential pair
   passes against code that has no guard at all. */

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

const token = (await (await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_OWNER_A, password: process.env.TEST_PASSWORD, returnSecureToken: true }) }
)).json()).idToken;

const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

console.log('\nDiiwaan queue concurrency\n');

const biz = (await call('POST', '/api/businesses', {
  name: `Race ${Date.now()}`, city: 'KM4', country: 'Somalia', category: 'Clinic'
})).body.business;

const anon = (method, url, body) => fetch(API + url, {
  method, headers: { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/* ---------- numbering under a burst of simultaneous joins ---------- */
const JOINS = 12;
const joins = await Promise.all(
  Array.from({ length: JOINS }, (_, i) => anon('POST', `/api/public/${biz.slug}/join`, { name: `Customer ${i}` }))
);
const created = joins.filter(j => j.status === 201);
const numbers = created.map(j => j.body?.view?.ticket?.number).filter(Boolean);
check('every simultaneous join is accepted', created.length === JOINS, `${created.length}/${JOINS}`);
check('no two customers get the same number',
  new Set(numbers).size === numbers.length,
  `${numbers.length} tickets, ${new Set(numbers).size} distinct: ${numbers.join(',')}`);

const snapshot = await call('GET', `/api/businesses/${biz.id}/queue`);
check('the queue counts them all', (snapshot.body?.waiting?.length || 0) === JOINS,
  `waiting=${snapshot.body?.waiting?.length}`);

/* ---------- two staff pressing NEXT at the same instant ---------- */
const pair = await Promise.all([
  call('POST', `/api/businesses/${biz.id}/queue/next`),
  call('POST', `/api/businesses/${biz.id}/queue/next`)
]);
const claimed = pair.filter(p => p.status === 200).map(p => p.body?.ticket?.id).filter(Boolean);
check('both presses are answered', pair.every(p => p.status === 200 || p.status === 409),
  pair.map(p => p.status).join(','));
check('two simultaneous NEXT presses claim different customers',
  new Set(claimed).size === claimed.length, `claimed: ${claimed.join(' , ')}`);

/* ---------- a burst of NEXT never hands the same ticket out twice ---------- */
const BURST = 6;
const burst = await Promise.all(Array.from({ length: BURST }, () => call('POST', `/api/businesses/${biz.id}/queue/next`)));
const ids = burst.filter(b => b.status === 200).map(b => b.body?.ticket?.id);
check(`${BURST} simultaneous presses hand out ${new Set(ids).size} distinct customers`,
  new Set(ids).size === ids.length, ids.join(','));

/* ---------- completing the same ticket twice ---------- */
const target = ids[0];
if (target) {
  const twice = await Promise.all([
    call('POST', `/api/businesses/${biz.id}/queue/tickets/${target}/close`, { outcome: 'completed' }),
    call('POST', `/api/businesses/${biz.id}/queue/tickets/${target}/close`, { outcome: 'completed' })
  ]);
  const ok = twice.filter(t => t.status === 200).length;
  check('closing one ticket twice succeeds exactly once', ok === 1, `succeeded ${ok} times (${twice.map(t=>t.status).join(',')})`);
}

/* ---------- a malformed id is a clean refusal, not a crash ---------- */
for (const bad of ['undefined', 'not-an-id', '../../etc/passwd', '000000000000000000000000']) {
  const r = await call('POST', `/api/businesses/${biz.id}/queue/tickets/${encodeURIComponent(bad)}/serving`, {});
  check(`a ticket id of "${bad}" is refused cleanly`, r.status === 404 || r.status === 400, `got ${r.status}`);
}

await call('DELETE', `/api/businesses/${biz.id}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
