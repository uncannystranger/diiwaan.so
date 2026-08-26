/* Theme: light, dark, or follow the device. Persisted per device. */

import { ground } from './tokens.js';

const KEY = 'diiwaan:theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export let preference = localStorage.getItem(KEY) || 'system';

export const resolved = () => (preference === 'system' ? (media.matches ? 'dark' : 'light') : preference);

const ICONS = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  auto: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'
};
const WORDS = { system: 'follows your device', light: 'light', dark: 'dark' };

/* Repaints that swap the whole token set — a theme flip, a new palette — run
   with transitions switched off for one frame. Interpolating between two
   color-mix() values can leave Chrome holding the old colour, which shows up as
   text in the previous theme's ink on the new theme's ground. */
export function retint(mutate) {
  const root = document.documentElement;
  root.classList.add('retint');
  mutate();
  void root.offsetWidth;                                  // flush while transitions are off
  setTimeout(() => root.classList.remove('retint'), 0);
}

/* Painting is a single attribute write plus an in-place icon swap. No re-render,
   no toast, no await — the toggle should feel like a system control. */
function paint() {
  const theme = resolved();
  retint(() => { document.documentElement.dataset.theme = theme; });

  /* The browser's own chrome should be the colour of the page it frames, in
     whatever palette this business uses — read, never guessed.

     Read synchronously: retint() has already written the attribute and forced a
     layout flush, so the computed value is correct by now. An earlier version
     deferred this to requestAnimationFrame, which never fires in a hidden tab —
     the same trap this app already races a timer to avoid when rendering — so
     switching theme in a background tab left the chrome on the old colour. */
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = ground();

  const glyph = preference === 'system' ? 'auto' : preference === 'dark' ? 'moon' : 'sun';
  document.querySelectorAll('[data-action="cycle-theme"]').forEach(button => {
    const svg = button.querySelector('svg');
    if (svg) svg.innerHTML = ICONS[glyph];
    button.title = `Theme: ${WORDS[preference]}`;
    button.setAttribute('aria-label', `Theme: ${WORDS[preference]}. Activate to change.`);
  });
}

export function setTheme(next) {
  preference = next;
  if (next === 'system') localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  paint();
}

/** Cycles light → dark → follow-the-device, which is what the header button does. */
export function cycleTheme() {
  setTheme(preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light');
  return preference;
}

media.addEventListener('change', () => { if (preference === 'system') paint(); });
paint();
