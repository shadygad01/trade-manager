import { beforeEach, describe, expect, it } from "vitest";
import { PortfolioOsDatabase } from "../db";
import { DexieVerificationRepository } from "./DexieVerificationRepository";
import type { PositionVerification } from "@domain/entities/PositionVerification";

describe("DexieVerificationRepository", () => {
  let db: PortfolioOsDatabase;
  let repo: DexieVerificationRepository;

  beforeEach(async () => {
    db = new PortfolioOsDatabase(`test-db-${crypto.randomUUID()}`);
    repo = new DexieVerificationRepository(db);
  });

  function verification(overrides: Partial<PositionVerification>): PositionVerification {
    return {
      id: "v-1",
      portfolioId: "portfolio-1",
      ticker: "COMI",
      units: 100,
      capturedAt: "2026-01-01T00:00:00.000Z",
      source: "screenshot",
      ...overrides,
    };
  }

  it("returns the verification with the most recent capturedAt for a ticker", async () => {
    await repo.save(verification({ id: "v-1", capturedAt: "2026-01-01T00:00:00.000Z" }));
    await repo.save(verification({ id: "v-2", capturedAt: "2026-03-01T00:00:00.000Z" }));
    await repo.save(verification({ id: "v-3", capturedAt: "2026-02-01T00:00:00.000Z" }));

    const latest = await repo.getLatest("portfolio-1", "COMI");
    expect(latest?.id).toBe("v-2");
  });

  it("ignores verifications for other portfolios or tickers", async () => {
    await repo.save(verification({ id: "v-1", capturedAt: "2026-01-01T00:00:00.000Z" }));
    await repo.save(
      verification({
        id: "v-2",
        ticker: "HRHO",
        capturedAt: "2026-05-01T00:00:00.000Z",
      })
    );
    await repo.save(
      verification({
        id: "v-3",
        portfolioId: "portfolio-2",
        capturedAt: "2026-06-01T00:00:00.000Z",
      })
    );

    const latest = await repo.getLatest("portfolio-1", "COMI");
    expect(latest?.id).toBe("v-1");
  });

  it("returns undefined when there is no matching verification", async () => {
    expect(await repo.getLatest("portfolio-1", "COMI")).toBeUndefined();
  });
});
