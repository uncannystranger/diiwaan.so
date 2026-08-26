/* The authorisation gate must fail closed.
 *
 * requireBusiness ranks roles so a route can ask for "manager or better". The
 * ranking used to be an object literal compared directly:
 *
 *     if (ROLE_RANK[role] < ROLE_RANK[minimumRole]) throw forbidden
 *
 * Any role the table did not know made the left side undefined, the comparison
 * NaN, the condition false — and the request went through. An owner-only route
 * would have admitted a member whose role was a typo, a null, or an inherited
 * key like 'constructor'.
 *
 * Nothing reached it: the member schema constrains role to an enum and both
 * write paths allowlist manager and staff. It was latent. But an authorisation
 * gate whose failure mode is "allow" is the wrong shape however well it is
 * fenced upstream, so the ranking is a Map and an unknown role is refused
 * rather than compared.
 *
 * This drives the real gate with a real membership row, writing roles the
 * application itself would never write — which is the point: the test asks what
 * happens if something upstream ever slips.
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
const S = client(await signIn(process.env.TEST_STAFF_A));

console.log('\nRole gate — unknown roles must be refused\n');

const biz = (await A('POST', '/api/businesses',
  { name: `Roles ${Date.now()}`, city: 'KM4', country: 'Somalia', category: 'Clinic' })).body.business;

const uri = process.env.MONGODB_URI || fs.readFileSync(path.resolve(here, '../../.data/mongo-uri'), 'utf8').trim();
const mongo = new MongoClient(uri); await mongo.connect();
const db = mongo.db(process.env.MONGODB_DATABASE || 'diiwaan');
const members = db.collection('business_members');

const staffUid = (await S('GET', '/api/auth/me')).body.user.id;
const seat = await members.insertOne({
  businessId: new ObjectId(biz.id), userId: staffUid, email: process.env.TEST_STAFF_A,
  name: 'Yuusuf', role: 'staff', status: 'active', createdAt: new Date()
});

/* An owner-only route and a manager-only route, to prove the rank still ranks. */
const OWNER_ONLY = ['POST', `/api/businesses/${biz.id}/members`, { email: 'x@example.com' }];
const MANAGER_ONLY = ['PATCH', `/api/businesses/${biz.id}/branding`, { primary: '#123456' }];
const STAFF_OK = ['GET', `/api/businesses/${biz.id}/queue`, undefined];

const setRole = async role => {
  // bypassValidation: writing a role the schema forbids is exactly the
  // upstream slip this gate has to survive.
  await members.updateOne({ _id: seat.insertedId }, { $set: { role } }, { bypassDocumentValidation: true });
};

console.log('roles the application never writes must be refused everywhere');
for (const role of ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty', 'nonsense', '', 'OWNER', 'Owner']) {
  await setRole(role);
  const owner = await S(...OWNER_ONLY);
  const manager = await S(...MANAGER_ONLY);
  const staff = await S(...STAFF_OK);
  const refused = [403, 404].includes(owner.status) && [403, 404].includes(manager.status) && [403, 404].includes(staff.status);
  check(`role ${JSON.stringify(role)} is refused (owner ${owner.status}, manager ${manager.status}, staff ${staff.status})`, refused);
}

console.log('\nand the real roles still rank correctly');
await setRole('staff');
check('staff reaches a staff route', (await S(...STAFF_OK)).status === 200);
check('staff is refused a manager route', (await S(...MANAGER_ONLY)).status === 403);
check('staff is refused an owner route', (await S(...OWNER_ONLY)).status === 403);

await setRole('manager');
check('manager reaches a staff route', (await S(...STAFF_OK)).status === 200);
check('manager reaches a manager route', (await S(...MANAGER_ONLY)).status === 200);
check('manager is refused an owner route', (await S(...OWNER_ONLY)).status === 403);

await setRole('owner');
check('owner reaches an owner route', [200, 201, 409].includes((await S(...OWNER_ONLY)).status));

await members.deleteMany({ businessId: new ObjectId(biz.id) });
await mongo.close();
await A('DELETE', `/api/businesses/${biz.id}`);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
