/* The customer-facing display.

   A second screen in the room — a TV on the wall, a spare monitor turned to face
   the queue. It is not the printed sign and it is not the dashboard: it is read
   from across the room, so the number being served is the largest thing on it
   and the code is large enough to scan from a few metres away.

   The cashier keeps working in the dashboard while this runs in another window;
   both read the same live queue, so nothing here needs its own refresh. */

import { esc, logoMark, icon, watermark, madeBy } from '../ui.js';
import { qrSvg } from '../qr.js';
import { t } from '../i18n.js';

/** The controls only exist for the operator, and only until they are ready. */
function displayChrome(ui) {
  const voice = ui.displayVoice !== false;
  return `
  <div class="display__chrome ${ui.displayIdle ? 'display__chrome--away' : ''}">
    <a class="btn btn--quiet btn--sm btn--auto" href="/app/overview">${icon('back', 15)}&nbsp; ${t('display.exit')}</a>
    <button class="btn btn--quiet btn--sm btn--auto" data-action="toggle-display-voice" title="${voice ? t('display.voiceOn') : t('display.voiceOff')}">
      ${icon(voice ? 'phone' : 'close', 15)}&nbsp; ${voice ? t('display.voiceOn') : t('display.voiceOff')}
    </button>
    <button class="btn btn--quiet btn--sm btn--auto" data-action="display-fullscreen">
      ${icon('expand', 15)}&nbsp; ${t('display.fullscreen')}
    </button>
  </div>`;
}

function currentPrayerWindow() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const prayers = [
    { name: 'Fajr (Subax)', start: 4 * 60 + 30, end: 5 * 60 + 15 },
    { name: 'Dhuhr (Duhur)', start: 11 * 60 + 50, end: 12 * 60 + 35 },
    { name: 'Asr (Casir)', start: 15 * 60 + 10, end: 15 * 60 + 55 },
    { name: 'Maghrib (Maghrib)', start: 18 * 60 + 0, end: 18 * 60 + 45 },
    { name: 'Isha (Cisha)', start: 19 * 60 + 15, end: 19 * 60 + 55 }
  ];
  return prayers.find(p => minutes >= p.start && minutes <= p.end);
}

export function displayView(ui, { business, snapshot, joinBase }) {
  const qr = business.qrSettings;
  const queue = snapshot?.queue;
  const serving = snapshot?.serving;
  const waiting = snapshot?.waiting || [];
  const joinUrl = `${joinBase}/j/${business.slug}`;
  const layout = qr.displayLayout || 'split';
  const prayer = currentPrayerWindow();

  const code = `
    <div class="display__code living-qr-breath" style="background:${esc(qr.background)}">
      ${qrSvg(joinUrl, {
        size: 460, shape: qr.shape, dark: qr.foreground, light: qr.background,
        eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : '',
        quiet: qr.quietZone, level: qr.errorCorrection
      })}
    </div>`;

  const prayerBanner = prayer ? `
    <div class="display__prayer-held note note--alert" style="margin:0 clamp(16px, 3vw, 40px) 16px; text-align:center; font-weight:500">
      ${t('display.prayerHeld', { prayer: prayer.name })}
    </div>` : '';

  const nowServing = qr.displayShowServing !== false ? `
    <div class="display__serving">
      <div class="display__eyebrow">${t('con.nowServing')}</div>
      <div class="display__number flip-board ${serving ? '' : 'display__number--idle'}" data-anim-key="display-serving"
           role="status" aria-live="polite">${serving ? esc(serving.label) : '—'}</div>
    </div>` : '';

  const facts = `
    <div class="display__facts">
      ${qr.displayShowWaiting !== false ? `
        <div class="display__fact">
          <span>${waiting.length}</span>
          <small>${t('con.waiting')}</small>
        </div>` : ''}
      ${qr.displayShowNext !== false && queue ? `
        <div class="display__fact">
          <span>${esc(queue.nextLabel)}</span>
          <small>${t('con.nextNumber')}</small>
        </div>` : ''}
    </div>`;

  /* Three ways to fill a screen, because the rooms differ: a code beside the
     number, the code alone for a small display by the door, or a board that
     leads with who is being served and keeps the code as a corner. */
  const body = layout === 'code'
    ? `<div class="display__stage display__stage--code">
         ${prayerBanner}
         ${code}
         <p class="display__instruction">${esc(qr.signInstruction)}</p>
       </div>`
    : layout === 'board'
      ? `<div class="display__stage display__stage--board">
           ${prayerBanner}
           ${nowServing}
           ${facts}
           <div class="display__corner">
             ${code}
             <p class="display__instruction">${esc(qr.signInstruction)}</p>
           </div>
         </div>`
      : `<div class="display__stage display__stage--split">
           <div class="display__half">
             ${prayerBanner}
             ${nowServing}
             ${facts}
           </div>
           <div class="display__half display__half--code">
             ${code}
             <p class="display__instruction">${esc(qr.signInstruction)}</p>
           </div>
         </div>`;

  return `
  <div class="screen display living-display" data-layout="${esc(layout)}" style="--display-scale:${Number(qr.displayScale) || 1}">
    ${displayChrome(ui)}
    <header class="display__head">
      ${logoMark(business, 'xl')}
      <div>
        <div class="display__name">${esc(business.name)}</div>
        <div class="display__headline">${esc(qr.signHeadline)}</div>
      </div>
    </header>

    ${body}

    <footer class="display__foot">
      <span class="display__link">${esc(joinUrl.replace(/^https?:\/\//, ''))}</span>
      <span class="display__brand">${watermark()}${madeBy()}</span>
    </footer>
  </div>`;
}
