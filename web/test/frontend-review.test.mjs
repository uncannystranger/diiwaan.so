import assert from 'node:assert/strict';
import { test } from 'node:test';
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


const { landingView } = await import('../js/views/auth.js');
const { ticketView } = await import('../js/views/customer.js');
const { setupView } = await import('../js/views/setup.js');
const { setLanguage, t } = await import('../js/i18n.js');
const { DEFAULT_CUSTOMER_EXPERIENCE, DEFAULT_BRANDING, DEFAULT_QR, DEFAULT_QUEUE_SETTINGS } = await import('../../server/src/lib/defaults.js');
const business = {name: '<Clinic>', city: 'Mogadishu', branding: DEFAULT_BRANDING, experience: DEFAULT_CUSTOMER_EXPERIENCE, queueSettings: DEFAULT_QUEUE_SETTINGS, qrSettings: DEFAULT_QR, slug: 'clinic'};
const view = {business, ticket: {label: 'A-104', status: 'waiting', ahead: 4, aheadAtJoin: 5, estimateMin: 12, joinedAt: new Date().toISOString()}, at: Date.now(), serving: {label: 'A-100'}};
for (const language of ['so', 'en']) {
  test(`${language}: journey, queue states and onboarding remain understandable`, () => {
    setLanguage(language);
    const landing = landingView({});
    for (const step of ['scan', 'number', 'wait']) assert.ok(landing.includes(t(`auth.step.${step}`)));
    for (const connection of ['live', 'offline', 'reconnecting']) {
      const html = ticketView({}, {view, connection});
      assert.ok(html.includes('A-104'));
      assert.ok(html.includes('&lt;Clinic&gt;'));
      assert.ok(html.includes('aria-live="polite"'));
      assert.ok(!html.includes('data-anim-key="myticket"'));
      if (connection === 'reconnecting') assert.ok(html.includes(t('cust.reconnectingBody')));
      if (connection === 'offline') assert.ok(html.includes(t('cust.offlineBody')));
      if (connection === 'live') assert.ok(html.includes(t('status.upToDate')));
    }
    const called = ticketView({}, {view: {...view, ticket: {...view.ticket, status: 'called'}}, connection: 'live'});
    assert.ok(called.includes(t('cust.itIsYourTurn')));
    const setup = setupView({setup: {step: 1}, services: []}, business, 'https://example.com');
    assert.ok(setup.includes('aria-current="step"'));
    assert.ok(setup.includes(t('setup.stepOf', {n: 2, total: 4})));
  });
}
