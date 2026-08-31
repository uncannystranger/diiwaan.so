/* Telling a customer their turn has come.

   The web cannot ring a phone the way a call does. What it can do, in descending
   order of reliability, is: a push notification delivered by the service worker
   even when the tab is closed; a notification from the open page; a vibration;
   a short tone; and — always — a full-screen "your turn" state. This module
   arranges all of them and degrades quietly when a browser refuses one. */

import { buzz } from './haptics.js';


export const notificationsSupported = () =>
  'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

export const permission = () => (('Notification' in window) ? Notification.permission : 'unsupported');

const urlBase64ToUint8Array = base64 => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
};

/**
 * Asks for permission and registers a push subscription for this ticket.
 * Called from a button press — never on page load, which browsers punish and
 * customers resent.
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function enableAlerts({ slug, token, publicKey }) {
  if (!('Notification' in window)) return { ok: false, reason: 'unsupported' };

  const result = await Notification.requestPermission();
  if (result !== 'granted') return { ok: false, reason: result === 'denied' ? 'denied' : 'dismissed' };

  // Permission alone already buys us page-level notifications and vibration.
  if (!publicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return { ok: true, reason: 'local' };
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });

    const response = await fetch(`/api/public/${encodeURIComponent(slug)}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, subscription: subscription.toJSON() })
    });
    if (!response.ok) return { ok: true, reason: 'local' };
    const data = await response.json();
    return { ok: true, reason: data.enabled ? 'push' : 'local' };
  } catch {
    return { ok: true, reason: 'local' };
  }
}

/** The in-page half: fires while the customer is looking at the ticket. */
export function announce({ title, body, called }) {
  buzz(called ? 'turn' : 'soon');
  chime({ urgent: called });
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body, tag: 'diiwaan-turn', renotify: true }); } catch { /* platform refused */ }
  }
}

/* A short, soft two-note tone. Browsers only allow this once the customer has
   interacted with the page, which they have — they tapped "alert me". */
/* Being called is the one moment this page exists for, so the tone is louder,
   longer and repeated rather than a single polite ping.

   What the web cannot do: override a phone's hardware silent switch. On iOS the
   audio context is muted by that switch and no API changes it. So the alert
   never relies on sound alone — the vibration, the ringing card and the wake
   lock all carry it, and the tone is a bonus on devices that allow it. */
export function chime({ urgent = false } = {}) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const context = new Ctx();
    // Some browsers hand back a suspended context outside a gesture.
    context.resume?.().catch(() => {});

    const now = context.currentTime;
    const peak = urgent ? 0.5 : 0.22;
    // A rising three-note figure, repeated twice when it is someone's turn.
    const notes = urgent
      ? [880, 1174, 1568, 880, 1174, 1568]
      : [880, 1320];
    const step = urgent ? 0.16 : 0.18;

    notes.forEach((frequency, index) => {
      const at = now + index * step + (urgent && index === 3 ? 0.28 : 0);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      // A touch of triangle carries further through room noise than a pure sine.
      oscillator.type = urgent ? 'triangle' : 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + (urgent ? 0.42 : 0.32));
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + (urgent ? 0.44 : 0.34));
    });
    setTimeout(() => context.close(), urgent ? 2600 : 1200);
  } catch { /* audio is a bonus, never a requirement */ }
}

const SOMALI_DIGITS = {
  '0': 'eber', '1': 'kow', '2': 'laba', '3': 'saddex', '4': 'afar',
  '5': 'shan', '6': 'lix', '7': 'toddoba', '8': 'sideed', '9': 'sagaal'
};

/** R-1 Call It Out Loud: Two rising notes followed by digit pronunciation. */
export function speakTicket(label, { language = 'so' } = {}) {
  if (!label) return;
  chime({ urgent: false });
  if (!('speechSynthesis' in window)) return;

  setTimeout(() => {
    try {
      window.speechSynthesis.cancel();
      let text = label;
      if (language === 'so') {
        const parts = String(label).split('');
        const spoken = parts.map(char => SOMALI_DIGITS[char] || char).join(' ');
        text = `Lambarka ${spoken}`;
      } else {
        text = `Ticket ${label}`;
      }
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.92;
      utterance.pitch = 1.05;
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find(v => v.lang.startsWith(language)) || voices.find(v => v.lang.startsWith('en')) || voices[0];
      if (match) utterance.voice = match;
      window.speechSynthesis.speak(utterance);
    } catch { /* platform speech fallback */ }
  }, 380);
}

/* Keeps the screen awake while someone is waiting, so the call is seen rather
   than missed behind a locked phone. Released when they are done. */
let wakeLock = null;
export async function holdScreenAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* denied or unsupported: the page still shows the turn */ }
}
