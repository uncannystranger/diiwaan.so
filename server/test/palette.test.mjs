/* The two copies of the house palette must agree.

   The browser derives its colours from the --p-* block in the stylesheet; the
   server derives the branding a new business is created with, the default QR
   and the PDF report from lib/palette.js. Neither can read the other, so the
   only thing keeping them in step is this check.

   It exists because they drifted. The server sat on the previous generation of
   the palette for long enough that a business created through the API was born
   in one brand while the app it opened in painted another, and its printed
   report agreed with neither. That is not a class of bug worth finding by eye
   twice. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUSE_PALETTE } from '../src/lib/palette.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.resolve(here, '../../web/css/diiwaan.css'), 'utf8');

/* The first --p-* declarations in the file are :root's, which is the house
   palette; later ones are theme overrides and preset blocks. */
const seedOf = name => {
  const match = new RegExp(`--p-${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(css);
  return match?.[1]?.toUpperCase() || null;
};

let failed = 0;
console.log('\nHouse palette — stylesheet against server\n');
for (const [name, value] of Object.entries(HOUSE_PALETTE)) {
  const inCss = seedOf(name);
  const ok = inCss === value.toUpperCase();
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(9)} server ${value}   stylesheet ${inCss ?? '(missing)'}`);
}

/* Retired values must not reappear anywhere that ships. */
const RETIRED = ['#FF9F1C', '#011627', '#2EC4B6', '#FDFFFC', '#FFE6C2'];
const roots = ['web/js', 'web/css', 'server/src', 'web/index.html', 'web/manifest.webmanifest'];
const offenders = [];
const walk = target => {
  const full = path.resolve(here, '../../', target);
  if (!fs.existsSync(full)) return;
  if (fs.statSync(full).isDirectory()) {
    for (const entry of fs.readdirSync(full)) walk(path.join(target, entry));
    return;
  }
  if (!/\.(js|mjs|css|html|webmanifest)$/.test(full)) return;
  if (full.endsWith('palette.test.mjs') || full.endsWith('tokens.js') || full.endsWith('lib/palette.js')) return;
  const body = fs.readFileSync(full, 'utf8');
  for (const colour of RETIRED) {
    if (body.toUpperCase().includes(colour)) offenders.push(`${target} carries ${colour}`);
  }
};
roots.forEach(walk);

console.log('');
if (offenders.length) {
  failed += offenders.length;
  offenders.forEach(o => console.log(`  FAIL ${o}`));
} else {
  console.log('  ok   no retired palette value survives anywhere that ships');
}

console.log(failed ? `\n${failed} failed\n` : '\nboth copies agree\n');
process.exit(failed ? 1 : 0);
