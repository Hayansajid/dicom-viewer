/**
 * Windowing/rendering only. Parsing and decompressing the DICOM file
 * itself (including JPEG 2000, JPEG-LS, RLE, and multi-frame files)
 * happens server-side - see backend/app/pixel_utils.py - so the browser
 * only ever deals with an already-decoded frame: a plain grayscale
 * float32 buffer already in real-world units (rescale slope/intercept
 * applied), or an RGB uint8 buffer for color images.
 */

/** Builds an ImageData for a canvas context from a decoded frame and window settings. */
export function toImageData(ctx, slice, wc, ww) {
  const { cols: w, rows: h, isColor, isMonochrome1 } = slice;
  const out = ctx.createImageData(w, h);
  const data = out.data;

  if (isColor) {
    const src = slice.pixelData;
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const d = i * 4;
      data[d] = src[o] || 0;
      data[d + 1] = src[o + 1] || 0;
      data[d + 2] = src[o + 2] || 0;
      data[d + 3] = 255;
    }
    return out;
  }

  const lo = wc - ww / 2;
  const hi = wc + ww / 2;
  const range = hi - lo || 1;
  const pd = slice.pixelData;

  for (let j = 0; j < pd.length; j++) {
    let norm = (pd[j] - lo) / range;
    if (norm < 0) norm = 0;
    else if (norm > 1) norm = 1;

    // MONOCHROME1: minimum pixel value is intended to be displayed as white
    let g = Math.round(norm * 255);
    if (isMonochrome1) {
      g = 255 - g;
    }

    const idx = j * 4;
    data[idx] = g;
    data[idx + 1] = g;
    data[idx + 2] = g;
    data[idx + 3] = 255;
  }
  return out;
}

/** Computes a sensible default window from the pixel data when the file didn't specify one. */
/** Computes a sensible default window from the pixel data when the file didn't specify one. */
export function computeFallbackWindow(slice) {
  if (slice.isColor) return { wc: 127, ww: 255, min: 0, max: 255 };

  let min = Infinity;
  let max = -Infinity;
  const pd = slice.pixelData;
  const step = Math.max(1, Math.floor(pd.length / 20000));

  for (let i = 0; i < pd.length; i += step) {
    const val = pd[i];
    if (val < min) min = val;
    if (val > max) max = val;
  }

  if (min === Infinity || min === max) {
    min = 0;
    max = 255;
  }

  return {
    wc: (min + max) / 2,
    ww: Math.max(1, max - min),
    min,
    max,
  };
}