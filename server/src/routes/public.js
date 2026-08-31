/* The customer side. No account, no session cookie — a ticket is identified by
   an unguessable token held on the device, and nothing here ever returns another
   customer's name, phone or the business's internal data. */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { col, collections } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { parse, joinSchema } from '../lib/validate.js';
import { DEFAULT_BRANDING, DEFAULT_CUSTOMER_EXPERIENCE, DEFAULT_QR } from '../lib/defaults.js';
import * as queueService from '../services/queue.js';
import { record, EVENTS } from '../services/analytics.js';
import { subscribe } from '../services/realtime.js';
import { saveSubscription, pushEnabled, publicKey } from '../services/push.js';

const router = Router();

/* A whole waiting room can share one NAT address, so the join limit has to be
   generous enough for a genuine rush while still stopping a script. */
const joinLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.JOIN_RATE_LIMIT || (process.env.NODE_ENV === 'production' ? 20 : 200)),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'That is a lot of joining from this connection. Try again in a minute.' }
});

// Leaving is cheap to automate and destructive, so it gets its own budget.
const leaveLimiter = rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'production' ? 20 : 200, standardHeaders: 'draft-7', legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false });

/** Query and body values are attacker-shaped until proven otherwise. */
const asToken = value => (typeof value === 'string' ? value : '');

async function loadTenant(req) {
  const business = await col(collections.businesses).findOne({ slug: String(req.params.slug).toLowerCase() });
  if (!business) throw new HttpError(404, 'We could not find that queue.');
  const queue = await queueService.getQueue(business._id);
  return { business, queue };
}

const publicBusiness = business => ({
  /* The stable identity behind the slug. A slug can be given up by one business
     and taken by another later, and a device that scanned the first still holds
     everything it cached under that name — so the browser needs something that
     does not move to tell the two apart. Not a secret: it is already the id in
     every QR-reachable URL a member of that business uses. */
  id: String(business._id),
  name: business.name,
  slug: business.slug,
  city: business.city || '',
  address: business.address || '',
  phone: business.phone || '',
  logo: business.logo || business.branding?.logo || '',
  description: business.description || '',
  branding: { ...DEFAULT_BRANDING, ...(business.branding || {}) },
  experience: { ...DEFAULT_CUSTOMER_EXPERIENCE, ...(business.customerExperience || {}) },
  qr: { ...DEFAULT_QR, ...(business.qrSettings || {}) }
});

/** What a customer's device sees: the business, the queue state, and their own ticket. */
async function customerView(business, queue, token) {
  const [waitingCount, serving] = await Promise.all([
    col(collections.tickets).countDocuments({ queueId: queue._id, status: 'waiting' }),
    queue.servingTicketId
      // Scoped to the business as well: the id is server-derived today, and this
      // keeps it safe if the helper is ever reused with an untrusted one.
      ? col(collections.tickets).findOne({ _id: queue.servingTicketId, businessId: business._id })
      : null
  ]);

  const mine = token ? await queueService.ticketBySession(business._id, token) : null;
  const ahead = mine ? await queueService.positionOf(mine) : 0;
  const services = await col(collections.services)
    .find({ businessId: business._id, active: { $ne: false } })
    .sort({ createdAt: 1 })
    .toArray();

  return {
    business: publicBusiness(business),
    push: { enabled: pushEnabled(), publicKey: publicKey() },
    queue: {
      status: queue.status,
      prefix: queue.prefix,
      avgServiceMin: queue.avgServiceMin,
      nextLabel: queueService.ticketLabel(queue, queue.nextNumber),
      version: queue.version
    },
    services: services.map(s => ({ id: String(s._id), name: s.name, estimatedDuration: s.estimatedDuration })),
    serving: serving ? { label: serving.label, status: serving.status } : null,
    waitingCount,
    estimateMin: waitingCount * queue.avgServiceMin,
    ticket: mine
      ? {
        id: String(mine._id),
        label: mine.label,
        status: mine.status,
        service: mine.serviceName || '',
        ahead,
        estimateMin: ahead * queue.avgServiceMin,
        joinedAt: mine.createdAt,
        calledAt: mine.calledAt,
        aheadAtJoin: mine.aheadAtJoin ?? null
      }
      : null
    // Deliberately no timestamp: an unchanged queue must serialise identically
    // so the ETag can answer a rush of scans with 304s. The device stamps its
    // own receipt time for the "last updated" line.
  };
}

router.get('/:slug', readLimiter, async (req, res, next) => {
  try {
    const { business, queue } = await loadTenant(req);
    /* Header first. The query parameter is still read so a page loaded from the
       previous release keeps its ticket across the deploy; it can go once no
       such tab is left. */
    const ticketToken = asToken(req.get('x-diiwaan-ticket') || req.query.token);
    if (ticketToken) res.setHeader('Cache-Control', 'private, no-store');
    res.json(await customerView(business, queue, ticketToken));
  } catch (error) { next(error); }
});

router.post('/:slug/join', joinLimiter, async (req, res, next) => {
  try {
    const { business, queue } = await loadTenant(req);
    const experience = { ...DEFAULT_CUSTOMER_EXPERIENCE, ...(business.customerExperience || {}) };
    const input = parse(joinSchema, req.body);

    /* Bot checks come before anything is written. The reply is deliberately the
       same shape a real refusal takes, so a script learns nothing about which
       check caught it. */
    const tooFast = input.elapsed > 0 && input.elapsed < 900;
    if (input.company || tooFast) {
      throw new HttpError(429, 'That did not go through. Please try again.');
    }

    if (experience.requirePhone && !input.phone) {
      throw new HttpError(422, 'A phone number is needed so we can call you.', [
        { field: 'phone', message: 'Please add a phone number.' }
      ]);
    }

    const aheadAtJoin = await col(collections.tickets).countDocuments({ queueId: queue._id, status: 'waiting' });
    const ticket = await queueService.addTicket(business, queue, { ...input, source: 'public' });
    await col(collections.tickets).updateOne({ _id: ticket._id }, { $set: { aheadAtJoin } });

    res.status(201).json({
      token: ticket.sessionToken,
      view: await customerView(business, queue, ticket.sessionToken)
    });
  } catch (error) { next(error); }
});

router.post('/:slug/leave', leaveLimiter, async (req, res, next) => {
  try {
    const { business, queue } = await loadTenant(req);
    const mine = await queueService.ticketBySession(business._id, asToken(req.body.token));
    if (!mine) throw new HttpError(404, 'We could not find your ticket.');
    if (queueService.OPEN_STATUSES.includes(mine.status)) {
      await col(collections.tickets).updateOne(
        { _id: mine._id, status: { $in: queueService.OPEN_STATUSES } },
        { $set: { status: 'cancelled', completedAt: new Date(), updatedAt: new Date() } }
      );
      await record(EVENTS.ticketRemoved, {
        businessId: business._id, queueId: queue._id, ticketId: mine._id, data: { byCustomer: true }
      });
    }
    res.json({ view: await customerView(business, queue, null) });
  } catch (error) { next(error); }
});

/** W-2 Escalation Ladder: Customer replies with "Coming now" or "Two minutes" */
router.post('/:slug/reply', readLimiter, async (req, res, next) => {
  try {
    const { business, queue } = await loadTenant(req);
    const mine = await queueService.ticketBySession(business._id, asToken(req.body.token));
    if (!mine) throw new HttpError(404, 'We could not find your ticket.');
    const reply = req.body.reply === 'two_minutes' ? 'two_minutes' : 'coming_now';
    await col(collections.tickets).updateOne(
      { _id: mine._id },
      { $set: { customerReply: reply, updatedAt: new Date() } }
    );
    res.json({ ok: true, reply, view: await customerView(business, queue, mine.sessionToken) });
  } catch (error) { next(error); }
});

/** W-3 One-Tap Verdict: Customer records feedback on completed visit */
router.post('/:slug/verdict', readLimiter, async (req, res, next) => {
  try {
    const { business, queue } = await loadTenant(req);
    const mine = await queueService.ticketBySession(business._id, asToken(req.body.token));
    if (!mine) throw new HttpError(404, 'We could not find your ticket.');
    const score = ['good', 'okay', 'bad'].includes(req.body.score) ? req.body.score : 'good';
    const tag = ['fast', 'friendly', 'long_wait'].includes(req.body.tag) ? req.body.tag : null;
    await col(collections.tickets).updateOne(
      { _id: mine._id },
      { $set: { verdict: { score, tag, at: new Date() }, updatedAt: new Date() } }
    );
    res.json({ ok: true });
  } catch (error) { next(error); }
});

/** Live updates for the customer's ticket — redacted to queue-level facts. */
/** A customer's device asks to be told when its own number comes up. */
router.post('/:slug/notify', readLimiter, async (req, res, next) => {
  try {
    const { business } = await loadTenant(req);
    if (!pushEnabled()) return res.json({ enabled: false, publicKey: '' });

    const mine = await queueService.ticketBySession(business._id, asToken(req.body.token));
    if (!mine) throw new HttpError(404, 'We could not find your ticket.');

    const saved = await saveSubscription({
      businessId: business._id,
      ticketId: mine._id,
      subscription: req.body.subscription
    });
    res.json({ enabled: saved, publicKey: publicKey() });
  } catch (error) { next(error); }
});

router.get('/:slug/stream', async (req, res, next) => {
  try {
    const { business } = await loadTenant(req);
    subscribe(res, business._id, {
      lastEventId: req.get('last-event-id') || 0,
      shape: event => ({
        id: event.id,
        type: event.type,
        at: event.at,
        data: {
          version: event.data.version,
          status: event.data.status,
          section: event.data.section,
          serving: event.data.serving ? { label: event.data.serving.label } : undefined
        }
      })
    });
  } catch (error) { next(error); }
});

export default router;
