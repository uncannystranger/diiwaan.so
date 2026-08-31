/* Touch feedback that matches the device rather than assuming one.

   Three tiers exist in practice:
     rich   — the Vibration API with pattern support (most Android phones)
     simple — vibration that only honours a single short buzz
     none   — iOS Safari, desktops, and anyone who asked for less motion

   iOS has no web vibration at all, so there the feedback is carried by the
   visual press animation instead of being faked with a sound. Nothing here ever
   throws: a device that refuses is simply a device with no haptics. */

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

const PATTERNS = {
  tap: 8,            // a button press
  select: 12,        // a choice landed
  success: [14, 40, 22],
  warn: [22, 60, 22],
  error: [30, 50, 30, 50, 30],
  soon: [30, 80, 30],
  /* Being called is the strongest thing this app ever asks for: a long, rising
     pattern that carries through a pocket, repeated so it is not missed. */
  turn: [120, 80, 120, 80, 200, 100, 350, 150, 450]
};

function detect() {
  if (!('vibrate' in navigator) || typeof navigator.vibrate !== 'function') return 'none';
  // A pattern-capable implementation accepts an array; the ones that do not
  // either throw or return false, and both mean "one buzz is all you get".
  try {
    return navigator.vibrate([0]) === false ? 'simple' : 'rich';
  } catch {
    return 'simple';
  }
}

let level = null;

/** 'rich' | 'simple' | 'none' — computed once, on first use. */
export function supportLevel() {
  if (level === null) level = detect();
  return level;
}

let enabled = (() => {
  try { return localStorage.getItem('diiwaan:haptics') !== 'off'; } catch { return true; }
})();

export const hapticsEnabled = () => enabled;

export function setHaptics(on) {
  enabled = !!on;
  try { localStorage.setItem('diiwaan:haptics', enabled ? 'on' : 'off'); } catch { /* private mode */ }
  if (enabled) buzz('tap');
  return enabled;
}

/**
 * Plays one of the named patterns, degraded to what the device can do.
 * Unknown names are treated as a plain tap so a new call site cannot go silent
 * by accident.
 */
export function buzz(name = 'tap') {
  if (!enabled) return false;
  // Someone who has asked the system for less motion has asked for less of this
  // too; a buzzing phone is motion you feel rather than see.
  if (reduceMotion.matches) return false;

  const tier = supportLevel();
  if (tier === 'none') return false;

  /* Own-property, not `??`: nullish coalescing does not save you from an
     inherited value, because Object.prototype.toString is neither null nor
     undefined — it is a function, which would then be handed to navigator.vibrate. */
  const pattern = Object.hasOwn(PATTERNS, name) ? PATTERNS[name] : PATTERNS.tap;
  try {
    if (tier === 'simple') {
      // Collapse a pattern to its first pulse, which is the part that reads as
      // the acknowledgement; the rest is texture this device cannot render.
      navigator.vibrate(Array.isArray(pattern) ? pattern[0] : pattern);
    } else {
      navigator.vibrate(pattern);
    }
    return true;
  } catch {
    return false;
  }
}

/** Stops anything still playing — used when a screen is torn down. */
export function silence() {
  try { navigator.vibrate(0); } catch { /* nothing was playing */ }
}
