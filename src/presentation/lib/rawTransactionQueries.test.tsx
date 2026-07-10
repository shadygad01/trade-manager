// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { DexieRawTransactionRepository } from "@infrastructure/db/repositories/DexieRawTransactionRepository";
import { createRawTransaction, type BuyExecutionPayload, type RetractionPayload } from "@domain/entities/RawTransaction";

/**
 * Phase 9.7, task 3/5: proves useLiveRawTransactions/useLiveRawTransactionsForTicker
 * are genuinely reactive against a REAL Dexie table (fake-indexeddb, via the
 * global test-setup.ts), not just a plain promise a component happens to call
 * once. dexie-react-hooks' useLiveQuery only re-runs on writes to the actual
 * Dexie table it observed during its tracked read — a plain object mock (the
 * pattern ImportPage's own tests use) would never trigger that, so this test
 * deliberately does NOT mock @presentation/lib/data the way ImportPage's
 * tests do; it swaps in a real DexieRawTransactionRepository instead.
 */
const db = new PortfolioOsDatabase(`test-raw-transaction-queries-${crypto.randomUUID()}`);
const realRepo = new DexieRawTransactionRepository(db);

vi.mock("./data", () => ({
  repos: { rawTransactions: realRepo },
}));

const { useLiveRawTransactions, useLiveRawTransactionsForTicker } = await import("./rawTransactionQueries");

function buyPayload(overrides: Partial<BuyExecutionPayload> = {}): BuyExecutionPayload {
  return { ticker: "COMI", shares: 100, price: 45.5, executionDate: "2026-02-01", ...overrides };
}

function AllProbe() {
  const txns = useLiveRawTransactions();
  return <div data-testid="all-count">{txns === undefined ? "loading" : txns.length}</div>;
}

function TickerProbe({ ticker }: { ticker: string }) {
  const txns = useLiveRawTransactionsForTicker(ticker);
  return <div data-testid="ticker-count">{txns === undefined ? "loading" : txns.length}</div>;
}

describe("useLiveRawTransactions / useLiveRawTransactionsForTicker (Phase 9.7, task 3 — available, not yet consumed by ImportPage)", () => {
  it("resolves to the real table's current contents, then updates reactively the moment a new row is appended — no manual refetch", async () => {
    render(<AllProbe />);
    await waitFor(() => expect(screen.getByTestId("all-count").textContent).not.toBe("loading"));
    const before = Number(screen.getByTestId("all-count").textContent);

    await realRepo.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "COMI", payload: buyPayload() }));

    await waitFor(() => expect(Number(screen.getByTestId("all-count").textContent)).toBe(before + 1));
  });

  it("also reacts to a Retraction append — the hook is a raw, unfolded mirror of the table; filtering out retracted rows is the consumer's job (see verificationEngine.ts), not this hook's", async () => {
    const target = await realRepo.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "HRHO", payload: buyPayload({ ticker: "HRHO" }) }));

    render(<AllProbe />);
    await waitFor(() => expect(screen.getByTestId("all-count").textContent).not.toBe("loading"));
    const before = Number(screen.getByTestId("all-count").textContent);

    const retractionPayload: RetractionPayload = { targetId: target.id };
    await realRepo.append(createRawTransaction({ kind: "Retraction", source: "manual", payload: retractionPayload }));

    await waitFor(() => expect(Number(screen.getByTestId("all-count").textContent)).toBe(before + 1));
  });

  it("useLiveRawTransactionsForTicker only counts rows for that ticker, and updates reactively when a new one for it is appended", async () => {
    await realRepo.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "ORWE", payload: buyPayload({ ticker: "ORWE" }) }));

    render(<TickerProbe ticker="ORWE" />);
    await waitFor(() => expect(screen.getByTestId("ticker-count").textContent).not.toBe("loading"));
    const before = Number(screen.getByTestId("ticker-count").textContent);

    // A write for a DIFFERENT ticker must not move this count.
    await realRepo.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "PHAR", payload: buyPayload({ ticker: "PHAR" }) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(Number(screen.getByTestId("ticker-count").textContent)).toBe(before);

    await realRepo.append(createRawTransaction({ kind: "BuyExecution", source: "manual", ticker: "ORWE", payload: buyPayload({ ticker: "ORWE" }) }));
    await waitFor(() => expect(Number(screen.getByTestId("ticker-count").textContent)).toBe(before + 1));
  });
});
