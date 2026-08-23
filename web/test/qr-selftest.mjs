/* Reads back what qr.js encoded: unmask the matrix, walk the placement in
   reverse, de-interleave the blocks and parse the byte-mode segment.
   Run with:  node test/qr-selftest.mjs
   (The encoder was also checked against segno and decoded with OpenCV's
   QRCodeDetector while it was written; this keeps the invariant under test.) */

import { qrMatrix, _internals as I } from '../js/qr.js';

const cases = [
  'A',
  'HELLO WORLD',
  'https://diiwaan.so/hodan',
  'http://localhost:4173/#/j/hodan',
  'Ku biir safka — Hodan Medical Clinic, KM4 Mogadishu',
  'x'.repeat(40),
  'y'.repeat(90),
  'z'.repeat(150),
  'w'.repeat(200)
];

function readFormat(modules) {
  const bits = [];
  for (let i = 0; i <= 5; i++) bits.push(modules[i][8]);
  bits.push(modules[7][8], modules[8][8], modules[8][7]);
  for (let i = 9; i <= 14; i++) bits.push(modules[8][14 - i]);
  let value = 0;
  bits.forEach((bit, i) => { value |= bit << i; });
  const data = (value ^ 0x5412) >> 10;
  const level = Object.keys(I.FORMAT_BITS).find(k => I.FORMAT_BITS[k] === (data >> 3));
  return { level, mask: data & 7 };
}

function decode(modules) {
  const size = modules.length;
  const version = (size - 17) / 4;
  const { level, mask } = readFormat(modules);
  const skeleton = I.buildMatrix(version);

  const plain = modules.map(row => row.slice());
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!skeleton.reserved[r][c] && I.MASKS[mask](r, c)) plain[r][c] ^= 1;
    }
  }

  const bits = [];
  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (skeleton.reserved[row][col]) continue;
        bits.push(plain[row][col]);
      }
    }
    upward = !upward;
  }

  // Codewords come out interleaved across blocks; rebuild the data blocks,
  // then read the byte-mode segment from the front of the joined stream.
  const codewords = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const sizes = I.dataBlockSizes(version, level);
  const blocks = sizes.map(() => []);
  let cursor = 0;
  for (let i = 0; i < Math.max(...sizes); i++) {
    blocks.forEach((block, b) => {
      if (i < sizes[b]) block.push(codewords[cursor++]);
    });
  }
  const stream = blocks.flat();

  let position = 0;
  const take = n => {
    let value = 0;
    for (let i = 0; i < n; i++, position++) {
      value = (value << 1) | ((stream[position >> 3] >> (7 - (position & 7))) & 1);
    }
    return value;
  };
  const mode = take(4);
  if (mode !== 0b0100) throw new Error(`expected byte mode, got ${mode.toString(2)}`);
  const length = take(version < 10 ? 8 : 16);
  const out = [];
  for (let i = 0; i < length; i++) out.push(take(8));
  return new TextDecoder().decode(Uint8Array.from(out));
}

let failures = 0;
let checks = 0;
for (const text of cases) {
  for (const level of ['L', 'M', 'Q', 'H']) {
    // Version 10 is the ceiling here, so the longest strings only fit the lower levels.
    const ceiling = { L: 271, M: 213, Q: 151, H: 119 }[level];
    if (text.length > ceiling) continue;
    checks++;
    const got = decode(qrMatrix(text, level));
    const ok = got === text;
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${level} ${JSON.stringify(text.slice(0, 34))}${ok ? '' : ` -> ${JSON.stringify(got.slice(0, 34))}`}`);
  }
}
console.log(failures ? `${failures} failing` : `${checks} passing`);
process.exit(failures ? 1 : 0);
