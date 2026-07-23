import { describe, it, expect } from "vitest";
import { buildExistingDividendKeys, isDividendAlreadyRecorded, suggestDuplicateDividendIdsToDelete } from "./dividendDuplicateDetection";
import { createTimelineEvent } from "@domain/entities/TimelineEvent";

describe("buildExistingDividendKeys / isDividendAlreadyRecorded", () => {
  it("flags a dividend matching an already-recorded Dividend event by ticker/date/amount", () => {
    const events = [
      createTimelineEvent({
        id: "e1",
        portfolioId: "p1",
        type: "Dividend",
        timestamp: "2026-04-15T00:00",
        ticker: "comi.ca",
        amount: 114,
      }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 114 }, keys)).toBe(true);
  });

  it("ignores non-Dividend events and events with no ticker/amount", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: -114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI" }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 114 }, keys)).toBe(false);
  });

  it("does not flag a dividend with a different amount, date, or ticker", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
    ];
    const keys = buildExistingDividendKeys(events);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-04-15", amount: 50 }, keys)).toBe(false);
    expect(isDividendAlreadyRecorded({ ticker: "COMI", date: "2026-05-15", amount: 114 }, keys)).toBe(false);
    expect(isDividendAlreadyRecorded({ ticker: "HRHO", date: "2026-04-15", amount: 114 }, keys)).toBe(false);
  });
});

describe("suggestDuplicateDividendIdsToDelete", () => {
  it("suggests every event but the first in a same-ticker/date/amount group", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual(["e2", "e3"]);
  });

  it("does not flag dividends that differ in ticker, date, or amount", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Dividend", timestamp: "2026-05-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "HRHO", amount: 114 }),
      createTimelineEvent({ id: "e4", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 50 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual([]);
  });

  it("ignores non-Dividend events and dividends with no ticker", () => {
    const events = [
      createTimelineEvent({ id: "e1", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e2", portfolioId: "p1", type: "Buy", timestamp: "2026-04-15T00:00", ticker: "COMI", amount: 114 }),
      createTimelineEvent({ id: "e3", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
      createTimelineEvent({ id: "e4", portfolioId: "p1", type: "Dividend", timestamp: "2026-04-15T00:00", amount: 114 }),
    ];
    expect(suggestDuplicateDividendIdsToDelete(events)).toEqual([]);
  });
});
