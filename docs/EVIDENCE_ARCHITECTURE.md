# Evidence Architecture

Covers three additions layered on top of the existing raw-transaction
foundation (see `ROADMAP.md`'s "Architecture Foundation" entry and
`VERIFICATION_ENGINE.md`): extraction provenance, the Evidence Graph, and the
richer minimal-document recovery plan. None of these are a new source of
truth — every one is either an additive field on `RawTransaction`/`Upload`,
or a read-only view composing what `verificationEngine.ts`/
`completenessEngine.ts` already compute.

## Extraction provenance

`RawTransaction` gained two fields, both set once at extraction time and
never recomputed:

- `extractionMethod` (`"native-pdf-text" | "ocr-tesseract" | "csv-text" |
  "manual-entry"`) — how the fact's text was obtained, independent of
  `confidence` (which reflects ticker-resolution certainty within
  already-extracted text, not the reliability of the channel that produced
  it). A native PDF/CSV text layer is machine-generated and effectively
  lossless; a Tesseract OCR read of a photographed screen has a real,
  separate misread risk neither `confidence` nor the OCR-derived text itself
  can see. Set once, in `ImportOrchestrator.importFile` (it already knows
  whether the upload was an image, a PDF, or plain text), stamped onto every
  candidate/order-evidence row via `withProvenance()` before returning.
- `parserVersion` — which released version of the `BrokerParser`
  (`ThndrParser.version`/`CsvStatementParser.version`) produced the fact.
  Lets a future re-parse of the permanently-stored original document
  (`Upload.fileBlob`) identify exactly which live facts predate a parser fix.

Both flow through `importRecording.ts` unchanged from the
`ParsedTradeCandidate`/`ParsedOrderEvidence` shape into
`createRawTransaction`.

**Not yet wired to a decision.** These fields are captured and queryable
(via the Evidence Graph's transaction nodes) but nothing in
`verificationEngine.ts`/`completenessEngine.ts` conditions a verdict or a
recovery-document recommendation on `extractionMethod` yet — e.g. "trust a
native-PDF Statement's conflict with an OCR'd screenshot before the
reverse," which the first architecture review flagged as a real gap. Wiring
that in is the natural next step now that the signal exists (see "Future
recommendations").

## Evidence Graph (`src/application/services/evidenceGraph.ts`)

`buildEvidenceGraph(ticker, params, uploads?)` returns `{ nodes, edges }`:

- **Nodes**: one `transaction` node per live Buy/Sell `RawTransaction` in
  scope (ticker, side, shares, price, date, source, extraction
  method/confidence, parser version, verdict); one `document` node per
  `Upload` any of those transactions were extracted from (deduplicated);
  exactly one `ticker-position` node the ticker's transactions all converge
  on, carrying `checkTickerMatch`'s own `matched`/`reason`/`netShares` plus
  the full `TickerCompletenessReport`.
- **Edges**: `sourced-from` (transaction → its Upload), `corroborates` /
  `contradicts` (transaction → transaction, built directly from
  `verifyAllDetailed`'s own `EvidenceItem[]` — see below), `reconciles-against`
  (every transaction → the ticker node), `missing` (the ticker node → itself,
  one per orphaned Orders-history row with no matching transaction at all —
  there is no transaction node for a fact that doesn't exist yet).

This mirrors the worked example (Invoice → Transaction → Orders → Statement
→ My Position) as a real convergence: every document-derived fact for a
ticker is a node that ultimately points at that ticker's one reconciliation
outcome, with corroboration/contradiction edges linking facts to each other
along the way.

**Deliberately not persisted.** No new Dexie table, no `EvidenceGraphRepository`.
This codebase's existing projections (`ledgerCache`, `allocationsCache`, and
every `*Engine` module — see `holdingsEngine.ts`'s own doc comment) already
established the rule that anything cheaply and correctly derivable from
`RawTransaction` must be regenerated fresh on every read, never cached as a
second source of truth that can silently drift as new evidence arrives.
"Corroborates"/"contradicts" are judgments about the *current total evidence
set* — they must be recomputed whenever that set grows (a new upload), not
remembered from the last time they were computed. Storing them on the fact
itself, as originally specified, would reintroduce exactly the staleness
risk this architecture's append-only design exists to prevent: an old fact's
stored "corroborated by X" would need active invalidation the moment a
contradicting document arrives later, and a missed invalidation is a silent
truth-drift bug. The graph is a *view*, rebuilt on demand from
`verifyAllDetailed` + `assessTickerCompleteness`, exactly like every other
derived structure in this codebase.

**One real gap closed while building this**: `EvidenceItem.matchedTransactionId`
existed in the type since the Verification Engine contract was completed
(Phase 9.5) but was never actually populated — `corroboratingSourceLabel`
computed the donor transaction internally and then discarded it, returning
only a label string. Renamed to `corroboratingSource` and now returns the
donor's key too, so `matchedTransactionId` is populated for real,
transaction-to-transaction `corroborates` edges instead of being a dead
field. This was a pre-existing gap, not something the graph introduced —
building the graph is what surfaced it.

## Minimal-document recovery plan

`completenessEngine.RecoveryPlan` gained `expectedExecution?: { ticker, side,
date?, shares? }` — populated only in the direct-evidence branch (an
orphaned Orders-history row already names the missing transaction exactly),
using that row's own ticker/side/date/shares. Never fabricated for a bounded
or unbounded arithmetic gap, which by construction can't point at one
specific execution. Matches the business rule's own worked example (a named
ticker, date, and quantity, not a vague "upload more history").

## Known limitations

- `extractionMethod` is captured but not yet a decision input anywhere (see above).
- `expectedExecution` only ever names the *first* orphaned row when several
  exist for one ticker — multiple gaps need multiple separate requests, not
  one bundled one; the plan intentionally returns one concrete ask, not a
  list, but a ticker with two distinct missing executions currently only
  surfaces the first.
- `page` (which page of a multi-page PDF a fact came from) was scoped out —
  `extractPdfText` joins every page into one text block with no page-boundary
  tracking, and none of this app's real Statement PDFs are long enough (1-2
  pages) to make that worth the risk of reworking PDF extraction/row-parsing
  internals for a field nothing currently reads.
