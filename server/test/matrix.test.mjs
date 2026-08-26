/* The access matrix, tested exhaustively rather than by sampling.
 *
 * Every resource this API exposes is reached by an identifier in a URL, and
 * every one of those identifiers is attacker-controlled. This walks the whole
 * grid: each resource type, against each kind of caller, with each shape of id.
 *
 *   owner  → own resource            must succeed
 *   owner  → another tenant's        must be refused, and indistinguishably so
 *   staff  → permitted               must succeed
 *   staff  → beyond their role       must be refused as forbidden
 *   nobody → anything protected      must be refused as unauthenticated
 *   malformed id                     must be a controlled refusal, never a 500
 *   well-formed but nonexistent      must be a controlled 404
 *
 * The last three matter as much as the first four. A driver error escaping as a
 * 500 is both a crash and a disclosure — it tells a caller their input reached
 * the database — and a tenant-scoped resource that answers differently for
 * "someone else owns this" than for "this never existed" is an enumeration
 * oracle no amount of hiding in the interface can close.
 *
 * Staff is seated directly in MongoDB. Going through an invitation would need a
 * confirmed mailbox, and what is under test here is the role boundary, not the
 * path that establishes it.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const API = process.env.TEST_API_URL || 'http://localhost:4173';
const KEY = process.env.FIREBASE_API_KEY;
const PASSWORD = process.env.TEST_PASSWORD;

const need = { FIREBASE_API_KEY: KEY, TEST_PASSWORD: PASSWORD,
  TEST_OWNER_A: process.env.TEST_OWNER_A, TEST_OWNER_B: process.env.TEST_OWNER_B,
  TEST_STAFF_A: process.env.TEST_STAFF_A };
const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.error(`\nNeeded in .env:\n  ${missing.join('\n  ')}\n`); process.exit(1); }

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
};

const signIn = async email => {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }) });
  const b = await r.json();
  if (!b.idToken) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(b).slice(0, 140)}`);
  return b.idToken;
};

const client = token => async (method, url, body) => {
  const r = await fetch(API + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let parsed = null;
  const text = await r.text();
  try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 200); }
  return { status: r.status, body: parsed };
};

console.log('\nDiiwaan access matrix\n');

const A = client(await signIn(process.env.TEST_OWNER_A));
const B = client(await signIn(process.env.TEST_OWNER_B));
const S = client(await signIn(process.env.TEST_STAFF_A));
const anon = client(null);

/* ---------- fixtures ---------- */
const stamp = Date.now();
const bizA = (await A('POST', '/api/businesses', { name: `Matrix A ${stamp}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;
const bizB = (await B('POST', '/api/businesses', { name: `Matrix B ${stamp}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;
const svcA = (await A('POST', `/api/businesses/${bizA.id}/services`, { name: 'Consultation', estimatedDuration: 10 })).body?.service;
const joinA = await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Deeqa Jibril' });
const ticketA = joinA.body?.view?.ticket;
const memberA = (await A('POST', `/api/businesses/${bizA.id}/members`, { email: 'outsider@example.com', name: 'Yuusuf', role: 'staff' })).body?.member;

// Seat the staff account on A, which is the state a confirmed invitation reaches.
const staffUid = (await S('GET', '/api/auth/me')).body.user.id;
const mongo = new MongoClient(process.env.MONGODB_URI || (await import('node:fs')).readFileSync(path.resolve(here, '../../.data/mongo-uri'), 'utf8').trim());
await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'diiwaan');
await db.collection('business_members').insertOne({
  businessId: new ObjectId(bizA.id), userId: staffUid, email: process.env.TEST_STAFF_A,
  name: 'Yuusuf', role: 'staff', status: 'active', createdAt: new Date()
});

const logo = await (async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), 'logo.png');
  const r = await fetch(`${API}/api/businesses/${bizA.id}/logo`, {
    method: 'POST', headers: { Authorization: `Bearer ${await signIn(process.env.TEST_OWNER_A)}` }, body: form
  });
  return (await r.json()).url || '';
})();

console.log('fixtures:', {
  businessA: !!bizA?.id, businessB: !!bizB?.id, service: !!svcA?.id,
  ticket: !!ticketA?.id, member: !!memberA?.id, logo: !!logo, staffSeated: !!staffUid
});

/* ---------- the grid ---------- */
const ok = s => s >= 200 && s < 300;
const REFUSED = [401, 403, 404];
const CONTROLLED = [400, 401, 403, 404, 409, 422];

/* Each row: a resource, and how to address it for a given business + child id. */
const url = {
  business:  (b) => `/api/businesses/${b}`,
  queue:     (b) => `/api/businesses/${b}/queue`,
  analytics: (b) => `/api/businesses/${b}/analytics`,
  members:   (b) => `/api/businesses/${b}/members`,
  services:  (b) => `/api/businesses/${b}/services`,
  report:    (b) => `/api/businesses/${b}/report.pdf`,
  branding:  (b) => `/api/businesses/${b}/branding`,
  ticket:    (b, t) => `/api/businesses/${b}/queue/tickets/${t}/serving`,
  service:   (b, s) => `/api/businesses/${b}/services/${s}`,
  member:    (b, m) => `/api/businesses/${b}/members/${m}`,
  logoUp:    (b) => `/api/businesses/${b}/logo`
};

console.log('\n1. owner reaches their own resources');
for (const [name, u] of [['business', url.business(bizA.id)], ['queue', url.queue(bizA.id)],
  ['analytics', url.analytics(bizA.id)], ['members', url.members(bizA.id)],
  ['services', url.services(bizA.id)], ['report', url.report(bizA.id)]]) {
  const r = await A('GET', u);
  check(`owner GET own ${name}`, ok(r.status), `got ${r.status}`);
}

console.log('\n2. owner is refused another tenant\'s resources');
for (const [name, u] of [['business', url.business(bizB.id)], ['queue', url.queue(bizB.id)],
  ['analytics', url.analytics(bizB.id)], ['members', url.members(bizB.id)],
  ['services', url.services(bizB.id)], ['report', url.report(bizB.id)]]) {
  const r = await A('GET', u);
  check(`owner GET other tenant's ${name} is 404`, r.status === 404, `got ${r.status}`);
}

console.log('\n3. staff reaches what their role permits');
for (const [name, u] of [['queue', url.queue(bizA.id)], ['business', url.business(bizA.id)], ['services', url.services(bizA.id)]]) {
  const r = await S('GET', u);
  check(`staff GET ${name}`, ok(r.status), `got ${r.status}`);
}
check('staff can call the next customer', ok((await S('POST', `/api/businesses/${bizA.id}/queue/next`)).status));

console.log('\n4. staff is refused beyond their role (403, not 404 — they belong here)');
for (const [name, method, u, body] of [
  ['close the queue', 'POST', `/api/businesses/${bizA.id}/queue/status`, { status: 'closed' }],
  ['change branding', 'PATCH', url.branding(bizA.id), { primary: '#000000' }],
  ['invite staff', 'POST', url.members(bizA.id), { email: 'x@example.com' }],
  ['download the report', 'GET', url.report(bizA.id), undefined],
  ['rename the business', 'PATCH', url.business(bizA.id), { name: 'Renamed' }],
  ['delete the business', 'DELETE', url.business(bizA.id), undefined],
  ['upload a logo', 'POST', url.logoUp(bizA.id), {}]
]) {
  const r = await S(method, u, body);
  check(`staff cannot ${name}`, r.status === 403, `got ${r.status}`);
}

console.log('\n5. unauthenticated is refused every protected resource');
for (const [name, u] of [['business', url.business(bizA.id)], ['queue', url.queue(bizA.id)],
  ['analytics', url.analytics(bizA.id)], ['members', url.members(bizA.id)],
  ['services', url.services(bizA.id)], ['report', url.report(bizA.id)]]) {
  const r = await anon('GET', u);
  check(`anonymous GET ${name}`, REFUSED.includes(r.status), `got ${r.status}`);
}

console.log('\n6. malformed identifiers are controlled refusals, never a 500');
const MALFORMED = ['x', 'not-an-id', '%2e%2e%2f', "' OR 1=1", '{"$ne":null}', 'null', 'undefined', '../../etc/passwd', '1'.repeat(200)];
for (const bad of MALFORMED) {
  const enc = encodeURIComponent(bad);
  const probes = [
    [`business ${JSON.stringify(bad)}`, 'GET', url.business(enc)],
    [`queue ${JSON.stringify(bad)}`, 'GET', url.queue(enc)],
    [`ticket ${JSON.stringify(bad)}`, 'POST', url.ticket(bizA.id, enc)],
    [`service ${JSON.stringify(bad)}`, 'PATCH', url.service(bizA.id, enc)],
    [`member ${JSON.stringify(bad)}`, 'DELETE', url.member(bizA.id, enc)],
    [`branding asset ${JSON.stringify(bad)}`, 'GET', `/api/branding/${enc}`]
  ];
  for (const [name, method, u] of probes) {
    const r = await A(method, u, method === 'PATCH' ? { name: 'x' } : undefined);
    check(`malformed ${name}`, CONTROLLED.includes(r.status), `got ${r.status}`);
  }
}

console.log('\n7. well-formed but nonexistent identifiers are a controlled 404');
const GHOST = '0'.repeat(24);
for (const [name, method, u] of [
  ['business', 'GET', url.business(GHOST)],
  ['ticket', 'POST', url.ticket(bizA.id, GHOST)],
  ['service', 'PATCH', url.service(bizA.id, GHOST)],
  ['member', 'DELETE', url.member(bizA.id, GHOST)],
  ['branding asset', 'GET', `/api/branding/${GHOST}`]
]) {
  const r = await A(method, u, method === 'PATCH' ? { name: 'x' } : undefined);
  check(`nonexistent ${name} is 404`, r.status === 404, `got ${r.status}`);
}

console.log('\n8. another tenant\'s real id is indistinguishable from a ghost');
const pairs = [
  ['business', 'GET', url.business(bizB.id), url.business(GHOST)],
  ['ticket', 'POST', url.ticket(bizB.id, ticketA?.id), url.ticket(bizB.id, GHOST)],
  ['service', 'PATCH', url.service(bizB.id, svcA?.id), url.service(bizB.id, GHOST)],
  ['member', 'DELETE', url.member(bizB.id, memberA?.id), url.member(bizB.id, GHOST)]
];
for (const [name, method, realUrl, ghostUrl] of pairs) {
  const real = await A(method, realUrl, method === 'PATCH' ? { name: 'x' } : undefined);
  const ghost = await A(method, ghostUrl, method === 'PATCH' ? { name: 'x' } : undefined);
  check(`${name}: real-elsewhere and nonexistent answer alike`,
    real.status === ghost.status, `real ${real.status} vs ghost ${ghost.status}`);
}

console.log('\n9. uploads');
check('anonymous cannot upload a logo', REFUSED.includes((await anon('POST', url.logoUp(bizA.id), {})).status));
check('owner cannot upload into another tenant', REFUSED.includes((await A('POST', url.logoUp(bizB.id), {})).status));
if (logo) {
  check('a stored logo is publicly readable by id', ok((await anon('GET', logo)).status));
}

/* ---------- clean up ---------- */
await db.collection('business_members').deleteMany({ businessId: new ObjectId(bizA.id) });
await mongo.close();
await A('DELETE', url.business(bizA.id));
await B('DELETE', url.business(bizB.id));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
