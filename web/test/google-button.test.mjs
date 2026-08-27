/* What the Google button does when Google cannot be used.
 *
 * The button on the sign-in and sign-up screens rendered live whatever the
 * server reported. On a deployment where Google was switched off, pressing it
 * ran the whole click handler down to a guard several layers below and returned
 * a sentence about configuration to somebody who had asked to sign in. The
 * control was not lying about existing — the method is part of the product and
 * should be visible — it was lying about working.
 *
 * These assert the three states named in the requirement: available means live,
 * unavailable means disabled with a reason a person can act on, and a transient
 * failure is never described as missing configuration.
 *
 * Rendering is string templating, so this needs no browser.
 */

import assert from 'node:assert/strict';

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (error) { failures.push(`${name} — ${error.message}`); console.log(`  FAIL ${name} — ${error.message}`); }
};

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.location = { origin: 'http://localhost:4173', pathname: '/', search: '', hash: '' };
globalThis.history = { replaceState() {} };
globalThis.document = {
  documentElement: { lang: 'en', dataset: {}, style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, removeAttribute() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  head: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} })
};
const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia = matchMedia;
globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia };
if (!globalThis.navigator) globalThis.navigator = { onLine: true };

/* The screens read availability through session.js, which reads it from the
   config the server sent. Driving it through the real boot is what makes this a
   test of the path rather than of a mock. */
const stubConfig = ({ googleAuth, reason, env = 'development' }) => {
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.includes('/api/config')) {
      return { ok: true, status: 200, json: async () => ({
        firebase: { projectId: 'p', apiKey: 'k', authDomain: 'p.firebaseapp.com', appId: 'a' },
        appUrl: 'http://localhost:4173', env, googleAuth, googleAuthReason: reason
      }) };
    }
    if (path.includes('/api/auth/session')) return { ok: true, status: 204, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
};

/* What app.js hands these screens. Only the fields they read. */
const UI = { auth: { name: '', email: '', password: '', errors: {} }, showPassword: false, busy: false, googleBusy: false, resetSent: false };

/* Imported once, deliberately. Cache-busting session.js gives a fresh module
   while views/auth.js keeps importing the unbusted one, so the screens would be
   reading a copy nobody booted — every state would look identical and the test
   would pass or fail for the wrong reason. boot() re-reads /api/config, so
   re-booting the one instance is what actually changes the state under test. */
const session = await import('../js/session.js');
const views = await import('../js/views/auth.js');

const load = async state => {
  stubConfig(state);
  await session.boot();
  return { session, views };
};

console.log('\nThe Google button, in each state the server can report\n');

/* ---------- available ---------- */
{
  const { session } = await load({ googleAuth: true, reason: 'ok' });
  const signIn = views.signInView(UI);
  const signUp = views.signUpView(UI);

  check('reports itself available', () => assert.equal(session.googleAuthAvailable(), true));
  check('sign-in offers the button', () => assert.ok(signIn.includes('data-action="google-auth"')));
  check('sign-up offers the button', () => assert.ok(signUp.includes('data-action="google-auth"')));

  const button = signIn.slice(signIn.indexOf('data-action="google-auth"'));
  const tag = button.slice(0, button.indexOf('>'));
  check('and it is live, not disabled', () => assert.ok(!tag.includes('disabled')));
  check('with no talk of configuration in front of the person', () =>
    assert.ok(!signIn.includes('switched off') && !signIn.includes('lagama heli karo')));
}

/* ---------- switched off ---------- */
{
  const { session } = await load({ googleAuth: false, reason: 'turned_off' });
  const signIn = views.signInView(UI);
  const signUp = views.signUpView(UI);

  check('reports itself unavailable', () => assert.equal(session.googleAuthAvailable(), false));

  for (const [name, html] of [['sign-in', signIn], ['sign-up', signUp]]) {
    const at = html.indexOf('data-action="google-auth"');
    check(`${name} still shows the method exists`, () => assert.ok(at > -1));
    const tag = html.slice(at, html.indexOf('>', at));
    check(`${name} renders it disabled rather than live`, () => assert.ok(tag.includes('disabled')));
    check(`${name} says why, where the person can read it`, () =>
      assert.ok(/switched off|lagama heli karo/.test(html)));
  }
}

/* ---------- unreachable, which is not the same as unconfigured ---------- */
{
  await load({ googleAuth: false, reason: 'probe_failed' });
  const signIn = views.signInView(UI);

  check('a network failure is not described as missing configuration', () =>
    assert.ok(!/switched off|lagama heli karo/.test(signIn)));
  check('it is described as something to try again', () =>
    assert.ok(/could not be reached|lama gaari karin/.test(signIn)));
}

/* ---------- the sentence nobody should meet again ---------- */
{
  await load({ googleAuth: false, reason: 'turned_off' });
  const signIn = views.signInView(UI);
  check('"not set up yet" appears nowhere', () =>
    assert.ok(!/not set up yet/i.test(signIn)));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log('\nfailures:'); failures.forEach(f => console.log('  - ' + f)); process.exit(1); }
process.exit(0);
