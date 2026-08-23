#!/usr/bin/env node
/* Development seed data — never imported by the running server.

   Creates two businesses with queues, services and a few waiting customers so
   the console has something to show while you work.

   Each argument is the owner of one seeded business: either a Supabase user id
   (always works) or an email address (needs SUPABASE_SERVICE_ROLE_KEY so the id
   can be looked up).

   Usage:
     npm run seed -- 5f3c…-uuid another-uuid
     npm run seed -- owner-a@example.com
*/

import { connect, disconnect, col, collections } from '../src/db.js';
import { config } from '../src/config.js';
import { DEFAULT_BRANDING, DEFAULT_CUSTOMER_EXPERIENCE, DEFAULT_QR, DEFAULT_QUEUE_SETTINGS } from '../src/lib/defaults.js';
import * as queueService from '../src/services/queue.js';
import { record, EVENTS } from '../src/services/analytics.js';

if (config.env === 'production') {
  console.error('Refusing to seed a production database.');
  process.exit(1);
}

const owners = (process.argv.slice(2).length
  ? process.argv.slice(2)
  : (process.env.SEED_OWNER_EMAILS || '').split(',')
).map(value => value.trim().toLowerCase()).filter(Boolean);

if (!owners.length) {
  console.error('Give me at least one owner: npm run seed -- <supabase-user-id|email>');
  process.exit(1);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolves an owner argument to a Supabase user id. */
async function supabaseUserId(email) {
  if (UUID.test(email)) return email;
  if (!config.supabase.serviceRoleKey) {
    console.warn(`  ! no SUPABASE_SERVICE_ROLE_KEY — cannot look up ${email}; pass the Supabase user id instead`);
    return `seed-${email}`;
  }
  const response = await fetch(
    `${config.supabase.url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: { apikey: config.supabase.serviceRoleKey, Authorization: `Bearer ${config.supabase.serviceRoleKey}` } }
  );
  if (!response.ok) return `seed-${email}`;
  const { users = [] } = await response.json();
  return users.find(user => user.email?.toLowerCase() === email)?.id || `seed-${email}`;
}

const TEMPLATES = [
  {
    name: 'Hodan Medical Clinic',
    slug: 'hodan-clinic',
    city: 'KM4 · Mogadishu',
    category: 'Clinic',
    description: 'Walk in, take a number, sit anywhere.',
    prefix: 'A',
    avgServiceMin: 6,
    branding: { primary: '#D68C45', emphasis: '#2C6E49', tint: '#FFC9B9' },
    services: [['Consultation', 12], ['Lab', 8]],
    waiting: [
      ['Amina Yusuf', 'Consultation', '61 442 118'],
      ['Cabdi Nuur', 'Lab', ''],
      ['Ilhan Maxamed', 'Consultation', '61 903 774'],
      ['Faarax Warsame', 'Consultation', ''],
      ['Sagal Aden', 'Lab', '63 210 887']
    ]
  },
  {
    name: 'Sahra Pharmacy',
    slug: 'sahra-pharmacy',
    city: 'Wadajir · Mogadishu',
    category: 'Pharmacy',
    description: 'Prescriptions and advice without the crowd.',
    prefix: 'S',
    avgServiceMin: 4,
    branding: { primary: '#5B8C2A', emphasis: '#28401A', tint: '#DCEBBF' },
    services: [['Prescription', 5], ['Advice', 6]],
    waiting: [
      ['Deeqa Jibril', 'Prescription', ''],
      ['Yuusuf Hersi', 'Advice', '68 114 559']
    ]
  }
];

await connect();

for (const [index, owner] of owners.entries()) {
  const template = TEMPLATES[index % TEMPLATES.length];
  const ownerId = await supabaseUserId(owner);
  const email = UUID.test(owner) ? '' : owner;
  const now = new Date();

  await col(collections.businesses).deleteMany({ slug: template.slug });

  const business = {
    ownerId,
    name: template.name,
    slug: template.slug,
    category: template.category,
    description: template.description,
    logo: '',
    phone: '',
    email,
    address: '',
    city: template.city,
    country: 'Somalia',
    timezone: 'Africa/Mogadishu',
    branding: { ...DEFAULT_BRANDING, ...template.branding },
    customerExperience: { ...DEFAULT_CUSTOMER_EXPERIENCE },
    qrSettings: { ...DEFAULT_QR },
    queueSettings: { ...DEFAULT_QUEUE_SETTINGS, prefix: template.prefix, avgServiceMin: template.avgServiceMin },
    onboarded: true,
    createdAt: now,
    updatedAt: now
  };
  const { insertedId: businessId } = await col(collections.businesses).insertOne(business);

  await col(collections.members).deleteMany({ businessId });
  await col(collections.members).insertOne({
    businessId, userId: ownerId, email: email || `${ownerId}@seed.local`, name: '', role: 'owner', status: 'active',
    serviceIds: [], lastActiveAt: now, createdAt: now, updatedAt: now
  });

  const serviceIds = [];
  for (const [name, minutes] of template.services) {
    const { insertedId } = await col(collections.services).insertOne({
      businessId, name, description: '', estimatedDuration: minutes, color: '', active: true,
      createdAt: now, updatedAt: now
    });
    serviceIds.push({ id: insertedId, name });
  }

  const queue = await queueService.createQueue(businessId, {
    name: 'Main queue', prefix: template.prefix, avgServiceMin: template.avgServiceMin
  });
  const fullBusiness = { ...business, _id: businessId };

  for (const [name, serviceName, phone] of template.waiting) {
    const service = serviceIds.find(s => s.name === serviceName);
    await queueService.addTicket(fullBusiness, await queueService.getQueue(businessId), {
      name, phone, serviceId: service ? String(service.id) : null, source: 'desk', actorId: ownerId
    });
  }

  // One completed customer so the dashboard has a number to show.
  const { ticket } = await queueService.callNext(fullBusiness, await queueService.getQueue(businessId), { actorId: ownerId });
  await queueService.closeTicket(fullBusiness, await queueService.getQueue(businessId), ticket._id, 'completed', { actorId: ownerId });
  await record(EVENTS.queueOpened, { businessId, queueId: queue._id, actorId: ownerId });

  console.log(`seeded ${template.name} → /j/${template.slug} for ${email || ownerId}`);
}

await disconnect();
console.log('done');
