/* The owner console: the desk screen and the day's overview.
   Canvas frames 5, 6 and 7 — topbar with the pill tab group, serving panel and
   waiting list side by side, add-customer as a bottom sheet. */

import {
  esc, cx, icon, logoMark, themeButton, languageButton, livePill,
  initials, waitedMin, ago, today, skeletonRows, skeletonBlock, errorPanel, watermark, madeBy
} from '../ui.js';
import { t, lang } from '../i18n.js';
import { resolved as resolvedTheme } from '../theme.js';
import { qrSvg } from '../qr.js';
import { state as sessionState } from '../session.js';

const TABS = ['queue', 'overview', 'brand', 'settings'];

/* Two identities live in this header and they must never be confused:
   the business (its logo, its name) and the person signed in (their initials,
   their email). The avatar is always the person — never the company mark. */
const personInitials = (user, membership) =>
  initials(user?.name || membership?.name || user?.email || '?');

/* The top row reads left to right as: who this is, where you are, what you can
   do. Three tracks, so the navigation sits in the true centre of the row rather
   than trailing after a business name whose length nobody can predict. Nothing
   here paints a bar across the page — each piece floats on the same background
   as the content below it. */
export function chrome(current, { business, user, role, connection, snapshot }) {
  const queue = snapshot?.queue;
  return `
  <a class="skip-link" href="#main">${t('con.skipToQueue')}</a>
  <div class="topbar">
    <div class="topbar__identity">
      <a class="topbar__id" href="#/queue" aria-label="${esc(business.name)} — queue">
        ${logoMark(business)}
        <span>
          <b>${esc(business.name)}</b>
          <span class="hint">${esc(queue?.name || business.queueSettings.name)}</span>
        </span>
      </a>
    </div>

    <nav class="seg topbar__tabs" aria-label="${esc(t('con.sections'))}">
      ${TABS.map(id => `
        <a href="#/${id}" ${current === id ? 'aria-current="page"' : ''}>${t(`con.tab.${id}`)}</a>`).join('')}
    </nav>

    <div class="topbar__right">
      ${livePill(connection, { paused: queue?.status === 'paused', closed: queue?.status === 'closed' })}
      <a class="icon-btn hide-sm" href="#/j/${esc(business.slug)}" title="${esc(t('brand.openReal'))}"
         aria-label="${esc(t('brand.openReal'))}">${icon('eye')}</a>
      <span class="hide-sm">${languageButton()}</span>
      <span class="hide-sm">${themeButton()}</span>
      <button class="icon-btn" data-action="sign-out-confirm"
              aria-label="${esc(t('con.signOut'))}"
              title="${esc(t('con.signOut'))}">${icon('logout')}</button>
    </div>
  </div>`;
}

export function mobileNav(current) {
  return `
  <nav class="mobile-nav" aria-label="${esc(t('con.sections'))}">
    ${TABS.map(id => `
      <a href="#/${id}" ${current === id ? 'aria-current="page"' : ''}>
        ${icon(id, 21)}<span>${t(`con.tab.${id}`)}</span>
      </a>`).join('')}
    <span class="mobile-nav__tools">
      <button class="mobile-nav__tool" data-action="toggle-language"
              title="${esc(t('common.language'))}" aria-label="${esc(t('common.language'))}">
        <span class="mobile-nav__lang" aria-hidden="true">${esc(lang().toUpperCase())}</span>
      </button>
      <button class="mobile-nav__tool" data-action="cycle-theme" title="${esc(t('con.theme'))}"
              aria-label="${esc(t('con.changeTheme'))}">${icon(resolvedTheme() === 'dark' ? 'moon' : 'sun', 19)}</button>
    </span>
  </nav>`;
}

function waitingRow(ticket, index, { role }) {
  return `
  <div class="row ${index === 0 ? 'row--next' : ''}" style="--i:${index}" data-ticket="${ticket.id}">
    <div class="row__ticket">${esc(ticket.label)}</div>
    <div class="row__main">
      <div class="row__name">${esc(ticket.name)}</div>
      <div class="row__meta">${ticket.service ? `${esc(ticket.service)} · ` : ''}${t('con.waitingMin', { count: waitedMin(ticket.createdAt) })}${ticket.phone ? ` · ${esc(ticket.phone)}` : ''}</div>
    </div>
    <div class="row__tools">
      <button class="icon-btn icon-btn--sm icon-btn--call" data-action="ticket-call" data-id="${ticket.id}"
              data-label="${esc(ticket.label)}" title="${esc(t('con.callNow'))}"
              aria-label="Call ${esc(ticket.label)} now">${icon('phone', 15)}</button>
      ${index > 0 ? `<button class="icon-btn icon-btn--sm" data-action="ticket-move" data-id="${ticket.id}" data-value="up"
        title="${esc(t('con.moveUp'))}" aria-label="${esc(t('con.moveUpOf', { label: ticket.label }))}">${icon('up', 15)}</button>` : ''}
      <button class="icon-btn icon-btn--sm" data-action="ticket-move" data-id="${ticket.id}" data-value="down"
              title="${esc(t('con.moveDown'))}" aria-label="${esc(t('con.moveDownOf', { label: ticket.label }))}">${icon('down', 15)}</button>
      <button class="icon-btn icon-btn--sm" data-action="ticket-remove" data-id="${ticket.id}" data-label="${esc(ticket.label)}"
              title="${esc(t('con.remove'))}" aria-label="${esc(t('con.removeOf', { label: ticket.label }))}">${icon('close', 15)}</button>
    </div>
  </div>`;
}

export function queueView(ui, ctx) {
  const { business, snapshot, connection, loading, error } = ctx;
  if (!snapshot) {
    return frame(ui, ctx, 'queue', `
      <div class="workspace workspace--queue">
        <div class="panel-stack">
          ${error ? errorPanel(error, { retryAction: 'reload-queue' }) : `<div class="card serving-panel">${loadingPanel()}</div>`}
        </div>
        <div class="card card--quiet side-panel">${skeletonRows(5)}</div>
      </div>`);
  }

  const queue = snapshot.queue;
  const waiting = snapshot.waiting;
  const search = (ui.search || '').trim().toLowerCase();
  const shown = search
    ? waiting.filter(t => `${t.label} ${t.name} ${t.phone}`.toLowerCase().includes(search))
    : waiting;
  const next = waiting[0];
  const serving = snapshot.serving;
  const busy = key => Boolean(ctx.busy && ctx.busy.has(key));
  const closed = queue.status === 'closed';

  const banner = queue.status === 'open' ? '' : `
    <div class="note ${queue.status === 'paused' ? '' : 'note--alert'}"
         style="margin:0 clamp(16px,3vw,40px) 16px;font-family:Poppins,sans-serif;font-size:14px">
      <strong>${queue.status === 'paused' ? t('con.pausedTitle') : t('con.closedTitle')}</strong>
      ${queue.status === 'paused' ? t('con.pausedBody') : t('con.closedBody')}
    </div>`;

  return frame(ui, ctx, 'queue', `
    ${banner}
    <div class="workspace workspace--queue">
      <div class="panel-stack">
        <div class="card serving-panel ${serving && serving.status === 'called' ? 'calling' : ''}">
          <div class="serving-head">
            <div>
              <div class="eyebrow eyebrow--wide" id="now-serving-label">${t('con.nowServing')}</div>
              <div class="numeral serving-now ${serving ? '' : 'serving-now--idle'}" data-anim-key="serving"
                   role="status" aria-live="polite" aria-labelledby="now-serving-label">
                ${serving ? esc(serving.label) : '—'}
              </div>
              <div class="row-flex gap-8" style="margin-top:8px">
                ${serving ? `
                  <span class="pill ${serving.status === 'serving' ? '' : 'pill--warn'}">
                    ${serving.status === 'serving' ? `<i class="tick"></i>${t('con.beingServed')}` : `<i class="dot dot--live"></i>${t('con.called')}`}
                  </span>
                  <span class="serving-who" style="font-size:15px;color:var(--ink-3)">
                    ${esc(serving.name)} · ${serving.status === 'serving'
                      ? t('con.minInService', { count: waitedMin(serving.servingAt) })
                      : t('con.waitingAtDesk', { when: ago(serving.calledAt) })}
                    ${serving.recallCount ? ` · ${t('con.calledTimes', { count: serving.recallCount + 1 })}` : ''}
                  </span>` : `
                  <span style="font-size:15px;color:var(--ink-3)">
                    ${closed ? t('con.queueClosed') : t('con.pressNext')}
                  </span>`}
              </div>
            </div>
            <div style="text-align:right">
              <div class="eyebrow eyebrow--wide">${t('con.next')}</div>
              <div class="serving-next" data-anim-key="next">${next ? esc(next.label) : '—'}</div>
              <div class="hint mt-4">${next ? esc(next.name) : t('con.queueClear')}</div>
            </div>
          </div>

          <div class="spacer" style="min-height:20px"></div>

          <button class="btn btn--hero" data-action="queue-next"
                  ${!waiting.length || busy('next') || closed ? 'disabled' : ''} ${busy('next') ? 'aria-busy="true"' : ''}>
            ${busy('next') ? `<span class="spinner"></span>&nbsp; ${t('con.calling')}` : `${t('con.nextCustomer')}${next ? ` · ${esc(next.label)}` : ''}`}
          </button>

          <div class="btn-row mt-16">
            <button class="btn btn--ghost btn--wide" style="flex:1.4 1 190px" data-action="open-add">+&nbsp; ${t('con.addCustomer')}</button>
            <button class="btn btn--quiet" data-action="queue-recall" ${serving ? '' : 'disabled'}>${t('con.callAgain')}</button>
            <button class="btn btn--quiet" data-action="ticket-skip" ${serving ? '' : 'disabled'}>${t('con.skip')}</button>
          </div>
          ${serving ? `
            <div class="btn-row mt-12">
              <button class="btn btn--quiet btn--sm" data-action="ticket-serving" data-id="${serving.id}"
                      ${serving.status === 'serving' ? 'disabled' : ''}>${t('con.startServing')}</button>
              <button class="btn btn--quiet btn--sm" data-action="ticket-complete" data-id="${serving.id}">${t('con.complete')}</button>
              <button class="btn btn--quiet btn--sm" data-action="ticket-noshow" data-id="${serving.id}">${t('con.noShow')}</button>
            </div>` : ''}
          <p class="hint mt-12">${t('con.shortcuts', {
              n: '<kbd>N</kbd>', a: '<kbd>A</kbd>', s: '<kbd>S</kbd>', p: '<kbd>P</kbd>', slash: '<kbd>/</kbd>'
            })}</p>
        </div>

        <div class="stats">
          <div class="stat"><div class="eyebrow">${t('con.waiting')}</div><b data-anim-key="waiting">${snapshot.counts.waiting}</b></div>
          <div class="stat"><div class="eyebrow">${t('con.servedToday')}</div><b>${snapshot.counts.completedToday}</b></div>
          <div class="stat"><div class="eyebrow">${t('con.avgWait')}</div><b>${snapshot.counts.waiting * queue.avgServiceMin}<small> ${t('common.minShort')}</small></b></div>
          <div class="stat"><div class="eyebrow">${t('con.nextNumber')}</div><b>${esc(queue.nextLabel)}</b></div>
        </div>
      </div>

      <div class="card card--quiet side-panel">
        <div class="between">
          <div class="eyebrow" style="letter-spacing:.24em">${t('con.waiting')}</div>
          <span class="hint">${snapshot.counts.waiting} ${t(snapshot.counts.waiting === 1 ? 'con.person' : 'con.people')}</span>
        </div>
        <div class="row-flex mt-12" style="position:relative">
          <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--ink-4);pointer-events:none">${icon('search', 16)}</span>
          <input class="input" data-keep="queue-search" data-search placeholder="${esc(t('con.search'))}"
                 aria-label="${esc(t('con.searchLabel'))}" value="${esc(ui.search || '')}"
                 style="padding-left:40px;min-height:48px;font-size:14px" />
        </div>
        <div class="side-panel__list rows">
          ${loading && !shown.length ? skeletonRows(4) : shown.length
            ? shown.map((ticket, i) => waitingRow(ticket, i, ctx)).join('')
            : `<div class="empty" style="margin-top:16px">
                 <strong>${search ? t('con.noMatch')
                   : closed ? t('con.queueClosed')
                     : t('con.noOneWaiting')}</strong>
                 <span>${search ? t('con.noMatchHint')
                   : closed ? t('con.reopenHint')
                     : t('con.queueClear')}</span>
               </div>`}
        </div>
      </div>

      <aside class="context-panel">
        <div class="card card--quiet stack gap-16">
          <div class="eyebrow" style="letter-spacing:.24em">${t('con.today')}</div>
          ${ctx.analytics ? `
            <div class="stack gap-12">
              ${[[t('con.avgWait'), `${ctx.analytics.summary.avgWaitMin} ${t('common.minShort')}`],
                 [t('con.avgService'), `${ctx.analytics.summary.avgServiceMin} ${t('common.minShort')}`],
                 [t('con.completed'), ctx.analytics.summary.completed],
                 [t('con.skipped'), ctx.analytics.summary.skipped],
                 [t('con.noShows'), ctx.analytics.summary.noShow]].map(([label, value]) => `
                <div class="between"><span class="hint">${label}</span><strong style="font-size:15px;font-weight:500">${esc(value)}</strong></div>`).join('')}
            </div>` : '<div class="skeleton" style="height:120px;border-radius:20px"></div>'}
        </div>
        <div class="card card--quiet stack gap-12" style="flex:1;min-height:0">
          <div class="eyebrow" style="letter-spacing:.24em">${t('con.recentActivity')}</div>
          <div class="stack gap-8" style="overflow-y:auto">
            ${(ctx.analytics?.activity || []).slice(0, 10).map(event => `
              <div class="between" style="gap:8px">
                <span class="hint" style="color:var(--ink-3)">${esc(activityLabel(event))}</span>
                <span class="hint">${ago(event.createdAt)}</span>
              </div>`).join('') || `<span class="hint">${t('con.nothingYet')}</span>`}
          </div>
        </div>
      </aside>
    </div>
    ${ui.addOpen ? addSheet(ui, ctx) : ''}`);
}

/** A rounded 0 with samples behind it means "under a minute", not "no data". */
const duration = (summary, field, samples) => {
  if (!summary) return '—';
  if (!summary[samples]) return '—';
  return summary[field] || '<1';
};

/* Event types come from the server as stable keys, which is exactly what a
   dictionary lookup wants — an unknown one falls back to the raw key rather
   than to English. */
const activityLabel = event => {
  const word = t(`act.${event.type}`);
  const label = word === `act.${event.type}` ? event.type : word;
  return `${label}${event.data?.label ? ` · ${event.data.label}` : ''}`;
};

function loadingPanel() {
  return `
    <div class="stack gap-16">
      <div class="skeleton" style="width:120px;height:12px"></div>
      <div class="skeleton" style="width:260px;height:96px;border-radius:26px"></div>
      <div class="skeleton" style="width:100%;height:64px;border-radius:26px"></div>
    </div>`;
}

function addSheet(ui, { business, services }) {
  const chosen = ui.add.serviceId || '';
  return `
  <div class="scrim" data-action="close-scrim">
    <form class="sheet" data-action="add-customer" novalidate>
      <div class="sheet__grip"></div>
      <h2>${t('con.addTitle')}</h2>
      <p class="hint mt-4">${t('con.addHint')}</p>
      <div class="stack gap-16 mt-24">
        <div class="field ${ui.add.error ? 'field--bad' : ''}">
          <label for="add-name">${t('common.name')}</label>
          <input id="add-name" name="add-name" data-keep="add-name" value="${esc(ui.add.name)}"
                 placeholder="${esc(t('con.customerName'))}" autofocus />
          ${ui.add.error ? `<span class="error-text">${esc(ui.add.error)}</span>` : ''}
        </div>
        <div class="field-row">
          <div class="field">
            <label for="add-phone">${t('common.phone')} <span>${t('common.optional')}</span></label>
            <input id="add-phone" name="add-phone" type="tel" data-keep="add-phone" value="${esc(ui.add.phone)}" placeholder="+252 …" />
          </div>
          ${services.length ? `
            <div class="field">
              <label>${t('con.service')} <span>${t('common.optional')}</span></label>
              <div class="chips">
                ${services.map(service => `
                  <button type="button" class="chip" data-action="pick-add-service" data-id="${service.id}"
                          aria-pressed="${chosen === service.id}">${esc(service.name)}</button>`).join('')}
              </div>
            </div>` : ''}
        </div>
      </div>
      <div class="btn-row mt-24">
        <button type="button" class="btn btn--quiet" data-action="close-add">${t('common.cancel')}</button>
        <button type="submit" class="btn" style="flex:2 1 200px" ${ui.busy ? 'disabled aria-busy="true"' : ''}>${t('con.addToQueue')}</button>
      </div>
    </form>
  </div>`;
}

export function overviewView(ui, ctx) {
  const { business, snapshot, analytics, error } = ctx;
  if (error && !snapshot) {
    return frame(ui, ctx, 'overview', `
      <div class="workspace">${errorPanel(error, { retryAction: 'reload-queue', title: t('con.todayFailed') })}</div>`);
  }
  const summary = analytics?.summary;
  const waiting = snapshot?.waiting || [];
  const joinUrl = `${ctx.joinBase}/j/${business.slug}`;
  const qr = business.qrSettings;

  return frame(ui, ctx, 'overview', `
    <div class="workspace">
      <div class="between">
        <div>
          <div class="eyebrow eyebrow--brand" style="letter-spacing:.24em">${today()}</div>
          <h1 class="serif mt-8">${esc(business.name)}</h1>
        </div>
        <div class="btn-row">
          <button class="btn btn--quiet btn--auto btn--sm" data-action="download-report">
            ${icon('report', 15)}&nbsp; ${t('con.downloadReport')}
          </button>
          <a class="btn btn--ghost btn--auto btn--sm" href="#/queue">${t('con.openQueue')}</a>
        </div>
      </div>

      <div class="stats mt-24" style="gap:24px">
        <!-- The headline figure, and the one place a dash is not a number.
             Drawn at display scale, an em-dash is a wide pale bar sitting where
             a value belongs — it reads as a skeleton that never resolves. The
             idle class takes it back down to text size; the sentence underneath
             is what actually says nobody is being served. -->
        <div class="stat stat--wide">
          <div class="eyebrow" style="letter-spacing:.24em">${t('con.nowServing')}</div>
          <b class="numeral ${snapshot?.serving ? '' : 'numeral--idle'}" data-anim-key="serving">${snapshot?.serving ? esc(snapshot.serving.label) : '—'}</b>
          <div class="hint mt-4">${snapshot?.serving ? esc(snapshot.serving.name) : t('con.nobodyInService')}</div>
        </div>
        <div class="stat"><div class="eyebrow">${t('con.waiting')}</div><b>${snapshot?.counts.waiting ?? '—'}</b></div>
        <div class="stat"><div class="eyebrow">${t('con.completed')}</div><b>${summary ? summary.completed : '—'}</b></div>
        <div class="stat"><div class="eyebrow">${t('con.avgWait')}</div><b>${duration(summary, 'avgWaitMin', 'waitSamples')}<small> ${t('common.minShort')}</small></b></div>
        <div class="stat"><div class="eyebrow">${t('con.avgService')}</div><b>${duration(summary, 'avgServiceMin', 'serviceSamples')}<small> ${t('common.minShort')}</small></b></div>
      </div>

      <div class="grid grid--auto mt-24" style="align-items:start">
        <div class="card card--quiet stack gap-16" style="grid-column:span 2;min-width:0">
          <div class="between">
            <div class="eyebrow" style="letter-spacing:.24em">${t('con.upNext')}</div>
            <span class="hint">${waiting.length} ${t('con.inLine')}</span>
          </div>
          <div class="rows">
            ${!snapshot ? skeletonRows(4) : waiting.slice(0, 6).map((ticket, i) => `
              <div class="row" style="--i:${i}">
                <div class="row__ticket">${esc(ticket.label)}</div>
                <div class="row__main">
                  <div class="row__name">${esc(ticket.name)}</div>
                  <div class="row__meta">${t('con.waitingMin', { count: waitedMin(ticket.createdAt) })}</div>
                </div>
                <div class="row__aside">${esc(ticket.service || '')}</div>
              </div>`).join('') || `<div class="empty"><strong>${t('con.noOneWaiting')}</strong><span>${t('con.queueClear')}</span></div>`}
          </div>
          <hr class="rule" />
          <div class="row-flex gap-24">
            <div><div class="eyebrow">${t('con.busiestHour')}</div>
              <div style="font-size:17px;font-weight:500;margin-top:2px">${summary?.busiestHour != null ? `${String(summary.busiestHour).padStart(2, '0')}:00` : '—'}</div></div>
            <div><div class="eyebrow">${t('con.opens')}</div>
              <div style="font-size:17px;font-weight:500;margin-top:2px">${esc(business.queueSettings.opensAt)}</div></div>
            <div><div class="eyebrow">${t('con.closes')}</div>
              <div style="font-size:17px;font-weight:500;margin-top:2px">${esc(business.queueSettings.closesAt)}</div></div>
            <div><div class="eyebrow">${t('con.skipped')}</div>
              <div style="font-size:17px;font-weight:500;margin-top:2px">${summary ? summary.skipped : '—'}</div></div>
          </div>
        </div>

        <div class="card stack gap-16" style="align-items:center;text-align:center">
          <div class="eyebrow" style="letter-spacing:.24em;color:var(--clay)">${esc(qr.signHeadline)}</div>
          <div class="qr-frame" style="background:${esc(qr.background)}">
            ${qrSvg(joinUrl, {
              size: 180, shape: qr.shape, dark: qr.foreground, light: qr.background,
              eye: qr.eyeColor || qr.foreground, logo: qr.logoOnCode ? business.logo : '', quiet: qr.quietZone
            })}
          </div>
          <div>
            <div style="font-size:14px;font-weight:500">${esc(joinUrl.replace(/^https?:\/\//, ''))}</div>
            <div class="hint mt-4">${t('con.printIt')}</div>
          </div>
          <div class="btn-row" style="width:100%">
            <button class="btn btn--quiet btn--sm" data-action="copy-link">${icon('copy', 15)}&nbsp; ${t('con.copyLink')}</button>
            <a class="btn btn--quiet btn--sm" href="#/sign" style="text-align:center">${icon('print', 15)}&nbsp; ${t('con.sign')}</a>
          </div>
          <button class="btn btn--ghost btn--sm" style="width:100%" data-action="open-display">
            ${icon('screen', 15)}&nbsp; ${t('display.open')}
          </button>
          <p class="hint" style="text-align:center">${t('display.hint')}</p>
        </div>
      </div>

      ${summary?.services?.length ? `
        <div class="card card--quiet stack gap-16 mt-24">
          <div class="eyebrow" style="letter-spacing:.24em">${t('con.servicePerformance')}</div>
          <div class="rows">
            ${summary.services.map((service, i) => `
              <div class="row" style="--i:${i}">
                <div class="row__main">
                  <div class="row__name">${esc(service.name)}</div>
                  <div class="row__meta">${t('con.completedOf', { done: service.completed, total: service.total })}</div>
                </div>
                <div class="row__aside">${t('con.avgMinutes', { count: service.avgServiceMin })}</div>
              </div>`).join('')}
          </div>
        </div>` : ''}
    </div>`);
}

/* A reminder, not a barrier. The account already works; confirming the address
   is what lets an owner recover it and what binds a staff invitation, so the
   strip says why rather than simply nagging. It sits in the flow of the page
   instead of over it — nothing to dismiss before the dashboard can be used. */
function verifyStrip(ui) {
  const user = sessionState.user;
  if (!user || user.emailVerified !== false || ui.verifyDismissed) return '';
  return `
  <div class="verify-strip" role="status">
    <span class="verify-strip__dot" aria-hidden="true"></span>
    <p class="verify-strip__text">
      <strong>${esc(t('verify.title'))}</strong>
      <span>${esc(t('verify.body', { email: user.email }))}</span>
    </p>
    <span class="verify-strip__actions">
      <button class="btn btn--quiet btn--auto btn--sm" data-action="resend-verification" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
        ${ui.busy ? t('auth.sending') : t('verify.resend')}
      </button>
      <button class="btn btn--quiet btn--auto btn--sm" data-action="check-verification" ${ui.busy ? 'disabled' : ''}>${t('verify.recheck')}</button>
      <button class="icon-btn verify-strip__close" data-action="dismiss-verify" aria-label="${esc(t('verify.dismiss'))}">${icon('close')}</button>
    </span>
  </div>`;
}

/** Wraps a console screen in the branded frame plus chrome. */
export function frame(ui, ctx, current, inner) {
  const { business } = ctx;
  return `
  <div class="${cx('screen', current === 'queue' && 'screen--fixed')}">
    ${chrome(current, ctx)}
    <main id="main">${inner}</main>
    <!-- After the work, not in front of it.
         This sat between the chrome and the page, so a standing reminder about
         an email address outranked every heading on every screen — the first
         thing the eye met on the queue was a note about something that can wait
         indefinitely. It is still here, still dismissible, and still says the
         same thing; it just no longer claims to be the most important object on
         the page. -->
    ${verifyStrip(ui)}
    <footer class="console-footer">${watermark()}${madeBy()}</footer>
    ${mobileNav(current)}
    ${ui.accountOpen ? accountSheet(ctx) : ''}
  </div>`;
}

/* The dashboard belongs to the business, so this sheet leads with the business
   and the caller's role in it. The personal name and email live in
   Settings → Account, which is one tap away. */
function accountSheet({ business, user, role }) {
  return `
  <div class="scrim" data-action="close-scrim" role="dialog" aria-modal="true" aria-label="${esc(business.name)}">
    <div class="sheet sheet--dialog">
      <div class="sheet__grip"></div>

      <div class="row-flex gap-16">
        ${logoMark(business, 'lg')}
        <div style="min-width:0">
          <div class="serif" style="font-size:19px;font-weight:500">${esc(business.name)}</div>
          <div class="hint">${esc(t('con.youAre', { role: role || 'staff' }))}</div>
        </div>
      </div>

      <div class="stack gap-12 mt-24">
        <a class="btn btn--quiet" href="#/brand" style="text-align:center">${t('con.brandPage')}</a>
        <a class="btn btn--quiet" href="#/settings" style="text-align:center">${t('con.settings')}</a>
        <button class="btn btn--quiet" data-action="sign-out">${icon('logout', 16)}&nbsp; ${t('con.signOut')}</button>
      </div>
    </div>
  </div>`;
}
