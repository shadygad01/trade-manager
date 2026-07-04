import { createPortfolio, type Portfolio, type PortfolioKind } from "@domain/entities/Portfolio";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";
import { Money } from "@domain/value-objects/Money";
import { generateId } from "@domain/value-objects/id";
import { normalizeTicker } from "@domain/value-objects/Ticker";
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
  if (withdrawAmount.greaterThan(currentCash)) {
    throw new Error(`Insufficient cash in portfolio ${portfolioId}: have ${currentCash.toFixed()}, want ${withdrawAmount.toFixed()}`);
  }
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
}

export async function recordDividend(
  repos: AppRepositories,
  portfolioId: string,
  input: RecordDividendInput
): Promise<Portfolio> {
  if (input.amount <= 0) {
    throw new Error("dividend amount must be positive");
  }
  const portfolio = await requirePortfolio(repos, portfolioId);
  const updated = { ...portfolio, cash: Money.from(portfolio.cash).add(Money.from(input.amount)).toNumber() };
  await repos.portfolios.save(updated);
  await repos.timeline.save(
    createTimelineEvent({
      id: generateId(),
      portfolioId,
      type: "Dividend",
      timestamp: new Date().toISOString(),
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
