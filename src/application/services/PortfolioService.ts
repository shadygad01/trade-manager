import { createPortfolio, type Portfolio, type PortfolioKind } from "@domain/entities/Portfolio";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
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

export async function createPortfolioAndSave(repos: AppRepositories, input: CreatePortfolioInput): Promise<Portfolio> {
  const portfolio = createPortfolio({ id: generateId(), ...input });
  await repos.portfolios.save(portfolio);
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
