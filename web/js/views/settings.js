/* Settings — canvas frame 8's list rows, grouped into sections the owner can
   step through: Business, Queue, Services, Staff, Notifications, Account. */

import { esc, icon, initials, skeletonRows, errorPanel } from '../ui.js';
import { frame } from './console.js';
import { t } from '../i18n.js';

const SECTIONS = ['business', 'queue', 'services', 'staff', 'reports', 'account'];

const PREFIXES = ['A', 'B', 'H', 'Q', 'S'];

export function settingsView(ui, ctx) {
  const { business, snapshot, members, services, user, role, error } = ctx;
  const section = ui.settingsSection || 'business';
  const queue = snapshot?.queue;

  if (error && !snapshot) {
    return frame(ui, ctx, 'settings', `
      <div class="workspace"><div class="stage" style="padding:0;max-width:920px">
        ${errorPanel(error, { retryAction: 'reload-queue', title: t('set.failed') })}
      </div></div>`);
  }

  const body = {
    business: businessSection(business),
    queue: queueSection(business, queue),
    services: servicesSection(services),
    staff: staffSection(members, role, user, ctx.membersLoading),
    reports: reportsSection(business),
    account: accountSection(user, business, role)
  }[section];

  return frame(ui, ctx, 'settings', `
    <div class="workspace">
      <div class="stage" style="padding:0;max-width:920px">
        <div class="between">
          <h1>${t('set.title')}</h1>
          ${ui.saving ? `<span class="pill pill--mute"><span class="spinner"></span>${t('common.saving')}</span>`
                      : `<span class="pill"><i class="tick"></i>${t('common.saved')}</span>`}
        </div>

        <nav class="seg mt-24" aria-label="${esc(t('set.sections'))}">
          ${SECTIONS.map(id => `
            <button data-action="settings-section" data-value="${id}" aria-pressed="${section === id}">${t(`set.tab.${id}`)}</button>`).join('')}
        </nav>

        <div class="mt-24">${body}</div>
      </div>
    </div>`);
}

const businessSection = business => `
  <div class="settings-list">
    <div class="setting">
      <div><label class="setting__label" for="set-name">${t('set.businessName')}</label><div class="setting__hint">${t('set.businessNameHint')}</div></div>
      <input id="set-name" type="text" data-keep="set-name" data-business="name" value="${esc(business.name)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-category">${t('set.category')}</label><div class="setting__hint">${t('set.categoryHint')}</div></div>
      <input id="set-category" type="text" data-keep="set-category" data-business="category" value="${esc(business.category)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-city">${t('set.city')}</label><div class="setting__hint">${t('set.cityHint')}</div></div>
      <input id="set-city" type="text" data-keep="set-city" data-business="city" value="${esc(business.city)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-address">${t('set.address')}</label><div class="setting__hint">${t('set.addressHint')}</div></div>
      <input id="set-address" type="text" data-keep="set-address" data-business="address" value="${esc(business.address)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-phone">${t('common.phone')}</label><div class="setting__hint">${t('set.phoneHint')}</div></div>
      <input id="set-phone" type="tel" data-keep="set-phone" data-business="phone" value="${esc(business.phone)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-email">${t('set.contactEmail')}</label><div class="setting__hint">${t('set.contactEmailHint')}</div></div>
      <input id="set-email" type="email" data-keep="set-email" data-business="email" value="${esc(business.email)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-slug">${t('set.publicLink')}</label><div class="setting__hint">${t('set.publicLinkHint')}</div></div>
      <div class="setting__control">
        <input id="set-slug" type="text" data-keep="set-slug" value="${esc(business.slug)}" />
        <button class="btn btn--quiet btn--sm btn--auto" data-action="save-slug">${t('set.changeLink')}</button>
      </div>
    </div>
  </div>`;

const queueSection = (business, queue) => `
  <div class="settings-list">
    <div class="setting">
      <div><div class="setting__label">${t('set.queueName')}</div><div class="setting__hint">${t('set.queueNameHint')}</div></div>
      <input id="set-queue-name" type="text" data-keep="set-queue-name" data-queue="name" value="${esc(queue?.name || business.queueSettings.name)}" />
    </div>
    <div class="setting">
      <div><label class="setting__label" for="set-user-name">${t('set.prefix')}</label><div class="setting__hint">${esc(t('set.nextNumberIs', { label: queue?.nextLabel || '—' }))}</div></div>
      <div class="prefix-pick">
        ${PREFIXES.map(prefix => `
          <button type="button" data-action="set-prefix" data-value="${prefix}"
                  aria-pressed="${(queue?.prefix || business.queueSettings.prefix) === prefix}">${prefix}</button>`).join('')}
      </div>
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('set.avgService')}</div><div class="setting__hint">${t('set.avgServiceHint')}</div></div>
      <div class="setting__control">
        <input type="range" min="1" max="60" step="1" data-queue-range="avgServiceMin"
               value="${queue?.avgServiceMin || business.queueSettings.avgServiceMin}" />
        <span data-range-label style="font-size:16px;font-weight:500;width:64px">${queue?.avgServiceMin || business.queueSettings.avgServiceMin} ${t('common.minShort')}</span>
      </div>
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('set.hours')}</div><div class="setting__hint">${t('set.hoursHint')}</div></div>
      <div class="setting__control">
        <input type="time" data-keep="set-opens" data-hours="opensAt" value="${esc(business.queueSettings.opensAt)}" />
        <span class="muted">—</span>
        <input type="time" data-keep="set-closes" data-hours="closesAt" value="${esc(business.queueSettings.closesAt)}" />
      </div>
    </div>
    <div class="setting">
      <div>
        <div class="setting__label">${t('set.queueStatus')}</div>
        <div class="setting__hint">${queue?.status === 'open' ? t('set.canJoinNow')
          : queue?.status === 'paused' ? t('set.pausedHint')
          : t('set.closedHint')}</div>
      </div>
      <div class="setting__control">
        <div class="seg seg--sm">
          ${[['open', t('set.open')], ['paused', t('set.paused')], ['closed', t('set.closed')]].map(([id, label]) => `
            <button data-action="queue-status" data-value="${id}" aria-pressed="${queue?.status === id}">${label}</button>`).join('')}
        </div>
      </div>
    </div>
  </div>`;

const servicesSection = services => `
  <div class="settings-list">
    ${services.length ? services.map(service => `
      <div class="setting">
        <div>
          <div class="setting__label">${esc(service.name)}</div>
          <div class="setting__hint">${service.estimatedDuration} ${t('common.minShort')}${service.description ? ` · ${esc(service.description)}` : ''}</div>
        </div>
        <div class="setting__control">
          <button class="switch" data-action="toggle-service-active" data-id="${service.id}"
                  aria-pressed="${service.active !== false}" aria-label="${esc(t('set.serviceActive', { name: service.name }))}"><i></i></button>
          <button class="icon-btn" data-action="delete-service" data-id="${service.id}" data-label="${esc(service.name)}"
                  aria-label="${esc(t('set.deleteService', { name: service.name }))}">${icon('close', 16)}</button>
        </div>
      </div>`).join('') : `
      <div class="setting">
        <div>
          <div class="setting__label">${t('set.noServices')}</div>
          <div class="setting__hint">${t('set.noServicesHint')}</div>
        </div>
      </div>`}
    <div class="setting">
      <div><div class="setting__label">${t('set.addService')}</div><div class="setting__hint">${t('set.addServiceHint')}</div></div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="add-service">${icon('plus', 15)}&nbsp; ${t('set.addService')}</button>
    </div>
  </div>`;

const staffSection = (members, role, user, loading) => `
  ${loading && !members.length ? skeletonRows(3) : `
  <div class="settings-list">
    ${members.map(member => `
      <div class="setting">
        <div class="row-flex gap-12">
          <span class="avatar" style="cursor:default">${esc(initials(member.name || member.email || (member.isYou ? user?.name || user?.email : '?')))}</span>
          <div>
            <div class="setting__label">${esc(member.name || (member.isYou ? user?.name || user?.email : member.email))}${member.isYou ? t('set.you') : ''}</div>
            <div class="setting__hint">${esc(member.email || (member.isYou ? user?.email : ''))} · ${member.status === 'invited' ? t('set.invitationSent') : member.status}</div>
          </div>
        </div>
        <div class="setting__control">
          ${member.role === 'owner'
            ? `<span class="pill pill--mute">${t('set.owner')}</span>`
            : `<div class="seg seg--sm">
                 ${[['manager', t('set.manager')], ['staff', t('set.staff')]].map(([id, label]) => `
                   <button data-action="member-role" data-id="${member.id}" data-value="${id}"
                           aria-pressed="${member.role === id}" ${role !== 'owner' ? 'disabled' : ''}>${label}</button>`).join('')}
               </div>
               ${role === 'owner' ? `
                 <button class="switch" data-action="member-status" data-id="${member.id}"
                         aria-pressed="${member.status === 'active'}" aria-label="${esc(t('set.enabled'))}"><i></i></button>
                 <button class="icon-btn" data-action="member-remove" data-id="${member.id}" data-label="${esc(member.name || member.email)}"
                         aria-label="${esc(t('set.removeMember', { email: member.email }))}">${icon('close', 16)}</button>` : ''}`}
        </div>
      </div>`).join('')}
    ${role === 'owner' ? `
      <div class="setting">
        <div><div class="setting__label">${t('set.inviteSomeone')}</div><div class="setting__hint">${t('set.inviteHint')}</div></div>
        <button class="btn btn--quiet btn--sm btn--auto" data-action="invite-member">${icon('plus', 15)}&nbsp; ${t('set.invite')}</button>
      </div>` : ''}
  </div>`}`;

const reportsSection = business => `
  <div class="settings-list">
    <div class="setting">
      <div>
        <div class="setting__label">${t('set.reportToday')}</div>
        <div class="setting__hint">${t('set.reportTodayHint')}</div>
      </div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="download-report" data-value="today">
        ${icon('download', 15)}&nbsp; ${t('set.downloadPdf')}
      </button>
    </div>
    <div class="setting">
      <div>
        <div class="setting__label">${t('set.reportWeek')}</div>
        <div class="setting__hint">${t('set.reportWeekHint')}</div>
      </div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="download-report" data-value="week">
        ${icon('download', 15)}&nbsp; ${t('set.downloadPdf')}
      </button>
    </div>
    <div class="setting">
      <div>
        <div class="setting__label">${t('set.reportMonth')}</div>
        <div class="setting__hint">${t('set.reportMonthHint')}</div>
      </div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="download-report" data-value="month">
        ${icon('download', 15)}&nbsp; ${t('set.downloadPdf')}
      </button>
    </div>
  </div>
  <p class="hint mt-16">${esc(t('set.reportsNote', { business: business.name }))}</p>`;

const accountSection = (user, business, role) => `
  <div class="settings-list">
    <div class="setting">
      <div><div class="setting__label">${t('auth.yourName')}</div><div class="setting__hint">${t('set.yourNameHint')}</div></div>
      <input id="set-user-name" type="text" data-keep="set-user-name" data-profile="name" value="${esc(user?.name || '')}" />
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('common.email')}</div><div class="setting__hint">${t('set.emailHint')}</div></div>
      <span class="hint">${esc(user?.email || '')}</span>
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('common.password')}</div><div class="setting__hint">${t('set.passwordHint')}</div></div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="send-reset-signed-in">${t('set.sendReset')}</button>
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('set.yourRole')}</div><div class="setting__hint">${esc(t('set.inBusiness', { business: business.name }))}</div></div>
      <span class="pill pill--mute">${esc(role)}</span>
    </div>
    <div class="setting">
      <div><div class="setting__label">${t('con.signOut')}</div><div class="setting__hint">${t('set.signOutHint')}</div></div>
      <button class="btn btn--quiet btn--sm btn--auto" data-action="sign-out">${icon('logout', 15)}&nbsp; ${t('con.signOut')}</button>
    </div>
  </div>
  <div class="note note--alert mt-24">${t('set.closeNote')}</div>
  <div class="btn-row mt-16">
    <button class="btn btn--danger btn--auto" data-action="close-queue-today">${t('set.closeToday')}</button>
  </div>`;
