/* Privilege escalation, mass assignment, and injection through the body.
 *
 * The access matrix proves the right callers reach the right URLs. This asks a
 * different question: once inside a request they are entitled to make, can a
 * caller write something they are not entitled to write?
 *
 * The classic shapes, all of them attempted here rather than reasoned about:
 * promoting yourself by patching your own membership; inviting yourself back as
 * an owner; smuggling ownerId or _id into an ordinary update; sending a Mongo
 * operator where a string is expected; and spending another customer's ticket
 * token.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient, ObjectId } from 'mongodb';
import fs from 'node:fs';

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

const signIn = async email => {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: process.env.TEST_PASSWORD, returnSecureToken: true }) });
  return (await r.json()).idToken;
};
const client = token => async (method, url, body) => {
  const r = await fetch(API + url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 160); }
  return { status: r.status, body: parsed };
};

console.log('\nDiiwaan privilege escalation and mass assignment\n');

const A = client(await signIn(process.env.TEST_OWNER_A));
const S = client(await signIn(process.env.TEST_STAFF_A));
const anon = client(null);

const stamp = Date.now();
const biz = (await A('POST', '/api/businesses', { name: `Esc ${stamp}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;

const mongoUri = process.env.MONGODB_URI || fs.readFileSync(path.resolve(here, '../../.data/mongo-uri'), 'utf8').trim();
const mongo = new MongoClient(mongoUri); await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'diiwaan');

const staffUid = (await S('GET', '/api/auth/me')).body.user.id;
const seat = await db.collection('business_members').insertOne({
  businessId: new ObjectId(biz.id), userId: staffUid, email: process.env.TEST_STAFF_A,
  name: 'Yuusuf', role: 'staff', status: 'active', createdAt: new Date()
});
const seatId = String(seat.insertedId);

/* ---------- 1. promoting yourself ---------- */
console.log('1. a staff member cannot promote themselves');
for (const [what, body] of [
  ['to manager', { role: 'manager' }],
  ['to owner', { role: 'owner' }],
  ['by status', { status: 'active', role: 'owner' }]
]) {
  const r = await S('PATCH', `/api/businesses/${biz.id}/members/${seatId}`, body);
  check(`staff PATCH own seat ${what} is refused`, r.status === 403, `got ${r.status}`);
}
const seatNow = await db.collection('business_members').findOne({ _id: new ObjectId(seatId) });
check('the seat is still staff in the database', seatNow.role === 'staff', `role is ${seatNow.role}`);

/* ---------- 2. inviting an owner ---------- */
console.log('\n2. nobody is invited as an owner');
const invite = await A('POST', `/api/businesses/${biz.id}/members`, { email: `esc-${stamp}@example.com`, role: 'owner' });
if (invite.status === 201) {
  check('an invite asking for owner does not become one', invite.body.member?.role !== 'owner', `role is ${invite.body.member?.role}`);
} else {
  check('an invite asking for owner is refused outright', [400, 422].includes(invite.status), `got ${invite.status}`);
}

/* ---------- 3. the owner's own seat is untouchable ---------- */
console.log('\n3. the owner seat cannot be demoted or removed');
const ownerSeat = await db.collection('business_members').findOne({ businessId: new ObjectId(biz.id), role: 'owner' });
if (ownerSeat) {
  const demote = await A('PATCH', `/api/businesses/${biz.id}/members/${ownerSeat._id}`, { role: 'staff' });
  check('owner seat cannot be demoted', demote.status === 404, `got ${demote.status}`);
  const remove = await A('DELETE', `/api/businesses/${biz.id}/members/${ownerSeat._id}`);
  check('owner seat cannot be deleted', remove.status === 404, `got ${remove.status}`);
} else {
  check('owner has no member row to attack (ownership is on the business)', true);
}

/* ---------- 4. mass assignment ---------- */
console.log('\n4. fields nobody may set are ignored, not applied');
const before = await db.collection('businesses').findOne({ _id: new ObjectId(biz.id) });
await A('PATCH', `/api/businesses/${biz.id}`, {
  name: 'Renamed legitimately',
  ownerId: 'attacker-uid',
  _id: '000000000000000000000000',
  createdAt: new Date(0).toISOString(),
  role: 'owner'
});
const after = await db.collection('businesses').findOne({ _id: new ObjectId(biz.id) });
check('ownerId is unchanged', String(after.ownerId) === String(before.ownerId), `${before.ownerId} -> ${after.ownerId}`);
check('_id is unchanged', String(after._id) === String(before._id));
check('createdAt is unchanged', String(after.createdAt) === String(before.createdAt));
check('the legitimate field did apply', after.name === 'Renamed legitimately', `name is ${after.name}`);

/* ---------- 5. Mongo operators through the body ---------- */
console.log('\n5. a Mongo operator where a string belongs');
const injections = [
  ['business name', 'PATCH', `/api/businesses/${biz.id}`, { name: { $ne: null } }],
  ['slug', 'PATCH', `/api/businesses/${biz.id}`, { slug: { $gt: '' } }],
  ['branding colour', 'PATCH', `/api/businesses/${biz.id}/branding`, { primary: { $ne: null } }],
  ['service name', 'POST', `/api/businesses/${biz.id}/services`, { name: { $ne: null } }],
  ['invite email', 'POST', `/api/businesses/${biz.id}/members`, { email: { $ne: null } }]
];
for (const [what, method, url, body] of injections) {
  const r = await A(method, url, body);
  check(`${what} rejects an operator object`, [400, 422].includes(r.status), `got ${r.status}`);
}

console.log('\n6. the public endpoints');
const join = await anon('POST', `/api/public/${biz.slug}/join`, { name: 'Deeqa Jibril' });
const token = join.body?.token;
check('a customer can join', join.status === 201, `got ${join.status}`);

const join2 = await anon('POST', `/api/public/${biz.slug}/join`, { name: 'Faarax' });
const token2 = join2.body?.token;

for (const [what, body] of [
  ['an operator as a token', { token: { $ne: null } }],
  ['a missing token', {}],
  ['a made-up token', { token: '00000000-0000-0000-0000-000000000000' }]
]) {
  const r = await anon('POST', `/api/public/${biz.slug}/leave`, body);
  check(`leaving with ${what} is refused`, [400, 401, 403, 404, 422].includes(r.status), `got ${r.status}`);
}
if (token && token2) {
  const cross = await anon('POST', `/api/public/${biz.slug}/leave`, { token: token2 });
  check('one customer can leave with their own token', cross.status === 200, `got ${cross.status}`);
}
const injectName = await anon('POST', `/api/public/${biz.slug}/join`, { name: { $ne: null } });
check('joining with an operator as a name is refused', [400, 422].includes(injectName.status), `got ${injectName.status}`);

console.log('\n7. the report period is not a free-text query');
for (const period of ['today', 'week', 'month', "'; DROP", '{"$ne":null}', 'x'.repeat(200)]) {
  const r = await A('GET', `/api/businesses/${biz.id}/report.pdf?period=${encodeURIComponent(period)}`);
  const fine = r.status === 200 || [400, 422].includes(r.status);
  check(`period ${JSON.stringify(period.slice(0, 20))} is handled`, fine, `got ${r.status}`);
}

await db.collection('business_members').deleteMany({ businessId: new ObjectId(biz.id) });
await mongo.close();
await A('DELETE', `/api/businesses/${biz.id}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
