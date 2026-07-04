import { createWorker } from "tesseract.js";

export interface OcrProgress {
  status: string;
}

export type OcrProgressCallback = (progress: OcrProgress) => void;

/** Anything tesseract.js's worker.recognize() accepts directly. */
export type OcrImageInput = HTMLCanvasElement | Blob | File | string;

/**
 * tesseract.js defaults every one of these to a CDN (jsdelivr) when left
 * unset, so OCR would otherwise depend on a third-party host being reachable
 * at runtime — a hard break for a "fully client-side, no backend" app the
 * moment that CDN is blocked or unreachable (corporate proxy, restrictive
 * ISP, offline use). See `public/tesseract/README.md` for what's vendored
 * here and how to refresh it.
 */
const TESSERACT_ASSET_BASE = `${import.meta.env.BASE_URL}tesseract/`;
const LOCAL_TESSERACT_PATHS = {
  workerPath: `${TESSERACT_ASSET_BASE}worker.min.js`,
  corePath: `${TESSERACT_ASSET_BASE}tesseract-core-lstm.js`,
  langPath: TESSERACT_ASSET_BASE,
  // tesseract.js defaults to spawning the worker from a `blob:` URL (to dodge
  // CORS when workerPath is a CDN) — but that leaves the worker's own
  // location as an opaque blob: URL, which breaks the core script's relative
  // lookup of its sibling .wasm file. workerPath is same-origin here, so
  // there's no CORS problem to work around; spawning the worker directly
  // keeps a real location the core script can resolve its .wasm against.
  workerBlobURL: false,
};

/** Runs Tesseract once against a single image/canvas with a given language set. */
export async function runOcr(
  image: OcrImageInput,
  languages: string[],
  onProgress?: OcrProgressCallback,
): Promise<string> {
  const worker = await createWorker(languages, 1, {
    ...LOCAL_TESSERACT_PATHS,
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress({ status: `OCR: ${Math.round((m.progress ?? 0) * 100)}%` });
      }
    },
  });
  try {
    const result = await worker.recognize(image);
    return result.data.text;
  } finally {
    await worker.terminate();
  }
}

/** Runs OCR against a header-band canvas and a body canvas with one worker, concatenating the text. */
async function runOcrPair(
  languages: string[],
  headerBand: HTMLCanvasElement,
  body: HTMLCanvasElement,
  onProgress?: OcrProgressCallback,
): Promise<string> {
  const worker = await createWorker(languages, 1, {
    ...LOCAL_TESSERACT_PATHS,
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) {
        onProgress({ status: `OCR: ${Math.round((m.progress ?? 0) * 100)}%` });
      }
    },
  });
  try {
    const headerResult = await worker.recognize(headerBand);
    const bodyResult = await worker.recognize(body);
    return `${headerResult.data.text}\n${bodyResult.data.text}`;
  } finally {
    await worker.terminate();
  }
}

/** Recognizes several images with a single worker instance (row-isolated rescan: one row per slice), reused across all slices rather than spun up per-row. */
export async function recognizeBatch(images: OcrImageInput[], languages: string[]): Promise<string[]> {
  const worker = await createWorker(languages, 1, LOCAL_TESSERACT_PATHS);
  try {
    const texts: string[] = [];
    for (const image of images) {
      const result = await worker.recognize(image);
      texts.push(result.data.text);
    }
    return texts;
  } finally {
    await worker.terminate();
  }
}

/**
 * English-first, Arabic-retry OCR policy. Loading the Arabic and English
 * Tesseract models together measurably degrades English digit accuracy — a
 * real observed failure had a fulfilled order's timestamp ("01:57PM")
 * consistently misread as "74" only when both language models were loaded at
 * once, silently dropping that row downstream. English-only recognizes the
 * same text correctly every time, so it always runs first; the bilingual
 * pass is only retried when the English-only text doesn't match any known
 * document shape (so Arabic-language broker apps are still supported).
 */
export async function recognizeWithFallback(
  headerBand: HTMLCanvasElement,
  body: HTMLCanvasElement,
  isRecognizedDocument: (text: string) => boolean,
  onProgress?: OcrProgressCallback,
): Promise<{ text: string; usedFallback: boolean }> {
  const englishText = await runOcrPair(["eng"], headerBand, body, onProgress);
  if (isRecognizedDocument(englishText)) {
    return { text: englishText, usedFallback: false };
  }
  const bilingualText = await runOcrPair(["ara", "eng"], headerBand, body, onProgress);
  return { text: bilingualText, usedFallback: true };
}
