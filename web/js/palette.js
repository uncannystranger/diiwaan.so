/* The brand colour system.

   A brand is five colours with defined jobs, not five colours that happen to sit
   next to each other:

     primary    the action colour — buttons, the number being served
     emphasis   the deep structural colour every ink tone and dark ground derives from
     accent     the supporting colour — live states, links, highlights
     base       the light ground the surfaces are mixed from
     tint       the soft highlight used for washes and badges

   Everything else in the interface is derived from those five, per theme, in CSS.
   This module owns the presets, the contrast arithmetic that decides what text
   sits on a colour, and the harmony used when an owner picks their own. */

/* Six moods. Each is five colours with fixed jobs:

     base       a sophisticated off-white, carrying a trace of the family
     emphasis   a sophisticated near-black, carrying the same trace
     primary    the action colour
     accent     the supporting colour
     tint       a third hue at mid strength, for washes, glass and badges

   The three coloured values are a family, not three picks: each preset walks a
   short path across the wheel — deep to muted to atmospheric — so a gradient
   between any two of them stays calm. Nothing here is fully saturated; the point
   is depth rather than brightness. */
export const PRESETS = [
  {
    id: 'diiwaan',
    name: 'Diiwaan',
    character: 'Lamplight amber over harbour navy — the house identity',
    base: '#FBFCFA', emphasis: '#04121D',
    primary: '#E0912F',   // lamp amber
    accent: '#3AA69B',    // still water
    tint: '#25506E'       // harbour blue at depth
  },
  {
    id: 'cardamom',
    name: 'Cardamom',
    character: 'Deep forest into muted emerald and warm moss',
    base: '#F4F6F1', emphasis: '#0C1712',
    primary: '#3E8A69',   // muted emerald
    accent: '#9CA666',    // warm moss
    tint: '#14484F'       // deep petrol, where the forest meets water
  },
  {
    id: 'harbour',
    name: 'Harbour',
    character: 'Night navy through blue-violet to a muted cyan',
    base: '#F1F5F9', emphasis: '#07121E',
    primary: '#4C6FB5',   // blue-violet
    accent: '#5BA9B8',    // muted cyan
    tint: '#2E2870'       // indigo at depth
  },
  {
    id: 'midnight',
    name: 'Midnight',
    character: 'Deep indigo, muted violet and an atmospheric teal',
    base: '#F5F5F8', emphasis: '#0A0C16',
    primary: '#7367BF',   // muted violet
    accent: '#4B9F9C',    // atmospheric teal
    tint: '#1F3C78'       // deep blue holding the two together
  },
  {
    id: 'ember',
    name: 'Ember',
    character: 'Banked terracotta, warm clay and low amber light',
    base: '#FAF5F0', emphasis: '#1B110C',
    primary: '#B24A38',   // banked terracotta
    accent: '#D2A24E',    // low gold
    tint: '#23484C'       // cold slate-teal, the sky behind the fire
  },
  {
    id: 'plum',
    name: 'Plum',
    character: 'Night plum softening through mauve into dusty rose',
    base: '#F9F4F6', emphasis: '#170C14',
    primary: '#A34368',   // dusty rose
    accent: '#9C7BC0',    // mauve
    tint: '#3E2140'       // plum at depth
  }
];

export const SURFACES = [
  { id: 'calm', name: 'Calm', hint: 'Quiet ground, gentle contrast' },
  { id: 'aurora', name: 'Aurora', hint: 'Soft atmospheric light' },
  { id: 'gradient', name: 'Gradient', hint: 'One smooth fall of colour' },
  { id: 'bold', name: 'Bold', hint: 'Deeper ground, stronger accents' }
];

export const presetById = id => PRESETS.find(preset => preset.id === id) || null;

/* ---------- colour arithmetic ---------- */

const clamp = value => Math.min(255, Math.max(0, Math.round(value)));

export function parseHex(hex) {
  const value = String(hex || '').replace('#', '');
  const full = value.length === 3 ? [...value].map(c => c + c).join('') : value;
  const int = parseInt(full, 16);
  return Number.isNaN(int) ? { r: 0, g: 0, b: 0 } : { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

export const toHex = ({ r, g, b }) =>
  `#${[r, g, b].map(v => clamp(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

const channel = value => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex) {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The colour that text should be when it sits on `background`. */
export const readableOn = (background, dark = '#0B1116', light = '#FFFFFF') =>
  contrast(background, dark) >= contrast(background, light) ? dark : light;

export function mix(a, b, amount) {
  const from = parseHex(a);
  const to = parseHex(b);
  return toHex({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount
  });
}

/** Nudges a colour until it reads against a ground, without losing its identity. */
export function ensureContrast(colour, against, target = 4.5) {
  const toward = luminance(against) > 0.4 ? '#000000' : '#FFFFFF';
  let result = colour;
  for (let step = 0; step < 12 && contrast(result, against) < target; step++) {
    result = mix(result, toward, 0.08);
  }
  return result;
}

/* ---------- harmony ---------- */

const rotate = (hex, degrees) => {
  const { r, g, b } = parseHex(hex);
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const l = (max + min) / 510;
  const d = (max - min) / 255;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / 255 / d) % 6;
    else if (max === g) h = (b - r) / 255 / d + 2;
    else h = (r - g) / 255 / d + 4;
  }
  h = (((h * 60 + degrees) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return toHex({ r: (rr + m) * 255, g: (gg + m) * 255, b: (bb + m) * 255 });
};

/**
 * Builds the other four colours from one the owner picked, so a custom brand is
 * still a coherent set rather than a single colour dropped into a default theme.
 */
/* Builds the same shape as a preset from one colour: a near-black and an
   off-white that both carry a trace of it, plus two more hues a short walk
   around the wheel — far enough to be their own colours, near enough that a
   gradient between them stays calm. */
export function deriveFromPrimary(primary) {
  return {
    primary,
    emphasis: mix(rotate(primary, -14), '#05080C', 0.86),
    accent: mix(rotate(primary, 150), '#FFFFFF', 0.14),
    base: mix(primary, '#FFFFFF', 0.955),
    tint: mix(rotate(primary, -46), '#0B1018', 0.42)
  };
}

/** Fills in anything an older saved brand does not have yet. */
export function completeBranding(branding = {}) {
  const preset = presetById(branding.preset);

  /* A stored preset id is the source of truth for its five colours. That way a
     business that chose "Harbour" gets Harbour as it is now, rather than the
     copy of it that happened to be current the day they picked it — while a
     business that set its own colours (no preset id) keeps every one of them
     exactly as saved. */
  if (preset) {
    return {
      ...branding,
      primary: preset.primary,
      emphasis: preset.emphasis,
      accent: preset.accent,
      base: preset.base,
      tint: preset.tint,
      surface: branding.surface || 'aurora'
    };
  }

  const fallback = PRESETS[0];
  const primary = branding.primary || fallback.primary;
  const derived = deriveFromPrimary(primary);
  return {
    ...branding,
    primary,
    emphasis: branding.emphasis || derived.emphasis,
    accent: branding.accent || derived.accent,
    base: branding.base || derived.base,
    tint: branding.tint || derived.tint,
    surface: branding.surface || 'aurora'
  };
}

/**
 * The five colours plus the handful of decisions that cannot be made in CSS:
 * what text sits on each colour, and an accent guaranteed to read on a light
 * ground. Everything else is derived per theme in the stylesheet.
 */
export function paletteVars(branding) {
  const brand = completeBranding(branding);
  const accentInk = ensureContrast(brand.accent, brand.base, 5.2);

  /* On a dark ground a very dark primary needs lifting to stay visible — but the
     label sitting on it has to be decided for the lifted colour, not the original,
     or the button loses its own text. */
  const primaryDark = luminance(brand.primary) < 0.2 ? mix(brand.primary, '#FFFFFF', 0.22) : brand.primary;

  /* The primary is chosen to be a good *fill*. Used as text on the page ground —
     a ghost button's label, a link — a light primary like amber falls to 2:1, so
     each theme gets a version of it darkened or lightened until it reads. */
  /* The ground these sit on is not the raw colour: the canvas is mixed toward
     white or black and then carries a wash on top, which costs a little
     contrast. Both inks are computed with headroom so the real page clears 4.5
     rather than landing just under it. */
  const primaryInk = ensureContrast(brand.primary, brand.base, 5.2);
  const primaryInkDark = ensureContrast(brand.primary, brand.emphasis, 5.2);

  return [
    `--p-primary-dark:${primaryDark}`,
    `--p-on-primary-dark:${readableOn(primaryDark)}`,
    `--p-primary-ink:${primaryInk}`,
    `--p-primary-ink-dark:${primaryInkDark}`,
    `--p-primary:${brand.primary}`,
    `--p-emphasis:${brand.emphasis}`,
    `--p-accent:${brand.accent}`,
    `--p-base:${brand.base}`,
    `--p-tint:${brand.tint}`,
    `--p-on-primary:${readableOn(brand.primary)}`,
    `--p-on-accent:${readableOn(brand.accent)}`,
    `--p-accent-ink:${accentInk}`,
    `--p-accent-lift:${mix(brand.accent, '#FFFFFF', 0.28)}`
  ].join(';');
}
