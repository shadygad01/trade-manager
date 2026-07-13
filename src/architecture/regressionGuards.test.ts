import { describe, it, expect } from "vitest";
import { PortfolioOsDatabase } from "@infrastructure/db/db";
import { allSourceFiles, filesMatching } from "./sourceScan";

/**
 * CI regression-prevention checks (docs/PORTFOLIO_OS_V2_SPEC.md Part 19's
 * migration foundation): permanent, automated versions of the manual
 * "repo-wide architectural audit" this codebase's own history proves is the
 * only thing that actually closes a bug CLASS rather than one instance of
 * it (see docs/ROADMAP.md's "Repo-wide architectural audit" entry). Each
 * check below freezes the CURRENT, already-known set of violations as an
 * explicit allowlist and fails the moment a NEW one appears anywhere else —
 * it does not attempt to fix or reduce the existing ones (that's PR2-PR6's
 * job, explicitly out of scope this sprint: "Do not implement Guardian. Do
 * not implement Policy Engine. Do not remove legacy code.").
 *
 * When a check here fails because of a genuinely new, reviewed, INTENTIONAL
 * addition (not a regression): update the allowlist in the SAME commit as
 * the change that triggered it, and add a one-line reason next to the new
 * entry — never widen an allowlist silently. Update
 * docs/ARCHITECTURAL_DEBT.md in the same commit too (see that file's own
 * "keep this in sync" note).
 */

const files = allSourceFiles();

describe("CI guard: no new direct writers of Trade/TradeAllocation (dual-writer prevention)", () => {
  it("only the already-known set of application-layer files calls .trades/.allocations/.tradeAllocations .save()/.delete()/.saveRemainingShares() directly", () => {
    const KNOWN_DIRECT_WRITERS = [
      "application/services/TradeService.ts", // the primary use-case layer — the intended, documented writer
      "application/services/ledgerProjection.ts", // the replay-projection writer — the SECOND, known, disclosed dual-writer (docs/PORTFOLIO_OS_V2_SPEC.md Part 0.2/Part 5) — closing this is PR4/PR6's job, not this sprint's
      "application/services/ledgerRebuild.ts", // applyLedgerRebuild's auto-applicable metadata corrections (companyName/transactionNumber only — never share counts/allocations)
      "application/services/lotManager.ts", // stale-legacy-allocation cleanup during an explicit Lot Manager retraction
      "application/services/BackupService.ts", // full-ledger import/export — a bulk restore from a user-provided backup file, not a normal business write path
    ].sort();

    const actual = filesMatching(
      files.filter((f) => f.path.startsWith("application/")),
      /\.(trades|allocations|tradeAllocations)\.(save|delete|saveRemainingShares)\(/
    );

    expect(actual).toEqual(KNOWN_DIRECT_WRITERS);
  });
});

describe("CI guard: no new replay/holdings-computation implementations", () => {
  it("computePositions/computeHoldings/computeCanonicalPositions stay the only three position-computation functions", () => {
    const KNOWN_POSITION_COMPUTATIONS: Record<string, string> = {
      "application/services/TradeService.ts": "computePositions", // legacy — reads Trade directly
      "application/services/holdingsEngine.ts": "computeHoldings", // canonical replay — reads LedgerEvent/Allocation
      "application/services/canonicalHoldings.ts": "computeCanonicalPositions", // hybrid: computes both above, reconciles
    };

    for (const [path, fnName] of Object.entries(KNOWN_POSITION_COMPUTATIONS)) {
      const file = files.find((f) => f.path === path);
      expect(file, `expected ${path} to exist`).toBeDefined();
      expect(file!.content, `expected ${path} to still define ${fnName}`).toMatch(new RegExp(`export (async )?function ${fnName}\\(`));
    }

    const anyPositionFn = filesMatching(files, /export (async )?function compute\w*(Position|Holding)s?\(/);
    expect(anyPositionFn.sort()).toEqual(Object.keys(KNOWN_POSITION_COMPUTATIONS).sort());
  });

  it("generateLedgerEvents/generateAllocations stay defined in exactly one file each — the Ledger/Allocation Engines", () => {
    const ledgerEngineDefiners = filesMatching(files, /export function generateLedgerEvents\(/);
    expect(ledgerEngineDefiners).toEqual(["application/services/ledgerEngine.ts"]);

    const allocationEngineDefiners = filesMatching(files, /export function generateAllocations\(/);
    expect(allocationEngineDefiners).toEqual(["application/services/allocationEngine.ts"]);
  });

  it("ledgerRebuild.ts's Upload-based reconstruction stays the only OTHER replay-shaped pipeline — a second one appearing elsewhere is exactly the 'two ledgers' class of bug this file's own dry-run/apply split already fought (see docs/ROADMAP.md)", () => {
    const dryRunDefiners = filesMatching(files, /export (async )?function dryRunLedgerRebuild\(/);
    expect(dryRunDefiners).toEqual(["application/services/ledgerRebuild.ts"]);
  });
});

describe("CI guard: no new policy/trust-judgment implementations outside their canonical location", () => {
  it("every known trust/authority/verification-judgment function is still defined in exactly the one file that owns it", () => {
    const KNOWN_POLICY_FUNCTIONS: Record<string, string> = {
      authorityRank: "application/services/evidenceAuthority.ts",
      higherAuthority: "application/services/evidenceAuthority.ts",
      isTickerFullyOfficialBrokerExcelSourced: "application/services/reconciliation.ts",
      checkTickerMatch: "application/services/importVerification.ts",
      verifyAll: "application/services/verificationEngine.ts",
      verifyTransaction: "application/services/verificationEngine.ts",
      verifyAllDetailed: "application/services/verificationEngine.ts",
      verifyTicker: "application/services/verificationEngine.ts",
    };

    for (const [fnName, expectedPath] of Object.entries(KNOWN_POLICY_FUNCTIONS)) {
      const definers = filesMatching(files, new RegExp(`export (async )?function ${fnName}\\(`));
      expect(definers, `${fnName} should be defined in exactly ${expectedPath}, found in: ${definers.join(", ") || "(nowhere)"}`).toEqual([expectedPath]);
    }
  });

  it("no file outside evidenceAuthority.ts defines its own authority/trust RANKING table (the exact 'duplicate policy implementation' bug class named in docs/PORTFOLIO_OS_V2_SPEC.md Part 0.5 — constraintValidation.ts's own inventory check and ledgerRebuild's pre-unification trust exemption were real, historical instances of this)", () => {
    // A second `AUTHORITY_RANK`-shaped const (a Record from a document-type-like key to a number) is the concrete shape that bug took — grepped for the literal identifier plus any near-identical alias, not a broad heuristic that would false-positive on unrelated numeric maps.
    const rankingTableDefiners = filesMatching(files, /\b(AUTHORITY_RANK|SOURCE_RANK|TRUST_RANK)\s*[:=]/);
    expect(rankingTableDefiners).toEqual(["application/services/evidenceAuthority.ts"]);
  });
});

describe("CI guard: one canonical execution fact per business execution identity", () => {
  /**
   * The invariant certified here (Portfolio OS v2 Severity-1 data-integrity
   * finding): exactly ONE live BuyExecution/SellExecution RawTransaction
   * fact may exist per business execution identity (ticker/date/shares/
   * price/time), regardless of source. Proven violated in two of six
   * writers (backfillRawTransactions.ts's runBackfill — the reported ARCC
   * "Needs broker screenshot" defect — and importRecording.ts's
   * recordImportedRawTransactions, a genuine re-import race); both fixed by
   * checking `findLiveExecutionFact` (rawTransactionFolds.ts, the same
   * primitive TradeService.ensureBuyFact/ensureSellFacts already used
   * safely) before writing. This freezes the current, reviewed set of
   * writer sites so a NEW one — a future importer, a Notification-based
   * recorder, anything constructing `kind: "BuyExecution"`/`"SellExecution"`
   * — trips this guard instead of silently reintroducing the bug class.
   *
   * lotManager.ts is deliberately NOT required to call
   * findLiveExecutionFact/findUnclaimedSellExecutionFact here: it already
   * calls findUnclaimedSellExecutionFact for its own, narrower, intentional
   * reason (see lotManager.test.ts's "never adopts another still-pending
   * 'manual' Lot Manager sell sharing the same value" — two same-value
   * manual sells MUST be allowed to coexist as genuinely distinct
   * executions, an irreducible ambiguity this file resolves differently
   * on purpose, not a violation of this invariant).
   */
  it("every file constructing a BuyExecution/SellExecution RawTransaction is in the known, reviewed set", () => {
    const KNOWN_EXECUTION_FACT_WRITERS = [
      "application/services/TradeService.ts", // ensureBuyFact/ensureSellFacts — adopts via findLiveExecutionFact/findUnclaimedSellExecutionFact
      "application/services/backfillRawTransactions.ts", // runBackfill — fixed: skips a trade/sell-order already covered by a live fact
      "application/services/importRecording.ts", // recordImportedRawTransactions — fixed: skips a tie-or-lower-authority re-import of an already-live execution
      "application/services/ledgerProjection.ts", // ensureLegacyFactsExist — gap-backfill, already checks live facts grouped by value-key before creating
      "application/services/lotManager.ts", // recordSellTransactionLocked — its own narrower, intentional adoption policy (see doc comment above)
    ].sort();

    const actual = filesMatching(
      files.filter((f) => f.path.startsWith("application/")),
      // Negative lookahead excludes a union TYPE position (`kind: "BuyExecution" | "SellExecution"`,
      // e.g. rawTransactionFolds.findLiveExecutionFact's own match parameter) — only an
      // actual object-literal construction (no trailing `|`) counts as a writer.
      /kind:\s*["'](BuyExecution|SellExecution)["'](?!\s*\|)/
    );

    expect(actual).toEqual(KNOWN_EXECUTION_FACT_WRITERS);
  });

  it("the two writers this invariant was fixed in both still call the shared identity-matching primitive before writing", () => {
    const backfill = files.find((f) => f.path === "application/services/backfillRawTransactions.ts")!;
    expect(backfill.content).toMatch(/findLiveExecutionFact/);

    const importRecording = files.find((f) => f.path === "application/services/importRecording.ts")!;
    expect(importRecording.content).toMatch(/findLiveExecutionFact/);
  });
});

describe("CI guard: no new direct-mutable derived-state Dexie table", () => {
  it("the live schema's table list matches the reviewed, categorized allowlist exactly", () => {
    // Every table, categorized so a reviewer immediately sees what kind of
    // state a new addition would be (and therefore what write discipline it
    // must follow — see each category's own note):
    const KNOWN_TABLES: Record<string, string> = {
      // Fact store — append-only, structurally enforced (RawTransactionRepository exposes no update/delete).
      rawTransactions: "fact-store",
      // Replay caches — full delete-and-replace per (portfolioId, ticker) ONLY, never incrementally patched. See CommittedLedgerRepository's own doc comment.
      ledgerCache: "replay-cache",
      allocationsCache: "replay-cache",
      // Legacy projection — a DERIVED view of the fact log (ledgerProjection.ts), but still directly writable by TradeService too (the known, disclosed dual-writer — see the dual-writer guard above). A new table joining this category without ALSO closing that dual-writer gap would be new debt, not just more of the same.
      trades: "legacy-projection (dual-writer)",
      tradeAllocations: "legacy-projection (dual-writer)",
      // Genuinely owned, directly-mutable domain state — not derived from anything, no replay concern.
      portfolios: "owned-mutable",
      timelineEvents: "owned-mutable",
      journalEntries: "owned-mutable",
      verifications: "owned-mutable",
      uploads: "owned-mutable",
      pendingExecutions: "owned-mutable (explicitly NOT a Fact — see PendingExecution's own doc comment)",
      // Diagnostics Center (docs/DIAGNOSTICS_CENTER_SPEC.md Part 3.1) — observation-only, never read by business logic (Part 5.4), never wiped by purge.ts's Reset (see purge.ts's own doc comment on allTables). diagnosticEvents mirrors rawTransactions's append-only discipline; diagnosticCases mirrors ledgerCache's full-delete-and-regenerate-per-key discipline.
      diagnosticEvents: "diagnostic-store (append-only)",
      diagnosticCases: "diagnostic-store (replay-cache)",
    };

    const db = new PortfolioOsDatabase(`arch-guard-${Math.random()}`);
    const liveTableNames = db.tables.map((t) => t.name).sort();

    expect(liveTableNames).toEqual(Object.keys(KNOWN_TABLES).sort());
  });
});
