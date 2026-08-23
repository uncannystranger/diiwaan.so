/* First run: create the business, shape the queue, pick colours, take the QR.
   Canvas frame 9 — four step cards, the active one opening inline. */

import { t } from '../i18n.js';
import { esc, wordmark, themeButton, icon, logoMark } from '../ui.js';
import { PRESETS, readableOn } from '../palette.js';
import { qrSvg } from '../qr.js';

const STEPS = [
  ['setup.step1', 'setup.step1Hint'],
  ['setup.step2', 'setup.step2Hint'],
  ['setup.step3', 'setup.step3Hint'],
  ['setup.step4', 'setup.step4Hint']
];

function stepBody(index, ui, business, joinBase) {
  const draft = ui.setup;

  if (index === 0) return `
    <form class="stack gap-16 mt-16" data-action="setup-business" novalidate>
      <div class="field ${ui.setup.errors?.name ? 'field--bad' : ''}">
        <label for="s-name">${t('set.businessName')}</label>
        <input id="s-name" name="s-name" data-keep="s-name" data-setup="name"
               value="${esc(draft.name ?? business?.name ?? '')}" placeholder="Hodan Clinic" />
        ${ui.setup.errors?.name ? `<span class="error-text">${esc(ui.setup.errors.name)}</span>` : ''}
      </div>
      <div class="field-row">
        <div class="field">
          <label for="s-category">${t('setup.kindOfBusiness')} <span>${t('common.optional')}</span></label>
          <input id="s-category" data-keep="s-category" data-setup="category"
                 value="${esc(draft.category ?? business?.category ?? '')}" placeholder="${esc(t('set.categoryHint'))}" />
        </div>
        <div class="field">
          <label for="s-city">${t('set.city')}</label>
          <input id="s-city" data-keep="s-city" data-setup="city"
                 value="${esc(draft.city ?? business?.city ?? '')}" placeholder="KM4 · Mogadishu" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="s-phone">${t('common.phone')} <span>${t('common.optional')}</span></label>
          <input id="s-phone" data-keep="s-phone" data-setup="phone" value="${esc(draft.phone ?? business?.phone ?? '')}" />
        </div>
        <div class="field">
          <label for="s-country">${t('setup.country')}</label>
          <input id="s-country" data-keep="s-country" data-setup="country"
                 value="${esc(draft.country ?? business?.country ?? 'Somalia')}" />
        </div>
      </div>
      <p class="hint">${t('setup.joinAt')} <strong>${esc(joinBase)}/j/${esc(ui.setup.slugPreview || '…')}</strong></p>
      <button class="btn" type="submit" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
        ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('setup.saving')}` : t('setup.continue')}
      </button>
    </form>`;

  if (index === 1) return `
    <div class="stack gap-16 mt-16">
      <div class="field">
        <label>${t('set.prefix')}</label>
        <div class="prefix-pick">
          ${['A', 'B', 'H', 'Q', 'S'].map(p => `
            <button type="button" data-action="setup-prefix" data-value="${p}"
                    aria-pressed="${(draft.prefix ?? business.queueSettings.prefix) === p}">${p}</button>`).join('')}
        </div>
      </div>
      <div class="field">
        <label for="s-avg">${t('setup.howLong')}</label>
        <div class="row-flex gap-16" style="flex-wrap:nowrap">
          <input type="range" id="s-avg" min="1" max="60" step="1" data-setup="avgServiceMin"
                 value="${draft.avgServiceMin ?? business.queueSettings.avgServiceMin}" style="flex:1;min-width:120px" />
          <span data-range-label style="font-size:15px;font-weight:500;width:76px">${draft.avgServiceMin ?? business.queueSettings.avgServiceMin} min</span>
        </div>
      </div>
      <div class="field">
        <label>${t('setup.whatOffer')} <span>${t('common.optional')}</span></label>
        <div class="chips">
          ${(ui.services || []).map(service => `
            <span class="chip chip--tint">${esc(service.name)}
              <button type="button" data-action="delete-service" data-id="${service.id}"
                      aria-label="${esc(t('setup.removeService', { name: service.name }))}" style="border:none;background:none;cursor:pointer;color:inherit;padding:0">×</button>
            </span>`).join('')}
          <button type="button" class="chip chip--dashed" data-action="add-service">${icon('plus', 14)} Add</button>
        </div>
      </div>
      <button class="btn" data-action="setup-queue" ${ui.busy ? 'disabled' : ''}>${t('setup.continue')}</button>
    </div>`;

  if (index === 2) return `
    <div class="stack gap-16 mt-16">
      <div class="row-flex gap-16">
        ${logoMark(business, 'lg')}
        <div class="stack gap-8">
          <label class="btn btn--quiet btn--sm btn--auto" style="cursor:pointer">
            ${icon('plus', 15)}&nbsp; ${business.logo ? t('setup.replaceLogo') : t('setup.uploadLogo')}
            <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo hidden />
          </label>
          <span class="hint">${t('setup.logoFormats')}</span>
        </div>
      </div>
      <div class="stack gap-8">
        <div class="eyebrow">${t('setup.colours')}</div>
        <div class="swatches">
          ${PRESETS.map(preset => `
            <button class="swatch" data-action="apply-preset" data-id="${preset.id}"
                    aria-pressed="${(business.branding.preset || '') === preset.id}"
                    title="${esc(preset.name)} — ${esc(preset.character)}"
                    aria-label="${esc(preset.name)}"
                    style="background:linear-gradient(135deg, ${preset.tint} 0%, ${preset.primary} 50%, ${preset.emphasis} 100%)"></button>`).join('')}
        </div>
      </div>
      <p class="hint">${t('setup.fineTune')}</p>
      <button class="btn" data-action="setup-next">${t('setup.continue')}</button>
    </div>`;

  const qr = business.qrSettings;
  return `
    <div class="row-flex gap-24 mt-16" style="align-items:flex-start">
      <div class="qr-frame" style="background:${esc(qr.background)}">
        ${qrSvg(`${joinBase}/j/${business.slug}`, {
          size: 150, shape: qr.shape, dark: qr.foreground, light: qr.background,
          eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : ''
        })}
      </div>
      <div class="stack gap-12" style="flex:1;min-width:200px">
        <div style="font-size:15px;font-weight:500">${esc(joinBase.replace(/^https?:\/\//, ''))}/j/${esc(business.slug)}</div>
        <p class="hint">${t('setup.qrHint')}</p>
        <div class="btn-row">
          <button class="btn btn--quiet btn--auto btn--sm" data-action="download-qr" data-value="png">${icon('download', 15)}&nbsp; PNG</button>
          <button class="btn btn--quiet btn--auto btn--sm" data-action="copy-link">${icon('copy', 15)}&nbsp; Copy link</button>
        </div>
      </div>
    </div>
    <button class="btn mt-16" data-action="setup-finish" ${ui.busy ? 'disabled' : ''}>${t('setup.startServing')}</button>`;
}

export function setupView(ui, business, joinBase) {
  const active = ui.setup.step;
  return `
  <div class="screen">
    <div class="topbar">
      ${wordmark(16)}
      <div class="topbar__right">${themeButton()}
        <button class="btn btn--link" data-action="sign-out">${t('con.signOut')}</button>
      </div>
    </div>
    <div class="stage" style="max-width:780px">
      <h1 class="serif">${t('setup.fourSteps')}</h1>
      <p class="lead mt-8">${t('setup.twoMinutes')}</p>

      <div class="stack gap-16 mt-32">
        ${STEPS.map(([titleKey, hintKey], i) => {
          const done = i < active;
          const isActive = i === active;
          return `
          <div class="step${done ? ' step--done' : ''}${isActive ? ' step--active' : ''}">
            <div class="step__head">
              <div class="step__num">${done ? icon('check', 16) : i + 1}</div>
              <div class="step__body"><strong>${t(titleKey)}</strong><span>${t(hintKey)}</span></div>
              ${done ? `<span class="pill">${t('setup.done')}</span>` : ''}
            </div>
            ${isActive ? stepBody(i, ui, business, joinBase) : ''}
          </div>`;
        }).join('')}
      </div>

      <div class="spacer" style="min-height:28px"></div>
      <div class="row-flex gap-16">
        <div class="meter" style="flex:1"><i style="width:${(active / STEPS.length) * 100}%"></i></div>
        <span class="hint">${t('setup.stepOf', { n: active + 1, total: STEPS.length })}</span>
      </div>
    </div>
  </div>`;
}
