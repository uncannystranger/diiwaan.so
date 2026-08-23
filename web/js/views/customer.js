/* The customer side: join, ticket, called, offline. Canvas frames 1–4, wearing
   the business's brand rather than Diiwaan's. */

import {
  esc, logoMark, wordmark, themeButton, languageButton, clock, ago,
  skeletonBlock, errorPanel, icon, watermark, madeBy
} from '../ui.js';
import { t } from '../i18n.js';

const headline = (ahead, called) => {
  if (called) return t('cust.itIsYourTurn');
  if (ahead === 0) return t('cust.youAreNext');
  if (ahead <= 2) return t('cust.almost');
  return t('cust.inQueue');
};

/* The customer's page is the company's page. Their mark sits centred at the top
   with their name directly beneath it — the first thing a scanned code should
   confirm is that you are in the right place. Diiwaan's own name appears once,
   quietly, at the very bottom. */
function shell(view, inner, { connection, extra = '' } = {}) {
  const business = view.business;
  const trouble = connection === 'offline' || connection === 'reconnecting';

  return `
  <div class="screen screen--customer">
    <div class="cust-tools">
      ${trouble ? `
        <span class="pill ${connection === 'offline' ? 'pill--warn' : 'pill--mute'}">
          ${connection === 'offline'
            ? `<i class="dot dot--hollow"></i>${t('status.noSignal')}`
            : `<span class="spinner"></span>${t('status.reconnecting')}`}
        </span>` : ''}
      <span class="cust-tools__controls">${languageButton()}${themeButton()}</span>
    </div>

    <header class="cust-head">
      ${logoMark(business, 'xl')}
      <h1 class="cust-head__name">${esc(business.name)}</h1>
      ${business.city || business.address
        ? `<p class="cust-head__where">${esc(business.city || business.address)}</p>` : ''}
    </header>
    ${extra}
    ${inner}

    <footer class="cust-foot">
      ${watermark()}
      ${madeBy()}
    </footer>
  </div>`;
}

export function customerLoading() {
  return `
  <div class="screen">
    <div class="topbar"><div class="row-flex gap-12">
      <span class="skeleton" style="width:44px;height:44px;border-radius:14px"></span>
      <span class="skeleton" style="width:140px;height:16px"></span>
    </div></div>
    <div class="stage">
      <div class="customer-split">
        <div class="stack gap-16">
          <span class="skeleton" style="width:70%;height:38px;border-radius:12px"></span>
          <span class="skeleton" style="width:50%;height:16px;border-radius:8px"></span>
        </div>
        ${skeletonBlock(320)}
      </div>
    </div>
  </div>`;
}

export function customerErrorView(error) {
  /* Three different things send a customer here and each needs its own sentence:
     a wrong link, a queue that is closed, and a phone that lost signal. */
  const offline = error?.offline;
  const missing = error?.status === 404;
  const title = offline ? t('cust.offlineTitle')
    : missing ? t('cust.notFound')
      : t('cust.didNotLoad');
  const advice = offline ? t('cust.offlineAdvice')
    : missing ? t('cust.notFoundBody')
      : t('cust.didNotLoadBody');

  return `
  <div class="screen">
    <div class="topbar">${wordmark(15)}<span class="row-flex gap-8">${languageButton()}${themeButton()}</span></div>
    <div class="stage stage--narrow" style="justify-content:center">
      ${errorPanel(error, { retryAction: 'reload-customer', title })}
      <p class="hint center mt-16">${esc(advice)}</p>
    </div>
  </div>`;
}

export function joinView(ui, { view, connection }) {
  const business = view.business;
  const page = business.experience;
  const closed = view.queue.status !== 'open';
  const services = page.askService ? view.services : [];
  const chosen = ui.join.serviceId || '';

  const notice = closed
    ? `<div class="note note--alert" style="margin:0 clamp(20px,3.5vw,44px)">
         ${esc(view.queue.status === 'paused' ? page.pausedMessage : page.closedMessage)}
       </div>`
    : '';

  return shell(view, `
    <div class="stage">
      <div class="customer-split">
        <div class="stack gap-24">
          ${ui.greeted && ui.join.name ? `
            <div class="welcome-back">
              <span>${esc(t('cust.welcomeBack', { name: ui.join.name }))}</span>
              <button type="button" class="btn btn--link btn--sm" data-action="forget-me">${t('cust.notYou')}</button>
            </div>` : ''}
          <h1 class="serif">${esc(page.headline)}</h1>
          <p class="lead" style="max-width:46ch">${esc(page.subheading)}</p>
          ${business.description ? `<p class="hint" style="font-size:14px">${esc(business.description)}</p>` : ''}

          <div class="grid" style="max-width:540px;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px">
            <div class="stat">
              <div class="eyebrow">${t('cust.nowServing')}</div>
              <b data-anim-key="serving">${view.serving ? esc(view.serving.label) : '—'}</b>
            </div>
            <div class="stat">
              <div class="eyebrow">${t('cust.waiting')}</div>
              <b data-anim-key="waiting">${view.waitingCount}</b>
            </div>
            ${page.showEstimate ? `
              <div class="stat">
                <div class="eyebrow">${t('cust.wait')}</div>
                <b>${view.estimateMin}<small> ${t('common.minShort')}</small></b>
              </div>` : ''}
          </div>
        </div>

        <form class="card stack gap-20" data-action="join-queue" novalidate data-shown="${Date.now()}">
          <div class="trap" aria-hidden="true">
            <label for="join-company">Company</label>
            <input id="join-company" name="company" type="text" tabindex="-1" autocomplete="off" />
          </div>
          <div class="field ${ui.join.errors.name ? 'field--bad' : ''}">
            <label for="join-name">${t('common.name')}</label>
            <input id="join-name" name="join-name" type="text" autocomplete="name" placeholder="${esc(t('cust.yourName'))}"
                   data-keep="join-name" value="${esc(ui.join.name)}" required />
            ${ui.join.errors.name ? `<span class="error-text">${esc(ui.join.errors.name)}</span>` : ''}
          </div>
          <div class="field ${ui.join.errors.phone ? 'field--bad' : ''}">
            <label for="join-phone">${t('common.phone')} ${page.requirePhone ? '' : `<span>${t('common.optional')}</span>`}</label>
            <input id="join-phone" name="join-phone" type="tel" autocomplete="tel" placeholder="+252 …"
                   data-keep="join-phone" value="${esc(ui.join.phone)}" />
            ${ui.join.errors.phone ? `<span class="error-text">${esc(ui.join.errors.phone)}</span>` : ''}
          </div>
          ${services.length ? `
            <div class="field">
              <label>${t('cust.whatDoYouNeed')} <span>${t('common.optional')}</span></label>
              <div class="chips">
                ${services.map(service => `
                  <button type="button" class="chip" data-action="pick-service" data-id="${service.id}"
                          aria-pressed="${chosen === service.id}">${esc(service.name)}</button>`).join('')}
              </div>
            </div>` : ''}
          <p class="hint">${t('cust.phoneUse')}</p>
          ${ui.join.errors.form ? `<p class="error-text">${esc(ui.join.errors.form)}</p>` : ''}
          <button class="btn" type="submit" ${closed || ui.busy ? 'disabled' : ''} ${ui.busy ? 'aria-busy="true"' : ''}>
            ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('cust.joining')}` : t('cust.join')}
          </button>
          <p class="hint center">${t('cust.nextNumber')} <strong>${esc(view.queue.nextLabel)}</strong> · ${clock()}</p>
        </form>
      </div>
    </div>`, { connection, extra: notice });
}

export function ticketView(ui, { view, connection }) {
  const business = view.business;
  const page = business.experience;
  const ticket = view.ticket;
  const called = ticket.status === 'called' || ticket.status === 'serving';
  const ahead = ticket.ahead;
  const start = Math.max(1, ticket.aheadAtJoin || ahead || 1);
  const progress = called ? 100 : Math.min(100, Math.round(((start - ahead) / start) * 100));
  const offline = connection === 'offline';

  const offlineBanner = offline ? `
    <div class="stage" style="padding-bottom:0">
      <div class="note row-flex gap-12" style="font-family:Poppins,sans-serif;font-size:14px">
        <span style="width:32px;height:32px;border-radius:50%;border:2px solid color-mix(in srgb, var(--brand) 60%, transparent);display:grid;place-items:center;flex:none">
          <i class="dot" style="background:var(--brand)"></i>
        </span>
        <span>${t('cust.offlineBody')}${view.at ? ` (${ago(view.at)})` : ''}</span>
      </div>
    </div>` : '';

  return shell(view, `
    <div class="stage">
      <div class="customer-split customer-split--even">
        <div class="card stack gap-16 ${called ? 'calling' : ''}" style="text-align:center;align-items:center">
          <div class="eyebrow eyebrow--wide">${t('cust.yourNumber')}</div>
          <div class="numeral numeral--xl" data-anim-key="myticket">${esc(ticket.label)}</div>
          <div class="serif" style="font-size:20px;font-style:italic;color:var(--clay)">${headline(ahead, called)}</div>
          ${called
            ? `<p class="lead">${esc(page.calledMessage)}</p>`
            : page.showProgress ? `
              <div class="queue-line" style="width:100%;max-width:380px">
                <div class="meter meter--journey" data-anim-key="progress">
                  <i style="width:${progress}%"></i>
                  <!-- Rides the filled part, so the line reads as a queue that is
                       moving rather than a bar that happens to be part-full. -->
                  <span class="meter__pulse" style="left:${progress}%"></span>
                </div>
                <div class="queue-line__ends">
                  <span>${esc(t('cust.joined'))}</span>
                  <span>${esc(t('cust.yourNumber'))}</span>
                </div>
              </div>` : ''}
          ${ticket.service ? `<span class="pill pill--mute">${esc(ticket.service)}</span>` : ''}
        </div>

        <div class="stack gap-20">
          <div class="card stack gap-16">
            <div class="row-flex" style="gap:0">
              ${page.showPeopleAhead ? `
                <div style="flex:1">
                  <div class="eyebrow">${t('cust.aheadOfYou')}</div>
                  <div class="numeral numeral--lg mt-4" ${offline ? 'style="color:var(--ink-4)"' : ''} data-anim-key="ahead">${ahead}</div>
                </div>` : ''}
              <div style="width:1px;align-self:stretch;background:var(--hairline)"></div>
              <div style="flex:1;padding-left:22px">
                <div class="eyebrow">${offline ? t('cust.lastUpdate') : page.showEstimate ? t('cust.approxWait') : t('cust.joined')}</div>
                <div class="numeral numeral--lg mt-4" ${offline ? 'style="color:var(--ink-4)"' : ''}>
                  ${offline
                    ? `${esc(ago(view.at))}`
                    : page.showEstimate
                      ? `${ticket.estimateMin}<small style="font-size:16px;font-weight:400;color:var(--ink-4)"> ${t('common.minShort')}</small>`
                      : clock(new Date(ticket.joinedAt))}
                </div>
              </div>
            </div>
            <hr class="rule" />
            <div class="between">
              <span style="font-size:13px;color:var(--ink-3)">${t('cust.nowServing')}</span>
              <span class="numeral numeral--md numeral--brand" data-anim-key="serving">
                ${view.serving ? esc(view.serving.label) : '—'}
              </span>
            </div>
          </div>

          <div class="note${offline ? ' note--green' : ''}">
            ${esc(offline ? t('cust.offlineSaved') : page.ticketNote)}
          </div>

          ${page.instructions ? `<p class="hint">${esc(page.instructions)}</p>` : ''}

          <div class="btn-row">
            <button class="btn btn--quiet" data-action="leave-queue" ${offline ? 'disabled' : ''}>${t('cust.leave')}</button>
            <button class="btn btn--quiet" data-action="notify" aria-pressed="${!!ui.notifyOn}">
              ${ui.notifyOn ? t('cust.alertsOn') : t('cust.alertMe')}
            </button>
          </div>
        </div>
      </div>

      <p class="center hint mt-24">${t('cust.keepOpen')}</p>
    </div>`, { connection, extra: offlineBanner });
}

/** Their number has been served, or the desk removed them. */
export function doneView(ui, { view, connection }) {
  const business = view.business;
  return shell(view, `
    <div class="stage stage--narrow">
      <div class="stack gap-16" style="flex:1;justify-content:center;align-items:center;text-align:center">
        <h1 class="serif">${t('cust.turnPassed')}</h1>
        <p class="lead" style="max-width:34ch">${esc(t('cust.turnPassedBody', { business: business.name }))}</p>
        <div style="width:100%;max-width:320px" class="mt-16">
          <button class="btn" data-action="rejoin">${t('cust.joinAgain')}</button>
        </div>
      </div>
    </div>`, { connection });
}

/** An offline join that has not reached the server yet. */
export function pendingView(ui, { view, connection }) {
  return shell(view, `
    <div class="stage stage--narrow">
      <div class="card stack gap-16" style="margin:auto 0">
        <span class="pill pill--warn" style="align-self:flex-start"><i class="dot dot--hollow"></i>${t('cust.savedWillSync')}</span>
        <h1>${t('cust.pendingTitle')}</h1>
        <p class="lead">${esc(t('cust.pendingBody', { name: ui.join.name || '—' }))}</p>
        <div class="btn-row">
          <button class="btn btn--quiet" data-action="retry-join">${icon('refresh', 15)}&nbsp; ${t('common.tryNow')}</button>
          <button class="btn btn--quiet" data-action="cancel-pending">${t('common.cancel')}</button>
        </div>
      </div>
    </div>`, { connection });
}
