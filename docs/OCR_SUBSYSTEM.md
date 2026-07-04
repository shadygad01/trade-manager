# OCR Subsystem — Screenshot Import

Portfolio OS can import trades directly from broker screenshots and PDF statements, entirely client-side — no image or text ever leaves the browser. The reference broker is [Thndr](https://thndr.app), a popular Egyptian brokerage app, with support for Buy/Sell confirmations, order-history screens, portfolio/position screenshots, per-trade invoice PDFs, and statement PDFs, in both Arabic and English.

Import (`/import`) is a global page, not scoped to one portfolio, and runs as an explicit two-phase workflow:

1. **Extract** — select or drop any number of files at once (screenshots, PDFs, CSVs); they're processed sequentially through one shared Tesseract worker (parallel OCR workers would contend for CPU/memory in the same tab) with a "Processing X of N: filename" progress indicator, and every file's candidates/verification rows accumulate into one pool rather than replacing the previous file's results. A running "N transactions from M files" count is the confirmation that extraction is complete before moving to Step 2 — more files can still be dropped in at any time.
2. **Distribute** — the accumulated pool is grouped by ticker, and each ticker group gets exactly **one** portfolio picker shared by every buy, sell, and verification row for that ticker. This is deliberate: a sell only makes sense against the specific portfolio holding the shares it closes, so assigning a ticker's buys to a portfolio must carry its sells along automatically rather than asking the user to repeat the same choice per row.

`Upload.portfolioId` is therefore optional; the file-hash dedup check (`UploadRepository.getByHash`) and the possible-duplicate check against existing trades (`duplicateDetection.ts`) are both global, not per-portfolio, since a re-uploaded file or a duplicated trade is a duplicate regardless of which portfolio it's assigned to.

The Step 1/2 pool itself (`src/presentation/lib/importSession.ts`) deliberately does **not** live in the page component's React state: the two-phase workflow expects a user to leave the Import page mid-session (e.g. to create a portfolio to distribute into) and come back, and plain `useState` is destroyed the moment the page unmounts. It's a module-level store instead, persisted to `localStorage` so it survives both in-app navigation and a full page reload, read via a `useSyncExternalStore`-backed hook (`useImportSession`). A "Clear all" action clears it explicitly once a session's distribution is done — it never clears itself automatically — and also deletes every persisted `Upload` record (`UploadRepository.getAll`), so a file cleared this way can be re-imported afterward instead of being permanently flagged as a duplicate.

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

`parseStatementText` itself routes between two genuinely different Thndr document shapes rather than being a single format: the dated "Customer Account Statement" (`Buy X (qty@price)` inline rows, price derived from the Value column) and a per-trade "Invoice" PDF — a one-transaction-per-document email receipt with every field explicitly labeled ("Security Name", "Total Quantity", "Total Fees", ...) instead of positionally guessed at. `looksLikeInvoiceImpl` detects the latter (its own footer states "the text in this invoice is standardized"), letting that path trust `Average Price`/`Total Cost`/`Total Fees` directly — a more reliable source than any screenshot this file otherwise parses — rather than deriving price from a Value column.

## Why OCR quality required this many stages

- **Arabic + English loaded together measurably degrades English digit accuracy** (a real observed failure: a timestamp misread only when both language models were loaded). `tesseractClient.ts` always tries English-only first, and only retries with Arabic+English if the English pass doesn't match any known document shape.
- **Full-page binarization drops real content.** The header (ticker + company name, next to icons) is white-on-dark and needs its native colors preserved; the body needs hard black/white thresholding because Thndr's pastel-green "Fulfilled" status text is invisible to Tesseract's default luminance-based binarization. `imagePreprocess.ts` handles these as two separate crops/passes.
- **Order-history screenshots can mispair a status label with the wrong row** when OCR'd as one flat image. `segmentOrderRows` geometrically segments the image into per-row canvases by ink-density scanline gaps, and each row is OCR'd independently — this makes cross-row mispairing structurally impossible rather than something to detect after the fact. Row status (Fulfilled vs. Cancelled) is read from **pixel color**, not OCR'd text, since a saturated green/red patch is far more reliable than small status-word OCR.
- **Printed per-share prices don't include brokerage commission**, but a statement's "Value" column (money actually debited/credited) does — so wherever a Value figure is present, `ThndrParser` derives `price = abs(value) / quantity` instead of trusting the printed price, so downstream P/L matches what the broker itself would show.
- **Ticker resolution tolerates OCR letter-garbling**: exact match → prefix match → Levenshtein fuzzy match against `KNOWN_EGX_TICKERS` (`src/domain/value-objects/knownTickers.ts`).
- **A statement row's description can OCR down to an implausibly short fragment** (real observed failure: a garbled read producing just "TE" as a whole description) — `ThndrParser.resolveTicker` rejects any normalized company-name key under `MIN_UNMAPPED_NAME_LENGTH` (3 characters) outright rather than either (a) fabricating a fallback "ticker" out of noise, or (b) letting the prefix-match step spuriously match a short fragment against an unrelated long company name (`"TELECOM EGYPT".startsWith("TE")` was a real false positive this exposed). The row is dropped, not surfaced as a bogus low-confidence candidate.

## Adding a new broker

Implement `BrokerParser` (`src/infrastructure/ocr/parsers/BrokerParser.ts`) and add an instance to the `parsers` array passed into `ImportOrchestrator`. Each parser is responsible for recognizing its own documents (`looksLikeOwnDocument`) so multiple brokers' parsers can coexist without one's regexes accidentally matching another's screenshot. Do not add broker-specific branches inside `ThndrParser.ts` — that file is Thndr-only by design.

`CsvStatementParser` (`src/infrastructure/ocr/parsers/CsvStatementParser.ts`) is the second implementation, proving the extension point against a genuinely different input shape: a plain CSV/TSV transaction export (flexible header aliases, comma/semicolon/tab delimiter auto-detection, d/m/y or ISO dates), which involves no OCR/image processing at all — `ImportOrchestrator` routes any non-image, non-PDF file straight to its raw decoded text. Screenshot-only interface methods (`parseOrdersScreenText`, `parsePositionVerification`, `resolveHeaderTicker`, `parseOrderRowsText`) are legitimately empty no-ops for this parser, since those concepts don't exist in a CSV export.

Both parsers share `trackedDateRange.ts`'s rolling-cutoff helpers rather than each maintaining their own copy — extend that module, don't fork it, if a new parser needs date-range logic.

## Dividend history extraction

A "My Position" screenshot's "Earned Cash Dividends" section (a per-payout list of date + EGP amount below the position header) is parsed by `BrokerParser.parseDividends` into `ParsedDividendCandidate[]` — one entry per historical payout, dated to when the dividend was actually paid rather than to import time. `ThndrParser.parseDividends` resolves the ticker from the same position-verification header used for units/avg-cost, then regex-matches each `<date> EGP <amount>` row under the section marker; `CsvStatementParser.parseDividends` is a no-op since a transaction CSV export has no such section.

These land in the Import page's Step 2 distribution pool alongside buy/sell candidates and verification rows (grouped by ticker, same portfolio picker), each with an "Add as Dividend" action that calls `PortfolioService.recordDividend` with the screenshot's own date — so a dividend paid months ago is timelined to that date, not to the moment it was imported. Recorded dividends flow into `equityCurve`/`portfolioReturn` like any other `TimelineEvent`, and are summed across all portfolios in the Dashboard's "Total Dividends" tile.

## Ground truth: position verification and reconciliation

A "My Position" screenshot (units, average cost) is parsed independently of trade history and stored as a `PositionVerification` (see [DATA_MODEL.md](DATA_MODEL.md#ground-truth-verification)). `src/application/services/reconciliation.ts` (`reconcilePositions`) compares the trade-ledger-derived position for each ticker against the most recent verification and flags:

- **`quantityMismatch`** — computed shares exceed the verified units (likely a duplicate or misparsed trade).
- **`quantityShortfall`** — computed shares fall short of the verified units (a trade is missing from the ledger — including the case where the portfolio has zero open trades for a verified ticker).
- **`verificationStale`** — a trade/allocation for that ticker was recorded after the screenshot was captured, so the gap is expected and the two flags above are suppressed.

This is surfaced on `PortfolioDetailPage`'s holdings table. `quantityMismatch` lists the ticker's open trades directly so the actual duplicate can be deleted (`TradeService.deleteTrade` — refunds its cost and removes its `Buy` event, guarded to only unallocated trades) instead of just labeled a warning; an earlier "Accept as current" action was removed because it only re-labeled the wrong computed total as verified without fixing anything. `quantityShortfall` remains pure information — the ledger is never auto-corrected by filling in an invented trade.

## Duplicate-trade detection on import

`src/application/services/duplicateDetection.ts` checks each freshly parsed candidate against trades/allocations already on the ledger (same ticker, date, and share count): an **exact** match (price matches too) usually means the same file was re-imported; a **possible** match (price differs) usually means the same real trade was parsed from two different document formats — one commission-inclusive, one not (see the price-from-value note above). `ImportPage` surfaces this as a badge next to the candidate and relabels the action button ("Add anyway" / "Allocate anyway") — it never blocks the action, since a false positive should never prevent recording a real trade.

## Confidence scoring

Every `ParsedTradeCandidate` carries a `confidence: "high" | "medium" | "low"` (see `ThndrParser.ts`), combining two independent signals — whichever is weaker wins (`downgrade()`):

1. **Ticker resolution**: exact company-name match = high, prefix or Levenshtein-fuzzy match = medium, unmapped fallback = low.
2. **Parse-path reliability**: statement rows are anchored/regex-strict (no path penalty); the flat orders-screen parse pairs fields positionally and has a documented mispairing failure mode, so it's capped at medium regardless of ticker confidence; the row-isolated rescan is otherwise the most reliable path, but is capped at medium for rows whose status came from the OCR'd status word rather than pixel color (the less reliable of the two status sources — see above).

`ImportPage` shows this as a labeled colored dot next to each candidate. It is a cue to double-check, never a filter — a low-confidence candidate is still fully actionable, just flagged.

**Low confidence gates the action, not just a label.** A `confidence: "low"` row (`CandidateRow` in `ImportPage.tsx`) requires an explicit "I've checked this row is correct" checkbox before its Add/Allocate button is even clickable — a low ticker-resolution confidence usually means an unmapped-company fallback that can be flat-out wrong (see the merge-suggestion and manual-rename features above), so this is the one confidence tier where a single click is deliberately not enough. High/medium rows are unaffected — the checkbox only appears where confidence is genuinely weak.

## Correcting a wrong ticker

The header-ticker fallback (used when a screenshot's company name doesn't resolve against `KNOWN_EGX_TICKERS`) only accepts an all-caps token of exactly 4 letters — every real EGX ticker is 4 characters, so a 2-3 letter OCR fragment near the header (a misread label, not the actual ticker) is rejected outright rather than fabricated into a bogus ticker group. This closed one real failure mode, but OCR ticker resolution can never be made perfect for every unmapped company, so `ImportPage`'s Step 2 also lets the ticker itself be corrected directly: clicking a ticker group's heading turns it into an editable field, and confirming a new ticker moves every pending candidate/verification/dividend currently grouped under the old one to the corrected ticker (and carries over its chosen portfolio, if one was already picked). This is a pending-pool-only edit — nothing is touched once a row has already been added as a real trade/dividend/verification.

**Automatic merge suggestion.** Manually retyping a ticker for every misread group doesn't scale, but the app can't silently guess at financial data either — so `ImportPage` computes a `mergeSuggestions` map: when a ticker group's every buy/sell candidate is `confidence: "low"` (i.e. resolved from the unmapped-company fallback, not a real company-name match) and another group in the same pending batch has a byte-for-byte identical set of buy/sell rows (same side, shares, price, and date), it's flagged as almost certainly the same real upload read under a different guessed ticker. This only ever renders a one-click "Merge into X" suggestion — nothing merges without that click, and a coincidental exact match across unrelated real trades is vanishingly unlikely. It never fires for two groups that are merely similar, only identical.

**Existing-portfolio suggestion.** A ticker that already has trades recorded in one portfolio no longer requires re-picking a portfolio on every subsequent import: `portfolioForTicker` defaults to that portfolio automatically (shown as a note above the ticker card), unless the ticker already has trades split across more than one portfolio, in which case nothing is auto-picked and the note lists all of them — an intentionally ambiguous case left to the user to resolve.

**Row-level failures are surfaced, not swallowed.** `addBuyCandidate`, `addDividend`, and `acceptVerification` all wrap their write in a try/catch and render the failure inline under that row (most commonly `recordBuy`'s "insufficient cash" guard, which real historical/backfilled imports can hit before a portfolio's deposits are fully recorded) — previously an unhandled promise rejection meant the row silently never added and gave no indication why.

An insufficient-cash failure specifically gets a real recovery action, not just a message: `recordBuy` throws a structured `InsufficientCashError` (`portfolioId`/`required`/`available`, see `application/services/errors.ts`) rather than a plain `Error`, so `ImportPage` can show "Portfolio X is short ¤Y for this buy — Deposit ¤Y & add" and, on click, deposit exactly the shortfall then retry the same buy — one action instead of leaving Import to deposit manually and coming back.
