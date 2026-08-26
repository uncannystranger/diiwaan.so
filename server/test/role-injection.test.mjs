/* Can a client put an unrecognised role into a membership row?
 *
 * requireBusiness decides authorisation from `membership.role`, read out of
 * MongoDB. The gate itself is now closed against roles it does not know
 * (test:role-gate proves that). This asks the other half of the question, and
 * the one that decides severity: can the value ever get in there?
 *
 * Every path that writes business_members.role is attacked here with prototype
 * keys and junk, and the database is read back after each attempt. A 4xx alone
 * would not settle it — the row could still have been written and the response
 * failed later — so what is asserted is the stored document.
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
const VALID_ROLES = ['owner', 'manager', 'staff'];
const HOSTILE = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty',
                 'owner', 'OWNER', 'Owner', 'admin', '', '   ', 'nonsense'];

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name} — ${detail}`); console.log(`  FAIL ${name} — ${detail}`); }
};

const signIn = async email => (await (await fetch(
  `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: process.env.TEST_PASSWORD, returnSecureToken: true }) })).json()).idToken;
const client = t => async (m, u, b) => {
  const r = await fetch(API + u, { method: m, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const A = client(await signIn(process.env.TEST_OWNER_A));
const B = client(await signIn(process.env.TEST_OWNER_B));

const uri = process.env.MONGODB_URI || fs.readFileSync(path.resolve(here, '../../.data/mongo-uri'), 'utf8').trim();
const mongo = new MongoClient(uri); await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'diiwaan');
const members = db.collection('business_members');

console.log('\nRole injection — can an unrecognised role be stored?\n');

const biz = (await A('POST', '/api/businesses',
  { name: `Injection ${Date.now()}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;
const bizId = new ObjectId(biz.id);

/* ---------- path 1: the invitation ---------- */
console.log('1. inviting somebody with a hostile role');
for (const role of HOSTILE) {
  const email = `inj-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const r = await A('POST', `/api/businesses/${biz.id}/members`, { email, name: 'X', role });
  const stored = await members.findOne({ businessId: bizId, email });
  const clean = !stored || VALID_ROLES.includes(stored.role);
  check(`invite role=${JSON.stringify(role)} -> ${r.status}, stored role ${stored ? JSON.stringify(stored.role) : '(no row)'}`,
    clean, `stored ${stored?.role}`);
}

/* ---------- path 2: patching an existing seat ---------- */
console.log('\n2. patching a real seat to a hostile role');
const seatEmail = `seat-${Date.now()}@example.com`;
await A('POST', `/api/businesses/${biz.id}/members`, { email: seatEmail, name: 'Seat', role: 'staff' });
const seat = await members.findOne({ businessId: bizId, email: seatEmail });
for (const role of HOSTILE) {
  const r = await A('PATCH', `/api/businesses/${biz.id}/members/${seat._id}`, { role });
  const after = await members.findOne({ _id: seat._id });
  check(`patch role=${JSON.stringify(role)} -> ${r.status}, seat is ${JSON.stringify(after.role)}`,
    VALID_ROLES.includes(after.role) && after.role !== 'owner', `became ${after.role}`);
}

/* ---------- path 3: smuggling extra fields alongside a legal role ---------- */
console.log('\n3. smuggling role through fields the schema does not name');
for (const body of [
  { role: 'staff', 'role ': 'owner' },
  { role: 'staff', ROLE: 'owner' },
  { role: 'staff', __proto__: { role: 'owner' } },
  { role: ['owner'] },
  { role: { $ne: null } }
]) {
  const email = `smug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const r = await A('POST', `/api/businesses/${biz.id}/members`, { email, name: 'X', ...body });
  const stored = await members.findOne({ businessId: bizId, email });
  const clean = !stored || (VALID_ROLES.includes(stored.role) && stored.role !== 'owner');
  check(`invite ${JSON.stringify(body).slice(0, 46)} -> stored ${stored ? JSON.stringify(stored.role) : '(no row)'}`, clean);
}

/* ---------- path 4: does MongoDB itself refuse the value? ---------- */
console.log('\n4. the collection refuses it even without the application');
let dbRefused = false;
try {
  await members.insertOne({ businessId: bizId, userId: 'x', email: 'direct@example.com',
    name: '', role: '__proto__', status: 'active', createdAt: new Date() });
} catch { dbRefused = true; }
check('a direct insert with role=__proto__ is refused by the schema validator', dbRefused);
await members.deleteMany({ email: 'direct@example.com' });

/* ---------- path 5: the real unauthorized scenario ---------- */
console.log('\n5. owner B attempts to gain rights in tenant A');
const before = await members.countDocuments({ businessId: bizId });
for (const role of ['__proto__', 'constructor', 'owner']) {
  const r = await B('POST', `/api/businesses/${biz.id}/members`, { email: `b-${Date.now()}@example.com`, role });
  check(`B inviting into A's business with role=${JSON.stringify(role)} is refused`, r.status === 404, `got ${r.status}`);
}
const after = await members.countDocuments({ businessId: bizId });
check('B added no membership rows to A', after === before, `${before} -> ${after}`);

/* every row that exists carries a role we recognise */
const rows = await members.find({ businessId: bizId }).toArray();
const bad = rows.filter(m => !VALID_ROLES.includes(m.role));
check(`all ${rows.length} membership rows carry a known role`, bad.length === 0,
  bad.map(m => m.role).join(','));

await members.deleteMany({ businessId: bizId });
await mongo.close();
await A('DELETE', `/api/businesses/${biz.id}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
