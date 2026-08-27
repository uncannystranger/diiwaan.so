/* Brand studio: identity, colours, the words customers read, and the QR — with
   a live preview of the page a customer lands on after scanning. */

import { t } from '../i18n.js';
import { esc, icon, logoMark, brandStyle, errorPanel } from '../ui.js';
import { qrSvg } from '../qr.js';
import { frame } from './console.js';
import { resolved as resolvedTheme } from '../theme.js';

/* Each preset is a group of five: the primary action, two blends between it and
   the emphasis colour, the emphasis itself, and the soft tint. The swatch shows
   all five as one smooth gradient, which is also exactly how they meet in the
   interface. */
import { PRESETS, SURFACES, presetById, completeBranding, deriveFromPrimary, contrast, readableOn } from '../palette.js';

/** A miniature of the real interface, painted in one palette. */
function paletteCard(preset, { selected, theme }) {
  return `
  <button class="palette" data-action="apply-preset" data-id="${preset.id}"
          aria-pressed="${selected}" aria-label="${esc(preset.name)} — ${esc(preset.character)}">
    <span class="palette__stage" data-theme="${theme}" data-brand data-surface="calm"
          style="${paletteStyle(preset)}">
      <span class="palette__nav">
        <span class="palette__dot"></span>
        <span class="palette__bar"></span>
      </span>
      <span class="palette__card">
        <span class="palette__line palette__line--strong"></span>
        <span class="palette__line"></span>
        <span class="palette__row">
          <span class="palette__btn">Aa</span>
          <span class="palette__badge"></span>
        </span>
      </span>
    </span>
    <span class="palette__meta">
      <span class="palette__name">${esc(preset.name)}${selected ? ' <i class="palette__tick"></i>' : ''}</span>
      <span class="palette__character">${esc(preset.character)}</span>
      <span class="palette__swatches">
        ${['primary', 'emphasis', 'accent', 'base', 'tint']
          .map(role => `<i style="background:${preset[role]}" title="${role}"></i>`).join('')}
      </span>
    </span>
  </button>`;
}

const paletteStyle = preset => [
  `--p-primary:${preset.primary}`, `--p-emphasis:${preset.emphasis}`,
  `--p-accent:${preset.accent}`, `--p-base:${preset.base}`, `--p-tint:${preset.tint}`,
  `--p-on-primary:${readableOn(preset.primary)}`, `--p-on-accent:${readableOn(preset.accent)}`
].join(';');

const toggle = (label, hint, action, on) => `
  <div class="setting">
    <div><div class="setting__label">${label}</div><div class="setting__hint">${hint}</div></div>
    <button class="switch" data-action="${action}" aria-pressed="${on}" aria-label="${label}"><i></i></button>
  </div>`;

function preview(ui, business) {
  const brand = completeBranding(business.branding);
  const page = business.customerExperience;
  const theme = brand.theme === 'system' ? resolvedTheme() : brand.theme;
  const tab = ui.previewTab || 'join';
  const surface = ` data-brand data-surface="${esc(brand.surface || 'aurora')}"`;

  const join = `
    <div class="row-flex gap-12">
      ${logoMark(business)}
      <div>
        <div class="serif" style="font-size:17px">${esc(business.name)}</div>
        <div class="hint">${esc(business.city)}</div>
      </div>
    </div>
    <div class="stack gap-8" style="margin-top:26px">
      <h2 class="serif" style="font-size:30px;line-height:1.14">${esc(page.headline)}</h2>
      <p class="lead" style="font-size:15px">${esc(page.subheading)}</p>
    </div>
    <div class="card stack gap-12" style="margin-top:22px;padding:20px">
      <div class="field"><label>${t('common.name')}</label><div class="input" style="color:var(--ink-4)">${t('cust.yourName')}</div></div>
      <div class="field">
        <label>${t('common.phone')} ${page.requirePhone ? '' : `<span>${t('common.optional')}</span>`}</label>
        <div class="input" style="color:var(--ink-4)">+252 …</div>
      </div>
      ${page.askService && ui.services.length
        ? `<div class="chips">${ui.services.slice(0, 3).map((s, i) => `<span class="chip" ${i === 0 ? 'aria-pressed="true"' : ''}>${esc(s.name)}</span>`).join('')}</div>`
        : ''}
      <div class="btn">${t('cust.join')}</div>
    </div>`;

  const ticket = `
    <div class="between">
      <div class="row-flex gap-8">${logoMark(business)}<span class="serif" style="font-size:15px">${esc(business.name)}</span></div>
      <span class="pill"><i class="dot dot--live"></i>${t('status.live')}</span>
    </div>
    <div class="center" style="margin-top:36px">
      <div class="eyebrow eyebrow--wide">${t('cust.yourNumber')}</div>
      <div class="numeral" style="font-size:104px;margin-top:10px">${esc(business.queueSettings.prefix)}-27</div>
      <div class="serif" style="font-size:18px;font-style:italic;color:var(--clay);margin-top:8px">${t('cust.inQueue')}</div>
    </div>
    <div class="card stack gap-12" style="margin-top:26px;padding:20px">
      <div class="row-flex" style="gap:0">
        ${page.showPeopleAhead ? `<div style="flex:1"><div class="eyebrow">${t('cust.aheadOfYou')}</div><div class="numeral" style="font-size:30px;margin-top:4px">4</div></div>` : ''}
        ${page.showEstimate ? `<div style="flex:1"><div class="eyebrow">${t('cust.approxWait')}</div><div class="numeral" style="font-size:30px;margin-top:4px">${4 * business.queueSettings.avgServiceMin}<small style="font-size:14px;font-weight:400"> ${t('common.minShort')}</small></div></div>` : ''}
      </div>
      ${page.showProgress ? '<div class="meter"><i style="width:52%"></i></div>' : ''}
    </div>
    <div class="note" style="margin-top:18px;font-size:15px">${esc(page.ticketNote)}</div>`;

  const called = `
    <div class="center" style="margin-top:60px">
      <div class="eyebrow eyebrow--wide">${t('cust.yourNumber')}</div>
      <div class="numeral" style="font-size:104px;margin-top:10px">${esc(business.queueSettings.prefix)}-27</div>
      <div class="serif" style="font-size:19px;font-style:italic;color:var(--clay);margin-top:10px">${t('cust.itIsYourTurn')}</div>
      <p class="lead" style="margin-top:16px">${esc(page.calledMessage)}</p>
    </div>`;

  return `
  <div class="stack gap-16" style="position:sticky;top:20px">
    <div class="between">
      <div class="eyebrow">${t('brand.preview')}</div>
      <div class="seg seg--sm">
        ${[['join', t('brand.tab.join')], ['ticket', t('brand.tab.ticket')], ['called', t('brand.tab.called')]].map(([id, label]) => `
          <button data-action="preview-tab" data-value="${id}" aria-pressed="${tab === id}">${label}</button>`).join('')}
      </div>
    </div>
    <div class="device" data-theme="${theme}"${surface} style="${brandStyle(brand)}">
      <div class="device__aurora"></div>
      <div class="device__scale">${tab === 'join' ? join : tab === 'ticket' ? ticket : called}</div>
    </div>
    <a class="btn btn--ghost" href="#/j/${esc(business.slug)}" style="text-align:center">${t('brand.openReal')}</a>
  </div>`;
}

export function brandView(ui, ctx) {
  const { business, joinBase, error } = ctx;
  if (error && error.status && error.status !== 409) {
    return frame(ui, ctx, 'brand', `
      <div class="workspace">${errorPanel(error, { retryAction: 'reload-queue', title: t('brand.failed') })}</div>`);
  }
  const brand = completeBranding(business.branding);
  const page = business.customerExperience;
  const qr = business.qrSettings;
  const joinUrl = `${joinBase}/j/${business.slug}`;

  return frame(ui, ctx, 'brand', `
    <div class="workspace">
      <div class="studio">
        <div class="stack gap-24" style="min-width:0">

          <section class="card stack gap-20">
            <div class="between">
              <h2>${t('brand.identity')}</h2>
              ${ui.saving ? `<span class="pill pill--mute"><span class="spinner"></span>${t('common.saving')}</span>`
                          : `<span class="pill"><i class="tick"></i>${t('common.saved')}</span>`}
            </div>
            <div class="row-flex gap-16">
              ${logoMark(business, 'xl')}
              <div class="stack gap-8">
                <label class="btn btn--quiet btn--sm btn--auto" style="cursor:pointer">
                  ${icon('plus', 15)}&nbsp; ${business.logo ? t('setup.replaceLogo') : t('setup.uploadLogo')}
                  <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-logo hidden />
                </label>
                ${business.logo ? `<button class="btn btn--link" data-action="clear-logo">${t('brand.removeLogo')}</button>` : ''}
                <span class="hint">${t('brand.logoFormats')}</span>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="b-name">${t('set.businessName')}</label>
                <input id="b-name" data-keep="b-name" data-business="name" value="${esc(business.name)}" />
              </div>
              <div class="field">
                <label for="b-city">${t('set.city')}</label>
                <input id="b-city" data-keep="b-city" data-business="city" value="${esc(business.city)}" />
              </div>
            </div>
            <div class="field">
              <label for="b-description">${t('brand.shortDescription')} <span>${t('common.optional')}</span></label>
              <textarea id="b-description" data-keep="b-description" data-business="description" rows="2"
                        placeholder="${esc(t('brand.descriptionPlaceholder'))}">${esc(business.description)}</textarea>
            </div>
            <div class="field">
              <label for="b-slug">${t('set.publicLink')}</label>
              <div class="slug-row">
                <span class="hint nowrap">${esc(joinBase.replace(/^https?:\/\//, ''))}/j/</span>
                <input id="b-slug" data-keep="b-slug" value="${esc(business.slug)}" />
                <button class="btn btn--quiet btn--sm btn--auto" data-action="save-slug">${t('brand.change')}</button>
                <button class="icon-btn" data-action="copy-link"
                        title="${esc(t('con.copyLink'))}" aria-label="${esc(t('con.copyLink'))}">${icon('copy')}</button>
              </div>
              <span class="hint">${t('brand.reprintNote')}</span>
            </div>
          </section>

          <section class="card stack gap-24">
            <div class="between">
              <div>
                <h2>${t('brand.colours')}</h2>
                <p class="hint mt-4">${t('brand.coloursLead')}</p>
              </div>
              ${ui.saving ? `<span class="pill pill--mute"><span class="spinner"></span>${t('common.saving')}</span>` : ''}
            </div>

            <div class="palettes">
              ${PRESETS.map(preset => paletteCard(preset, {
                selected: (brand.preset || '') === preset.id,
                theme: brand.theme === 'system' ? resolvedTheme() : brand.theme
              })).join('')}
            </div>

            <div class="stack gap-12">
              <div class="between">
                <div class="eyebrow">${t('brand.surfaceStyle')}</div>
                <span class="hint">${esc(SURFACES.find(item => item.id === (brand.surface || 'aurora'))?.hint || '')}</span>
              </div>
              <div class="seg seg--sm">
                ${SURFACES.map(item => `
                  <button data-action="brand-surface" data-value="${item.id}"
                          aria-pressed="${(brand.surface || 'aurora') === item.id}">${item.name}</button>`).join('')}
              </div>
            </div>

            <details class="custom" ${brand.preset ? '' : 'open'}>
              <summary>${t('brand.ownColours')}</summary>
              <p class="hint mt-8">${t('brand.deriveHint')}</p>
              <div class="field-row mt-16">
                ${[['primary', t('brand.rolePrimary')], ['emphasis', t('brand.roleEmphasis')], ['accent', t('brand.roleAccent')],
                   ['base', t('brand.roleBase')], ['tint', t('brand.roleTint')]].map(([key, label]) => `
                  <div class="field">
                    <label for="c-${key}">${label}</label>
                    <div class="row-flex gap-8" style="flex-wrap:nowrap">
                      <input type="color" id="c-${key}" data-brand="${key}" value="${esc(brand[key] || '#000000')}" />
                      <input class="input" data-keep="c-${key}-hex" data-brand-hex="${key}"
                             aria-label="${label} — ${t('brand.hexValue')}"
                             value="${esc(brand[key] || '')}" style="flex:1;min-height:42px;min-width:0" />
                    </div>
                  </div>`).join('')}
              </div>
              <div class="btn-row mt-16">
                <button class="btn btn--quiet btn--sm btn--auto" data-action="derive-palette">
                  Rebuild the set from my primary
                </button>
              </div>
              ${ui.contrastWarning ? `<p class="error-text mt-12">${esc(ui.contrastWarning)}</p>` : ''}
            </details>

            <div class="stack gap-12">
              <div class="eyebrow">${t('brand.customerTheme')}</div>
              <div class="seg seg--sm">
                ${[['system', t('brand.matchDevice')], ['light', t('brand.alwaysLight')], ['dark', t('brand.alwaysDark')]].map(([id, label]) => `
                  <button data-action="brand-theme" data-value="${id}" aria-pressed="${brand.theme === id}">${label}</button>`).join('')}
              </div>
              <span class="hint">${t('brand.consoleThemeNote')}</span>
            </div>
          </section>

          <section class="card stack gap-20">
            <h2>${t('brand.whatTheyRead')}</h2>
            <div class="field">
              <label for="p-headline">${t('brand.headline')}</label>
              <input id="p-headline" data-keep="p-headline" data-page="headline" value="${esc(page.headline)}" />
            </div>
            <div class="field">
              <label for="p-sub">${t('brand.underHeadline')}</label>
              <textarea id="p-sub" data-keep="p-sub" data-page="subheading">${esc(page.subheading)}</textarea>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="p-note">${t('brand.ticketNote')}</label>
                <textarea id="p-note" data-keep="p-note" data-page="ticketNote">${esc(page.ticketNote)}</textarea>
              </div>
              <div class="field">
                <label for="p-called">${t('brand.whenCalled')}</label>
                <textarea id="p-called" data-keep="p-called" data-page="calledMessage">${esc(page.calledMessage)}</textarea>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="p-paused">${t('brand.whilePaused')}</label>
                <textarea id="p-paused" data-keep="p-paused" data-page="pausedMessage" rows="2">${esc(page.pausedMessage)}</textarea>
              </div>
              <div class="field">
                <label for="p-closed">${t('brand.whileClosed')}</label>
                <textarea id="p-closed" data-keep="p-closed" data-page="closedMessage" rows="2">${esc(page.closedMessage)}</textarea>
              </div>
            </div>
            <div class="settings-list">
              ${toggle(t('brand.requirePhone'), t('brand.requirePhoneHint'), 'toggle-phone', page.requirePhone)}
              ${toggle(t('brand.askNeed'), t('brand.askNeedHint'), 'toggle-service', page.askService)}
              ${toggle(t('brand.showAhead'), t('brand.showAheadHint'), 'toggle-ahead', page.showPeopleAhead)}
              ${toggle(t('brand.showEstimate'), t('brand.showEstimateHint'), 'toggle-estimate', page.showEstimate)}
              ${toggle(t('brand.showProgress'), t('brand.showProgressHint'), 'toggle-progress', page.showProgress)}
            </div>
          </section>

          <section class="card stack gap-20">
            <h2>QR code</h2>
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(210px,1fr));align-items:center">
              <div class="center">
                <div class="qr-frame" id="qr-preview" style="background:${esc(qr.background)}">
                  ${qrSvg(joinUrl, {
                    size: 200, shape: qr.shape, dark: qr.foreground, light: qr.background,
                    eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : '',
                    quiet: qr.quietZone, level: qr.errorCorrection
                  })}
                </div>
                <p class="hint mt-8">${esc(joinUrl.replace(/^https?:\/\//, ''))}</p>
                ${ui.qrWarning ? `<p class="error-text mt-8">${esc(ui.qrWarning)}</p>` : ''}
              </div>
              <div class="stack gap-16">
                <div class="stack gap-8">
                  <div class="eyebrow">${t('brand.moduleShape')}</div>
                  <div class="seg seg--sm">
                    ${[['square', t('brand.qrSquare')], ['rounded', t('brand.qrRounded')], ['dot', t('brand.qrDots')]].map(([id, label]) => `
                      <button data-action="qr-shape" data-value="${id}" aria-pressed="${qr.shape === id}">${label}</button>`).join('')}
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label for="q-fg">${t('brand.codeColour')}</label>
                    <input type="color" id="q-fg" data-qr="foreground" value="${esc(qr.foreground)}" />
                  </div>
                  <div class="field">
                    <label for="q-bg">${t('brand.background')}</label>
                    <input type="color" id="q-bg" data-qr="background" value="${esc(qr.background)}" />
                  </div>
                  <div class="field">
                    <label for="q-eye">${t('brand.corners')}</label>
                    <input type="color" id="q-eye" data-qr="eyeColor" value="${esc(qr.eyeColor || qr.foreground)}" />
                  </div>
                </div>
                <div class="stack gap-8">
                  <div class="eyebrow">${t('brand.errorCorrection')}</div>
                  <div class="seg seg--sm">
                    ${['L', 'M', 'Q', 'H'].map(level => `
                      <button data-action="qr-level" data-value="${level}"
                              aria-pressed="${(qr.logoOnCode ? 'H' : qr.errorCorrection) === level}"
                              ${qr.logoOnCode && level !== 'H' ? 'disabled title="A logo needs level H"' : ''}>${level}</button>`).join('')}
                  </div>
                  <span class="hint">Higher levels survive smudges and a logo, at the cost of a denser code.</span>
                </div>
                <div class="settings-list">
                  ${toggle(t('brand.logoInMiddle'), t('brand.logoInMiddleHint'), 'toggle-qr-logo', qr.logoOnCode)}
                </div>
                <div class="field">
                  <label for="q-headline">${t('brand.signHeadline')}</label>
                  <input id="q-headline" data-keep="q-headline" data-qr-text="signHeadline" value="${esc(qr.signHeadline)}" />
                </div>
                <div class="field">
                  <label for="q-instruction">${t('brand.signInstruction')}</label>
                  <input id="q-instruction" data-keep="q-instruction" data-qr-text="signInstruction" value="${esc(qr.signInstruction)}" />
                </div>
                <div class="btn-row">
                  <button class="btn btn--quiet btn--sm" data-action="download-qr" data-value="svg">${icon('download', 15)}&nbsp; SVG</button>
                  <button class="btn btn--quiet btn--sm" data-action="download-qr" data-value="png">${icon('download', 15)}&nbsp; PNG</button>
                  <a class="btn btn--quiet btn--sm" href="#/sign" style="text-align:center">${icon('print', 15)}&nbsp; ${t('con.sign')}</a>
                </div>
                <p class="hint">${t('brand.qrCheckHint')}</p>
              </div>
            </div>

            <hr class="rule" />

            <div class="stack gap-16">
              <div>
                <div class="eyebrow">${t('display.title')}</div>
                <p class="hint mt-4">${t('display.hint')}</p>
              </div>

              <div class="seg seg--sm">
                ${[['split', t('display.layoutSplit')], ['code', t('display.layoutCode')], ['board', t('display.layoutBoard')]]
                  .map(([id, label]) => `
                    <button data-action="display-layout" data-value="${id}"
                            aria-pressed="${(qr.displayLayout || 'split') === id}">${label}</button>`).join('')}
              </div>

              <div class="settings-list">
                ${toggle(t('display.showServing'), '', 'toggle-display-serving', qr.displayShowServing !== false)}
                ${toggle(t('display.showWaiting'), '', 'toggle-display-waiting', qr.displayShowWaiting !== false)}
                ${toggle(t('display.showNext'), '', 'toggle-display-next', qr.displayShowNext !== false)}
              </div>

              <div class="field">
                <label for="q-scale">${t('display.scale')}</label>
                <div class="setting__control">
                  <input id="q-scale" type="range" min="0.7" max="1.6" step="0.05"
                         data-qr-range="displayScale" value="${Number(qr.displayScale) || 1}" />
                  <span data-range-label style="font-size:15px;font-weight:500;width:52px">${Math.round((Number(qr.displayScale) || 1) * 100)}%</span>
                </div>
              </div>

              <button class="btn btn--ghost btn--sm" data-action="open-display">
                ${icon('screen', 15)}&nbsp; ${t('display.open')}
              </button>
            </div>
          </section>
        </div>

        ${preview(ui, business)}
      </div>
    </div>`);
}
