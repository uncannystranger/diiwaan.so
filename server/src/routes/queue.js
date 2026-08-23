/* Queue and ticket operations for the desk. Mounted under
   /api/businesses/:businessId/queue — mergeParams keeps the tenant in scope. */

import { Router } from 'express';
import { requireUser, requireBusiness } from '../middleware/auth.js';
import { parse, joinSchema } from '../lib/validate.js';
import { HttpError } from '../lib/errors.js';
import * as queueService from '../services/queue.js';

const router = Router({ mergeParams: true });

const withQueue = async (req, res, next) => {
  try {
    req.queue = await queueService.getQueue(req.business._id, req.query.queueId);
    next();
  } catch (error) { next(error); }
};

const staff = [requireUser, requireBusiness('staff'), withQueue];
const actor = req => req.user.id;

router.get('/', ...staff, async (req, res, next) => {
  try {
    res.json(await queueService.snapshot(req.business, req.queue));
  } catch (error) { next(error); }
});

router.post('/next', ...staff, async (req, res, next) => {
  try {
    const { ticket, queue } = await queueService.callNext(req.business, req.queue, { actorId: actor(req) });
    res.json({
      ticket: queueService.publicTicket(ticket),
      snapshot: await queueService.snapshot(req.business, queue)
    });
  } catch (error) { next(error); }
});

router.post('/recall', ...staff, async (req, res, next) => {
  try {
    const ticket = await queueService.recall(req.business, req.queue, { actorId: actor(req) });
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

router.post('/status', ...staff, async (req, res, next) => {
  try {
    if (req.membership.role === 'staff' && req.body.status === 'closed') {
      throw new HttpError(403, 'Only a manager can close the queue.');
    }
    const queue = await queueService.setStatus(req.business, req.queue, req.body.status, { actorId: actor(req) });
    res.json({ snapshot: await queueService.snapshot(req.business, queue) });
  } catch (error) { next(error); }
});

router.patch('/', ...staff, async (req, res, next) => {
  try {
    if (req.membership.role === 'staff') throw new HttpError(403, 'Your role does not allow that.');
    const queue = await queueService.updateQueue(req.business, req.queue, req.body);
    res.json({ snapshot: await queueService.snapshot(req.business, queue) });
  } catch (error) { next(error); }
});

/* ---------- tickets ---------- */

router.post('/tickets', ...staff, async (req, res, next) => {
  try {
    const input = parse(joinSchema, req.body);
    const ticket = await queueService.addTicket(req.business, req.queue, {
      ...input, source: 'desk', actorId: actor(req)
    });
    res.status(201).json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

/** Calls one waiting customer out of order, and notifies their device. */
router.post('/tickets/:ticketId/call', ...staff, async (req, res, next) => {
  try {
    const { ticket, queue } = await queueService.callTicket(req.business, req.queue, req.params.ticketId, { actorId: actor(req) });
    res.json({
      ticket: queueService.publicTicket(ticket),
      snapshot: await queueService.snapshot(req.business, queue)
    });
  } catch (error) { next(error); }
});

router.post('/tickets/:ticketId/serving', ...staff, async (req, res, next) => {
  try {
    const ticket = await queueService.startServing(req.business, req.queue, req.params.ticketId, { actorId: actor(req) });
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

router.post('/tickets/:ticketId/skip', ...staff, async (req, res, next) => {
  try {
    const ticket = await queueService.skipToEnd(req.business, req.queue, req.params.ticketId, { actorId: actor(req) });
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

router.post('/tickets/:ticketId/move', ...staff, async (req, res, next) => {
  try {
    const direction = ['up', 'down', 'front'].includes(req.body.direction) ? req.body.direction : 'up';
    const ticket = await queueService.move(req.business, req.queue, req.params.ticketId, direction, { actorId: actor(req) });
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

router.post('/tickets/:ticketId/service', ...staff, async (req, res, next) => {
  try {
    const ticket = await queueService.assignService(
      req.business, req.queue, req.params.ticketId, req.body.serviceId || null, { actorId: actor(req) }
    );
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

/** status: completed | skipped | no_show | cancelled */
router.post('/tickets/:ticketId/close', ...staff, async (req, res, next) => {
  try {
    const ticket = await queueService.closeTicket(
      req.business, req.queue, req.params.ticketId, req.body.status || 'completed', { actorId: actor(req) }
    );
    res.json({ ticket: queueService.publicTicket(ticket) });
  } catch (error) { next(error); }
});

export default router;
