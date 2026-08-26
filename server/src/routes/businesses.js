/* Owner console API. Every route below resolves the tenant through
   requireBusiness(), which only ever returns businesses the caller belongs to. */

import { Router } from 'express';
import { ObjectId } from 'mongodb';
import { col, collections } from '../db.js';
import { requireUser, requireBusiness, withProfile, listBusinessesFor } from '../middleware/auth.js';
import { HttpError } from '../lib/errors.js';
import {
  parse, businessCreateSchema, businessUpdateSchema, brandingSchema,
  experienceSchema, qrSchema, serviceSchema, memberInviteSchema, slugify, slugSchema
} from '../lib/validate.js';
import { DEFAULT_BRANDING, DEFAULT_CUSTOMER_EXPERIENCE, DEFAULT_QR, DEFAULT_QUEUE_SETTINGS } from '../lib/defaults.js';
import { config } from '../config.js';

/* A logo URL arrives from the browser after it uploads. Accept only paths this
   app serves itself: an arbitrary URL here would let anyone point a business's
   logo at an offsite tracker that every customer of that queue would then load.
   Anchored at the start and with no '//' allowed, so '/api/branding/../..' or a
   protocol-relative '//evil.example' cannot slip through. */
const STORAGE_PREFIX = '/api/branding/';
const assertOwnStorage = url => {
  const ok = !url
    || (url.startsWith(STORAGE_PREFIX) && !url.includes('..') && !url.slice(1).includes('//'));
  if (!ok) throw new HttpError(422, 'Images must be uploaded through Diiwaan.');
};
import * as queueService from '../services/queue.js';
import * as analytics from '../services/analytics.js';
import { subscribe, publish } from '../services/realtime.js';
import { streamReport } from '../services/report.js';
import queueRoutes from './queue.js';

const router = Router();

const shape = (business, role) => ({
  id: String(business._id),
  role,
  name: business.name,
  slug: business.slug,
  category: business.category || '',
  description: business.description || '',
  logo: business.logo || '',
  phone: business.phone || '',
  email: business.email || '',
  address: business.address || '',
  city: business.city || '',
  country: business.country || '',
  timezone: business.timezone || '',
  branding: { ...DEFAULT_BRANDING, ...(business.branding || {}) },
  customerExperience: { ...DEFAULT_CUSTOMER_EXPERIENCE, ...(business.customerExperience || {}) },
  qrSettings: { ...DEFAULT_QR, ...(business.qrSettings || {}) },
  queueSettings: { ...DEFAULT_QUEUE_SETTINGS, ...(business.queueSettings || {}) },
  onboarded: Boolean(business.onboarded),
  joinUrl: `/j/${business.slug}`,
  createdAt: business.createdAt
});

async function uniqueSlug(candidate) {
  const base = slugify(candidate);
  let slug = base;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await col(collections.businesses).findOne({ slug })) slug = `${base}-${++n}`;
  return slug;
}

/* ---------- collection ---------- */

/* withProfile is what resolves the linked identities this listing matches on. */
router.get('/', requireUser, withProfile, async (req, res, next) => {
  try {
    const businesses = await listBusinessesFor(req.authIds || [req.user.id]);
    res.json({ businesses: businesses.map(b => shape(b, b.role)) });
  } catch (error) { next(error); }
});

router.post('/', requireUser, async (req, res, next) => {
  try {
    const input = parse(businessCreateSchema, req.body);
    const now = new Date();
    const business = {
      ownerId: req.user.id,
      name: input.name,
      slug: await uniqueSlug(input.slug || input.name),
      category: input.category,
      description: input.description,
      logo: '',
      phone: input.phone,
      email: input.email || req.user.email,
      address: input.address,
      city: input.city,
      country: input.country,
      timezone: input.timezone,
      branding: { ...DEFAULT_BRANDING },
      customerExperience: { ...DEFAULT_CUSTOMER_EXPERIENCE },
      qrSettings: { ...DEFAULT_QR },
      queueSettings: { ...DEFAULT_QUEUE_SETTINGS },
      onboarded: false,
      createdAt: now,
      updatedAt: now
    };
    const { insertedId } = await col(collections.businesses).insertOne(business);

    await col(collections.members).insertOne({
      businessId: insertedId,
      userId: req.user.id,
      email: req.user.email,
      name: req.profile?.name || '',
      role: 'owner',
      status: 'active',
      serviceIds: [],
      lastActiveAt: now,
      createdAt: now,
      updatedAt: now
    });

    await queueService.createQueue(insertedId, business.queueSettings);
    await analytics.audit({
      businessId: insertedId, actorId: req.user.id, action: 'business.created',
      ip: req.ip, data: { slug: business.slug }
    });

    res.status(201).json({ business: shape({ ...business, _id: insertedId }, 'owner') });
  } catch (error) { next(error); }
});

router.get('/slug-available/:slug', requireUser, async (req, res, next) => {
  try {
    const slug = parse(slugSchema, req.params.slug);
    const taken = await col(collections.businesses).findOne({ slug });
    res.json({ slug, available: !taken });
  } catch (error) { next(error); }
});

/* ---------- one business ---------- */

router.get('/:businessId', requireUser, requireBusiness('staff'), async (req, res) => {
  res.json({ business: shape(req.business, req.membership.role) });
});

router.patch('/:businessId', requireUser, requireBusiness('manager'), async (req, res, next) => {
  try {
    const input = parse(businessUpdateSchema, req.body);
    if (input.logo !== undefined) assertOwnStorage(input.logo);
    const update = { ...input, updatedAt: new Date() };
    if (input.queueSettings) {
      update.queueSettings = { ...DEFAULT_QUEUE_SETTINGS, ...(req.business.queueSettings || {}), ...input.queueSettings };
    }

    if (input.slug && input.slug !== req.business.slug) {
      const taken = await col(collections.businesses).findOne({ slug: input.slug, _id: { $ne: req.business._id } });
      if (taken) throw new HttpError(409, 'That link is already taken.');
      await analytics.audit({
        businessId: req.business._id, actorId: req.user.id, action: 'business.slug_changed',
        ip: req.ip, data: { from: req.business.slug, to: input.slug }
      });
    }

    const business = await col(collections.businesses).findOneAndUpdate(
      { _id: req.business._id },
      { $set: update },
      { returnDocument: 'after' }
    );
    // Customer pages are open right now; tell them their host changed.
    publish(business._id, 'business.updated', { slug: business.slug });
    res.json({ business: shape(business, req.membership.role) });
  } catch (error) { next(error); }
});

/** Deleting a business takes its queue, tickets, services and team with it. */
router.delete('/:businessId', requireUser, requireBusiness('owner'), async (req, res, next) => {
  try {
    const businessId = req.business._id;
    await Promise.all([
      col(collections.tickets).deleteMany({ businessId }),
      col(collections.queues).deleteMany({ businessId }),
      col(collections.services).deleteMany({ businessId }),
      col(collections.members).deleteMany({ businessId }),
      col(collections.invitations).deleteMany({ businessId }),
      col(collections.events).deleteMany({ businessId })
    ]);
    await col(collections.businesses).deleteOne({ _id: businessId });
    await analytics.audit({
      businessId: null, actorId: req.user.id, action: 'business.deleted', ip: req.ip,
      data: { slug: req.business.slug, name: req.business.name }
    });
    publish(businessId, 'business.deleted', {});
    res.status(204).end();
  } catch (error) { next(error); }
});

router.post('/:businessId/onboarded', requireUser, requireBusiness('owner'), async (req, res, next) => {
  try {
    const business = await col(collections.businesses).findOneAndUpdate(
      { _id: req.business._id },
      { $set: { onboarded: true, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    res.json({ business: shape(business, req.membership.role) });
  } catch (error) { next(error); }
});

const patchSection = (field, schema, defaults, role = 'manager') => async (req, res, next) => {
  try {
    const input = parse(schema, req.body);
    if (input.logo !== undefined) assertOwnStorage(input.logo);
    if (input.favicon !== undefined) assertOwnStorage(input.favicon);
    const merged = { ...defaults, ...(req.business[field] || {}), ...input };
    const business = await col(collections.businesses).findOneAndUpdate(
      { _id: req.business._id },
      { $set: { [field]: merged, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    await analytics.audit({
      businessId: req.business._id, actorId: req.user.id, action: `business.${field}_updated`, ip: req.ip
    });
    publish(business._id, 'business.updated', { section: field });
    res.json({ business: shape(business, req.membership.role) });
  } catch (error) { next(error); }
};

router.patch('/:businessId/branding', requireUser, requireBusiness('manager'),
  patchSection('branding', brandingSchema, DEFAULT_BRANDING));

router.patch('/:businessId/customer-experience', requireUser, requireBusiness('manager'),
  patchSection('customerExperience', experienceSchema, DEFAULT_CUSTOMER_EXPERIENCE));

router.patch('/:businessId/qr', requireUser, requireBusiness('manager'),
  patchSection('qrSettings', qrSchema, DEFAULT_QR));

/* ---------- services ---------- */

router.get('/:businessId/services', requireUser, requireBusiness('staff'), async (req, res, next) => {
  try {
    const services = await col(collections.services)
      .find({ businessId: req.business._id })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({ services: services.map(s => ({ ...s, id: String(s._id) })) });
  } catch (error) { next(error); }
});

router.post('/:businessId/services', requireUser, requireBusiness('manager'), async (req, res, next) => {
  try {
    const input = parse(serviceSchema, req.body);
    const now = new Date();
    const doc = { ...input, businessId: req.business._id, createdAt: now, updatedAt: now };
    try {
      const { insertedId } = await col(collections.services).insertOne(doc);
      res.status(201).json({ service: { ...doc, id: String(insertedId), _id: insertedId } });
    } catch (error) {
      if (error.code === 11000) throw new HttpError(409, 'You already offer a service with that name.');
      throw error;
    }
  } catch (error) { next(error); }
});

router.patch('/:businessId/services/:serviceId', requireUser, requireBusiness('manager'), async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.serviceId)) throw new HttpError(404, 'Service not found.');
    const input = parse(serviceSchema.partial(), req.body);
    const service = await col(collections.services).findOneAndUpdate(
      { _id: new ObjectId(req.params.serviceId), businessId: req.business._id },
      { $set: { ...input, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!service) throw new HttpError(404, 'Service not found.');
    res.json({ service: { ...service, id: String(service._id) } });
  } catch (error) { next(error); }
});

router.delete('/:businessId/services/:serviceId', requireUser, requireBusiness('manager'), async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.serviceId)) throw new HttpError(404, 'Service not found.');
    const { deletedCount } = await col(collections.services).deleteOne({
      _id: new ObjectId(req.params.serviceId),
      businessId: req.business._id
    });
    if (!deletedCount) throw new HttpError(404, 'Service not found.');
    res.status(204).end();
  } catch (error) { next(error); }
});

/* ---------- members ---------- */

router.get('/:businessId/members', requireUser, requireBusiness('staff'), async (req, res, next) => {
  try {
    const members = await col(collections.members)
      .find({ businessId: req.business._id })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({
      members: members.map(m => ({
        id: String(m._id),
        email: m.email,
        name: m.name,
        role: m.role,
        status: m.status,
        serviceIds: (m.serviceIds || []).map(String),
        lastActiveAt: m.lastActiveAt,
        isYou: m.userId === req.user.id
      }))
    });
  } catch (error) { next(error); }
});

router.post('/:businessId/members', requireUser, requireBusiness('owner'), async (req, res, next) => {
  try {
    const input = parse(memberInviteSchema, req.body);
    const email = input.email.toLowerCase();
    const existing = await col(collections.members).findOne({ businessId: req.business._id, email });
    if (existing) throw new HttpError(409, 'That person is already on your team.');

    const now = new Date();
    const token = crypto.randomUUID();
    const member = {
      businessId: req.business._id,
      // No userId until the invited person signs in with this address.
      email,
      name: input.name,
      role: input.role,
      status: 'invited',
      serviceIds: input.serviceIds.filter(ObjectId.isValid).map(id => new ObjectId(id)),
      lastActiveAt: null,
      createdAt: now,
      updatedAt: now
    };
    const { insertedId } = await col(collections.members).insertOne(member);
    await col(collections.invitations).insertOne({
      businessId: req.business._id, email, role: input.role, token, acceptedAt: null, createdAt: now
    });
    await analytics.audit({
      businessId: req.business._id, actorId: req.user.id, action: 'member.invited', ip: req.ip, data: { email }
    });

    res.status(201).json({
      member: { id: String(insertedId), email, name: input.name, role: input.role, status: 'invited' },
      // The invited person signs up with this email; the code links their account on first sign-in.
      inviteToken: token
    });
  } catch (error) { next(error); }
});

router.patch('/:businessId/members/:memberId', requireUser, requireBusiness('owner'), async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.memberId)) throw new HttpError(404, 'Team member not found.');
    const patch = {};
    if (req.body.role && ['manager', 'staff'].includes(req.body.role)) patch.role = req.body.role;
    if (req.body.status && ['active', 'disabled'].includes(req.body.status)) patch.status = req.body.status;
    if (Array.isArray(req.body.serviceIds)) {
      patch.serviceIds = req.body.serviceIds.filter(ObjectId.isValid).map(id => new ObjectId(id));
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'Nothing to change.');

    const member = await col(collections.members).findOneAndUpdate(
      { _id: new ObjectId(req.params.memberId), businessId: req.business._id, role: { $ne: 'owner' } },
      { $set: { ...patch, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!member) throw new HttpError(404, 'Team member not found.');
    res.json({ member: { ...member, id: String(member._id) } });
  } catch (error) { next(error); }
});

router.delete('/:businessId/members/:memberId', requireUser, requireBusiness('owner'), async (req, res, next) => {
  try {
    if (!ObjectId.isValid(req.params.memberId)) throw new HttpError(404, 'Team member not found.');
    const { deletedCount } = await col(collections.members).deleteOne({
      _id: new ObjectId(req.params.memberId),
      businessId: req.business._id,
      role: { $ne: 'owner' }
    });
    if (!deletedCount) throw new HttpError(404, 'Team member not found.');
    await analytics.audit({
      businessId: req.business._id, actorId: req.user.id, action: 'member.removed', ip: req.ip
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

/* ---------- analytics ---------- */

router.get('/:businessId/analytics', requireUser, requireBusiness('staff'), async (req, res, next) => {
  try {
    const days = Math.min(30, Math.max(0, Number(req.query.days) || 0));
    const since = days
      ? new Date(Date.now() - days * 24 * 3600 * 1000)
      : new Date(new Date().setHours(0, 0, 0, 0));
    const [summary, activity] = await Promise.all([
      analytics.summary(req.business._id, { since, timezone: req.business.timezone || 'UTC' }),
      analytics.activity(req.business._id, Number(req.query.activity) || 12)
    ]);
    res.json({ summary, activity });
  } catch (error) { next(error); }
});

/** A branded PDF of this business's queue activity. Manager and above. */
router.get('/:businessId/report.pdf', requireUser, withProfile, requireBusiness('manager'), async (req, res, next) => {
  try {
    const period = ['today', 'week', 'month'].includes(req.query.period) ? req.query.period : 'today';
    const filename = `${req.business.slug}-queue-report-${period}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    await analytics.audit({
      businessId: req.business._id, actorId: req.user.id, action: 'report.downloaded', ip: req.ip, data: { period }
    });
    await streamReport(req.business, { period, generatedBy: req.profile?.name || req.user.email }, res);
  } catch (error) { next(error); }
});

/* ---------- realtime ---------- */

router.get('/:businessId/stream', requireUser, requireBusiness('staff'), (req, res) => {
  subscribe(res, req.business._id, {
    lastEventId: req.get('last-event-id') || req.query.lastEventId || 0
  });
});

/* ---------- queue ---------- */

/* One mount, deliberately.
 *
 * This router was also mounted at /:businessId/tickets, which gave every queue
 * operation a second URL — and a misleading one. PATCH .../tickets edited queue
 * settings, POST .../tickets/status closed the queue, and POST
 * .../tickets/tickets created a ticket, all working exactly as the /queue paths
 * did. Authorisation held on both, so nothing was exposed, but it doubled the
 * live surface, none of it was documented, and nothing called it: the frontend
 * has only ever used /queue.
 *
 * A second way in that nobody uses is a second way in that nobody watches. */
router.use('/:businessId/queue', queueRoutes);

export default router;
