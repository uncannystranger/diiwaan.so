/* Every shape a status can arrive in, checked against the database.
 *
 * This exists because of a defect that an HTTP status alone would not have
 * characterised. `TERMINAL[status]` was an object literal read by truthiness,
 * so '__proto__', 'constructor', 'toString', 'valueOf' and 'hasOwnProperty'
 * all found something inherited from Object.prototype, passed the guard, and
 * produced a malformed update.
 *
 * Measured against the pre-fix code with the database inspected after every
 * attempt, the impact was precisely this: five inputs returned 500 instead of
 * 400. No ticket changed state, no junk field was written, no status outside
 * the schema was stored, and nothing was pollutable — the expression reads
 * Object.prototype, it never writes to it, and MongoDB's own schema validator
 * refused the malformed document. An availability and error-handling defect,
 * then, not a prototype-pollution or state-corruption one. Worth fixing, worth
 * not overstating.
 *
 * A Map cannot answer with an inherited key, so the class is gone rather than
 * the five names being blacklisted. This test holds that line, and checks the
 * stored state rather than trusting the response code.
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

const tok = (await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${KEY}`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.TEST_OWNER_A, password: process.env.TEST_PASSWORD, returnSecureToken: true }) })).json()).idToken;
const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const call = async (m, u, b) => {
  const r = await fetch(API + u, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const uri = process.env.MONGODB_URI || fs.readFileSync(path.resolve(here, '../../.data/mongo-uri'), 'utf8').trim();
const mongo = new MongoClient(uri); await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'diiwaan');

console.log('\nTicket status input — response and stored state\n');

const biz = (await call('POST', '/api/businesses',
  { name: `Status ${Date.now()}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;
const Q = `/api/businesses/${biz.id}/queue`;
const join = async n => (await (await fetch(`${API}/api/public/${biz.slug}/join`,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) })).json())?.view?.ticket;

const SCHEMA_STATUSES = ['waiting', 'called', 'serving', 'completed', 'skipped', 'cancelled', 'no_show'];

/* Everything that is not one of the four terminal words must be refused with a
   controlled 400, and must leave the ticket exactly as it was. */
const REJECT = [
  ['a prototype key', '__proto__'], ['a prototype key', 'constructor'], ['a prototype key', 'prototype'],
  ['a prototype method', 'toString'], ['a prototype method', 'valueOf'], ['a prototype method', 'hasOwnProperty'],
  ['an unknown word', 'nonsense'], ['a role name', 'owner'],
  ['an empty string', ''], ['whitespace', '   '],
  ['uppercase', 'COMPLETED'], ['mixed case', 'Completed'], ['padded', ' completed '],
  ['null', null], ['a number', 7], ['a boolean', true],
  ['an array', ['completed']], ['an object', { status: 'completed' }], ['an operator', { $ne: null }],
  ['a non-terminal state', 'waiting'], ['a non-terminal state', 'called'], ['a non-terminal state', 'serving']
];

for (const [label, status] of REJECT) {
  const t = await join('Probe');
  const before = await db.collection('tickets').findOne({ _id: new ObjectId(t.id) });
  const r = await call('POST', `${Q}/tickets/${t.id}/close`, { status });
  const after = await db.collection('tickets').findOne({ _id: new ObjectId(t.id) });

  const controlled = r.status === 400 || r.status === 422;
  const untouched = before.status === after.status;
  check(`${label} ${JSON.stringify(status)} -> ${r.status}, ticket still ${after.status}`,
    controlled && untouched, `status ${r.status}, ticket ${before.status} -> ${after.status}`);
}

/* The four that must work, each leaving exactly its own state. */
console.log('\nthe four terminal statuses each store exactly themselves');
for (const status of ['completed', 'skipped', 'cancelled', 'no_show']) {
  const t = await join('Probe');
  const r = await call('POST', `${Q}/tickets/${t.id}/close`, { status });
  const after = await db.collection('tickets').findOne({ _id: new ObjectId(t.id) });
  check(`${status} -> 200 and stored as ${after.status}`,
    r.status === 200 && after.status === status, `status ${r.status}, stored ${after.status}`);
  check(`${status} stamped a completion time`, after.completedAt instanceof Date, `completedAt=${after.completedAt}`);
}

/* An omitted status is the documented convenience, and means completed. */
const omitted = await join('Probe');
const rOmitted = await call('POST', `${Q}/tickets/${omitted.id}/close`, {});
const afterOmitted = await db.collection('tickets').findOne({ _id: new ObjectId(omitted.id) });
check('an omitted status defaults to completed',
  rOmitted.status === 200 && afterOmitted.status === 'completed', `status ${rOmitted.status}, stored ${afterOmitted.status}`);

/* Nothing anywhere may hold a status the schema does not name, or a field
   called "undefined" — the two footprints the old bug would have left. */
console.log('\nthe database carries no trace of a malformed write');
const offSchema = await db.collection('tickets').countDocuments({ status: { $nin: SCHEMA_STATUSES } });
check('no ticket has a status outside the schema', offSchema === 0, `${offSchema} found`);
const junk = await db.collection('tickets').countDocuments({ undefined: { $exists: true } });
check('no ticket carries an "undefined" field', junk === 0, `${junk} found`);

/* And the running process is unpolluted. */
check('Object.prototype was not written to',
  ({}).stamp === undefined && ({}).completedAt === undefined && ({}).status === undefined);

await call('DELETE', `/api/businesses/${biz.id}`);
await mongo.close();
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
