/* Logo preparation.

   Whatever an owner picks — a 5 MB photo, a screenshot, an SVG export — is
   decoded, trimmed to a sensible size and re-encoded before it leaves the
   device. That does three jobs at once: customers on slow connections download
   a few tens of kilobytes instead of megabytes, storage never holds an SVG that
   could carry script, and the owner does not have to think about any of it. */

export const MAX_INPUT_BYTES = 5 * 1024 * 1024;
export const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_EDGE = 1024;         // plenty for a logo on a printed sign
const QUALITY = 0.92;

export const humanSize = bytes => bytes >= 1024 * 1024
  ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  : `${Math.round(bytes / 1024)} KB`;

function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    // An <img> never executes script inside an SVG, so this is a safe way to
    // rasterise one.
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That image could not be read.')); };
    image.src = url;
  });
}

const encode = (canvas, type, quality) =>
  new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));

/** Samples the alpha channel: a logo on a transparent ground must stay PNG. */
function hasAlpha(context, width, height) {
  try {
    const { data } = context.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4 * 37) {   // every 37th pixel is plenty
      if (data[i] < 250) return true;
    }
  } catch {
    return true; // tainted canvas: assume transparency and keep PNG
  }
  return false;
}

/**
 * @returns {Promise<{file: File, before: number, after: number, width: number, height: number}>}
 */
export async function prepareLogo(file, { name = 'logo' } = {}) {
  if (!ACCEPTED.includes(file.type)) {
    throw new Error('Use a PNG, JPEG, WebP or SVG image.');
  }
  if (file.size > MAX_INPUT_BYTES) {
    throw new Error(`That image is ${humanSize(file.size)} — the limit is 5 MB.`);
  }

  const image = await decode(file);
  // An SVG with no intrinsic size decodes as 0×0; give it a square to draw into.
  const naturalWidth = image.naturalWidth || MAX_EDGE;
  const naturalHeight = image.naturalHeight || MAX_EDGE;
  const scale = Math.min(1, MAX_EDGE / Math.max(naturalWidth, naturalHeight));
  const width = Math.max(1, Math.round(naturalWidth * scale));
  const height = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: true });
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);

  /* PNG when the artwork has transparency, JPEG when it does not. Both embed
     cleanly in the PDF reports, which WebP cannot — a logo has to work on the
     customer's screen and on the owner's printed report alike. */
  const transparent = hasAlpha(context, width, height);
  let type = transparent ? 'image/png' : 'image/jpeg';
  let blob = await encode(canvas, type, transparent ? undefined : QUALITY);
  if (!blob) {
    type = 'image/png';
    blob = await encode(canvas, type);
  }
  if (!blob) throw new Error('That image could not be processed.');

  const extension = type === 'image/png' ? 'png' : 'jpg';
  return {
    file: new File([blob], `${name}.${extension}`, { type }),
    before: file.size,
    after: blob.size,
    width,
    height
  };
}
