import { createPortfolio, type Portfolio, type PortfolioKind } from "@domain/entities/Portfolio";
import { createTimelineEvent, type TimelineEvent } from "@domain/entities/TimelineEvent";
import type { Trade } from "@domain/entities/Trade";
import type { TradeAllocation } from "@domain/entities/TradeAllocation";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import { TRACKING_START_DATE, isBeforeTrackingStart } from "@domain/value-objects/trackingWindow";
import type { AppRepositories } from "./types";

export interface CreatePortfolioInput {
  name: string;
  kind: PortfolioKind;
  customKindLabel?: string;
  initialCash?: number;
  notes?: string;
}

/**
 * `initialCash` also gets a dated Deposit event, not just the raw
 * `Portfolio.cash` field — every return-% calculator (performanceCurve,
 * bucketPerformance, portfolioReturn) measures gains against net contributed
 * capital drawn *only* from Deposit/Withdrawal timeline events, so a
 * portfolio funded solely via this field (with no matching event) reads as
 * having contributed zero capital: every realized/dividend % permanently
 * computes as 0%, no matter how much was actually gained (see
 * findPortfoliosMissingFundingRecord for the backfill path on portfolios
 * that already exist without this event).
 */
export async function createPortfolioAndSave(repos: AppRepositories, input: CreatePortfolioInput): Promise<Portfolio> {
  const portfolio = createPortfolio({ id: generateId(), ...input });
  await repos.portfolios.save(portfolio);
  if (input.initialCash && input.initialCash > 0) {
    await repos.timeline.save(
      createTimelineEvent({
        id: generateId(),
        portfolioId: portfolio.id,
        type: "Deposit",
        timestamp: portfolio.createdAt,
        amount: input.initialCash,
        notes: "Initial funding recorded at portfolio creation.",
      })
    );
  }
  return portfolio;
}

async function requirePortfolio(repos: AppRepositories, portfolioId: string): Promise<Portfolio> {
  const portfolio = await repos.portfolios.getById(portfolioId);
  if (!portfolio) {
    throw new Error(`Portfolio not found: ${portfolioId}`);
  }
  return portfolio;
}

/**
 * Archiving hides a portfolio from the main list without touching any of
 * its data — trades, cash, and history all stay exactly as they are and
 * remain fully reachable by unarchiving. Never a delete.
 */
export async function archivePortfolio(repos: AppRepositories, portfolioId: string): Promise<Portfolio> {
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, archivedAt: new Date().toISOString() };
  await repos.portfolios.save(updated);
  return updated;
}

export async function unarchivePortfolio(repos: AppRepositories, portfolioId: string): Promise<Portfolio> {
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated: Portfolio = { ...portfolio };
  delete updated.archivedAt;
  await repos.portfolios.save(updated);
  return updated;
}

/** Renaming is just a label change — trades, cash, and history are untouched, and it works the same whether or not the portfolio already has recorded transactions. */
export async function renamePortfolio(repos: AppRepositories, portfolioId: string, name: string): Promise<Portfolio> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("portfolio name must not be empty");
  }
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, name: trimmed };
  await repos.portfolios.save(updated);
  return updated;
}

/**
 * Cash is a supplementary figure, not a gate: it can go negative rather than
 * blocking a withdrawal, deposit, buy, or portfolio move. It exists to show
 * the balance an investor intends to work with, not to verify that a trade
 * actually happened — the broker screenshot/invoice is the source of truth
 * for that.
 */
export async function deposit(
  repos: AppRepositories,
  portfolioId: string,
  amount: number,
  notes?: string
): Promise<Portfolio> {
  if (amount <= 0) {
    throw new Error("deposit amount must be positive");
  }
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, cash: Money.from(portfolio.cash).add(Money.from(amount)).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Deposit",
      timestamp: new Date().toISOString(),
      amount,
      notes,
    })
  );
  return updated;
}

export async function withdraw(
  repos: AppRepositories,
  portfolioId: string,
  amount: number,
  notes?: string
): Promise<Portfolio> {
  if (amount <= 0) {
    throw new Error("withdraw amount must be positive");
  }
  const portfolio = await requirePortfolio(repos, portfolioId);
  const currentCash = Money.from(portfolio.cash);
  const withdrawAmount = Money.from(amount);
  const updated = { ...portfolio, cash: currentCash.subtract(withdrawAmount).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Withdrawal",
      timestamp: new Date().toISOString(),
      amount: -amount,
      notes,
    })
  );
  return updated;
}

export interface RecordDividendInput {
  ticker?: string;
  amount: number;
  notes?: string;
  /** ISO date the dividend was actually paid, e.g. from a broker's dividend history. Defaults to now for manually-entered dividends. */
  date?: string;
}

export async function recordDividend(
  repos: AppRepositories,
  portfolioId: string,
  input: RecordDividendInput
): Promise<Portfolio> {
  if (input.amount <= 0) {
    throw new Error("dividend amount must be positive");
  }
  if (input.date && isBeforeTrackingStart(input.date)) {
    throw new Error(`Transactions before ${TRACKING_START_DATE} are not tracked: got ${input.date}`);
  }
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, cash: Money.from(portfolio.cash).add(Money.from(input.amount)).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Dividend",
      timestamp: input.date ? `${input.date}T00:00` : new Date().toISOString(),
      ticker: input.ticker ? normalizeTicker(input.ticker) : undefined,
      amount: input.amount,
      notes: input.notes,
    })
  );
  return updated;
}

/**
 * Undoes a recorded dividend — for a duplicate (the same real payment
 * recorded twice, e.g. from overlapping statements imported before the
 * cross-session dedup existed) or a plain mistake. Refunds its amount back
 * out of cash the same way deleteTrade refunds a buy's cost, and removes
 * the timeline event entirely rather than leaving a zeroed-out placeholder.
 */
export async function deleteDividend(repos: AppRepositories, event: TimelineEvent): Promise<void> {
  if (event.type !== "Dividend") {
    throw new Error(`deleteDividend called with a non-Dividend event: ${event.type}`);
  }
  const portfolio = await requirePortfolio(repos, event.portfolioId);
  const updated = { ...portfolio, cash: Money.from(portfolio.cash).subtract(Money.from(event.amount ?? 0)).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.delete(event.id);
}

export async function recordCashAdjustment(
  repos: AppRepositories,
  portfolioId: string,
  amount: number,
  notes: string
): Promise<Portfolio> {
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, cash: Money.from(portfolio.cash).add(Money.from(amount)).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "CashAdjustment",
      timestamp: new Date().toISOString(),
      amount,
      notes,
    })
  );
  return updated;
}

/**
 * Split/rights-issue share and price rebasing across open Trades is out of
 * scope for now — these only leave a record on the timeline (ratio/details
 * captured in `notes`) so the event isn't lost, without pretending to
 * automatically adjust historical trades.
 */
export async function recordSplit(
  repos: AppRepositories,
  portfolioId: string,
  input: { ticker: string; notes: string }
): Promise<void> {
  await requirePortfolio(repos, portfolioId);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Split",
      timestamp: new Date().toISOString(),
      ticker: normalizeTicker(input.ticker),
      notes: input.notes,
    })
  );
}

export async function recordRightsIssue(
  repos: AppRepositories,
  portfolioId: string,
  input: { ticker: string; notes: string }
): Promise<void> {
  await requirePortfolio(repos, portfolioId);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "RightsIssue",
      timestamp: new Date().toISOString(),
      ticker: normalizeTicker(input.ticker),
      notes: input.notes,
    })
  );
}

export interface MissingFundingEntry {
  portfolioId: string;
  portfolioName: string;
  /**
   * The exact amount of cash this portfolio currently holds that no
   * Deposit/Withdrawal/CashAdjustment/Dividend/trade event can account for —
   * i.e. `Portfolio.cash` minus what the rest of the ledger implies it
   * should be. This is the true missing initial-funding amount, not a guess.
   */
  missingAmount: number;
}

/**
 * Flags a portfolio whose current cash balance doesn't reconcile against
 * everything its ledger actually explains — every Deposit/Withdrawal/
 * CashAdjustment/Dividend event, plus every trade's buy cost and every
 * allocation's sell proceeds (recordBuy/recordSell's own cash math,
 * mirrored here). Any leftover difference is cash that came from nowhere the
 * ledger can name — in practice, `Portfolio.cash` set directly at creation
 * before `createPortfolioAndSave` recorded a matching dated Deposit event.
 *
 * This intentionally checks the balance itself rather than "is any Deposit
 * recorded at all": a portfolio that has since logged a small, unrelated
 * top-up deposit still reconciles to a large missing amount here, whereas an
 * "any deposit ⇒ skip" check would have missed it entirely. Every
 * realized/dividend % calculator divides by whatever *is* recorded as
 * contributed capital, so this exact shortfall is exactly what's silently
 * missing from every return-% chart until it's backfilled.
 *
 * Only portfolios with at least one trade or dividend are considered — a
 * portfolio that's never traded has nothing for a return-% calculator to get
 * wrong yet, so there's no point nagging about a funding gap that isn't
 * visibly affecting anything.
 */
export function findPortfoliosMissingFundingRecord(
  portfolios: Portfolio[],
  trades: Trade[],
  allocations: TradeAllocation[],
  timelineEvents: TimelineEvent[]
): MissingFundingEntry[] {
  const entries: MissingFundingEntry[] = [];

  for (const portfolio of portfolios) {
    const ownTrades = trades.filter((t) => t.portfolioId === portfolio.id);
    const ownEvents = timelineEvents.filter((e) => e.portfolioId === portfolio.id);
    const hasDividend = ownEvents.some((e) => e.type === "Dividend");
    if (ownTrades.length === 0 && !hasDividend) continue;

    const cashEvents = ownEvents
      .filter((e) => e.type === "Deposit" || e.type === "Withdrawal" || e.type === "CashAdjustment" || e.type === "Dividend")
      .reduce((sum, e) => sum + (e.amount ?? 0), 0);

    const buyCost = ownTrades.reduce((sum, t) => sum + t.shares * t.entryPrice + t.fees + t.taxes, 0);
    const sellProceeds = allocations
      .filter((a) => a.portfolioId === portfolio.id)
      .reduce((sum, a) => sum + a.sharesClosed * a.exitPrice - a.fees - a.taxes, 0);

    const expectedCash = cashEvents - buyCost + sellProceeds;
    const missingAmount = Math.round((portfolio.cash - expectedCash) * 100) / 100;

    if (missingAmount > 0.01) {
      entries.push({ portfolioId: portfolio.id, portfolioName: portfolio.name, missingAmount });
    }
  }

  return entries;
}

/**
 * Backfills the missing dated Deposit event for capital that funded a
 * portfolio before anyone recorded it as a dated event (typically initial
 * cash set at creation, pre-dating this fix). Deliberately does NOT touch
 * `Portfolio.cash` — that balance already reflects this funding; this only
 * gives the return-% calculators the capital basis they need.
 */
export async function backfillInitialFunding(
  repos: AppRepositories,
  portfolioId: string,
  amount: number,
  date: string
): Promise<void> {
  if (amount <= 0) {
    throw new Error("backfill amount must be positive");
  }
  if (isBeforeTrackingStart(date)) {
    throw new Error(`Transactions before ${TRACKING_START_DATE} are not tracked: got ${date}`);
  }
  await requirePortfolio(repos, portfolioId);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Deposit",
      timestamp: `${date}T00:00`,
      amount,
      notes: "Backfilled: initial funding recorded retroactively so return % has a real capital basis.",
    })
  );
}
