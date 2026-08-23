/* Server-sent events, one channel per business.

   Every queue mutation publishes a small event carrying the queue's version, so
   a client that reconnects (or receives events out of order) can tell whether
   what it holds is stale and re-read state instead of guessing. A single process
   keeps subscribers in memory; behind more than one instance, publish() is the
   one function to point at Redis pub/sub. */

import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
bus.setMaxListeners(0);

let sequence = 0;
const recent = new Map(); // businessId -> [{ id, event }] for Last-Event-ID replay

const RETAIN = 50;

export function publish(businessId, type, data = {}) {
  const key = String(businessId);
  const event = { id: ++sequence, type, businessId: key, data, at: new Date().toISOString() };

  const history = recent.get(key) || [];
  history.push(event);
  while (history.length > RETAIN) history.shift();
  recent.set(key, history);

  bus.emit(key, event);
  return event;
}

export function missedSince(businessId, lastEventId) {
  const history = recent.get(String(businessId)) || [];
  return history.filter(event => event.id > Number(lastEventId));
}

/**
 * Streams events for one business. `shape` lets the public customer stream strip
 * anything a customer should not see.
 */
export function subscribe(res, businessId, { lastEventId = 0, shape = event => event } = {}) {
  const key = String(businessId);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = event => {
    const payload = shape(event);
    if (!payload) return;
    res.write(`id: ${event.id}\nevent: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  res.write('retry: 3000\n\n');
  for (const event of missedSince(key, lastEventId)) send(event);

  const listener = event => send(event);
  bus.on(key, listener);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  const close = () => {
    clearInterval(heartbeat);
    bus.off(key, listener);
  };
  res.on('close', close);
  res.on('error', close);
  return close;
}
