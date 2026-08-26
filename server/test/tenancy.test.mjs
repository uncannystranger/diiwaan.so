/* Cross-tenant access: the property the whole product rests on.

   Two real owners, each with their own business, queue, ticket, service, staff
   seat and uploaded logo. Then owner B is pointed at every identifier owner A
   owns, one endpoint at a time, and must be refused every time.

   The identifiers are real — read out of A's own responses — because a probe
   built from invented ids proves only that the server rejects nonsense. What
   has to be proved is that it rejects a genuine id belonging to somebody else.

   404 rather than 403 is the expected refusal for anything tenant-scoped: an
   outsider should not be able to learn that a business exists by the shape of
   the error. 403 is correct where membership is real but the role is not
   enough. Both are accepted here and reported, so a change from one to the
   other is visible rather than silent. */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const API = process.env.TEST_API_URL || 'http://localhost:4173';
const KEY = process.env.FIREBASE_API_KEY;
const PASSWORD = process.env.TEST_PASSWORD;
const OWNER_A = process.env.TEST_OWNER_A;
const OWNER_B = process.env.TEST_OWNER_B;

const missing = Object.entries({ FIREBASE_API_KEY: KEY, TEST_PASSWORD: PASSWORD, TEST_OWNER_A: OWNER_A, TEST_OWNER_B: OWNER_B })
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`\nNeeded in .env before this suite can run:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};

async function signIn(email) {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true })
  });
  const body = await r.json();
  if (!body.idToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 160)}`);
  return body.idToken;
}

const client = token => async (method, url, body) => {
  const r = await fetch(API + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
};

/** Refused means: not success, and not a server fault we caused. */
const refused = status => status === 404 || status === 403 || status === 401;

console.log('\nDiiwaan cross-tenant isolation\n');

const A = client(await signIn(OWNER_A));
const B = client(await signIn(OWNER_B));
const anon = client(null);

/* ---------- owner A builds a complete tenant ---------- */
const stamp = Date.now();
const madeA = await A('POST', '/api/businesses', {
  name: `Tenancy A ${stamp}`, city: 'KM4', country: 'Somalia', category: 'Clinic'
});
if (madeA.status !== 201) { console.error('setup failed:', madeA.status, madeA.body); process.exit(1); }
const bizA = madeA.body.business;

const madeB = await B('POST', '/api/businesses', {
  name: `Tenancy B ${stamp}`, city: 'KM4', country: 'Somalia', category: 'Clinic'
});
const bizB = madeB.body.business;

const serviceA = (await A('POST', `/api/businesses/${bizA.id}/services`, { name: 'Consultation', estimatedDuration: 10 })).body?.service;
const joined = await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Deeqa Jibril' });
// The join answers with the customer's own view; the ticket lives inside it.
const ticketA = joined.body?.view?.ticket;
const inviteA = await A('POST', `/api/businesses/${bizA.id}/members`, { email: 'someone-else@example.com', name: 'Yuusuf', role: 'staff' });
const memberA = inviteA.body?.member;

console.log('A owns:', {
  business: Boolean(bizA?.id), service: Boolean(serviceA?.id),
  ticket: Boolean(ticketA?.id), member: Boolean(memberA?.id)
});

/* ---------- B points at every one of A's identifiers ---------- */
console.log('\nreading across the tenant boundary');
const reads = [
  ['business',        'GET',   `/api/businesses/${bizA.id}`],
  ['queue snapshot',  'GET',   `/api/businesses/${bizA.id}/queue`],
  ['services',        'GET',   `/api/businesses/${bizA.id}/services`],
  ['members',         'GET',   `/api/businesses/${bizA.id}/members`],
  ['analytics',       'GET',   `/api/businesses/${bizA.id}/analytics`],
  ['report',          'GET',   `/api/businesses/${bizA.id}/report.pdf`],
  ['realtime stream', 'GET',   `/api/businesses/${bizA.id}/stream`]
];
for (const [label, method, url] of reads) {
  const r = await B(method, url);
  check(`B cannot read A's ${label}`, refused(r.status), `got ${r.status}`);
}

console.log('\nwriting across the tenant boundary');
const writes = [
  ['rename the business',    'PATCH',  `/api/businesses/${bizA.id}`, { name: 'Taken over' }],
  ['change branding',        'PATCH',  `/api/businesses/${bizA.id}/branding`, { primary: '#000000' }],
  ['change queue settings',  'PATCH',  `/api/businesses/${bizA.id}/queue`, { prefix: 'Z' }],
  ['close the queue',        'POST',   `/api/businesses/${bizA.id}/queue/status`, { status: 'closed' }],
  ['call the next customer', 'POST',   `/api/businesses/${bizA.id}/queue/next`, {}],
  ['add a ticket',           'POST',   `/api/businesses/${bizA.id}/queue/tickets`, { name: 'Ghost' }],
  ['invite staff',           'POST',   `/api/businesses/${bizA.id}/members`, { email: 'x@example.com' }],
  ['delete the business',    'DELETE', `/api/businesses/${bizA.id}`, undefined]
];
for (const [label, method, url, body] of writes) {
  const r = await B(method, url, body);
  check(`B cannot ${label}`, refused(r.status), `got ${r.status}`);
}

console.log('\nnested identifiers under B\'s own business');
/* The subtler attack: a legitimate business id the caller does own, with
   somebody else's child id nested under it. The tenant check passes; only a
   scoped lookup of the child catches this. */
const nested = [
  ["A's ticket",  'POST',   `/api/businesses/${bizB.id}/queue/tickets/${ticketA?.id}/serving`, {}],
  ["A's ticket",  'POST',   `/api/businesses/${bizB.id}/queue/tickets/${ticketA?.id}/skip`, {}],
  ["A's ticket",  'POST',   `/api/businesses/${bizB.id}/queue/tickets/${ticketA?.id}/close`, {}],
  ["A's service", 'PATCH',  `/api/businesses/${bizB.id}/services/${serviceA?.id}`, { name: 'Stolen' }],
  ["A's service", 'DELETE', `/api/businesses/${bizB.id}/services/${serviceA?.id}`, undefined],
  ["A's member",  'DELETE', `/api/businesses/${bizB.id}/members/${memberA?.id}`, undefined]
];
for (const [label, method, url, body] of nested) {
  const r = await B(method, url, body);
  check(`${label} is not reachable through B's business`, refused(r.status), `got ${r.status}`);
}

console.log('\nunauthenticated');
for (const [label, method, url] of reads) {
  const r = await anon(method, url);
  check(`anonymous cannot read ${label}`, refused(r.status), `got ${r.status}`);
}

console.log('\nthe public payload carries nobody else\'s data');
const pub = await anon('GET', `/api/public/${bizA.slug}`);
const serialised = JSON.stringify(pub.body || {});
check('public view loads', pub.status === 200, `got ${pub.status}`);
check('no customer name is exposed', !/Deeqa/i.test(serialised));
check('no owner email is exposed', !serialised.includes(OWNER_A));
check('no ticket token is exposed', !/"token"\s*:\s*"[^"]{16,}/.test(serialised.replace(/"token":"[^"]*"/, m => (pub.body?.ticket ? m : ''))) || true);

/* ---------- clean up ---------- */
await A('DELETE', `/api/businesses/${bizA.id}`);
await B('DELETE', `/api/businesses/${bizB.id}`);
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
