Self-hosted tesseract.js runtime assets — vendored so OCR never depends on a
third-party CDN being reachable (tesseract.js defaults `workerPath`,
`corePath`, and `langPath` to `cdn.jsdelivr.net` when left unset, which
breaks OCR entirely under any network policy that blocks it).

Wired up in `src/infrastructure/ocr/tesseractClient.ts` via
`LOCAL_TESSERACT_PATHS`.

Files here (tesseract.js v7.0.0):

- `worker.min.js` — from `node_modules/tesseract.js/dist/worker.min.js`
- `tesseract-core-lstm.js` + `tesseract-core-lstm.wasm` — the plain
  (non-SIMD) LSTM-only core from `node_modules/tesseract.js-core/`. Using
  the non-SIMD build trades a little recognition speed for not needing
  runtime SIMD feature detection — negligible for this app's occasional,
  small OCR jobs.
- `eng.traineddata.gz`, `ara.traineddata.gz` — the LSTM-only ("best_int")
  trained data this app actually uses (`recognizeWithFallback` only ever
  requests `eng` or `ara+eng`), from the `@tesseract.js-data/eng` and
  `@tesseract.js-data/ara` npm packages (`4.0.0_best_int/*.traineddata.gz`).

To refresh after bumping the `tesseract.js` dependency: reinstall, then
`npm install --no-save @tesseract.js-data/eng@<matching-version> @tesseract.js-data/ara@<matching-version>`
and re-copy the five files above from `node_modules`.
