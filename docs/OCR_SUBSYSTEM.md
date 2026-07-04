# OCR Subsystem — Screenshot Import

Portfolio OS can import trades directly from broker screenshots and PDF statements, entirely client-side — no image or text ever leaves the browser. The reference broker is [Thndr](https://thndr.app), a popular Egyptian brokerage app, with support for Buy/Sell confirmations, order-history screens, portfolio/position screenshots, and statement PDFs, in both Arabic and English.

## Pipeline (`src/infrastructure/ocr/ImportOrchestrator.ts`)

```
File
 ├─ PDF  → pdfText.ts (pdfjs-dist text layer extraction)
 └─ image → imagePreprocess.ts (crop + binarize) → tesseractClient.ts (OCR)
                                                          │
                                     rawText ─────────────┘
                                          │
                     BrokerParser.looksLikePositionVerification? ──yes──▶ parsePositionVerification
                                          │ no
                     BrokerParser.parseStatementText  (dated statement rows)
                                          │ no match
                     BrokerParser.parseOrdersScreenText (flat parse)
                                          │ zero candidates on an image
                     row-isolated re-scan: segmentOrderRows → per-row OCR → parseOrderRowsText
```

Each stage that finds nothing hands off to the next; warnings (incomplete rows, status-count mismatches, out-of-range dates) are carried through to the final `ImportResult` rather than silently dropped, so the user can tell *why* a screenshot only produced a partial result.

## Why OCR quality required this many stages

- **Arabic + English loaded together measurably degrades English digit accuracy** (a real observed failure: a timestamp misread only when both language models were loaded). `tesseractClient.ts` always tries English-only first, and only retries with Arabic+English if the English pass doesn't match any known document shape.
- **Full-page binarization drops real content.** The header (ticker + company name, next to icons) is white-on-dark and needs its native colors preserved; the body needs hard black/white thresholding because Thndr's pastel-green "Fulfilled" status text is invisible to Tesseract's default luminance-based binarization. `imagePreprocess.ts` handles these as two separate crops/passes.
- **Order-history screenshots can mispair a status label with the wrong row** when OCR'd as one flat image. `segmentOrderRows` geometrically segments the image into per-row canvases by ink-density scanline gaps, and each row is OCR'd independently — this makes cross-row mispairing structurally impossible rather than something to detect after the fact. Row status (Fulfilled vs. Cancelled) is read from **pixel color**, not OCR'd text, since a saturated green/red patch is far more reliable than small status-word OCR.
- **Printed per-share prices don't include brokerage commission**, but a statement's "Value" column (money actually debited/credited) does — so wherever a Value figure is present, `ThndrParser` derives `price = abs(value) / quantity` instead of trusting the printed price, so downstream P/L matches what the broker itself would show.
- **Ticker resolution tolerates OCR letter-garbling**: exact match → prefix match → Levenshtein fuzzy match against `KNOWN_EGX_TICKERS` (`src/domain/value-objects/knownTickers.ts`).

## Adding a new broker

Implement `BrokerParser` (`src/infrastructure/ocr/parsers/BrokerParser.ts`) and add an instance to the `parsers` array passed into `ImportOrchestrator`. Each parser is responsible for recognizing its own documents (`looksLikeOwnDocument`) so multiple brokers' parsers can coexist without one's regexes accidentally matching another's screenshot. Do not add broker-specific branches inside `ThndrParser.ts` — that file is Thndr-only by design.

## Ground truth: position verification

A "My Position" screenshot (units, average cost) is parsed independently of trade history and stored as a `PositionVerification` (see [DATA_MODEL.md](DATA_MODEL.md#ground-truth-verification)). It's a manual reconciliation aid, never an automatic trade-ledger correction.
