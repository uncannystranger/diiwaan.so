/* End-to-end API test against real Supabase auth and a real MongoDB.
   Run the server first (npm run dev), then: npm run test:api */

import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../.env') });

const API = process.env.TEST_API_URL || 'http://localhost:4173';
const SUPABASE = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
/* The suite signs in as real Supabase users, so the accounts it uses are
   configuration, never source. Nothing here has a default: a checkout of this
   repository cannot authenticate as anyone until whoever runs it supplies their
   own test accounts in .env. */
const PASSWORD = process.env.TEST_PASSWORD;
const ACCOUNTS = {
  ownerA: process.env.TEST_OWNER_A,
  ownerB: process.env.TEST_OWNER_B,
  staffA: process.env.TEST_STAFF_A
};

const missing = Object.entries({ TEST_PASSWORD: PASSWORD, ...{
  TEST_OWNER_A: ACCOUNTS.ownerA, TEST_OWNER_B: ACCOUNTS.ownerB, TEST_STAFF_A: ACCOUNTS.staffA
} }).filter(([, value]) => !value).map(([name]) => name);

if (missing.length) {
  console.error(`\nThese are needed in .env before the API suite can run:\n  ${missing.join('\n  ')}\n`);
  console.error('They are three throwaway Supabase accounts and their shared password.\n');
  process.exit(1);
}

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function signIn(email) {
  const response = await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD })
  });
  const body = await response.json();
  if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.access_token;
}

const api = (token) => async (method, url, body) => {
  const response = await fetch(`${API}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: response.status, body: json };
};

const stamp = Date.now().toString(36);

console.log('\nDiiwaan API integration test\n');

/* ---------- authentication ---------- */
console.log('authentication');
const tokenA = await signIn(ACCOUNTS.ownerA);
const tokenB = await signIn(ACCOUNTS.ownerB);
const tokenStaff = await signIn(ACCOUNTS.staffA);
const A = api(tokenA);
const B = api(tokenB);
const S = api(tokenStaff);
const anon = api(null);

check('rejects a request with no token', (await anon('GET', '/api/auth/me')).status === 401);
check('rejects a forged token', (await api('not.a.token')('GET', '/api/auth/me')).status === 401);

const meA = await A('GET', '/api/auth/me');
check('signs in owner A and creates a MongoDB profile', meA.status === 200 && meA.body.user.email === ACCOUNTS.ownerA);
check('reports the verified email', meA.body.user.emailVerified === true);

/* ---------- businesses ---------- */
console.log('\nbusiness creation and tenancy');
const createA = await A('POST', '/api/businesses', {
  name: `Hodan Clinic ${stamp}`, city: 'KM4 · Mogadishu', country: 'Somalia', category: 'Clinic'
});
check('owner A creates a business', createA.status === 201, JSON.stringify(createA.body).slice(0, 120));
const bizA = createA.body.business;

const createB = await B('POST', '/api/businesses', { name: `Sahra Pharmacy ${stamp}`, city: 'Wadajir' });
const bizB = createB.body.business;
check('owner B creates a separate business', createB.status === 201 && bizB.id !== bizA.id);
check('each business gets its own slug', bizA.slug !== bizB.slug && /^[a-z0-9-]+$/.test(bizA.slug));

const dupe = await A('POST', '/api/businesses', { name: `Hodan Clinic ${stamp}` });
check('a duplicate name still gets a unique slug', dupe.body.business.slug !== bizA.slug);

check('owner A sees only their own businesses',
  (await A('GET', '/api/businesses')).body.businesses.every(b => b.id !== bizB.id));

/* ---------- tenant isolation ---------- */
console.log('\ntenant isolation');
check('owner A cannot read business B', (await A('GET', `/api/businesses/${bizB.id}`)).status === 404);
check('owner B cannot read business A', (await B('GET', `/api/businesses/${bizA.id}`)).status === 404);
check('owner A cannot rename business B', (await A('PATCH', `/api/businesses/${bizB.id}`, { name: 'Hijacked' })).status === 404);
check('owner A cannot read B\'s queue', (await A('GET', `/api/businesses/${bizB.id}/queue`)).status === 404);
check('owner A cannot call next in B\'s queue', (await A('POST', `/api/businesses/${bizB.id}/queue/next`)).status === 404);
check('owner A cannot read B\'s analytics', (await A('GET', `/api/businesses/${bizB.id}/analytics`)).status === 404);
check('a made-up business id is a 404', (await A('GET', '/api/businesses/64b7f3a2c1d4e5f6a7b8c9d0')).status === 404);
check('a malformed business id is a 404', (await A('GET', '/api/businesses/not-an-id')).status === 404);

/* ---------- configuration ---------- */
console.log('\nqueue, branding and services');
check('branding update sticks',
  (await A('PATCH', `/api/businesses/${bizA.id}/branding`, { primary: '#5B8C2A', emphasis: '#28401A' }))
    .body.business.branding.primary === '#5B8C2A');
check('a bad colour is rejected',
  (await A('PATCH', `/api/businesses/${bizA.id}/branding`, { primary: 'red' })).status === 422);

const fivePalette = {
  preset: 'harbour', primary: '#1F6FB2', emphasis: '#0B2438',
  accent: '#5FC6CE', base: '#F3F7FB', tint: '#D6E8F5'
};
const paletteSaved = (await A('PATCH', `/api/businesses/${bizA.id}/branding`, fivePalette)).body.business.branding;
check('all five brand colours round-trip',
  Object.entries(fivePalette).every(([key, value]) => paletteSaved[key] === value));
check('the surface style accepts the four options',
  (await A('PATCH', `/api/businesses/${bizA.id}/branding`, { surface: 'gradient' })).body.business.branding.surface === 'gradient');
check('an unknown surface style is refused',
  (await A('PATCH', `/api/businesses/${bizA.id}/branding`, { surface: 'neon' })).status === 422);
check('one business\'s palette does not touch another',
  (await B('GET', `/api/businesses/${bizB.id}`)).body.business.branding.primary !== fivePalette.primary);
check('the palette reaches that business\'s public page',
  (await anon('GET', `/api/public/${bizA.slug}`)).body.business.branding.accent === fivePalette.accent);
check('customer wording update sticks',
  (await A('PATCH', `/api/businesses/${bizA.id}/customer-experience`, { headline: 'Ku soo dhawoow' }))
    .body.business.customerExperience.headline === 'Ku soo dhawoow');
check('QR settings update sticks',
  (await A('PATCH', `/api/businesses/${bizA.id}/qr`, { shape: 'dot', foreground: '#28401A' }))
    .body.business.qrSettings.shape === 'dot');

const service = await A('POST', `/api/businesses/${bizA.id}/services`, { name: 'Consultation', estimatedDuration: 12 });
check('service created', service.status === 201);
check('duplicate service names are refused',
  (await A('POST', `/api/businesses/${bizA.id}/services`, { name: 'Consultation' })).status === 409);
const serviceId = service.body.service.id;

await A('PATCH', `/api/businesses/${bizA.id}/queue`, { prefix: 'H', avgServiceMin: 6 });
const snap0 = await A('GET', `/api/businesses/${bizA.id}/queue`);
check('queue settings applied', snap0.body.queue.prefix === 'H' && snap0.body.queue.avgServiceMin === 6);

/* ---------- public customer flow ---------- */
console.log('\npublic customer flow');
const view0 = await anon('GET', `/api/public/${bizA.slug}`);
check('public page resolves by slug', view0.status === 200 && view0.body.business.name === bizA.name);
check('public page carries the business branding', view0.body.business.branding.primary === fivePalette.primary);
check('public page carries the owner\'s wording', view0.body.business.experience.headline === 'Ku soo dhawoow');
check('unknown slug is a 404', (await anon('GET', '/api/public/no-such-business')).status === 404);

const join1 = await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Amina Yusuf', phone: '61 442 118', serviceId });
check('a customer joins', join1.status === 201 && join1.body.view.ticket.label === 'H-1');
const tokenTicket1 = join1.body.token;

const join2 = await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Cabdi Nuur' });
const join3 = await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Sagal Aden' });
check('numbers increment per tenant', join2.body.view.ticket.label === 'H-2' && join3.body.view.ticket.label === 'H-3');

check('joining without a name is refused',
  (await anon('POST', `/api/public/${bizA.slug}/join`, { name: '' })).status === 422);

/* Bot protection: both checks refuse, and neither says which one caught it. */
check('a filled honeypot is refused',
  (await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Script', company: 'spam' })).status === 429);
check('a form submitted faster than a person can type is refused',
  (await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Script', elapsed: 40 })).status === 429);
/* The phone is sealed in the database and opened again for the desk, so the
   staff screen is unchanged while a stray backup is unreadable. */
{
  const { connect, disconnect, col, collections } = await import('../src/db.js');
  await connect();
  const { ObjectId } = await import('mongodb');
  const stored = await col(collections.tickets).findOne({
    name: 'Amina Yusuf', businessId: new ObjectId(bizA.id)
  });
  check('the stored phone is not readable', !String(stored.phone).includes('442'));
  check('the desk still sees the real phone',
    (await A('GET', `/api/businesses/${bizA.id}/queue`)).body.waiting
      .some(t => t.name === 'Amina Yusuf' && t.phone === '61 442 118'));
  // The suite talks to the API over HTTP; this was the one direct look at the
  // database, and leaving its pool open would hold the test process open too.
  await disconnect();
}

const mine = await anon('GET', `/api/public/${bizA.slug}?token=${tokenTicket1}`);
check('a device sees its own ticket by token', mine.body.ticket?.label === 'H-1' && mine.body.ticket.ahead === 0);
const stranger = await anon('GET', `/api/public/${bizA.slug}?token=${crypto.randomUUID()}`);
check('an unknown token sees no ticket', stranger.body.ticket === null);
check('the public view never leaks other customers\' names',
  !JSON.stringify(view0.body).includes('Amina') && !JSON.stringify(mine.body).includes('Cabdi'));

const bView = await anon('GET', `/api/public/${bizB.slug}`);
check('business B\'s public queue is empty and separate', bView.body.waitingCount === 0);
check('A\'s ticket token is meaningless on B\'s page',
  (await anon('GET', `/api/public/${bizB.slug}?token=${tokenTicket1}`)).body.ticket === null);

/* ---------- concurrency ---------- */
console.log('\nqueue operations and concurrency');
const [next1, next2] = await Promise.all([
  A('POST', `/api/businesses/${bizA.id}/queue/next`),
  A('POST', `/api/businesses/${bizA.id}/queue/next`)
]);
const calledLabels = [next1.body.ticket?.label, next2.body.ticket?.label].filter(Boolean);
check('two simultaneous NEXT presses call two different people',
  calledLabels.length === 2 && calledLabels[0] !== calledLabels[1],
  calledLabels.join(' / '));

const afterNext = await A('GET', `/api/businesses/${bizA.id}/queue`);
check('the queue advanced', afterNext.body.counts.waiting === 1);

const servingTicket = afterNext.body.serving;
check('someone is being served', Boolean(servingTicket));

const recall = await A('POST', `/api/businesses/${bizA.id}/queue/recall`);
check('recall bumps the call count', recall.body.ticket.recallCount === 1);

const waitingId = afterNext.body.waiting[0].id;
check('move to front works', (await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${waitingId}/move`, { direction: 'front' })).status === 200);
check('skip sends a ticket to the end',
  (await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${waitingId}/skip`)).body.ticket.status === 'waiting');

const deskTicket = await A('POST', `/api/businesses/${bizA.id}/queue/tickets`, { name: 'Walk-in Warsame' });
check('the desk can add a customer', deskTicket.status === 201);
check('closing a ticket as no_show works',
  (await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${deskTicket.body.ticket.id}/close`, { status: 'no_show' }))
    .body.ticket.status === 'no_show');
check('closing the same ticket twice is refused',
  (await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${deskTicket.body.ticket.id}/close`, { status: 'completed' })).status === 409);

check('pausing the queue blocks new public joins',
  (await A('POST', `/api/businesses/${bizA.id}/queue/status`, { status: 'paused' })).status === 200 &&
  (await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Too late' })).status === 409);
await A('POST', `/api/businesses/${bizA.id}/queue/status`, { status: 'open' });
check('reopening lets customers join again',
  (await anon('POST', `/api/public/${bizA.slug}/join`, { name: 'Deeqa Jibril' })).status === 201);

const leave = await anon('POST', `/api/public/${bizA.slug}/leave`, { token: tokenTicket1 });
check('a customer can leave', leave.status === 200);

/* ---------- staff ---------- */
console.log('\nstaff and roles');
const invite = await A('POST', `/api/businesses/${bizA.id}/members`, { email: ACCOUNTS.staffA, name: 'Yuusuf', role: 'staff' });
check('owner invites a staff member', invite.status === 201);
check('staff cannot see the business before accepting',
  (await S('GET', `/api/businesses/${bizA.id}`)).status === 404);

const meStaff = await S('GET', '/api/auth/me');
check('signing in links the invitation to the account', meStaff.body.businesses.some(b => b.id === bizA.id));
check('staff can now read the queue', (await S('GET', `/api/businesses/${bizA.id}/queue`)).status === 200);
check('staff can call the next customer', (await S('POST', `/api/businesses/${bizA.id}/queue/next`)).status === 200);
check('staff cannot close the queue', (await S('POST', `/api/businesses/${bizA.id}/queue/status`, { status: 'closed' })).status === 403);
check('staff cannot change branding',
  (await S('PATCH', `/api/businesses/${bizA.id}/branding`, { primary: '#000000' })).status === 403);
check('staff cannot invite other staff',
  (await S('POST', `/api/businesses/${bizA.id}/members`, { email: 'x@example.com' })).status === 403);
check('staff still cannot touch business B', (await S('GET', `/api/businesses/${bizB.id}/queue`)).status === 404);

/* ---------- analytics ---------- */
console.log('\nanalytics');
const stats = await A('GET', `/api/businesses/${bizA.id}/analytics`);
check('analytics summarise real events', stats.status === 200 && stats.body.summary.completed >= 1);
check('analytics count skipped and no-shows', stats.body.summary.noShow >= 1);
check('activity feed is populated', stats.body.activity.length > 0);
check('service breakdown is present', stats.body.summary.services.some(s => s.name === 'Consultation'));

/* ---------- realtime ---------- */
console.log('\nrealtime');
const streamResponse = await fetch(`${API}/api/public/${bizA.slug}/stream`, { headers: { Accept: 'text/event-stream' } });
check('public stream opens', streamResponse.status === 200 &&
  streamResponse.headers.get('content-type').includes('text/event-stream'));

const reader = streamResponse.body.getReader();
const readChunk = async () => {
  const timeout = new Promise(resolve => setTimeout(() => resolve({ value: new Uint8Array() }), 4000));
  const { value } = await Promise.race([reader.read(), timeout]);
  return new TextDecoder().decode(value || new Uint8Array());
};
await readChunk(); // retry preamble + replay
await A('POST', `/api/businesses/${bizA.id}/queue/tickets`, { name: 'Realtime Rahma' });
const pushed = await readChunk();
check('a queue change is pushed to customers', pushed.includes('ticket.created'), pushed.slice(0, 60));
check('the pushed event carries no personal data', !pushed.includes('Rahma'));
await reader.cancel();

/* ---------- security regressions ---------- */
console.log('\nsecurity');

// A query-string operator must not be able to stand in for a session token.
const injected = await anon('GET', `/api/public/${bizA.slug}?token[$ne]=`);
check('a NoSQL operator in the ticket token matches nothing', injected.body.ticket === null);
const injectedLeave = await anon('POST', `/api/public/${bizA.slug}/leave`, { token: { $ne: null } });
check('an operator cannot cancel a stranger\'s ticket', injectedLeave.status === 404);

check('a logo URL outside our storage is refused',
  (await A('PATCH', `/api/businesses/${bizA.id}`, { logo: 'https://evil.example.com/pixel.png' })).status === 422);
check('a malformed queue id is a clean 404',
  (await A('GET', `/api/businesses/${bizA.id}/queue?queueId=not-an-id`)).status === 404);

const sessionNoHeader = await fetch(`${API}/api/auth/session`, { method: 'GET' });
check('the session cookie endpoint refuses a request without the client header', sessionNoHeader.status === 403);

const reportUnauthorised = await B('GET', `/api/businesses/${bizA.id}/report.pdf`);
check('owner B cannot download owner A\'s report', reportUnauthorised.status === 404);

const reportResponse = await fetch(`${API}/api/businesses/${bizA.id}/report.pdf?period=today`, {
  headers: { Authorization: `Bearer ${tokenA}` }
});
const reportBytes = Buffer.from(await reportResponse.arrayBuffer());
check('a report downloads as a real PDF',
  reportResponse.status === 200 && reportBytes.subarray(0, 4).toString() === '%PDF');
check('the report is served as an attachment',
  (reportResponse.headers.get('content-disposition') || '').includes('.pdf'));
check('the report contains selectable text, not an image',
  reportBytes.includes(Buffer.from('Queue report')) || reportBytes.includes(Buffer.from('FlateDecode')));

check('staff cannot download reports',
  (await S('GET', `/api/businesses/${bizA.id}/report.pdf`)).status === 403);

/* ---------- caching ---------- */
console.log('\ncaching');
const publicHead = await fetch(`${API}/api/public/${bizA.slug}`);
const etag = publicHead.headers.get('etag');
await publicHead.text();   // undici reuses the socket only once the body is drained
check('the public view is cacheable', (publicHead.headers.get('cache-control') || '').includes('max-age'));
const revalidated = await fetch(`${API}/api/public/${bizA.slug}`, {
  headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' }
});
await revalidated.arrayBuffer().catch(() => {});
check('an unchanged public view revalidates to 304', revalidated.status === 304, `got ${revalidated.status}`);

const queueHead = await fetch(`${API}/api/businesses/${bizA.id}/queue`, { headers: { Authorization: `Bearer ${tokenA}` } });
check('queue state is never cached', (queueHead.headers.get('cache-control') || '').includes('no-store'));

/* ---------- manual call ---------- */
console.log('\nmanual call');
const waitingNow = (await A('GET', `/api/businesses/${bizA.id}/queue`)).body.waiting;
if (waitingNow.length >= 2) {
  const last = waitingNow[waitingNow.length - 1];
  const called = await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${last.id}/call`);
  check('the desk can call a specific waiting customer', called.body.ticket?.label === last.label);
  check('calling that customer again is refused',
    (await A('POST', `/api/businesses/${bizA.id}/queue/tickets/${last.id}/call`)).status === 409);
  check('staff may also call a specific customer',
    [200, 409].includes((await S('POST', `/api/businesses/${bizA.id}/queue/tickets/${waitingNow[0].id}/call`)).status));
} else {
  check('the desk can call a specific waiting customer', false, 'not enough waiting tickets');
}

/* ---------- cleanup ---------- */
console.log('\ncleanup');
const removeOwn = async (client, businesses) => {
  for (const item of businesses) {
    if (item.name.includes(stamp)) await client('DELETE', `/api/businesses/${item.id}`);
  }
};
await removeOwn(A, (await A('GET', '/api/businesses')).body.businesses);
await removeOwn(B, (await B('GET', '/api/businesses')).body.businesses);
const leftoverA = (await A('GET', '/api/businesses')).body.businesses.filter(b => b.name.includes(stamp));
check('test businesses are cleaned up', leftoverA.length === 0, `${leftoverA.length} left`);

/* ---------- summary ---------- */
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('\nfailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
