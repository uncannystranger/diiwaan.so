/* Live queue updates over server-sent events.

   EventSource cannot carry an Authorization header, and the owner stream is
   authenticated, so the stream is read with fetch: the token stays in a header
   instead of a URL, and the same code serves the public customer stream.

   Events carry small facts — "the queue moved, it is now at version N" — and the
   screen re-reads state when it hears one, which makes duplicate or out-of-order
   delivery harmless. A reconnect resumes with Last-Event-ID so nothing is missed. */

import { accessToken } from './session.js';

const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
const SILENCE_MS = 45_000; // the server pings every 25s

export function connect(path, { onEvent, onStatus, authenticated = false } = {}) {
  let controller = null;
  let attempt = 0;
  let closed = false;
  /* Whether the last attempt was refused for the token, so a second refusal can
     be told from a first. */
  let unauthorised = false;
  let lastEventId = 0;
  let idleTimer = null;

  const setStatus = status => onStatus?.(status);

  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (closed) return;
      setStatus('reconnecting');
      controller?.abort();
    }, SILENCE_MS);
  };

  function dispatch(rawEvent) {
    const lines = rawEvent.split('\n');
    let id = null;
    let type = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (id) lastEventId = Number(id) || lastEventId;
    if (!data) return;
    try {
      onEvent?.({ type, ...JSON.parse(data) });
    } catch {
      /* a malformed frame is not worth breaking the stream over */
    }
  }

  async function run() {
    while (!closed) {
      controller = new AbortController();
      try {
        const response = await fetch(path, {
          signal: controller.signal,
          headers: {
            Accept: 'text/event-stream',
            ...(lastEventId ? { 'Last-Event-ID': String(lastEventId) } : {}),
            ...(authenticated && accessToken() ? { Authorization: `Bearer ${accessToken()}` } : {})
          }
        });

        /* A queue that does not exist, or one this device may not read, will
           not exist on the next attempt either. Retrying a permanent answer
           forever burns the customer's battery and the server's budget for
           nothing — the page has already shown them why. */
        if (response.status === 404 || response.status === 403) {
          setStatus('closed');
          closed = true;
          return;
        }

        /* A 401 is the one refusal that might not last.
         *
         * The owner stream carries an access token that expires every hour, and
         * the tab mints a new one a minute before it does — so a reconnect that
         * lands in that seam is refused for a token that is already being
         * replaced. Treating that as permanent, which this did, left the desk
         * with no live updates for the rest of the session and no sign that
         * anything had stopped; the queue simply went quiet until somebody
         * reloaded.
         *
         * So it is given one more go, after a pause long enough for the renewal
         * to land. Refused twice with a fresh token, it is a real refusal and
         * the stream closes as before. */
        if (response.status === 401) {
          if (unauthorised) {
            setStatus('closed');
            closed = true;
            return;
          }
          unauthorised = true;
          setStatus('reconnecting');
          await new Promise(resolve => setTimeout(resolve, 1500));
          continue;
        }
        unauthorised = false;

        if (!response.ok || !response.body) throw new Error(`stream ${response.status}`);

        attempt = 0;
        setStatus('live');
        armIdle();

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          armIdle();
          buffer += decoder.decode(value, { stream: true });
          let split;
          while ((split = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (chunk.startsWith(':')) continue; // heartbeat
            dispatch(chunk);
          }
        }
      } catch {
        /* fall through to the backoff below */
      }

      if (closed) return;
      setStatus('reconnecting');
      const delay = BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)];
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  run();

  return () => {
    closed = true;
    clearTimeout(idleTimer);
    controller?.abort();
    setStatus('closed');
  };
}
