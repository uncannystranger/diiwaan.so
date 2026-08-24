/* The way an owner gets into Diiwaan: landing, sign up, sign in, reset.
   Same canvas language — glass cards, 22px buttons, Lora headings. */

import { esc, wordmark, themeButton, languageButton, icon, madeBy, diiwaanMark } from '../ui.js';
import { t } from '../i18n.js';
import { googleAuthAvailable, oauthError, state as sessionState } from '../session.js';

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
function googleButton(ui) {
  if (!googleAuthAvailable()) return '';
  return `
    <div class="or-rule"><span>${t('auth.orContinue')}</span></div>
    <button type="button" class="btn btn--google" data-action="google-auth" ${ui?.busy ? 'disabled aria-busy="true"' : ''}>
      ${googleMark(19)}<span>${ui?.googleBusy ? t('auth.googleGoing') : t('auth.google')}</span>
    </button>
    <p class="hint center">${t('auth.googleHint')}</p>`;
}

function shell(inner) {
  return `
  <div class="screen">
    <div class="topbar">
      <a href="#/" aria-label="${esc(t('auth.home'))}">${wordmark(16)}</a>
      <div class="topbar__right">${languageButton()}${themeButton()}</div>
    </div>
    ${inner}
    <footer class="auth-footer">${madeBy()}</footer>
  </div>`;
}

export function landingView() {
  return shell(`
    <div class="stage stage--entry">
      <div class="customer-split">
        <div class="stack gap-24">
          <div class="brand-lockup">
            ${diiwaanMark(44)}
            <div>
              <div class="brand-lockup__name">DIIWAAN</div>
              <div class="hint">${t('auth.tagline')}</div>
            </div>
          </div>
          <h1 class="serif">${t('auth.headline')}</h1>
          <p class="lead" style="max-width:52ch">${t('auth.lead')}</p>
          <div class="btn-row" style="max-width:520px">
            <a class="btn entry-cta entry-cta--primary" href="#/signup">${t('auth.createQueue')}</a>
            <a class="btn btn--ghost entry-cta" href="#/signin">${t('auth.signIn')}</a>
          </div>
          <div class="row-flex gap-24 mt-8">
            ${[[t('auth.freeTitle'), t('auth.freeHint')],
               [t('auth.offlineTitle'), t('auth.offlineHint')],
               [t('auth.brandTitle'), t('auth.brandHint')]]
              .map(([title, hint]) => `
                <div style="min-width:150px">
                  <div style="font-size:14px;font-weight:500">${title}</div>
                  <div class="hint">${hint}</div>
                </div>`).join('')}
          </div>
        </div>

        <div class="card stack gap-20 hero-card">
          <div class="eyebrow">${t('auth.previewTitle')}</div>
          <div class="card card--quiet stack gap-12 hero-ticket" style="padding:20px;border-radius:30px">
            <div class="row-flex gap-12">
              <span class="hero-ticket__logo">${diiwaanMark(24)}</span>
              <div>
                <div class="serif" style="font-size:19px">${t('auth.yourBusiness')}</div>
                <div class="hint">${t('auth.yourCity')}</div>
              </div>
            </div>
            <div class="center" style="padding:12px 0">
              <div class="eyebrow eyebrow--wide">${t('auth.yourNumber')}</div>
              <div class="numeral hero-ticket__number" style="font-size:64px;margin-top:8px">A-27</div>
              <div class="hint mt-8 hero-ticket__ahead">${t('auth.aheadExample')}</div>
            </div>
            <!-- The line advances on its own: the queue moving is the product. -->
            <div class="meter meter--live"><i></i></div>
          </div>
          <p class="hint">${t('auth.everyColour')}</p>
        </div>
      </div>
    </div>`);
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
          <p class="hint center">${t('auth.haveAccount')} <a href="#/signin">${t('auth.signIn')}</a></p>
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
            <a class="hint" href="#/forgot">${t('auth.forgot')}</a>
            <a class="hint" href="#/signup">${t('auth.createOne')}</a>
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
            <a class="btn btn--quiet" href="#/signin" style="text-align:center">${t('auth.backToSignIn')}</a>
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
            <p class="hint center"><a href="#/signin">${t('auth.backToSignIn')}</a></p>
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

/** Offered after sign-up: the address is unconfirmed but the queue is already open. */
export function verifyView(ui, email) {
  return shell(`
    <div class="stage stage--narrow stage--entry">
      <div class="stack gap-24" style="flex:1;justify-content:center">
        <div class="card stack gap-16">
          <span class="pill pill--warn" style="align-self:flex-start"><i class="dot dot--hollow"></i>${t('auth.oneStep')}</span>
          <h1>${t('auth.confirmEmail')}</h1>
          <p class="lead">${esc(t('auth.confirmLead', { email }))}</p>
          <div class="btn-row">
            <button class="btn btn--quiet btn--auto" data-action="resend-verification" ${ui.busy ? 'disabled aria-busy="true"' : ''}>
              ${ui.busy ? `<span class="spinner"></span>&nbsp; ${t('auth.sending')}` : t('auth.sendAgain')}
            </button>
            <button class="btn btn--quiet btn--auto" data-action="check-verification">${t('auth.iConfirmed')}</button>
          </div>
          <p class="hint" style="line-height:1.55">${t('auth.noEmailHelp')}</p>
          <button class="btn btn--link" data-action="sign-out">${t('auth.differentAccount')}</button>
        </div>
      </div>
    </div>`);
}
