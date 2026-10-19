/* The way an owner gets into Diiwaan: landing, sign up, sign in, reset.
   Same canvas language — glass cards, 22px buttons, Lora headings. */

import { esc, wordmark, themeButton, languageButton, icon, madeBy, diiwaanMark } from '../ui.js';
import { t } from '../i18n.js';
import { googleAuthAvailable, googleAuthReason, isProduction, oauthError, state as sessionState } from '../session.js';

/* When the API itself is unreachable, no form on this page can succeed. Saying
   so above the form is more useful than letting each attempt fail with a
   message about credentials. */
function serviceNotice() {
  if (!sessionState.backendError) return '';
  return `
    <div class="note note--alert" role="alert">
      <strong>${t('auth.serviceDown')}</strong>
      <span class="hint" style="display:block;margin-top:6px">${esc(sessionState.backendError)}</span>
    </div>`;
}

/* Google's mark, drawn rather than fetched: the strict image policy keeps remote
   assets out, and a four-colour G is four paths. */
const googleMark = (size = 18) => `
  <svg width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.2-.4-4.6H24v9.1h12.4c-.5 2.9-2.2 5.4-4.7 7l7.6 5.9c4.4-4.1 6.8-10.2 6.8-17.4z"/>
    <path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.8-6.1C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.8-6.1z"/>
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.3 0-11.7-3.7-13.6-9.1l-7.8 6.1C6.5 42.6 14.6 48 24 48z"/>
  </svg>`;

/* Offered under the primary action rather than above it: an owner creating a
   queue for the first time is choosing how to sign in, not being sold a
   provider. It only appears when Google is actually switched on. */
/* Always rendered.
 *
 * It used to be withheld whenever the server's probe said Google would refuse
 * the redirect, which kept anyone from meeting a dead control — and also meant
 * the product silently lost a sign-in method with no explanation to the person
 * looking for it. A control that is part of the product should be visible and
 * should answer honestly when pressed. So the probe no longer decides whether
 * the button exists; it decides what pressing it says. */
function googleButton(ui) {

  /* Disabled while it is working as well as while the form is: this navigates
     away, so a second press would start a second authorisation and discard the
     first. aria-busy tells a screen reader the same thing the spinner tells
     everyone else. */
  const working = Boolean(ui?.googleBusy);

  /* A button that cannot do the thing it names is disabled, and says why.
   *
   * This screen used to render it live whatever the server reported, on the
   * reasoning that a control belonging to the product should be visible and
   * answer honestly when pressed. Visible was right; live was not. Pressing it
   * on a deployment where Google is switched off ran the whole click handler to
   * reach a guard several layers down, and the person got a sentence about
   * configuration in place of the sign-in they asked for. Disabled says the
   * same thing before the click, which is where an answer is worth having, and
   * it leaves the method visible so nobody wonders where it went. */
  const available = googleAuthAvailable();
  const disabled = working || ui?.busy || !available;

  return `
    <div class="or-rule"><span>${t('auth.orContinue')}</span></div>
    <button type="button" class="btn btn--google" data-action="google-auth"
            ${disabled ? 'disabled' : ''} ${working ? 'aria-busy="true"' : ''}
            ${available ? '' : `aria-describedby="google-why"`}>
      ${working ? '<span class="spinner"></span>' : googleMark(19)}
      <span>${working ? t('auth.googleGoing') : t('auth.google')}</span>
    </button>
    ${available
      ? `<p class="hint center">${t('auth.googleHint')}</p>`
      : `<p class="hint center" id="google-why">${esc(unavailableSentence())}</p>`}
    ${configNote()}`;
}

/* Said to whoever is trying to sign in, so it is about them and not about the
   deployment: what to do now, in plain words, in either language. The technical
   reason stays in configNote(), which production never shows. */
function unavailableSentence() {
  return googleAuthReason() === 'probe_failed'
    ? t('auth.googleUnreachable')
    : t('auth.googleUnavailable');
}

/* Why the button is absent — shown only where the server chose to say, which is
   never in production. A person signing in should not read configuration notes;
   a developer staring at a missing button should not have to guess. */
function configNote() {
  /* Shown only outside production. The API reports the reason everywhere now,
     so an operator can ask; a customer signing in still reads nothing about
     configuration. */
  if (isProduction()) return '';
  const reason = googleAuthReason();
  if (!reason || reason === 'ok' || reason === 'turned_off') return '';
  const words = {
    provider_disabled: t('auth.googleOffProvider'),
    no_auth_domain: t('auth.googleOffRedirect'),
    probe_failed: t('auth.googleOffUnknown'),
    checking: t('auth.googleChecking')
  };
  return `
    <p class="hint center" style="opacity:.75">${esc(words[reason] || reason)}</p>`;
}

function shell(inner) {
  return `
  <div class="screen">
    <div class="topbar">
      <a href="/" aria-label="${esc(t('auth.home'))}">${wordmark(16)}</a>
      <div class="topbar__right">${languageButton()}${themeButton()}</div>
    </div>
    ${inner}
    <footer class="auth-footer">${madeBy()}</footer>
  </div>`;
}

/**
 * Shown when boot could not find out whether anybody is signed in.
 *
 * The landing page used to stand in for this, which told an owner whose refresh
 * hit a cold server that they had been signed out — they had not, and the page
 * offering them a free trial was the wrong answer to a network problem. This
 * says the true thing and offers the only useful action.
 */
export function reconnectView(ui) {
  return shell(`
    <div class="stage stage--entry">
      <div class="reconnect">
        <div class="reconnect__pulse" aria-hidden="true"><span></span><span></span><span></span></div>
        <h1 class="serif">${t('boot.unreachableTitle')}</h1>
        <p class="lead" style="max-width:44ch">${t('boot.unreachableBody')}</p>
        ${sessionState.backendError
          ? `<p class="hint" style="max-width:44ch">${esc(sessionState.backendError)}</p>` : ''}
        <div class="btn-row" style="max-width:340px">
          <button type="button" class="btn entry-cta entry-cta--primary"
                  data-action="retry-boot" ${ui?.busy ? 'disabled aria-busy="true"' : ''}>
            ${ui?.busy ? `<span class="spinner"></span>` : ''}
            <span>${ui?.busy ? t('boot.retrying') : t('boot.retry')}</span>
          </button>
        </div>
        <p class="hint">
          <a class="btn--link" href="/signin">${t('auth.signIn')}</a>
        </p>
      </div>
    </div>`);
}

export function landingView(ui = {}) {
  const active = [0, 1, 2].includes(ui.landingStep) ? ui.landingStep : 0;
  const steps = ['scan', 'number', 'wait'];
  const qr = `<svg viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5 5h30v30H5zm6 6v18h18V11zM65 5h30v30H65zm6 6v18h18V11zM5 65h30v30H5zm6 6v18h18V71z"/><path d="M16 16h8v8h-8m60-8h8v8h-8M16 76h8v8h-8M43 5h9v12h-9m0 9h12v9H43M5 43h12v9H5m21 0h9v13h-9m17-12h9v9h-9m15 0h9v20h-9m18-20h19v9H76M43 61h9v18h-9m14-9h9v12h-9m16-16h9v9h-9m13-13h9v16h-9M43 87h20v8H43m26-16h8v16h-8m13-11h13v11H82"/></svg>`;
  return `
  <div class="screen product-landing" data-depth="0">
    <header class="topbar product-nav">
      <a href="/" aria-label="${esc(t('auth.home'))}">${wordmark(20)}</a>
      <div class="topbar__right">${languageButton()}${themeButton()}<a class="product-nav__signin" href="/signin">${t('auth.signIn')} <span aria-hidden="true">↗</span></a></div>
    </header>
    <main class="product-home">
      <section class="product-hero" aria-labelledby="product-title">
        <div class="product-hero__copy" data-depth="4">
          <p class="product-eyebrow"><span></span> ${t('auth.platformEyebrow')}</p>
          <h1 id="product-title"><span class="product-line"><span>${t('auth.platformLine1')}</span></span><span class="product-line"><span>${t('auth.platformLine2')}</span></span></h1>
          <p class="product-lead">${t('auth.lead')}</p>
          <div class="product-actions"><a class="btn product-primary" href="/signup">${t('auth.createQueue')} <span aria-hidden="true">↗</span></a><a class="product-text-link" href="/signin">${t('auth.signIn')}</a></div>
          ${!ui.designPreview && googleAuthAvailable() ? `<button type="button" class="btn btn--google" data-action="google-auth" ${ui.googleBusy ? 'disabled aria-busy="true"' : ''}>${googleMark(18)}<span>${ui.googleBusy ? t('auth.googleGoing') : t('auth.google')}</span></button>` : ui.designPreview ? '' : configNote()}
          ${ui.auth?.errors?.form ? `<p class="error-text">${esc(ui.auth.errors.form)}</p>` : ''}
          <div class="product-promise"><span>${icon('check',15)} ${t('auth.platformPromise1')}</span><span>${icon('check',15)} ${t('auth.platformPromise2')}</span></div>
        </div>
        <div class="queue-machine" data-depth="3" aria-label="${esc(t('auth.previewTitle'))}">
          <div class="queue-machine__head"><span>${diiwaanMark(17)} DIIWAAN</span><span class="machine-status">${t('auth.platformSample')}</span></div>
          <div class="queue-machine__body" aria-live="polite">
            <div class="machine-rail" aria-hidden="true"><i class="${active===0?'is-active':''}">01</i><span></span><i class="${active===1?'is-active':''}">02</i><span></span><i class="${active===2?'is-active':''}">03</i></div>
            <div class="machine-scene" data-step="${active}">
              <div class="machine-scan ${active===0?'scene-active':''}" aria-hidden="${active!==0}"><div class="scan-card"><span class="scan-corner"></span>${qr}<div class="scan-beam"></div></div><p>${t('auth.step.scan')}</p></div>
              <div class="machine-ticket ${active===1?'scene-active':''}" aria-hidden="${active!==1}"><span class="product-eyebrow">${t('auth.yourNumber')}</span><strong>A-27</strong><span class="ticket-rule"></span><small>${t('auth.aheadExample')}</small><div class="ticket-notch ticket-notch--left"></div><div class="ticket-notch ticket-notch--right"></div></div>
              <div class="machine-wait ${active===2?'scene-active':''}" aria-hidden="${active!==2}"><div class="wait-ring">${icon('check',34)}</div><strong>A-27</strong><p>${t('auth.step.waitBody')}</p><span class="wait-caption">${t('auth.platformPlaceKept')}</span></div>
            </div>
          </div>
          <div class="machine-controls" role="group" aria-label="${esc(t('auth.previewTitle'))}">${steps.map((step,index)=>`<button type="button" data-action="landing-step" data-step="${index}" data-keep="machine-${index}" aria-pressed="${active===index}"><span>0${index+1}</span>${t(`auth.step.${step}`)}</button>`).join('')}</div>
          <div class="machine-caption"><span class="machine-caption__dot"></span>${t(`auth.step.${steps[active]}Body`)}</div>
        </div>
      </section>
      <section class="product-story landing-journey" aria-labelledby="journey-title" data-depth="4">
        <div class="product-story__heading"><div><p class="product-eyebrow">${t('auth.journeyEyebrow')}</p><h2 id="journey-title">${t('auth.journeyTitle')}</h2></div><span class="story-index" aria-hidden="true">01 — 03</span></div>
        <ol class="landing-steps product-steps">${steps.map((step,index)=>`<li class="landing-step" style="--step:${index}"><button type="button" data-action="landing-step" data-step="${index}" data-keep="story-${index}" aria-pressed="${active===index}"><span class="landing-step__index">0${index+1}</span><span class="product-step__copy"><strong>${t(`auth.step.${step}`)}</strong><span>${t(`auth.step.${step}Body`)}</span></span><span class="step-arrow" aria-hidden="true">↗</span></button></li>`).join('')}</ol>
      </section>
      <section class="product-outcome" data-depth="3"><div><p class="product-eyebrow">${t('auth.platformForBusiness')}</p><h2>${t('auth.platformClosing')}</h2></div><a class="btn product-primary" href="/signup">${t('auth.createQueue')} <span aria-hidden="true">↗</span></a></section>
    </main><footer class="auth-footer product-footer"><span>DIIWAAN · ${t('auth.tagline')}</span>${madeBy()}</footer>
  </div>`;
}

function passwordField({ id, label, value, error, autocomplete, show, hint }) {
  return `
  <div class="field ${error ? 'field--bad' : ''}">
    <label for="${id}">${label}</label>
    <div style="position:relative">
      <input id="${id}" name="${id}" type="${show ? 'text' : 'password'}" autocomplete="${autocomplete}"
             data-keep="${id}" value="${esc(value)}" style="padding-right:58px" />
      <button type="button" class="icon-btn" data-action="toggle-password" aria-pressed="${!!show}"
              aria-label="${esc(show ? t('auth.hidePassword') : t('auth.showPassword'))}"
              style="position:absolute;right:8px;top:8px;border:none;background:none">${icon('eye')}</button>
    </div>
    ${hint ? `<span class="hint">${esc(hint)}</span>` : ''}
    ${error ? `<span class="error-text">${esc(error)}</span>` : ''}
  </div>`;
}

const strengthMeter = password => {
  let score = 0;
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (/[0-9]/.test(password) && /[a-zA-Z]/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;
  const words = ['', t('auth.weak'), t('auth.fair'), t('auth.good'), t('auth.strong')];
  return `
    <div class="row-flex gap-8" aria-hidden="true">
      ${[1, 2, 3, 4].map(i => `
        <span style="flex:1;height:4px;border-radius:4px;transition:background var(--mid);background:${i <= score ? 'var(--brand)' : 'var(--line)'}"></span>`).join('')}
      <span class="hint" style="width:52px;text-align:right">${words[score]}</span>
    </div>`;
};

export function signUpView(ui) {
  const form = ui.auth;
  return shell(`
    <div class="stage stage--narrow stage--entry">
      <div class="stack gap-24" style="flex:1;justify-content:center">
        <div class="stack gap-8">
          <h1>${t('auth.createTitle')}</h1>
          <p class="lead">${t('auth.createLead')}</p>
        </div>
        ${serviceNotice()}
        <form class="card stack gap-16" data-action="sign-up" novalidate>
          <div class="field ${form.errors.name ? 'field--bad' : ''}">
            <label for="su-name">${t('auth.yourName')}</label>
            <input id="su-name" name="su-name" type="text" autocomplete="name" data-keep="su-name"
                   value="${esc(form.name)}" placeholder="Hodan Ali" />
            ${form.errors.name ? `<span class="error-text">${esc(form.errors.name)}</span>` : ''}
          </div>
          <div class="field ${form.errors.email ? 'field--bad' : ''}">
            <label for="su-email">${t('common.email')}</label>
            <input id="su-email" name="su-email" type="email" autocomplete="email" data-keep="su-email"
                   value="${esc(form.email)}" placeholder="you@business.so" />
            ${form.errors.email ? `<span class="error-text">${esc(form.errors.email)}</span>` : ''}
          </div>
          ${passwordField({
            id: 'su-password', label: t('common.password'), value: form.password, error: form.errors.password,
            autocomplete: 'new-password', show: ui.showPassword, hint: t('auth.passwordHint')
          })}
          ${strengthMeter(form.password)}
          ${form.errors.form ? `<p class="error-text">${esc(form.errors.form)}</p>` : ''}
          <button class="btn" type="submit" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
            ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('auth.creating')}` : t('auth.createAccount')}
          </button>
          ${googleButton(ui)}
          <p class="hint center">${t('auth.haveAccount')} <a href="/signin">${t('auth.signIn')}</a></p>
        </form>
      </div>
    </div>`);
}

export function signInView(ui) {
  const form = ui.auth;
  return shell(`
    <div class="stage stage--narrow stage--entry">
      <div class="stack gap-24" style="flex:1;justify-content:center">
        <div class="stack gap-8">
          <h1>${t('auth.welcomeBack')}</h1>
          <p class="lead">${t('auth.signInLead')}</p>
        </div>
        ${serviceNotice()}
        <form class="card stack gap-16" data-action="sign-in" novalidate>
          <div class="field ${form.errors.email ? 'field--bad' : ''}">
            <label for="si-email">${t('common.email')}</label>
            <input id="si-email" name="si-email" type="email" autocomplete="email" data-keep="si-email" value="${esc(form.email)}" />
            ${form.errors.email ? `<span class="error-text">${esc(form.errors.email)}</span>` : ''}
          </div>
          ${passwordField({
            id: 'si-password', label: t('common.password'), value: form.password, error: form.errors.password,
            autocomplete: 'current-password', show: ui.showPassword
          })}
          ${form.errors.form || oauthError ? `<p class="error-text">${esc(form.errors.form || oauthError)}</p>` : ''}
          <button class="btn" type="submit" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
            ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('auth.signingIn')}` : t('auth.signInCta')}
          </button>
          ${googleButton(ui)}
          <div class="between">
            <a class="hint" href="/forgot">${t('auth.forgot')}</a>
            <a class="hint" href="/signup">${t('auth.createOne')}</a>
          </div>
        </form>
      </div>
    </div>`);
}

export function forgotView(ui) {
  const form = ui.auth;
  return shell(`
    <div class="stage stage--narrow stage--entry">
      <div class="stack gap-24" style="flex:1;justify-content:center">
        <div class="stack gap-8">
          <h1>${t('auth.resetTitle')}</h1>
          <p class="lead">${t('auth.resetLead')}</p>
        </div>
        ${ui.resetSent ? `
          <div class="card stack gap-16">
            <span class="pill" style="align-self:flex-start"><i class="tick"></i>${t('auth.emailSent')}</span>
            <p class="lead">${esc(t('auth.checkInbox', { email: form.email }))}</p>
            <a class="btn btn--quiet" href="/signin" style="text-align:center">${t('auth.backToSignIn')}</a>
          </div>` : `
          <form class="card stack gap-16" data-action="send-reset" novalidate>
            <div class="field ${form.errors.email ? 'field--bad' : ''}">
              <label for="fp-email">${t('common.email')}</label>
              <input id="fp-email" name="fp-email" type="email" autocomplete="email" data-keep="fp-email" value="${esc(form.email)}" />
              ${form.errors.email ? `<span class="error-text">${esc(form.errors.email)}</span>` : ''}
            </div>
            ${form.errors.form ? `<p class="error-text">${esc(form.errors.form)}</p>` : ''}
            <button class="btn" type="submit" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
              ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('auth.sending')}` : t('auth.sendReset')}
            </button>
            <p class="hint center"><a href="/signin">${t('auth.backToSignIn')}</a></p>
          </form>`}
      </div>
    </div>`);
}

export function resetView(ui) {
  const form = ui.auth;
  return shell(`
    <div class="stage stage--narrow stage--entry">
      <div class="stack gap-24" style="flex:1;justify-content:center">
        <div class="stack gap-8">
          <h1>${t('auth.chooseNew')}</h1>
          <p class="lead">${t('auth.chooseNewLead')}</p>
        </div>
        <form class="card stack gap-16" data-action="set-password" novalidate>
          ${passwordField({
            id: 'np-password', label: t('auth.newPassword'), value: form.password, error: form.errors.password,
            autocomplete: 'new-password', show: ui.showPassword, hint: t('auth.passwordHint')
          })}
          ${strengthMeter(form.password)}
          ${form.errors.form ? `<p class="error-text">${esc(form.errors.form)}</p>` : ''}
          <button class="btn" type="submit" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
            ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('auth.saving')}` : t('auth.savePassword')}
          </button>
        </form>
      </div>
    </div>`);
}

