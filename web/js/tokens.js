/* The one place JavaScript is allowed to learn a colour.

   The palette lives in CSS: five seeds on :root — primary, emphasis, accent,
   base, tint — from which every semantic token is derived with color-mix, per
   theme, and which branding re-tints per business. That system was already
   coherent. What was not coherent was the code around it.

   Several places in the app carried their own hex literals: the theme-color
   meta tag, the QR encoder's defaults, the heart in the footer. They had been
   written against an older generation of the palette (#011627 / #FDFFFC /
   #FF9F1C) and were never updated when the seeds changed to #04121D / #FBFCFA /
   #E0912F. So the browser chrome, the printed QR and the footer were painting
   one brand while the entire interface painted another — and no amount of
   changing the palette could fix them, because they were not reading it.

   Reading the computed value instead means there is exactly one definition. A
   business that re-tints its brand re-tints these too, for free, and a change
   to the seeds can never again leave part of the product behind.

   Every accessor takes a fallback for the moment before the stylesheet has
   arrived — the splash paints in that window and must not be colourless. */

const root = () => document.documentElement;

/**
 * One resolved custom property. Returns the fallback when the stylesheet has
 * not landed yet, or when the property does not exist.
 */
export function token(name, fallback = '') {
  try {
    const value = getComputedStyle(root()).getPropertyValue(name).trim();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/* The five seeds, and the two grounds the app paints itself on. Fallbacks are
   the current house values: correct if the stylesheet is late, and the only
   literals of their kind left in the JavaScript. */
export const brand = () => ({
  primary: token('--p-primary', '#E0912F'),
  emphasis: token('--p-emphasis', '#04121D'),
  accent: token('--p-accent', '#3AA69B'),
  base: token('--p-base', '#FBFCFA'),
  tint: token('--p-tint', '#25506E')
});

/* Most tokens are not colours yet — they are color-mix() expressions over other
   tokens, which is what lets one seed repaint the product. Anywhere the value
   leaves CSS, that expression is useless: a <meta name="theme-color"> or an SVG
   written to a file needs an actual colour.

   Painting it onto a canvas and reading the pixel back is the only resolution
   that is guaranteed to agree with what the screen shows, whatever colour space
   the browser chose to compute in — the same reason this project rasterises
   when it measures contrast. */
let probe = null;

export function resolveColor(value, fallback = '#000000') {
  if (!value) return fallback;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  try {
    probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!probe) return fallback;
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000000';
    probe.fillStyle = value;          // ignored silently if the browser cannot parse it
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return fallback;
  }
}

/** The page's own ground and ink for the current theme, as real colours. */
export const ground = () => resolveColor(token('--canvas'), token('--p-base', '#FBFCFA'));
export const ink = () => resolveColor(token('--ink'), token('--p-emphasis', '#04121D'));
