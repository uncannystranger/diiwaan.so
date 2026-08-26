/* Queue operations.

   Every state change is a single-document atomic update with a status guard, so
   two staff pressing NEXT at the same moment claim two different tickets rather
   than both calling the same person. Ticket ordering uses a float `position`
   which makes "move forward / backward" a one-document write instead of a
   renumbering pass. */

import { ObjectId } from 'mongodb';
import { col, collections } from '../db.js';
import { HttpError } from '../lib/errors.js';
import { publish } from './realtime.js';
import { record, EVENTS } from './analytics.js';
import { notifyTicket, dropSubscription } from './push.js';
import { sealField, openField } from '../lib/secrets.js';

const tickets = () => col(collections.tickets);
const queues = () => col(collections.queues);

export const OPEN_STATUSES = ['waiting', 'called', 'serving'];

export const ticketLabel = (queue, number) => `${queue.prefix || 'A'}-${number}`;

export async function getQueue(businessId, queueId) {
  if (queueId && !ObjectId.isValid(queueId)) throw new HttpError(404, 'That queue does not exist.');
  const query = queueId
    ? { _id: new ObjectId(queueId), businessId }
    : { businessId };
  const queue = await queues().findOne(query, { sort: { createdAt: 1 } });
  if (!queue) throw new HttpError(404, 'This business has no queue yet.');
  return queue;
}

export async function createQueue(businessId, { name = 'Main queue', prefix = 'A', avgServiceMin = 5 }) {
  const now = new Date();
  const doc = {
    businessId,
    name,
    prefix,
    status: 'open',
    avgServiceMin: Math.max(1, Math.min(240, Number(avgServiceMin) || 5)),
    nextNumber: 1,
    servingTicketId: null,
    openedAt: now,
    closedAt: null,
    version: 0,
    createdAt: now,
    updatedAt: now
  };
  const { insertedId } = await queues().insertOne(doc);
  return { ...doc, _id: insertedId };
}

async function bumpQueue(queueId, update = {}) {
  const result = await queues().findOneAndUpdate(
    { _id: queueId },
    { ...update, $inc: { ...(update.$inc || {}), version: 1 }, $set: { ...(update.$set || {}), updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  return result;
}

/** Waiting list in serving order, plus whoever is called or being served. */
export async function snapshot(business, queue) {
  const [waiting, active, servedToday] = await Promise.all([
    tickets().find({ queueId: queue._id, status: 'waiting' }).sort({ position: 1 }).limit(200).toArray(),
    tickets().find({ queueId: queue._id, status: { $in: ['called', 'serving'] } }).sort({ calledAt: -1 }).toArray(),
    tickets().countDocuments({
      queueId: queue._id,
      status: 'completed',
      completedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) }
    })
  ]);

  const serving = active.find(t => String(t._id) === String(queue.servingTicketId)) || active[0] || null;

  return {
    business: {
      id: String(business._id),
      name: business.name,
      slug: business.slug,
      city: business.city,
      logo: business.logo,
      branding: business.branding,
      customerExperience: business.customerExperience,
      qrSettings: business.qrSettings
    },
    queue: {
      id: String(queue._id),
      name: queue.name,
      prefix: queue.prefix,
      status: queue.status,
      avgServiceMin: queue.avgServiceMin,
      nextNumber: queue.nextNumber,
      nextLabel: ticketLabel(queue, queue.nextNumber),
      version: queue.version
    },
    serving: serving ? publicTicket(serving) : null,
    waiting: waiting.map(publicTicket),
    counts: { waiting: waiting.length, completedToday: servedToday }
  };
}

export const publicTicket = ticket => ({
  id: String(ticket._id),
  number: ticket.number,
  label: ticket.label,
  name: ticket.name,
  // Stored sealed; opened here so the desk sees the number it needs to call.
  phone: openField(ticket.phone),
  service: ticket.serviceName || '',
  status: ticket.status,
  createdAt: ticket.createdAt,
  calledAt: ticket.calledAt,
  servingAt: ticket.servingAt,
  recallCount: ticket.recallCount || 0
});

/** Strips staff-only fields for the public customer stream. */
export const anonymousTicket = ticket => ({
  id: String(ticket.id || ticket._id),
  label: ticket.label,
  status: ticket.status,
  service: ticket.service || ticket.serviceName || ''
});

async function nextPosition(queueId) {
  const last = await tickets()
    .find({ queueId, status: 'waiting' })
    .sort({ position: -1 })
    .limit(1)
    .toArray();
  return (last[0]?.position ?? 0) + 1000;
}

export async function addTicket(business, queue, { name, phone, serviceId, source = 'desk', actorId = '' }) {
  if (queue.status !== 'open' && source === 'public') {
    throw new HttpError(409, queue.status === 'paused'
      ? 'This queue is paused right now.'
      : 'This queue is closed right now.');
  }

  let service = null;
  if (serviceId) {
    if (!ObjectId.isValid(serviceId)) throw new HttpError(400, 'Unknown service.');
    service = await col(collections.services).findOne({ _id: new ObjectId(serviceId), businessId: business._id });
    if (!service) throw new HttpError(400, 'Unknown service.');
  }

  // Claim the next number atomically so two joins can never share one.
  const claimed = await bumpQueue(queue._id, { $inc: { nextNumber: 1 } });
  const number = claimed.nextNumber - 1;

  const now = new Date();
  const doc = {
    businessId: business._id,
    queueId: queue._id,
    number,
    label: ticketLabel(claimed, number),
    name: (name || '').trim().slice(0, 80) || 'Walk-in',
    phone: sealField((phone || '').trim().slice(0, 32)),
    serviceId: service?._id || null,
    serviceName: service?.name || '',
    status: 'waiting',
    position: await nextPosition(queue._id),
    source,
    sessionToken: crypto.randomUUID(),
    calledAt: null,
    servingAt: null,
    completedAt: null,
    recallCount: 0,
    servedBy: '',
    createdAt: now,
    updatedAt: now
  };

  const { insertedId } = await tickets().insertOne(doc);
  const ticket = { ...doc, _id: insertedId };

  await record(EVENTS.ticketCreated, {
    businessId: business._id, queueId: queue._id, ticketId: insertedId, actorId,
    data: { source, service: doc.serviceName }
  });
  if (service) {
    await record(EVENTS.serviceSelected, {
      businessId: business._id, queueId: queue._id, ticketId: insertedId, actorId, data: { service: service.name }
    });
  }
  publish(business._id, 'ticket.created', { ticket: anonymousTicket(ticket), version: claimed.version });
  return ticket;
}

/**
 * Completes whoever is in service and calls the next waiting ticket.
 * The claim is a single guarded findOneAndUpdate, so concurrent calls cannot
 * hand the same ticket to two members of staff.
 */
export async function callNext(business, queue, { actorId = '' } = {}) {
  const now = new Date();

  const claimed = await tickets().findOneAndUpdate(
    { queueId: queue._id, status: 'waiting' },
    { $set: { status: 'called', calledAt: now, updatedAt: now, servedBy: actorId } },
    { sort: { position: 1 }, returnDocument: 'after' }
  );

  if (!claimed) throw new HttpError(409, 'No one is waiting.');

  // Close out the previous ticket only if it is still open — never clobber a
  // ticket another member of staff has already finished.
  if (queue.servingTicketId) {
    const previous = await tickets().findOneAndUpdate(
      { _id: queue.servingTicketId, status: { $in: ['called', 'serving'] } },
      { $set: { status: 'completed', completedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (previous) {
      await record(EVENTS.ticketCompleted, {
        businessId: business._id, queueId: queue._id, ticketId: previous._id, actorId,
        data: { auto: true }
      });
    }
  }

  const updated = await bumpQueue(queue._id, { $set: { servingTicketId: claimed._id } });

  await record(EVENTS.ticketCalled, {
    businessId: business._id, queueId: queue._id, ticketId: claimed._id, actorId, data: { label: claimed.label }
  });
  publish(business._id, 'queue.next', {
    serving: anonymousTicket(claimed),
    version: updated.version
  });
  // Reaches the customer even with the tab closed; harmless when they never opted in.
  notifyTicket(claimed, business, {
    title: business.name,
    body: `${claimed.label} — it is your turn. Please come to the desk.`
  });

  return { ticket: claimed, queue: updated };
}

/* A guarded update tells us it did not apply, but not why, and the two reasons
   deserve different answers.

   A ticket that is not in this queue must read as absent — exactly like a
   made-up id — so that a caller holding another tenant's real identifier cannot
   tell it apart from a fabricated one by watching 404 turn into 409. A ticket
   that is genuinely here and simply in the wrong state is a conflict, and
   saying so is what lets a desk understand a double tap.

   Every ticket action routes its failure through here, so all of them answer
   consistently; they used to disagree, with skip and close reporting a conflict
   for tickets they had never seen. */
async function refuseTicket(queue, ticketId, conflictMessage) {
  const exists = await tickets().findOne(
    { _id: new ObjectId(ticketId), queueId: queue._id },
    { projection: { _id: 1 } }
  );
  throw exists ? new HttpError(409, conflictMessage) : new HttpError(404, 'Ticket not found.');
}

/** Marks the called ticket as actually being served (starts the service clock). */
export async function startServing(business, queue, ticketId, { actorId = '' } = {}) {
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');
  const now = new Date();
  const ticket = await tickets().findOneAndUpdate(
    { _id: new ObjectId(ticketId), queueId: queue._id, status: 'called' },
    { $set: { status: 'serving', servingAt: now, updatedAt: now, servedBy: actorId } },
    { returnDocument: 'after' }
  );
  if (!ticket) await refuseTicket(queue, ticketId, 'That ticket is not waiting to be served.');
  await record(EVENTS.ticketStarted, { businessId: business._id, queueId: queue._id, ticketId: ticket._id, actorId });
  publish(business._id, 'ticket.serving', { ticket: anonymousTicket(ticket) });
  return ticket;
}

const TERMINAL = {
  completed: { event: EVENTS.ticketCompleted, stamp: 'completedAt' },
  skipped: { event: EVENTS.ticketSkipped, stamp: 'completedAt' },
  no_show: { event: EVENTS.ticketNoShow, stamp: 'completedAt' },
  cancelled: { event: EVENTS.ticketRemoved, stamp: 'completedAt' }
};

/** completed | skipped | no_show | cancelled */
export async function closeTicket(business, queue, ticketId, status, { actorId = '' } = {}) {
  const rule = TERMINAL[status];
  if (!rule) throw new HttpError(400, 'Unknown ticket status.');
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');

  const now = new Date();
  const ticket = await tickets().findOneAndUpdate(
    { _id: new ObjectId(ticketId), queueId: queue._id, status: { $in: OPEN_STATUSES } },
    { $set: { status, [rule.stamp]: now, updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (!ticket) await refuseTicket(queue, ticketId, 'That ticket has already been dealt with.');

  if (String(queue.servingTicketId) === String(ticket._id)) {
    await bumpQueue(queue._id, { $set: { servingTicketId: null } });
  }

  await record(rule.event, {
    businessId: business._id, queueId: queue._id, ticketId: ticket._id, actorId, data: { label: ticket.label }
  });
  publish(business._id, 'ticket.closed', { ticket: anonymousTicket(ticket), status });
  dropSubscription(ticket._id).catch(() => {});
  return ticket;
}

/** Sends a called ticket back to the end of the waiting list. */
export async function skipToEnd(business, queue, ticketId, { actorId = '' } = {}) {
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');
  const now = new Date();
  const position = await nextPosition(queue._id);
  const ticket = await tickets().findOneAndUpdate(
    { _id: new ObjectId(ticketId), queueId: queue._id, status: { $in: OPEN_STATUSES } },
    { $set: { status: 'waiting', position, calledAt: null, updatedAt: now } },
    { returnDocument: 'after' }
  );
  if (!ticket) await refuseTicket(queue, ticketId, 'That ticket is no longer in the queue.');

  if (String(queue.servingTicketId) === String(ticket._id)) {
    await bumpQueue(queue._id, { $set: { servingTicketId: null } });
  }
  await record(EVENTS.ticketSkipped, {
    businessId: business._id, queueId: queue._id, ticketId: ticket._id, actorId, data: { movedToEnd: true }
  });
  publish(business._id, 'ticket.moved', { ticket: anonymousTicket(ticket) });
  return ticket;
}

/**
 * Calls one specific waiting customer out of order — the desk sees somebody in
 * the room, or a service is free early. Guarded on `waiting`, so two members of
 * staff cannot call the same person twice, and whoever was already at the desk
 * is closed out first.
 */
export async function callTicket(business, queue, ticketId, { actorId = '' } = {}) {
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');
  const now = new Date();

  const claimed = await tickets().findOneAndUpdate(
    { _id: new ObjectId(ticketId), queueId: queue._id, status: 'waiting' },
    { $set: { status: 'called', calledAt: now, updatedAt: now, servedBy: actorId } },
    { returnDocument: 'after' }
  );
  if (!claimed) throw new HttpError(409, 'That customer is no longer waiting — someone may have just called them.');

  if (queue.servingTicketId && String(queue.servingTicketId) !== String(claimed._id)) {
    const previous = await tickets().findOneAndUpdate(
      { _id: queue.servingTicketId, status: { $in: ['called', 'serving'] } },
      { $set: { status: 'completed', completedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    );
    if (previous) {
      await record(EVENTS.ticketCompleted, {
        businessId: business._id, queueId: queue._id, ticketId: previous._id, actorId, data: { auto: true }
      });
    }
  }

  const updated = await bumpQueue(queue._id, { $set: { servingTicketId: claimed._id } });

  await record(EVENTS.ticketCalled, {
    businessId: business._id, queueId: queue._id, ticketId: claimed._id, actorId,
    data: { label: claimed.label, outOfOrder: true }
  });
  publish(business._id, 'queue.next', { serving: anonymousTicket(claimed), version: updated.version });
  notifyTicket(claimed, business, {
    title: business.name,
    body: `${claimed.label} — it is your turn. Please come to the desk.`
  });

  return { ticket: claimed, queue: updated };
}

/** Calls the current ticket again — used when nobody came to the desk. */
export async function recall(business, queue, { actorId = '' } = {}) {
  if (!queue.servingTicketId) throw new HttpError(409, 'Nobody has been called yet.');
  const now = new Date();
  const ticket = await tickets().findOneAndUpdate(
    { _id: queue.servingTicketId, status: { $in: ['called', 'serving'] } },
    { $set: { calledAt: now, updatedAt: now }, $inc: { recallCount: 1 } },
    { returnDocument: 'after' }
  );
  if (!ticket) throw new HttpError(409, 'Nobody has been called yet.');
  await record(EVENTS.ticketRecalled, { businessId: business._id, queueId: queue._id, ticketId: ticket._id, actorId });
  publish(business._id, 'ticket.recalled', { ticket: anonymousTicket(ticket) });
  notifyTicket(ticket, business, {
    title: business.name,
    body: `${ticket.label} — the desk is calling you again.`,
    kind: 'recall'
  });
  return ticket;
}

/** direction: 'up' swaps with the ticket ahead, 'down' with the one behind, 'front' jumps the line. */
export async function move(business, queue, ticketId, direction, { actorId = '' } = {}) {
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');
  const _id = new ObjectId(ticketId);
  const ticket = await tickets().findOne({ _id, queueId: queue._id, status: 'waiting' });
  if (!ticket) throw new HttpError(404, 'Ticket not found in the waiting list.');

  let position;
  if (direction === 'front') {
    const first = await tickets().find({ queueId: queue._id, status: 'waiting' }).sort({ position: 1 }).limit(1).toArray();
    position = (first[0]?.position ?? ticket.position) - 1000;
  } else {
    const before = direction === 'up';
    const neighbours = await tickets()
      .find({
        queueId: queue._id,
        status: 'waiting',
        position: before ? { $lt: ticket.position } : { $gt: ticket.position }
      })
      .sort({ position: before ? -1 : 1 })
      .limit(2)
      .toArray();
    if (!neighbours.length) return ticket; // already at the end it is being moved toward
    const [neighbour, second] = neighbours;
    position = second
      ? (neighbour.position + second.position) / 2
      : neighbour.position + (before ? -1000 : 1000);
  }

  const moved = await tickets().findOneAndUpdate(
    { _id, status: 'waiting' },
    { $set: { position, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  publish(business._id, 'ticket.moved', { ticket: anonymousTicket(moved || ticket) });
  await record('ticket_moved', {
    businessId: business._id, queueId: queue._id, ticketId: _id, actorId, data: { direction }
  });
  return moved || ticket;
}

/** Moves a waiting ticket onto a different service. */
export async function assignService(business, queue, ticketId, serviceId, { actorId = '' } = {}) {
  if (!ObjectId.isValid(ticketId)) throw new HttpError(404, 'Ticket not found.');
  let service = null;
  if (serviceId) {
    if (!ObjectId.isValid(serviceId)) throw new HttpError(400, 'Unknown service.');
    service = await col(collections.services).findOne({ _id: new ObjectId(serviceId), businessId: business._id });
    if (!service) throw new HttpError(400, 'Unknown service.');
  }
  const ticket = await tickets().findOneAndUpdate(
    { _id: new ObjectId(ticketId), queueId: queue._id, status: { $in: OPEN_STATUSES } },
    { $set: { serviceId: service?._id || null, serviceName: service?.name || '', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!ticket) throw new HttpError(404, 'Ticket not found.');
  await record(EVENTS.ticketTransferred, {
    businessId: business._id, queueId: queue._id, ticketId: ticket._id, actorId,
    data: { service: service?.name || null }
  });
  publish(business._id, 'ticket.updated', { ticket: anonymousTicket(ticket) });
  return ticket;
}

/** open | paused | closed. Closing clears the floor. */
export async function setStatus(business, queue, status, { actorId = '' } = {}) {
  if (!['open', 'paused', 'closed'].includes(status)) throw new HttpError(400, 'Unknown queue status.');
  const now = new Date();

  const update = { $set: { status } };
  if (status === 'open') update.$set.openedAt = now;
  if (status === 'closed') update.$set.closedAt = now;

  const updated = await bumpQueue(queue._id, update);

  if (status === 'closed') {
    await tickets().updateMany(
      { queueId: queue._id, status: { $in: OPEN_STATUSES } },
      { $set: { status: 'cancelled', completedAt: now, updatedAt: now } }
    );
    await bumpQueue(queue._id, { $set: { servingTicketId: null } });
  }

  const eventName = {
    open: EVENTS.queueOpened,
    paused: EVENTS.queuePaused,
    closed: EVENTS.queueClosed
  }[status];
  await record(eventName, { businessId: business._id, queueId: queue._id, actorId });
  publish(business._id, 'queue.status', { status, version: updated.version });
  return updated;
}

export async function updateQueue(business, queue, patch) {
  const allowed = {};
  if (patch.name !== undefined) allowed.name = String(patch.name).slice(0, 60);
  if (patch.prefix !== undefined) allowed.prefix = String(patch.prefix).toUpperCase().slice(0, 1);
  if (patch.avgServiceMin !== undefined) {
    allowed.avgServiceMin = Math.max(1, Math.min(240, Number(patch.avgServiceMin) || 1));
  }
  const updated = await bumpQueue(queue._id, { $set: allowed });
  publish(business._id, 'queue.updated', { version: updated.version });
  return updated;
}

/** The ticket a customer device holds, looked up by its own session token.
    The token must be a plain string: Express's query parser will happily build
    `{$ne: ''}` out of `?token[$ne]=`, which would otherwise match somebody
    else's ticket. */
export async function ticketBySession(businessId, token) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 100) return null;
  return tickets().findOne({ businessId, sessionToken: token });
}

export async function positionOf(ticket) {
  if (!ticket || ticket.status !== 'waiting') return 0;
  return tickets().countDocuments({
    queueId: ticket.queueId,
    status: 'waiting',
    position: { $lt: ticket.position }
  });
}
