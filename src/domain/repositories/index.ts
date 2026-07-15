import type { Portfolio } from "../entities/Portfolio";
import type { Trade } from "../entities/Trade";
import type { TradeAllocation } from "../entities/TradeAllocation";
import type { TimelineEvent } from "../entities/TimelineEvent";
import type { JournalEntry } from "../entities/JournalEntry";
import type { PositionVerification } from "../entities/PositionVerification";
import type { Upload } from "../entities/Upload";
import type { RawTransaction } from "../entities/RawTransaction";
import type { LedgerEvent } from "../entities/LedgerEvent";
import type { Allocation } from "../entities/Allocation";
import type { PendingExecution } from "../entities/PendingExecution";
import type {
  DiagnosticEvent,
  DiagnosticEventBase,
  SessionEventRecord,
  WriteTraceRecord,
  ReadTraceRecord,
  DecisionTraceRecord,
  RuleExecutionRecord,
  PerfSampleRecord,
} from "../entities/diagnostics/DiagnosticEvent";
import type { DiagnosticCase } from "../entities/diagnostics/DiagnosticCase";

/** What a DiagnosticsRecorder caller supplies for one event kind — everything except the fields the repository itself assigns (DiagnosticEventBase's id/seq/recordedAt/sessionId) and the discriminant, which the recorder method name already implies. Exported so DiagnosticsRecorder implementations (Noop/Recording, @infrastructure/diagnostics) can type their methods against the exact same shape. */
export type RecorderInput<T extends DiagnosticEvent> = Omit<T, keyof DiagnosticEventBase | "kind"> &
  Partial<Pick<DiagnosticEventBase, "portfolioId" | "ticker" | "workflowStep" | "correlationId">>;

export interface PortfolioRepository {
  getAll(): Promise<Portfolio[]>;
  getById(id: string): Promise<Portfolio | undefined>;
  save(portfolio: Portfolio): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TradeRepository {
  getAll(): Promise<Trade[]>;
  /** Targeted import-page lookup; optional for backwards-compatible adapters. */
  getByTicker?(ticker: string): Promise<Trade[]>;
  getByPortfolio(portfolioId: string): Promise<Trade[]>;
  getById(id: string): Promise<Trade | undefined>;
  save(trade: Trade): Promise<void>;
  saveRemainingShares(tradeId: string, remainingShares: number): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TradeAllocationRepository {
  getAll(): Promise<TradeAllocation[]>;
  /** Targeted import-page lookup; optional for backwards-compatible adapters. */
  getByTicker?(ticker: string): Promise<TradeAllocation[]>;
  getByPortfolio(portfolioId: string): Promise<TradeAllocation[]>;
  getByTrade(tradeId: string): Promise<TradeAllocation[]>;
  save(allocation: TradeAllocation): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface TimelineRepository {
  getAll(): Promise<TimelineEvent[]>;
  getByPortfolio(portfolioId: string): Promise<TimelineEvent[]>;
  save(event: TimelineEvent): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface JournalRepository {
  getAll(): Promise<JournalEntry[]>;
  getByTrade(tradeId: string): Promise<JournalEntry | undefined>;
  getByPortfolio(portfolioId: string): Promise<JournalEntry[]>;
  save(entry: JournalEntry): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface VerificationRepository {
  getAll(): Promise<PositionVerification[]>;
  /** Targeted import-page lookup; optional for backwards-compatible adapters. */
  getByTicker?(ticker: string): Promise<PositionVerification[]>;
  getByPortfolio(portfolioId: string): Promise<PositionVerification[]>;
  getLatest(portfolioId: string, ticker: string): Promise<PositionVerification | undefined>;
  save(verification: PositionVerification): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface UploadRepository {
  getAll(): Promise<Upload[]>;
  getByPortfolio(portfolioId: string): Promise<Upload[]>;
  /** File-hash dedup is global — the same screenshot re-uploaded is a duplicate regardless of which portfolio its candidates end up assigned to. */
  getByHash(fileHash: string): Promise<Upload | undefined>;
  save(upload: Upload): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Storage for partial-fill executions awaiting broker-invoice confirmation
 * (see PendingExecution's own doc comment). `save` both creates (first
 * write) and updates in place (every later write reuses the same `id`) —
 * confirming an invoice never creates a second row for the same execution.
 */
export interface PendingExecutionRepository {
  getAll(): Promise<PendingExecution[]>;
  getByPortfolio(portfolioId: string): Promise<PendingExecution[]>;
  getById(id: string): Promise<PendingExecution | undefined>;
  save(pendingExecution: PendingExecution): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Storage for the append-only fact log (see RawTransaction's own doc
 * comment). Deliberately exposes no update/delete — immutability is
 * enforced structurally by this interface's shape, not by convention.
 */
export interface RawTransactionRepository {
  getAll(): Promise<RawTransaction[]>;
  getByPortfolio(portfolioId: string): Promise<RawTransaction[]>;
  getByTicker(ticker: string): Promise<RawTransaction[]>;
  getById(id: string): Promise<RawTransaction | undefined>;
  /** Assigns `seq` atomically and persists the row. The only way a RawTransaction ever reaches storage. */
  append(transaction: Omit<RawTransaction, "seq">): Promise<RawTransaction>;
  /**
   * Optional bulk append used by import pipelines. Implementations that do
   * not provide it remain fully compatible: callers fall back to append().
   * A batch is one logical write and must assign monotonically increasing seq
   * values in input order.
   */
  appendMany?(transactions: Omit<RawTransaction, "seq">[]): Promise<RawTransaction[]>;
}

/**
 * Storage for the Commit Engine's materialized read-models — the Ledger
 * (LedgerEvent[]) and Allocations (Allocation[]) generated for one
 * (portfolioId, ticker) at a time. Both tables always change together: this
 * one interface owns both so `commitTicker` can replace an entire ticker's
 * cached output atomically, and exposes no other write path — no per-row
 * save/update/delete, no way to add or patch a single event or allocation.
 * Every value here is 100% reconstructible from RawTransaction at any time;
 * this is a performance materialization, never a second source of truth.
 */
export interface CommittedLedgerRepository {
  getLedgerEvents(portfolioId: string, ticker: string): Promise<LedgerEvent[]>;
  getAllocations(portfolioId: string, ticker: string): Promise<Allocation[]>;
  /** Atomically replaces every cached event and allocation for (portfolioId, ticker) — full delete-and-replace, never a merge or patch. */
  commitTicker(params: { portfolioId: string; ticker: string; events: LedgerEvent[]; allocations: Allocation[] }): Promise<void>;
}

/** Freshness metadata for the price snapshot, so the UI can say which close the "current" prices actually represent. */
export interface PriceSnapshotInfo {
  /** When the fetch pipeline wrote the snapshot. */
  asOf: string;
  /** The latest per-ticker market quote time in the snapshot — after the EGX session this is the official close time. Absent for snapshots written before quote times were captured. */
  latestQuoteAt?: string;
}

/** Read-only access to the single source of truth for current market prices. `getSnapshotInfo` resolves to null (not undefined) when no usable snapshot exists, so callers can distinguish "definitively unavailable" from "still loading". */
export interface PriceRepository {
  getPrice(ticker: string): Promise<number | undefined>;
  getAllPrices(): Promise<Record<string, number>>;
  getSnapshotInfo(): Promise<PriceSnapshotInfo | null>;
  /** Day-by-day closing prices for one ticker, keyed by "YYYY-MM-DD". Empty object if no history is available yet. Backed by a separate accumulating snapshot (public/price-history.json) — a ticker only gains entries once fetch-prices has run on that trading day. */
  getPriceHistory(ticker: string): Promise<Record<string, number>>;
}

/**
 * Storage for the Diagnostics Center's append-only observation log (see
 * DiagnosticEvent.ts's own doc comment). Deliberately exposes no
 * update/delete beyond retention pruning — immutability is enforced
 * structurally by this interface's shape, matching RawTransactionRepository.
 * Never read by, or exposed to, any business-logic code path (see
 * docs/DIAGNOSTICS_CENTER_SPEC.md Part 5.4).
 */
export interface DiagnosticEventRepository {
  /** Assigns `seq` atomically and persists the row. The only way a DiagnosticEvent ever reaches storage. */
  append(event: Omit<DiagnosticEvent, "seq">): Promise<DiagnosticEvent>;
  getBySession(sessionId: string): Promise<DiagnosticEvent[]>;
  getRecent(limit: number): Promise<DiagnosticEvent[]>;
  /** Part 9 retention pruning — deletes events older than `cutoff` (ISO timestamp), oldest first. Never called from business logic. */
  pruneOlderThan(cutoff: string): Promise<number>;
}

/**
 * Storage for the Diagnostics Center's derived case index (see
 * DiagnosticCase.ts's own doc comment). `replaceForGroupKeys` is the only
 * write path — a full delete-and-regenerate for the given `groupKey`s, never
 * a per-field update, matching CommittedLedgerRepository.commitTicker's
 * discipline.
 */
export interface DiagnosticCaseRepository {
  getAll(): Promise<DiagnosticCase[]>;
  search(filter: {
    ticker?: string;
    portfolioId?: string;
    severity?: DiagnosticCase["severity"];
    workflowStep?: DiagnosticCase["workflowStep"];
  }): Promise<DiagnosticCase[]>;
  /** Deletes every existing case whose groupKey appears in `cases`, then inserts the given cases — full replace, never a merge or patch. */
  replaceForGroupKeys(cases: DiagnosticCase[]): Promise<void>;
  /** Part 9 retention pruning — caps the table at the most-recently-active N cases. */
  pruneToMostRecent(limit: number): Promise<number>;
}

/**
 * Port for recording diagnostics. `NoopDiagnosticsRecorder` (default,
 * Developer Mode off) makes every method a no-op — zero IndexedDB writes,
 * zero cost. `RecordingDiagnosticsRecorder` (Developer Mode on) writes to
 * DiagnosticEventRepository, fire-and-forget, never `await`ed by the caller
 * and never throwing into it — a diagnostics failure must never affect a
 * business write or read. See docs/DIAGNOSTICS_CENTER_SPEC.md Part 3.3/5.
 */
export interface DiagnosticsRecorder {
  recordSessionEvent(event: RecorderInput<SessionEventRecord>): void;
  recordWrite(event: RecorderInput<WriteTraceRecord>): void;
  recordRead(event: RecorderInput<ReadTraceRecord>): void;
  recordDecision(event: RecorderInput<DecisionTraceRecord>): void;
  recordRuleExecution(event: RecorderInput<RuleExecutionRecord>): void;
  recordPerfSample(event: RecorderInput<PerfSampleRecord>): void;
}
