/* The printable sign — the owner's brand, their wording, their QR. */

import { esc, icon, logoMark, watermark } from '../ui.js';
import { t } from '../i18n.js';
import { qrSvg } from '../qr.js';

export function signView(ui, { business, snapshot, joinBase }) {
  const qr = business.qrSettings;
  const joinUrl = `${joinBase}/j/${business.slug}`;

  return `
  <div class="screen">
    <div class="topbar no-print">
      <a class="btn btn--quiet btn--auto btn--sm" href="#/brand">${icon('back', 15)}&nbsp; ${t('sign.backToBrand')}</a>
      <div class="btn-row">
        <button class="btn btn--quiet btn--auto btn--sm" data-action="print">${icon('print', 15)}&nbsp; ${t('sign.print')}</button>
        <button class="btn btn--quiet btn--auto btn--sm" data-action="download-qr" data-value="png">${icon('download', 15)}&nbsp; PNG</button>
        <button class="btn btn--quiet btn--auto btn--sm" data-action="download-qr" data-value="svg">${icon('download', 15)}&nbsp; SVG</button>
      </div>
    </div>

    <div class="sign">
      ${logoMark(business, 'xl')}
      <h1 class="serif mt-24">${esc(qr.signHeadline)}</h1>
      <p class="lead mt-8">${esc(qr.signInstruction)}</p>

      <div class="qr-frame mt-32" style="background:${esc(qr.background)}">
        ${qrSvg(joinUrl, {
          size: 300, shape: qr.shape, dark: qr.foreground, light: qr.background,
          eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : '',
          quiet: qr.quietZone, level: qr.errorCorrection
        })}
      </div>
      <div style="margin-top:20px;font-size:19px;font-weight:500;letter-spacing:.02em">
        ${esc(joinUrl.replace(/^https?:\/\//, ''))}
      </div>
      ${qr.signFootnote ? `<p class="hint mt-8">${esc(qr.signFootnote)}</p>` : ''}

      <div class="spacer" style="min-height:28px"></div>

      <div class="card card--flat between" style="width:100%">
        <div style="text-align:left">
          <div class="serif" style="font-size:20px;font-weight:500">${esc(business.name)}</div>
          <div class="hint mt-4">${esc([business.city, business.address].filter(Boolean).join(' · '))}</div>
        </div>
        <div style="text-align:right">
          <div class="eyebrow">${t('con.nowServing')}</div>
          <div class="numeral numeral--md numeral--brand" style="font-size:26px">
            ${snapshot?.serving ? esc(snapshot.serving.label) : '—'}
          </div>
        </div>
      </div>
      <div style="margin-top:20px">${watermark()}</div>
    </div>
  </div>`;
}
