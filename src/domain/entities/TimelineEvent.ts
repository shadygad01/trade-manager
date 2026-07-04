export type TimelineEventType =
  | "Buy"
  | "Sell"
  | "PartialSell"
  | "Deposit"
  | "Withdrawal"
  | "Dividend"
  | "Split"
  | "RightsIssue"
  | "CashAdjustment"
  | "Note";

export interface TimelineEvent {
  id: string;
  portfolioId: string;
  type: TimelineEventType;
  timestamp: string;
  ticker?: string;
  /** Foreign reference to the Trade or TradeAllocation(s) this event narrates, if any. */
  relatedTradeIds?: string[];
  relatedAllocationIds?: string[];
  amount?: number;
  shares?: number;
  notes?: string;
  attachments: string[];
  createdAt: string;
}

export function createTimelineEvent(input: {
  id: string;
  portfolioId: string;
  type: TimelineEventType;
  timestamp: string;
  ticker?: string;
  relatedTradeIds?: string[];
  relatedAllocationIds?: string[];
  amount?: number;
  shares?: number;
  notes?: string;
}): TimelineEvent {
  return {
    id: input.id,
    portfolioId: input.portfolioId,
    type: input.type,
    timestamp: input.timestamp,
    ticker: input.ticker,
    relatedTradeIds: input.relatedTradeIds,
    relatedAllocationIds: input.relatedAllocationIds,
    amount: input.amount,
    shares: input.shares,
    notes: input.notes,
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}
