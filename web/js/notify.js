/* Telling a customer their turn has come.
   The web cannot ring a phone the way a call does. What it can do, in descending
   order of reliability, is: a push notification delivered by the service worker
   even when the tab is closed; a notification from the open page; a vibration;
   a clear, noticeable chime; and — always — a full-screen "your turn" state. */

import { buzz } from './haptics.js';

export const notificationsSupported = () =>
  'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;

export const permission = () => (('Notification' in window) ? Notification.permission : 'unsupported');

const urlBase64ToUint8Array = base64 => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map(char => char.charCodeAt(0)));
};

let sharedAudioCtx = null;

/**
 * Primes the audio subsystem during a user gesture (tap/click/submit) so that
 * later background/SSE-driven rings can play without browser autoplay restrictions.
 */
export function primeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    if (sharedAudioCtx.state === 'suspended') {
      sharedAudioCtx.resume().catch(() => {});
    }
  } catch { /* AudioContext unavailable */ }
}

if (typeof window !== 'undefined') {
  const primeHandler = () => {
    primeAudio();
    window.removeEventListener('pointerdown', primeHandler);
    window.removeEventListener('touchstart', primeHandler);
  };
  window.addEventListener('pointerdown', primeHandler, { passive: true, once: true });
  window.addEventListener('touchstart', primeHandler, { passive: true, once: true });
}

/**
 * Asks for permission and registers a push subscription for this ticket.
 * Called from a button press — never on page load.
 */
export async function enableAlerts({ slug, token, publicKey }) {
  primeAudio();
  if (!('Notification' in window)) return { ok: false, reason: 'unsupported' };

  const result = await Notification.requestPermission();
  if (result !== 'granted') return { ok: false, reason: result === 'denied' ? 'denied' : 'dismissed' };

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

/**
 * Plays a clear, professional multi-tone chime.
 * For urgent (called/serving), generates a prominent harmonic chime that cuts through noise.
 */
export function chime({ urgent = false } = {}) {
  try {
    primeAudio();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = sharedAudioCtx && sharedAudioCtx.state !== 'closed' ? sharedAudioCtx : new Ctx();
    ctx.resume?.().catch(() => {});

    const now = ctx.currentTime;
    const peak = urgent ? 0.75 : 0.35;

    // Rising melodic progression: C5, G5, C6, E6 (repeated for urgent calling)
    const chords = urgent
      ? [
          { freq: 523.25, time: 0.00, dur: 0.35 },
          { freq: 659.25, time: 0.12, dur: 0.35 },
          { freq: 783.99, time: 0.24, dur: 0.35 },
          { freq: 1046.50, time: 0.38, dur: 0.65 },
          { freq: 1318.51, time: 0.52, dur: 0.85 },
          // Second repeat burst for maximum noticeability
          { freq: 783.99, time: 1.10, dur: 0.35 },
          { freq: 1046.50, time: 1.22, dur: 0.40 },
          { freq: 1318.51, time: 1.36, dur: 0.90 }
        ]
      : [
          { freq: 880, time: 0.00, dur: 0.25 },
          { freq: 1320, time: 0.16, dur: 0.40 }
        ];

    chords.forEach(({ freq, time, dur }) => {
      const at = now + time;
      
      // Dual oscillator: Warm triangle + pure sine for full acoustic presence
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'triangle';
      osc1.frequency.setValueAtTime(freq, at);

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(freq, at);

      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.025);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(at);
      osc2.start(at);
      osc1.stop(at + dur + 0.05);
      osc2.stop(at + dur + 0.05);
    });
  } catch { /* Audio is a progressive enhancement */ }
}

const SOMALI_DIGITS = {
  '0': 'eber', '1': 'kow', '2': 'laba', '3': 'saddex', '4': 'afar',
  '5': 'shan', '6': 'lix', '7': 'toddoba', '8': 'sideed', '9': 'sagaal'
};

/** Spoken ticket announcement with voice synthesis */
export function speakTicket(label, { language = 'so' } = {}) {
  if (!label || !('speechSynthesis' in window)) return;

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
      utterance.rate = 0.94;
      utterance.pitch = 1.05;
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find(v => v.lang.startsWith(language)) || voices.find(v => v.lang.startsWith('en')) || voices[0];
      if (match) utterance.voice = match;
      window.speechSynthesis.speak(utterance);
    } catch { /* Speech synthesis fallback */ }
  }, 450);
}

/** The in-page alert: fires when the customer's state advances */
export function announce({ title, body, called = false, label = '', language = 'so' } = {}) {
  buzz(called ? 'turn' : 'soon');
  chime({ urgent: called });

  if (called) {
    // Secondary vibration pulse for pocket detection
    setTimeout(() => buzz('turn'), 1400);
    if (label) speakTicket(label, { language });
  }

  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body, tag: 'diiwaan-turn', renotify: true }); } catch { /* platform refused */ }
  }
}

/* Keeps the screen awake while someone is waiting, released when done */
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
  } catch { /* denied or unsupported */ }
}
