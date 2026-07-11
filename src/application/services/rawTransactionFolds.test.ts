import { describe, it, expect } from "vitest";
import { createRawTransaction, type RawTransaction, type SellExecutionPayload } from "@domain/entities/RawTransaction";
import { resolveCurrentTicker, findUnclaimedSellExecutionFact } from "./rawTransactionFolds";

function sellFact(overrides: Partial<SellExecutionPayload> & { id?: string; source?: RawTransaction["source"] } = {}): RawTransaction {
  const { id, source, ...payloadOverrides } = overrides;
  const payload: SellExecutionPayload = { ticker: "COMI", shares: 100, price: 60, executionDate: "2026-02-01", executionTime: "11:00", ...payloadOverrides };
  return { ...createRawTransaction({ id, kind: "SellExecution", source: source ?? "official-broker-excel", ticker: payload.ticker, payload }), seq: 1 };
}

describe("findUnclaimedSellExecutionFact", () => {
  it("finds an unclaimed fact under its current, corrected ticker even though it was written under the old name", () => {
    const fact = sellFact({ id: "s1", ticker: "CLHOA" });
    const correction = {
      ...createRawTransaction({ kind: "Correction", source: "manual", payload: { targetId: "s1", patch: { ticker: "CLHO" } } }),
      seq: 2,
    };
    const all = [fact, correction];

    const found = findUnclaimedSellExecutionFact(all, { ticker: "CLHO", executionDate: "2026-02-01", shares: 100, price: 60 });
    expect(found?.id).toBe("s1");

    // The OLD ticker name no longer matches this fact at all.
    expect(findUnclaimedSellExecutionFact(all, { ticker: "CLHOA", executionDate: "2026-02-01", shares: 100, price: 60 })).toBeUndefined();
  });

  it("does not match a fact whose resolved ticker differs from the requested one", () => {
    const fact = sellFact({ id: "s1", ticker: "COMI" });
    const found = findUnclaimedSellExecutionFact([fact], { ticker: "HRHO", executionDate: "2026-02-01", shares: 100, price: 60 });
    expect(found).toBeUndefined();
  });
});

describe("resolveCurrentTicker", () => {
  it("returns the fact's own ticker when no correction targets it", () => {
    const fact = sellFact({ id: "s1", ticker: "COMI" });
    expect(resolveCurrentTicker([fact], fact)).toBe("COMI");
  });
});
