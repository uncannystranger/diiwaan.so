/* Queue events are the historical record: every metric is derived from them or
   from ticket timestamps, never from whatever a browser happens to be holding. */

import { col, collections } from '../db.js';

export const EVENTS = {
  ticketCreated: 'ticket_created',
  ticketCalled: 'ticket_called',
  ticketStarted: 'ticket_started',
  ticketCompleted: 'ticket_completed',
  ticketSkipped: 'ticket_skipped',
  ticketRemoved: 'ticket_removed',
  ticketNoShow: 'ticket_no_show',
  ticketRecalled: 'ticket_recalled',
  ticketTransferred: 'ticket_transferred',
  queueOpened: 'queue_opened',
  queueClosed: 'queue_closed',
  queuePaused: 'queue_paused',
  queueResumed: 'queue_resumed',
  serviceSelected: 'service_selected'
};

export async function record(type, { businessId, queueId = null, ticketId = null, actorId = '', data = {} }) {
  await col(collections.events).insertOne({
    businessId,
    queueId,
    ticketId,
    type,
    actorId,
    data,
    createdAt: new Date()
  });
}

export async function audit({ businessId = null, actorId = '', action, target = '', ip = '', data = {} }) {
  await col(collections.audit).insertOne({
    businessId, actorId, action, target, ip, data, createdAt: new Date()
  });
}

const startOfDay = (date = new Date()) => {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** Dashboard numbers for one business, computed in the database. */
export async function summary(businessId, { since = startOfDay(), timezone = 'UTC' } = {}) {
  const tickets = col(collections.tickets);

  const [statusCounts] = await Promise.all([
    tickets.aggregate([
      { $match: { businessId, createdAt: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray()
  ]);

  const byStatus = Object.fromEntries(statusCounts.map(row => [row._id, row.count]));

  const [waitAgg] = await tickets.aggregate([
    { $match: { businessId, calledAt: { $ne: null }, createdAt: { $gte: since } } },
    { $project: { waitMs: { $subtract: ['$calledAt', '$createdAt'] } } },
    { $group: { _id: null, avg: { $avg: '$waitMs' }, max: { $max: '$waitMs' }, n: { $sum: 1 } } }
  ]).toArray();

  const [serviceAgg] = await tickets.aggregate([
    { $match: { businessId, completedAt: { $ne: null }, servingAt: { $ne: null }, createdAt: { $gte: since } } },
    { $project: { serviceMs: { $subtract: ['$completedAt', '$servingAt'] } } },
    { $group: { _id: null, avg: { $avg: '$serviceMs' }, n: { $sum: 1 } } }
  ]).toArray();

  const busiest = await col(collections.events).aggregate([
    { $match: { businessId, type: EVENTS.ticketCreated, createdAt: { $gte: since } } },
    { $group: { _id: { $hour: { date: '$createdAt', timezone } }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 1 }
  ]).toArray();

  const perService = await tickets.aggregate([
    { $match: { businessId, createdAt: { $gte: since }, serviceName: { $nin: [null, ''] } } },
    {
      $group: {
        _id: '$serviceName',
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        avgServiceMs: {
          $avg: {
            $cond: [
              { $and: ['$completedAt', '$servingAt'] },
              { $subtract: ['$completedAt', '$servingAt'] },
              null
            ]
          }
        }
      }
    },
    { $sort: { total: -1 } }
  ]).toArray();

  const minutes = ms => (ms ? Math.round(ms / 60000) : 0);

  return {
    since,
    waiting: byStatus.waiting || 0,
    called: byStatus.called || 0,
    serving: byStatus.serving || 0,
    completed: byStatus.completed || 0,
    skipped: byStatus.skipped || 0,
    noShow: byStatus.no_show || 0,
    cancelled: byStatus.cancelled || 0,
    throughput: (byStatus.completed || 0),
    avgWaitMin: minutes(waitAgg?.avg),
    maxWaitMin: minutes(waitAgg?.max),
    avgServiceMin: minutes(serviceAgg?.avg),
    // Sample counts let the console say "<1 min" instead of a misleading "0".
    waitSamples: waitAgg?.n || 0,
    serviceSamples: serviceAgg?.n || 0,
    busiestHour: busiest[0]?._id ?? null,
    services: perService.map(row => ({
      name: row._id,
      total: row.total,
      completed: row.completed,
      avgServiceMin: minutes(row.avgServiceMs)
    }))
  };
}

/** Recent activity for the dashboard feed. */
export async function activity(businessId, limit = 12) {
  return col(collections.events)
    .find({ businessId })
    .sort({ createdAt: -1 })
    .limit(Math.min(50, limit))
    .toArray();
}
