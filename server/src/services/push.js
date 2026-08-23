/* Web Push for customers waiting on a queue.

   A browser cannot ring a phone like a call, but a push subscription is the one
   web mechanism that reaches a customer whose screen is off and whose tab is in
   the background. Each ticket may register one subscription; when that ticket is
   called, the service worker shows a notification even if Diiwaan is closed.

   VAPID keys come from the environment. Without them push simply stays off and
   the customer falls back to the in-page alert, vibration and sound. */

import webpush from 'web-push';
import { col, collections } from '../db.js';
import { config } from '../config.js';

let enabled = false;

if (config.push.publicKey && config.push.privateKey) {
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  enabled = true;
} else {
  console.log('[push] VAPID keys not configured — customers fall back to in-page alerts');
}

export const pushEnabled = () => enabled;
export const publicKey = () => config.push.publicKey || '';

/** One subscription per ticket; re-subscribing replaces the old endpoint. */
export async function saveSubscription({ businessId, ticketId, subscription }) {
  if (!enabled) return false;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return false;

  await col(collections.pushSubscriptions).updateOne(
    { ticketId },
    {
      $set: {
        businessId,
        ticketId,
        endpoint: String(subscription.endpoint).slice(0, 1024),
        keys: { p256dh: String(subscription.keys.p256dh).slice(0, 200), auth: String(subscription.keys.auth).slice(0, 100) },
        updatedAt: new Date()
      },
      $setOnInsert: { createdAt: new Date() }
    },
    { upsert: true }
  );
  return true;
}

export async function dropSubscription(ticketId) {
  await col(collections.pushSubscriptions).deleteOne({ ticketId });
}

/**
 * Notifies one customer that their number is up. Failures are swallowed and the
 * dead subscription removed — a customer who closed their browser must never
 * break the desk's flow.
 */
export async function notifyTicket(ticket, business, { title, body, kind = 'called' } = {}) {
  if (!enabled) return false;
  const record = await col(collections.pushSubscriptions).findOne({ ticketId: ticket._id });
  if (!record) return false;

  const payload = JSON.stringify({
    kind,
    title: title || business.name,
    body: body || `${ticket.label} — it is your turn.`,
    label: ticket.label,
    slug: business.slug,
    icon: business.logo || '',
    url: `/t/${business.slug}`
  });

  try {
    await webpush.sendNotification(
      { endpoint: record.endpoint, keys: record.keys },
      payload,
      { TTL: 600, urgency: 'high' }
    );
    return true;
  } catch (error) {
    // 404/410 mean the subscription is gone for good.
    if (error.statusCode === 404 || error.statusCode === 410) await dropSubscription(ticket._id);
    return false;
  }
}
