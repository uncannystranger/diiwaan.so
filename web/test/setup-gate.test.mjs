/* The dashboard must survive a refresh.
 *
 * The bug this exists for: `onboarded` records that somebody pressed the button
 * at the end of the four-step wizard, and nothing more. It was being read as
 * permission to use the application at all. Every route resolved to the wizard
 * while it was false, so an owner who closed the tab on step three — or whose
 * business was created by any route other than the wizard, which on a live
 * database was ten businesses out of eleven — was returned to "create your
 * queue" on every visit and every refresh, at the root URL, permanently.
 *
 * It cannot be escaped from the inside: the only thing that sets the flag is a
 * button on the screen the owner can no longer reach. And it is invisible from
 * the session's side, which is why it survived several rounds of work on the
 * session — the session was fine the whole time. The router was overruling it.
 *
 * A named business already has a queue and a working QR code. Customers can
 * already join it. Its owner has a desk, and the desk is the product.
 */

import assert from 'node:assert/strict';
import { setupClaimsTheScreen as claims } from '../js/setup-gate.js';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

const CONSOLE = ['queue', 'overview', 'brand', 'settings', 'sign', 'display'];
const nameless   = { name: '',            onboarded: false };
const unfinished = { name: 'Hodan Clinic', onboarded: false };
const finished   = { name: 'Hodan Clinic', onboarded: true  };

console.log('\nThe wizard may not hold an owner away from their desk\n');

check('a refresh of the dashboard returns the dashboard, not the wizard', () => {
  assert.equal(claims(unfinished, 'queue'), false);
});

for (const route of CONSOLE) {
  check(`/app/${route} is honoured for a named but unfinished business`, () => {
    assert.equal(claims(unfinished, route), false);
  });
}

check('the bare domain sends a signed-in owner to their desk', () => {
  assert.equal(claims(unfinished, ''), false);
});

check('the wizard still takes the screen when there is nothing yet', () => {
  assert.equal(claims(nameless, ''), true);
  assert.equal(claims(nameless, 'queue'), true);
});

check('no business at all is the wizard', () => {
  assert.equal(claims(null, 'queue'), true);
  assert.equal(claims(undefined, ''), true);
});

check('/setup is still reachable, so the flag can be finished', () => {
  assert.equal(claims(unfinished, 'setup'), true);
  assert.equal(claims(nameless, 'setup'), true);
});

check('a finished business never sees the wizard, even at /setup', () => {
  for (const route of [...CONSOLE, '', 'setup']) assert.equal(claims(finished, route), false);
});

check('the decision does not depend on anything but these two arguments', () => {
  const frozen = Object.freeze({ name: 'X', onboarded: false });
  assert.equal(claims(frozen, 'queue'), claims(frozen, 'queue'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { failures.forEach(f => console.log(`  ${f}`)); process.exit(1); }
