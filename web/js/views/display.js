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
  return `
  <div class="display__chrome ${ui.displayIdle ? 'display__chrome--away' : ''}">
    <a class="btn btn--quiet btn--sm btn--auto" href="#/overview">${icon('back', 15)}&nbsp; ${t('display.exit')}</a>
    <button class="btn btn--quiet btn--sm btn--auto" data-action="display-fullscreen">
      ${icon('expand', 15)}&nbsp; ${t('display.fullscreen')}
    </button>
  </div>`;
}

export function displayView(ui, { business, snapshot, joinBase }) {
  const qr = business.qrSettings;
  const queue = snapshot?.queue;
  const serving = snapshot?.serving;
  const waiting = snapshot?.waiting || [];
  const joinUrl = `${joinBase}/j/${business.slug}`;
  const layout = qr.displayLayout || 'split';

  const code = `
    <div class="display__code" style="background:${esc(qr.background)}">
      ${qrSvg(joinUrl, {
        size: 460, shape: qr.shape, dark: qr.foreground, light: qr.background,
        eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : '',
        quiet: qr.quietZone, level: qr.errorCorrection
      })}
    </div>`;

  const nowServing = qr.displayShowServing !== false ? `
    <div class="display__serving">
      <div class="display__eyebrow">${t('con.nowServing')}</div>
      <div class="display__number ${serving ? '' : 'display__number--idle'}" data-anim-key="display-serving"
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
         ${code}
         <p class="display__instruction">${esc(qr.signInstruction)}</p>
       </div>`
    : layout === 'board'
      ? `<div class="display__stage display__stage--board">
           ${nowServing}
           ${facts}
           <div class="display__corner">
             ${code}
             <p class="display__instruction">${esc(qr.signInstruction)}</p>
           </div>
         </div>`
      : `<div class="display__stage display__stage--split">
           <div class="display__half">
             ${nowServing}
             ${facts}
           </div>
           <div class="display__half display__half--code">
             ${code}
             <p class="display__instruction">${esc(qr.signInstruction)}</p>
           </div>
         </div>`;

  return `
  <div class="screen display" data-layout="${esc(layout)}" style="--display-scale:${Number(qr.displayScale) || 1}">
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
