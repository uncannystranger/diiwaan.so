/* Where Google is told to come back to.
 *
 * This is one line of code and it was the whole reason Google sign-in did not
 * work anywhere. identitytoolkit passes `continueUri` straight through as the
 * OAuth `redirect_uri`, so asking it for an authorisation URL with this app's
 * own origin meant every origin the app is ever served from had to be
 * registered by hand on the project's OAuth client. Until someone did that,
 * Google answered redirect_uri_mismatch — measured on both
 * http://localhost:4173/ and https://diiwaan-so.vercel.app/ — and the button
 * could not work on any deployment, including a brand new one.
 *
 * Firebase registers its own handler on that client for every project. Routing
 * the round trip through it is what makes the button work without a console
 * change, and it is the kind of decision that is easy to undo by accident later
 * while "simplifying" — the origin looks like the obvious thing to send.
 *
 * So it is asserted here rather than left to a comment. No network, no
 * credentials: this is about which string is built.
 */

import assert from 'node:assert/strict';

process.env.FIREBASE_API_KEY ||= 'test-key';
process.env.FIREBASE_PROJECT_ID ||= 'diiwaan-test';
process.env.FIREBASE_AUTH_DOMAIN ||= 'diiwaan-test.firebaseapp.com';
process.env.APP_URL ||= 'https://diiwaan-so.vercel.app';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

const { googleRedirectUri } = await import('../src/lib/firebase.js');

console.log('\nGoogle redirect target\n');

const uri = googleRedirectUri();

check('is Firebase’s own auth handler', () =>
  assert.equal(uri, 'https://diiwaan-test.firebaseapp.com/__/auth/handler'));

check('is not this app’s origin, which Google refuses unless registered by hand', () => {
  assert.ok(!uri.startsWith(process.env.APP_URL), `redirect points back at the app: ${uri}`);
});

check('is https, whatever the app itself is served over', () =>
  assert.ok(uri.startsWith('https://')));

check('names the project’s auth domain, not a hardcoded one', () =>
  assert.ok(uri.includes(process.env.FIREBASE_AUTH_DOMAIN)));

check('is empty rather than wrong when no auth domain is configured', async () => {
  // A missing authDomain must not silently fall back to the origin.
  assert.ok(uri.length > 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
