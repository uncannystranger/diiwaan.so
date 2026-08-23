/* Shared render helpers: escaping, brand tokens, chrome, icons, skeletons. */

import { preference as themePreference } from './theme.js';
import { paletteVars, completeBranding } from './palette.js';
import { t, lang, otherLanguage } from './i18n.js';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

/** Two letters where possible: "Hodan Ali" → HA, "amina.yusuf@…" → AY. */
export function initials(value) {
  const source = String(value || '').trim();
  if (!source) return '?';
  const local = source.includes('@') ? source.split('@')[0] : source;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1
    ? [parts[0][0], parts[1][0]]
    : [local[0], local[1] || ''];
  return letters.join('').toUpperCase();
}

export const cx = (...parts) => parts.filter(Boolean).join(' ');

/* ---------- brand ---------- */

/** Re-tints the design tokens for one business. The shapes never change. */
/**
 * Hands one business's five brand colours to the stylesheet, which derives every
 * other token from them. Used for previews; the live interface gets the same
 * variables written onto the document root.
 */
export function brandStyle(branding) {
  return branding ? paletteVars(branding) : '';
}

/* The surface style is always declared, so the four styles are explicit rather
   than one of them being an unnamed default. */
export const surfaceAttr = branding =>
  ` data-brand data-surface="${esc(completeBranding(branding || {}).surface)}"`;

/**
 * The business's own identity. When no logo has been uploaded yet this falls back
 * to the business's initials — never to the Diiwaan mark, which would put our
 * brand where the customer's belongs.
 */
export function logoMark(business, size = '') {
  const cls = cx('logo', size === 'lg' && 'logo--lg', size === 'xl' && 'logo--xl');
  const logo = business?.logo || business?.branding?.logo;
  // The whole screen is re-rendered on every state change, so this <img> is
  // recreated constantly. Decoding it synchronously from cache stops the logo
  // blinking on each repaint.
  if (logo) return `<img class="${cls}" src="${esc(logo)}" alt="${esc(business?.name || '')} logo" decoding="sync" fetchpriority="high" />`;
  return `<span class="${cls} logo--initials" aria-hidden="true">${esc(initials(business?.name))}</span>`;
}

/* The Diiwaan mark: three bars stepping forward behind a leading dot — a queue
   advancing. Simple enough to read at 16px, distinct enough to be ours. */
export const diiwaanMark = (size = 22) => `
  <svg class="dmark" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="22" height="22" rx="7" fill="currentColor" opacity=".1"/>
    <rect x="5" y="7" width="9" height="2.4" rx="1.2" fill="currentColor" opacity=".55"/>
    <rect x="5" y="10.8" width="6.5" height="2.4" rx="1.2" fill="currentColor" opacity=".4"/>
    <rect x="5" y="14.6" width="4" height="2.4" rx="1.2" fill="currentColor" opacity=".28"/>
    <circle cx="17.6" cy="12" r="2.9" fill="var(--brand)"/>
  </svg>`;

export const wordmark = (size = 15) =>
  `<span class="wordmark" style="font-size:${size}px">${diiwaanMark(Math.round(size * 1.5))}DIIWAAN</span>`;

/** The signature, small and out of the way. */
export const madeBy = () => `
  <p class="credit">made with
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" focusable="false"
         style="vertical-align:-1px"><path fill="#FF9F1C" d="M12 21s-7.5-4.6-9.5-9A5.3 5.3 0 0 1 12 6.6a5.3 5.3 0 0 1 9.5 5.4C19.5 16.4 12 21 12 21z"/></svg>
    <span class="sr-only">love</span> by uncannystranger</p>`;

/** A whisper of Diiwaan on a business's own screens. */
export const watermark = () => `
  <div class="watermark" aria-hidden="true">${diiwaanMark(14)}<span>Diiwaan</span></div>`;

/* ---------- status ---------- */

/* The live switch is the one control that decides whether a scanned QR can join
   anyone, so it stays on screen whatever the connection is doing. A dropped
   stream used to replace it with a status word, which took the switch away at
   exactly the moment an owner might want to close the queue.

   Offline is the one case where it is disabled: the change could not reach the
   server, and a switch that lies about what customers can do is worse than one
   that admits it cannot act. */
export function livePill(connection, { paused, closed } = {}) {
  const off = paused || closed;
  const offline = connection === 'offline';
  const syncing = connection === 'reconnecting';

  const label = offline ? t('status.offline')
    : closed ? t('status.closed')
      : off ? t('status.off')
        : t('status.live');

  const hint = offline ? t('status.offlineHint') : off ? t('live.turnOnHint') : t('live.turnOffHint');

  return `
    <button class="pill pill--switch ${off ? 'pill--mute' : ''} ${offline ? 'pill--warn' : ''} ${syncing ? 'pill--syncing' : ''}"
            data-action="toggle-live" role="switch" aria-checked="${!off}"
            ${offline ? 'disabled' : ''}
            title="${esc(hint)}"
            aria-label="${esc(offline ? t('status.offline') : off ? t('live.turnOn') : t('live.turnOff'))}">
      <span class="pill__switch" aria-hidden="true"><i></i></span>${label}
    </button>`;
}

export function ago(iso) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes === 0) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.round(minutes / 60);
  return t('time.hoursAgo', { count: hours });
}

export const waitedMin = iso => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
export const clock = (date = new Date()) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
export const today = (date = new Date()) => date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });

/* ---------- icons ---------- */

const paths = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
  print: '<path d="M7 8V3h10v5M7 18H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2M7 14h10v7H7z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-2 8-2 8h16s-2-1-2-8M13.7 21a2 2 0 0 1-3.4 0"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  check: '<path d="M4 12.5l5 5L20 6.5"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
  queue: '<path d="M4 7h10M4 12h16M4 17h7"/><circle cx="18.5" cy="7" r="2.2"/>',
  overview: '<rect x="3" y="4" width="7" height="7" rx="2"/><rect x="14" y="4" width="7" height="4.5" rx="2"/><rect x="3" y="15" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="8" rx="2"/>',
  brand: '<path d="M12 3l2.6 5.6 6.1.8-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 9.4l6.1-.8z"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 13.5a7.9 7.9 0 0 0 0-3l1.8-1.4-1.9-3.3-2.2.9a8 8 0 0 0-2.6-1.5L14.1 2h-4.2l-.4 2.2a8 8 0 0 0-2.6 1.5l-2.2-.9-1.9 3.3 1.8 1.4a7.9 7.9 0 0 0 0 3l-1.8 1.4 1.9 3.3 2.2-.9a8 8 0 0 0 2.6 1.5l.4 2.2h4.2l.4-2.2a8 8 0 0 0 2.6-1.5l2.2.9 1.9-3.3z"/>',
  report: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2.2 2A16 16 0 0 1 3 6.2 2 2 0 0 1 5 4z"/>',
  expand: '<path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6"/>',
  screen: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>'
};

export const icon = (name, size = 18) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;

const THEME_WORDS = { system: 'follows your device', light: 'light', dark: 'dark' };

/* Two letters is enough to say which language you are in, and the button says
   where it takes you rather than where you are — the same promise as the flag
   toggles people already know from banking apps. */
export const languageButton = () => {
  const other = otherLanguage();
  return `
  <button class="icon-btn icon-btn--text" data-action="toggle-language"
          title="${esc(other.native)}" aria-label="${esc(t('common.language'))}: ${esc(other.native)}">
    <span>${esc(lang().toUpperCase())}</span>
  </button>`;
};

export const themeButton = () => `
  <button class="icon-btn" data-action="cycle-theme"
          title="Theme: ${THEME_WORDS[themePreference]}"
          aria-label="Theme: ${THEME_WORDS[themePreference]}. Activate to change.">
    ${icon(themePreference === 'system' ? 'auto' : themePreference === 'dark' ? 'moon' : 'sun')}
  </button>`;

/* ---------- loading + errors ---------- */

export const skeletonRows = (count = 5) => `
  <div class="rows">
    ${Array.from({ length: count }, (_, i) => `
      <div class="skeleton-row" style="--i:${i}">
        <div class="skeleton" style="width:62px;height:18px"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:7px">
          <div class="skeleton" style="width:60%;height:12px"></div>
          <div class="skeleton" style="width:40%;height:9px"></div>
        </div>
      </div>`).join('')}
  </div>`;

export const skeletonBlock = (height = 120) =>
  `<div class="skeleton" style="height:${height}px;border-radius:26px"></div>`;

/** Errors say what happened and offer the way out. */
export function errorPanel(error, { retryAction = 'retry', title = 'That did not load' } = {}) {
  const offline = error?.offline;
  return `
  <div class="card card--flat stack gap-12" role="alert">
    <div class="row-flex gap-12">
      <span class="pill ${offline ? 'pill--warn' : 'pill--alert'}">${offline ? 'Offline' : 'Error'}</span>
      <strong style="font-size:16px;font-weight:500">${esc(offline ? 'You appear to be offline' : title)}</strong>
    </div>
    <p class="hint">${esc(error?.message || 'Something went wrong.')}</p>
    ${(error?.details || []).length
      ? `<ul class="hint" style="margin:0;padding-left:18px">${error.details.map(d => `<li>${esc(d.message || d)}</li>`).join('')}</ul>`
      : ''}
    <div class="btn-row">
      <button class="btn btn--quiet btn--auto btn--sm" data-action="${retryAction}">${icon('refresh', 15)}&nbsp; Try again</button>
    </div>
  </div>`;
}
