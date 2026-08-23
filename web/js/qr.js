/* QR encoder — byte mode, all four ECC levels, versions 1-10, with styling.
   Owners brand their code (colours, module shape, a logo in the middle), so the
   renderer takes options and the encoder needs the higher ECC levels that let a
   logo cover part of the symbol. */

const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]] by version
const ECC = {
  L: [
    [7, [[1, 19]]], [10, [[1, 34]]], [15, [[1, 55]]], [20, [[1, 80]]], [26, [[1, 108]]],
    [18, [[2, 68]]], [20, [[2, 78]]], [24, [[2, 97]]], [30, [[2, 116]]], [18, [[2, 68], [2, 69]]]
  ],
  M: [
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]
  ],
  Q: [
    [13, [[1, 13]]], [22, [[1, 22]]], [18, [[2, 17]]], [26, [[2, 24]]], [18, [[2, 15], [2, 16]]],
    [24, [[4, 19]]], [18, [[2, 14], [4, 15]]], [22, [[4, 18], [2, 19]]], [20, [[4, 16], [4, 17]]], [24, [[6, 19], [2, 20]]]
  ],
  H: [
    [17, [[1, 9]]], [28, [[1, 16]]], [22, [[2, 13]]], [16, [[4, 9]]], [22, [[2, 11], [2, 12]]],
    [28, [[4, 15]]], [26, [[4, 13], [1, 14]]], [26, [[4, 14], [2, 15]]], [24, [[4, 12], [4, 13]]], [28, [[6, 15], [2, 16]]]
  ]
};

const FORMAT_BITS = { L: 0b01, M: 0b00, Q: 0b11, H: 0b10 };

const ALIGN_CENTERS = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]
];

/* ---- GF(256) ---- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

function generatorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j], EXP[i]);
      next[j + 1] ^= poly[j];
    }
    poly = next;
  }
  return poly.reverse(); // descending powers, leading coefficient first
}

function eccCodewords(data, count) {
  const gen = generatorPoly(count);
  const rem = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < count; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/* ---- data encoding ---- */
const toBytes = text => Array.from(new TextEncoder().encode(text));

const blockSpec = (version, level) => ECC[level][version - 1];

function dataCapacity(version, level) {
  const [ecPerBlock, groups] = blockSpec(version, level);
  const blocks = groups.reduce((n, g) => n + g[0], 0);
  return TOTAL_CODEWORDS[version - 1] - ecPerBlock * blocks;
}

/** Data-codeword sizes of each block, in interleaving order. */
function dataBlockSizes(version, level) {
  const [, groups] = blockSpec(version, level);
  const sizes = [];
  for (const [count, size] of groups) for (let i = 0; i < count; i++) sizes.push(size);
  return sizes;
}

function pickVersion(byteLen, level) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + byteLen * 8 <= dataCapacity(v, level) * 8) return v;
  }
  throw new Error('Diiwaan QR: content too long for this error-correction level');
}

function encodeData(bytes, version, level) {
  const [ecPerBlock] = blockSpec(version, level);
  const dataCw = dataCapacity(version, level);

  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacity = dataCw * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padding = [0xEC, 0x11];
  for (let i = 0; codewords.length < dataCw; i++) codewords.push(padding[i % 2]);

  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const size of dataBlockSizes(version, level)) {
    const block = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(block);
    eccBlocks.push(eccCodewords(block, ecPerBlock));
  }

  const result = [];
  const maxData = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return result;
}

/* ---- matrix ---- */
function buildMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const set = (r, c, value) => {
    modules[r][c] = value;
    reserved[r][c] = true;
  };

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const on = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        set(rr, cc, on ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    set(6, i, on);
    set(i, 6, on);
  }

  const centers = ALIGN_CENTERS[version - 1];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
        }
      }
    }
  }

  set(size - 8, 8, 1); // dark module

  for (let i = 0; i < 9; i++) {
    if (modules[8][i] === null) set(8, i, 0);
    if (modules[i][8] === null) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (modules[8][size - 1 - i] === null) set(8, size - 1 - i, 0);
    if (modules[size - 1 - i][8] === null) set(size - 1 - i, 8, 0);
  }

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      set(size - 11 + c, r, 0);
      set(r, size - 11 + c, 0);
    }
  }

  return { size, modules, reserved };
}

function placeData(matrix, codewords) {
  const { size, modules, reserved } = matrix;
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  let index = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        modules[row][col] = index < bits.length ? bits[index] : 0;
        index++;
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function formatBits(level, maskId) {
  const data = (FORMAT_BITS[level] << 3) | maskId;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) * 0x1f25);
  return (version << 12) | rem;
}

function applyFormat(matrix, level, maskId) {
  const { size, modules } = matrix;
  const bits = formatBits(level, maskId);
  const bit = i => (bits >> i) & 1;
  // first copy: down the left of the top-right finder, then left along row 8
  for (let i = 0; i <= 5; i++) modules[i][8] = bit(i);
  modules[7][8] = bit(6);
  modules[8][8] = bit(7);
  modules[8][7] = bit(8);
  for (let i = 9; i <= 14; i++) modules[8][14 - i] = bit(i);
  // second copy: along row 8 on the right, then down column 8 at the bottom
  for (let i = 0; i <= 7; i++) modules[8][size - 1 - i] = bit(i);
  for (let i = 8; i <= 14; i++) modules[size - 15 + i][8] = bit(i);
}

function applyVersionInfo(matrix, version) {
  if (version < 7) return;
  const { size, modules } = matrix;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = (bits >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    modules[size - 11 + c][r] = on;
    modules[r][size - 11 + c] = on;
  }
}

function penalty(modules, size) {
  let score = 0;
  const runScore = line => {
    let total = 0, run = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === line[i - 1]) {
        run++;
      } else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let r = 0; r < size; r++) score += runScore(modules[r]);
  for (let c = 0; c < size; c++) score += runScore(modules.map(row => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) score += 3;
    }
  }

  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const finderLike = (line, i) => {
    for (let k = 0; k < 7; k++) if (line[i + k] !== pattern[k]) return false;
    const clear = arr => arr.length >= 4 && arr.every(v => v === 0);
    return clear(line.slice(Math.max(0, i - 4), i)) || clear(line.slice(i + 7, i + 11));
  };
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    const col = modules.map(x => x[r]);
    for (let i = 0; i + 7 <= size; i++) {
      if (finderLike(row, i)) score += 40;
      if (finderLike(col, i)) score += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += modules[r][c];
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** size×size array of 0/1 modules. `level` is 'L' | 'M' | 'Q' | 'H'. */
export function qrMatrix(text, level = 'M') {
  if (!ECC[level]) throw new Error(`unknown ECC level ${level}`);
  const bytes = toBytes(text);
  const version = pickVersion(bytes.length, level);
  const codewords = encodeData(bytes, version, level);

  let best = null;
  for (let maskId = 0; maskId < 8; maskId++) {
    const matrix = buildMatrix(version);
    placeData(matrix, codewords);
    const mask = MASKS[maskId];
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        if (!matrix.reserved[r][c] && mask(r, c)) matrix.modules[r][c] ^= 1;
      }
    }
    applyFormat(matrix, level, maskId);
    applyVersionInfo(matrix, version);
    const score = penalty(matrix.modules, matrix.size);
    if (!best || score < best.score) best = { score, modules: matrix.modules };
  }
  return best.modules;
}

/* ---- rendering ---- */

const isFinder = (r, c, n) =>
  (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);

function eyePath(row, col, radius) {
  // 7×7 finder drawn as a rounded ring plus a rounded core
  const outer = `M${col} ${row}h7v7h-7z`;
  const inner = `M${col + 1} ${row + 1}h5v5h-5z`;
  const core = `M${col + 2} ${row + 2}h3v3h-3z`;
  return { outer, inner, core, radius };
}

/**
 * Renders a scannable QR as SVG.
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.size]      pixel size of the rendered square
 * @param {number} [options.quiet]     quiet-zone modules (4 is the spec minimum)
 * @param {string} [options.dark]      module colour
 * @param {string} [options.light]     background colour ('transparent' allowed)
 * @param {string} [options.eye]       finder-pattern colour (defaults to dark)
 * @param {'square'|'rounded'|'dot'} [options.shape]
 * @param {string} [options.logo]      image URL/data-URI to place in the middle
 * @param {number} [options.logoScale] logo width as a share of the symbol (0.1–0.3)
 * @param {string} [options.level]     ECC level; forced to 'H' when a logo is used
 */
export function qrSvg(text, options = {}) {
  const {
    size = 240,
    quiet = 4,
    dark = '#011627',
    light = '#FDFFFC',
    eye,
    shape = 'square',
    logo = '',
    logoScale = 0.22
  } = options;

  const level = logo ? 'H' : (options.level || 'M');
  const modules = qrMatrix(text, level);
  const n = modules.length;
  const total = n + quiet * 2;
  const eyeColor = eye || dark;

  // Modules the logo will cover are left out so the art stays crisp.
  const hole = logo ? Math.ceil(n * Math.min(0.3, Math.max(0.1, logoScale)) + 2) : 0;
  const holeFrom = Math.floor((n - hole) / 2);
  const holeTo = holeFrom + hole;
  const covered = (r, c) => logo && r >= holeFrom && r < holeTo && c >= holeFrom && c < holeTo;

  let body = '';
  if (shape === 'dot' || shape === 'rounded') {
    const radius = shape === 'dot' ? 0.5 : 0.28;
    let circles = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!modules[r][c] || isFinder(r, c, n) || covered(r, c)) continue;
        circles += shape === 'dot'
          ? `<circle cx="${c + quiet + 0.5}" cy="${r + quiet + 0.5}" r="${radius}"/>`
          : `<rect x="${c + quiet + 0.06}" y="${r + quiet + 0.06}" width="0.88" height="0.88" rx="${radius}"/>`;
      }
    }
    body += `<g fill="${dark}">${circles}</g>`;
  } else {
    let path = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!modules[r][c] || isFinder(r, c, n) || covered(r, c)) continue;
        path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    body += `<path d="${path}" fill="${dark}"/>`;
  }

  // Finder patterns, drawn as three shapes so they can take a rounded style
  const radius = shape === 'square' ? 0 : 1.6;
  for (const [row, col] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const r = row + quiet, c = col + quiet;
    body += `
      <rect x="${c}" y="${r}" width="7" height="7" rx="${radius}" fill="${eyeColor}"/>
      <rect x="${c + 1}" y="${r + 1}" width="5" height="5" rx="${Math.max(0, radius - 0.6)}" fill="${light === 'transparent' ? '#FDFFFC' : light}"/>
      <rect x="${c + 2}" y="${r + 2}" width="3" height="3" rx="${Math.max(0, radius - 1.1)}" fill="${eyeColor}"/>`;
  }

  if (logo) {
    const pad = 0.6;
    const box = hole - pad * 2;
    body += `
      <rect x="${holeFrom + quiet + pad / 2}" y="${holeFrom + quiet + pad / 2}" width="${hole - pad}" height="${hole - pad}" rx="${box * 0.22}" fill="${light === 'transparent' ? '#FDFFFC' : light}"/>
      <image href="${logo}" x="${holeFrom + quiet + pad}" y="${holeFrom + quiet + pad}" width="${box}" height="${box}" preserveAspectRatio="xMidYMid meet" clip-path="inset(0 round ${box * 0.18})"/>`;
  }

  /* No width/height attributes: the SVG scales to its box, which keeps it exact
     on any display density instead of being rasterised at one size. crispEdges
     keeps square modules on the pixel grid; rounded and dot styles need real
     antialiasing to stay round. */
  return `<svg class="qr" viewBox="0 0 ${total} ${total}" preserveAspectRatio="xMidYMid meet" ` +
    `style="width:${size}px;max-width:100%;aspect-ratio:1" ` +
    `shape-rendering="${shape === 'square' ? 'crispEdges' : 'geometricPrecision'}" ` +
    `xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code linking to ${text}">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>${body}</svg>`;
}

// Test hook for test/qr-selftest.mjs.
export const _internals = { eccCodewords, generatorPoly, dataBlockSizes, toBytes, pickVersion, encodeData, buildMatrix, placeData, MASKS, applyFormat, applyVersionInfo, penalty, FORMAT_BITS };
