/**
 * Canvas-based image preprocessing for the OCR pipeline. Everything here
 * operates on an already-decoded HTMLCanvasElement so callers control image
 * loading (see loadImageToCanvas) and these functions stay unit-testable in
 * isolation from File/Blob decoding.
 */

/** Decodes a File (or Blob) into a same-size source canvas. Browser-only (createImageBitmap + canvas). */
export async function loadImageToCanvas(file: File | Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.drawImage(bitmap, 0, 0);
  return canvas;
}

// Same distance-from-white measure used everywhere below: thresholding on
// distance from white per-channel (rather than converting to grayscale
// first) keeps saturated/dark text visible regardless of hue. Tesseract's
// own luminance-based binarization fails on Thndr's pastel-green "Fulfilled"
// status text — its grayscale luminance sits close enough to the white
// background that Tesseract's page segmentation drops the text entirely
// rather than misreading it (confirmed: the status column is silently
// absent from OCR output while every other column, including low-contrast
// ones, comes through fine).
const INK_THRESHOLD = 40;

/**
 * Full-body binarization: black text on white, at the cost of losing any
 * text that isn't sufficiently far from white (see header-band handling
 * below, which is why the header is cropped and preprocessed separately
 * instead of being binarized along with the rest of the page).
 */
export function preprocessForOcr(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(source, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const distFromWhite = 255 - Math.min(data[i], data[i + 1], data[i + 2]);
    const v = distFromWhite > INK_THRESHOLD ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Crops the app header band (ticker code, company name) at native colors,
 * top ~30% height / ~80% width. Full-page OCR consistently drops this text
 * (not misreads — drops it outright), apparently confused by the adjacent
 * back-arrow/bell/heart icons, even though the identical text OCRs correctly
 * in isolation. The header background is dark with light text in every
 * observed sample, so it is deliberately left un-binarized — running it
 * through the white-background threshold above would invert exactly the
 * text this crop exists to recover.
 */
export function cropHeaderBand(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(source.width * 0.8);
  canvas.height = Math.round(source.height * 0.3);
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.drawImage(source, 0, 0);
  return canvas;
}

/**
 * One row of an Orders-screen screenshot, isolated before OCR.
 * `colorStatus` is read from pixel color, not OCR'd text, because reading a
 * color is far more reliable than OCR-ing a small-font status word (the
 * failure this exists to eliminate: a misread status word cross-paired a
 * Cancelled order into the Fulfilled count). null when neither saturated
 * green nor red is present in enough quantity (e.g. a Pending row) — the
 * caller then falls back to the row's own OCR'd status word.
 */
export interface OrderRowSlice {
  canvas: HTMLCanvasElement;
  colorStatus: "fulfilled" | "cancelled" | null;
}

/**
 * Boundary between "line spacing within one order row" gaps and everything
 * larger (row separation, list furniture like the "All orders" title or the
 * Buy/Sell buttons), computed from the gaps themselves so it holds across
 * resolutions. Infinity when every gap is within-row spacing (a single row).
 *
 * The within-row gaps form the smallest, tightest cluster, so the boundary
 * is the first >=1.8x jump between consecutive sorted gaps — everything
 * before the jump is line spacing, everything after separates rows. The
 * previous formula, max(minGap*1.8, ((minGap+maxGap)/2)*0.8), failed on a
 * real full-screen capture (measured gaps [73, 36x5, 122-124x4, 284]): the
 * 284px gap before the Buy/Sell buttons dragged the midpoint term to ~143,
 * above the real ~123px between-row gaps, merging all five rows into one
 * slice that then parsed as a single order. A global minimum-variance
 * two-cluster split fails on the same capture for the opposite reason —
 * that outlier is so extreme that isolating it *alone* minimizes variance
 * (threshold ~204), which again merges the rows. Only the first-jump rule
 * finds the within/between boundary regardless of how many clusters sit
 * above it.
 */
export function rowGroupingGapThreshold(gaps: number[]): number {
  const sorted = [...gaps].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] >= sorted[i] * 1.8) return (sorted[i] + sorted[i + 1]) / 2;
  }
  return Infinity;
}

/**
 * Geometrically segments an Orders-screen screenshot into one canvas per
 * order row using ink-density scanlines, so each row is OCR'd independently
 * and cross-row status mispairing (Tesseract does not reliably preserve
 * top-to-bottom reading order for this two-line-per-row layout) becomes
 * geometrically impossible rather than merely unlikely.
 *
 * Geometry validated against real Thndr screenshots (1179px-wide iPhone
 * captures): two text lines per row (action+price, then date+status) sit
 * ~36px apart, while consecutive rows are separated by ~120px plus a
 * hairline divider. The ~3x contrast between within-row and between-row
 * gaps is what the grouping step keys on, so it holds across resolutions
 * instead of depending on fixed pixel sizes.
 */
export function segmentOrderRows(source: HTMLCanvasElement): OrderRowSlice[] {
  const w = source.width;
  const h = source.height;
  const ctx = source.getContext("2d");
  if (!ctx) return [];
  const data = ctx.getImageData(0, 0, w, h).data;

  const minChannel = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return Math.min(data[i], data[i + 1], data[i + 2]);
  };

  // 1. Find where the light-background body starts: the app header above it
  // is dark. No light body at all (full dark mode, unseen in practice)
  // yields no rows — the caller falls back to the flat-text parser.
  let bodyStart = -1;
  const xSamples = Math.ceil(w / 8);
  for (let y = 0; y < h; y++) {
    let light = 0;
    for (let x = 0; x < w; x += 8) {
      if (minChannel(x, y) > 200) light++;
    }
    if (light / xSamples > 0.85) {
      bodyStart = y;
      break;
    }
  }
  if (bodyStart < 0) return [];

  // 2. Ink profile: which scanlines contain text. Sampled every 4px
  // horizontally; a line counts as text once ~24px worth of ink shows up,
  // comfortably clearing hairline dividers and anti-aliasing noise.
  const isTextLine: boolean[] = new Array(h).fill(false);
  for (let y = bodyStart; y < h; y++) {
    let ink = 0;
    for (let x = 0; x < w; x += 4) {
      if (255 - minChannel(x, y) > INK_THRESHOLD) ink++;
      if (ink >= 6) break;
    }
    isTextLine[y] = ink >= 6;
  }

  // 3. Consecutive text scanlines form bands (one band ~ one text line).
  // Bands under 6px tall are divider lines/noise, not text.
  const bands: Array<{ top: number; bottom: number }> = [];
  let bandStart = -1;
  for (let y = bodyStart; y <= h; y++) {
    const text = y < h && isTextLine[y];
    if (text && bandStart < 0) bandStart = y;
    else if (!text && bandStart >= 0) {
      if (y - bandStart >= 6) bands.push({ top: bandStart, bottom: y });
      bandStart = -1;
    }
  }
  if (bands.length === 0) return [];

  // 4. Group bands into order rows: gaps larger than rowGroupingGapThreshold
  // separate rows, smaller ones are line spacing within a row.
  const groups: Array<Array<{ top: number; bottom: number }>> = [[bands[0]]];
  if (bands.length > 1) {
    const gaps = bands.slice(1).map((b, i) => b.top - bands[i].bottom);
    const threshold = rowGroupingGapThreshold(gaps);
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i] > threshold) groups.push([]);
      groups[groups.length - 1].push(bands[i + 1]);
    }
  }

  // 5. One slice per group: thresholded crop for OCR + color-derived status.
  const slices: OrderRowSlice[] = [];
  for (const group of groups) {
    const top = Math.max(bodyStart, group[0].top - 10);
    const bottom = Math.min(h, group[group.length - 1].bottom + 10);
    if (bottom - top < 20) continue; // too short to be a real row

    // Status color scan, right 45% of the row where the status label sits.
    // Thresholds picked off real captures: Fulfilled green ~ rgb(60,170,80),
    // Cancelled red ~ rgb(240,70,60); black/gray body text triggers neither.
    // 30+ matching pixels required so a stray anti-aliased edge can't decide
    // a status (real labels measure in the hundreds).
    let green = 0;
    let red = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = Math.floor(w * 0.55); x < w; x += 2) {
        const i = (y * w + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (g > r + 30 && g > b + 30 && g > 100) green++;
        else if (r > g + 40 && r > b + 40 && r > 120) red++;
      }
    }
    const colorStatus = green > Math.max(red, 30) ? "fulfilled" : red > Math.max(green, 30) ? "cancelled" : null;

    const rowCanvas = document.createElement("canvas");
    rowCanvas.width = w;
    rowCanvas.height = bottom - top;
    const rowCtx = rowCanvas.getContext("2d");
    if (!rowCtx) continue;
    rowCtx.drawImage(source, 0, top, w, bottom - top, 0, 0, w, bottom - top);
    const rowImage = rowCtx.getImageData(0, 0, w, bottom - top);
    const rowData = rowImage.data;
    for (let i = 0; i < rowData.length; i += 4) {
      const distFromWhite = 255 - Math.min(rowData[i], rowData[i + 1], rowData[i + 2]);
      const v = distFromWhite > INK_THRESHOLD ? 0 : 255;
      rowData[i] = v;
      rowData[i + 1] = v;
      rowData[i + 2] = v;
    }
    rowCtx.putImageData(rowImage, 0, 0);

    slices.push({ canvas: rowCanvas, colorStatus });
  }

  return slices;
}
