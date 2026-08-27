/* The one place the browser talks to the Diiwaan API.

   Every owner request carries the Firebase id token; the server decides what
   that identity may see. Failures come back as ApiError so screens can show the
   server's own sentence rather than a generic apology. */

import { accessToken, freshAccessToken, restore, isSignedIn } from './session.js';

/* The session endpoints mint tokens; retrying them with a token would be
   circular. */
const isAuthPath = path => path.startsWith('/auth/session');

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details || [];
    this.offline = status === 0;
  }
}

async function send(method, path, body, { signal, headers = {}, token } = {}) {
  return fetch(`/api${path}`, {
    method,
    signal,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body)
  });
}

async function request(method, path, body, { signal, raw = false, headers = {} } = {}) {
  /* Renewed before the request rather than on a timer. A tab that has been
     asleep holds an expired token, and asking for one here is what stops the
     first call back turning into a 401. */
  const token = isSignedIn() ? await freshAccessToken() : accessToken();
  let response;
  try {
    response = await send(method, path, body, { signal, headers, token });

    /* A 401 on a request we believed was authenticated means the token died
       between minting it and using it — a clock that jumped, a renewal that
       never fired, a token revoked elsewhere. The cookie is the authority and
       it is still here, so ask it once for a new token and try again.
     *
     * Without this the desk simply stopped: every call answered 401, nothing
     * renewed anything, and the only way back was a reload — which is how an
     * expired token came to look like being signed out.
     *
     * Only once, and only when the retry has a genuinely different token, so a
     * real refusal cannot become a loop. */
    if (response.status === 401 && isSignedIn() && !isAuthPath(path)) {
      const stale = token;
      await restore();
      const renewed = accessToken();
      if (renewed && renewed !== stale) {
        response = await send(method, path, body, { signal, headers, token: renewed });
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(0, 'You appear to be offline.');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }

  if (!response.ok) {
    throw new ApiError(response.status, payload.error || 'That did not work.', payload.details);
  }
  return raw ? response : payload;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  del: (path, options) => request('DELETE', path, undefined, options),

  /* owner */
  me: () => request('GET', '/auth/me'),
  updateProfile: patch => request('PATCH', '/auth/me', patch),
  businesses: () => request('GET', '/businesses'),
  createBusiness: input => request('POST', '/businesses', input),
  business: id => request('GET', `/businesses/${id}`),
  updateBusiness: (id, patch) => request('PATCH', `/businesses/${id}`, patch),
  slugAvailable: slug => request('GET', `/businesses/slug-available/${encodeURIComponent(slug)}`),
  finishOnboarding: id => request('POST', `/businesses/${id}/onboarded`),
  updateBranding: (id, patch) => request('PATCH', `/businesses/${id}/branding`, patch),
  updateExperience: (id, patch) => request('PATCH', `/businesses/${id}/customer-experience`, patch),
  updateQr: (id, patch) => request('PATCH', `/businesses/${id}/qr`, patch),

  /* queue */
  queue: id => request('GET', `/businesses/${id}/queue`),
  updateQueue: (id, patch) => request('PATCH', `/businesses/${id}/queue`, patch),
  queueStatus: (id, status) => request('POST', `/businesses/${id}/queue/status`, { status }),
  next: id => request('POST', `/businesses/${id}/queue/next`),
  recall: id => request('POST', `/businesses/${id}/queue/recall`),
  addTicket: (id, input) => request('POST', `/businesses/${id}/queue/tickets`, input),
  ticketAction: (id, ticketId, action, body) =>
    request('POST', `/businesses/${id}/queue/tickets/${ticketId}/${action}`, body ?? {}),

  /* services, staff, analytics */
  services: id => request('GET', `/businesses/${id}/services`),
  createService: (id, input) => request('POST', `/businesses/${id}/services`, input),
  updateService: (id, serviceId, patch) => request('PATCH', `/businesses/${id}/services/${serviceId}`, patch),
  deleteService: (id, serviceId) => request('DELETE', `/businesses/${id}/services/${serviceId}`),
  members: id => request('GET', `/businesses/${id}/members`),
  inviteMember: (id, input) => request('POST', `/businesses/${id}/members`, input),
  updateMember: (id, memberId, patch) => request('PATCH', `/businesses/${id}/members/${memberId}`, patch),
  removeMember: (id, memberId) => request('DELETE', `/businesses/${id}/members/${memberId}`),
  analytics: (id, params = '') => request('GET', `/businesses/${id}/analytics${params}`),

  uploadLogo: (id, file, kind = 'logo') => {
    const form = new FormData();
    form.append('file', file);
    return request('POST', `/uploads/businesses/${id}/logo?kind=${kind}`, form);
  },

  /* public customer side */
  /* The ticket token goes in a header, never the query string. It is the only
     proof that this device is the one holding position four, and a query string
     is written to CDN and proxy access logs and kept in browser history. */
  publicView: (slug, token) =>
    request('GET', `/public/${encodeURIComponent(slug)}`, undefined,
      { headers: token ? { 'X-Diiwaan-Ticket': token } : undefined }),
  join: (slug, input) => request('POST', `/public/${encodeURIComponent(slug)}/join`, input),
  leave: (slug, token) => request('POST', `/public/${encodeURIComponent(slug)}/leave`, { token }),
  reportUrl: (id, params = '') => `/api/businesses/${id}/report.pdf${params}`
};
