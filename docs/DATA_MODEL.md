# Data Model

All data is persisted client-side in IndexedDB via Dexie (`src/infrastructure/db/db.ts`, `PortfolioOsDatabase`, schema version 1). Every table's primary key is `id` (a UUID from `src/domain/value-objects/id.ts`).

## Tables

| Table | Indexes | Entity |
|---|---|---|
| `portfolios` | `kind`, `archivedAt` | `Portfolio` |
| `trades` | `portfolioId`, `ticker`, `[portfolioId+ticker]`, `executionDate` | `Trade` |
| `tradeAllocations` | `portfolioId`, `tradeId`, `ticker`, `sellGroupId`, `[portfolioId+ticker]` | `TradeAllocation` |
| `timelineEvents` | `portfolioId`, `type`, `ticker`, `timestamp` | `TimelineEvent` |
| `journalEntries` | `tradeId`, `portfolioId` | `JournalEntry` |
| `verifications` | `portfolioId`, `ticker`, `[portfolioId+ticker]`, `capturedAt` | `PositionVerification` |
| `uploads` | `portfolioId`, `fileHash`, `status` | `Upload` |

## The trade/allocation model

This is the core design decision in the whole product (see [ARCHITECTURE.md ADR-002](ARCHITECTURE.md#adr-002-explicit-per-trade-allocation-never-fifoaverage-cost)):

- **`Trade`** = one Buy execution. Immutable once created: `ticker`, `companyName`, `shares`, `entryPrice`, `fees`, `taxes`, `executionDate`/`executionTime` are never edited. `remainingShares` starts equal to `shares` and only ever decreases, and only via a `TradeAllocation` being recorded against it — never by direct mutation. `getTradeStatus(trade)` derives `"open"` (untouched) / `"partial"` (some shares closed) / `"closed"` (fully exited) from `remainingShares` — this is never stored, only computed.
- **`TradeAllocation`** = one Sell closing part (or all) of one specific `Trade`. A single sell action that spans multiple trades produces multiple `TradeAllocation` rows sharing one `sellGroupId`, so the timeline/UI can present it as one event while each lot's realized P/L (`realizedPnlMicros`, in `TradeAllocation.ts`) stays individually attributable.
- A ticker's **current position** in a portfolio = the sum of `remainingShares` across that ticker's `Trade`s with `remainingShares > 0`. There is no separately-stored "Holding" or "Position" table — positions are always computed on read (`TradeService.computePositions`), never persisted, so they can never drift out of sync with the trade ledger.
- **Moving a trade to a different portfolio** (`TradeService.moveTrade`, fixing a misassignment or a change of mind on how holdings should be split) reassigns `Trade.portfolioId`, refunds the buy's original cost to the source portfolio and charges it to the target, and moves any of its sells' net proceeds the same way — cash always follows the trade rather than being left behind. If the trade was sold together with other lots under one multi-trade `sellGroupId`, every lot in that group moves too (a single sell action can't end up split across two portfolios); the Buy/Sell/PartialSell timeline events narrating those trades move with them, but portfolio-level events (deposits, dividends, etc.) never do.
- **Cost basis** for the open portion of a trade = `(entryPrice * shares + fees + taxes) * (remainingShares / shares)` — a straight pro-rating of the original lot's total cost (fees and taxes both included — a broker-reported tax is real money spent, and is tracked separately from `fees` purely for reporting clarity, never treated differently in the math), not a re-averaged figure blended with other lots.

## Timeline

`TimelineEvent.type` covers: `Buy`, `Sell`, `PartialSell`, `Deposit`, `Withdrawal`, `Dividend`, `Split`, `RightsIssue`, `CashAdjustment`, `Note`. `TradeService.recordSell` chooses `Sell` vs `PartialSell` based on whether the sell action fully closed a single trade in one allocation, or left any remaining shares open / spanned multiple trades.

`Split` and `RightsIssue` are currently **record-only**: they log the event (ratio/details in `notes`) but do not automatically rebase existing trades' share counts or entry prices. Automatic rebasing was scoped out to avoid speculative complexity — add it as a deliberate follow-up if/when it's actually needed, not preemptively.

`Dividend` events can be dated to when the payout actually happened rather than to now — `PortfolioService.recordDividend` accepts an optional `date`, used both by the OCR import flow (see [OCR_SUBSYSTEM.md](OCR_SUBSYSTEM.md#dividend-history-extraction)) and by the manual "Record Dividend" action on `PortfolioDetailPage`, so a dividend lands on the timeline at its real payout date rather than clustering at entry time. Leaving the date blank defaults to now.

`CashAdjustment`, `Split`, and `RightsIssue` are all reachable from `PortfolioDetailPage`'s header actions ("Adjust Cash" and "Corporate Action") — `PortfolioService.recordCashAdjustment`/`recordSplit`/`recordRightsIssue` existed and were tested before the UI did; there is no remaining service-layer function without a UI path to reach it.

## Journal vs. Trade notes

`Trade.notes` / `Trade.strategyTags` are quick, execution-time fields set at fill time. `JournalEntry` (one per trade, `tradeId`-keyed) is the richer, reflective record: entry/exit reasoning, lessons learned, images, attachments. Both exist because they answer different questions ("what did I tag this trade as when I placed it" vs. "what did I learn after closing it").

Both entities carry their own `strategyTags`, and they're allowed to disagree — a tag added later during Journal reflection doesn't rewrite `Trade.strategyTags`. `strategyAttribution()` (see [ANALYTICS_ENGINE.md](ANALYTICS_ENGINE.md)) attributes by the **union** of both per trade, so a tag from either source counts, rather than only ever reading the fill-time one.

## Portfolio archiving

`Portfolio.archivedAt` (set/cleared via `PortfolioService.archivePortfolio`/`unarchivePortfolio`) hides a portfolio from the main `/portfolios` grid and the sidebar's portfolio switcher without touching any of its data — cash, trades, and history are all untouched, and unarchiving is a one-click reversal. `PortfoliosPage` keeps a collapsed "Archived (N)" section so an archived portfolio is still browsable, just not cluttering day-to-day navigation. Dashboard aggregates still include archived portfolios' totals — archiving is purely an organization/visibility concern, not a way to exclude real money from the numbers.

## Backup: export / import

`BackupService.exportLedger`/`importLedger` (`/data` page) move the *entire* ledger — every `Portfolio`, `Trade`, `TradeAllocation`, `TimelineEvent`, `JournalEntry`, and `PositionVerification` — in or out as one versioned JSON snapshot (`schemaVersion`, currently `1`). `Upload` rows are deliberately excluded: they're OCR duplicate-file bookkeeping with no other reader in the app (see [OCR_SUBSYSTEM.md](OCR_SUBSYSTEM.md)), not financial data, and are meaningless to replay on a different browser. Import is a **full replace** — every existing row in the six exported tables is deleted before the snapshot's rows are inserted — never a merge; see the file's own doc comment for why a merge's conflict-resolution problem is out of scope for a single-profile-at-a-time app.

## Ground-truth verification

`PositionVerification` records a snapshot from a broker's own "My Position" screen (units, avg cost, captured timestamp) independent of the trade ledger. It exists purely to help a user notice OCR-import drift — the app never uses it to silently overwrite trades; any reconciliation is a manual, explicit action (see [OCR_SUBSYSTEM.md](OCR_SUBSYSTEM.md#ground-truth-position-verification-and-reconciliation) for the mismatch/shortfall/stale reconciliation logic and the duplicate-trade detection run at import time).
