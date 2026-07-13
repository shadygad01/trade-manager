import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { repos } from "@presentation/lib/data";
import { isRetracted } from "@application/services/rawTransactionFolds";
import { canonicalKey } from "@application/services/ledgerRebuild";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { RawTransaction, BuyExecutionPayload } from "@domain/entities/RawTransaction";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-slate-800 py-1.5 last:border-0 sm:flex-row sm:gap-2">
      <span className="shrink-0 text-slate-500 sm:w-40">{label}</span>
      <span className="break-all font-mono text-slate-200">{value}</span>
    </div>
  );
}

function FactCard({ t, highlight }: { t: { id: string; seq: number; kind: string; source: string; ticker?: string; extra?: string }; highlight?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1.5 text-xs ${highlight ? "border-amber-500 bg-amber-950/30" : "border-slate-800 bg-slate-900"}`}>
      <div className="break-all font-mono text-slate-300">
        seq {t.seq} — {t.id}
      </div>
      <div className="text-slate-400">
        {t.kind} · {t.source} · {t.ticker ?? "—"}
        {t.extra ? ` · ${t.extra}` : ""}
      </div>
    </div>
  );
}

/**
 * TEMPORARY — mobile-usable version of the "which writer created this exact
 * RawTransaction" trace. Renders in the Diagnostics page itself (no DevTools
 * console needed) so it works from Chrome Mobile. Same real, unmodified
 * primitives as the console version it replaces (canonicalKey, isRetracted)
 * against the real repos.rawTransactions from production IndexedDB. Delete
 * this file and its import/usage in DiagnosticsPage.tsx once the fact's
 * lifecycle is fully explained.
 */
export function FactLifecyclePanel() {
  const [factId, setFactId] = useState("d8c82604-6307-48b2-8c26-c77dd247666b");
  const all = useLiveQuery(() => repos.rawTransactions.getAll(), []);
  const trade = useLiveQuery(() => repos.trades.getById(factId), [factId]);

  if (all === undefined) {
    return <p className="text-sm text-slate-500">Loading raw transactions…</p>;
  }

  const target = all.find((t) => t.id === factId);

  return (
    <div className="space-y-4 rounded-md border border-amber-700/50 bg-amber-950/20 p-4">
      <h2 className="text-sm font-semibold text-amber-300">TEMPORARY — RawTransaction lifecycle trace</h2>
      <p className="text-xs text-slate-400">Fully on-device. No console required — usable on Chrome Mobile.</p>
      <label className="flex flex-col gap-1 text-sm text-slate-300 sm:flex-row sm:items-center sm:gap-2">
        Fact id:
        <input
          value={factId}
          onChange={(e) => setFactId(e.target.value.trim())}
          className="w-full rounded border border-slate-700 bg-slate-800 px-2 py-1 font-mono text-xs text-slate-100 sm:flex-1"
        />
      </label>

      {!target ? (
        <p className="text-sm text-rose-400">Fact not found in this database.</p>
      ) : (
        <FactLifecycleBody all={all} target={target} trade={trade} />
      )}
    </div>
  );
}

function FactLifecycleBody({
  all,
  target,
  trade,
}: {
  all: RawTransaction[];
  target: RawTransaction;
  trade: Awaited<ReturnType<typeof repos.trades.getById>> | undefined;
}) {
  const ticker = target.ticker !== undefined ? normalizeTicker(target.ticker) : normalizeTicker((target.payload as BuyExecutionPayload).ticker);

  // PART 1 — writer identification.
  const allBackfill = all.filter((t) => t.source === "backfill").sort((a, b) => a.seq - b.seq);
  const neighbors = all.filter((t) => Math.abs(t.seq - target.seq) <= 5).sort((a, b) => a.seq - b.seq);
  const minSeq = Math.min(...all.map((t) => t.seq));
  const isNearStart = target.seq - minSeq <= 5;
  const neighborsMostlyBackfill = neighbors.length > 0 && neighbors.filter((t) => t.source === "backfill").length / neighbors.length >= 0.5;
  const writerVerdict =
    isNearStart && neighborsMostlyBackfill
      ? "Writer A — backfillRawTransactionsSilently (one-time startup batch)"
      : "Writer B — ensureLegacyFactsExist (reactive per-commit gap-fill)";

  // PART 2/3 — the legacy Trade + canonical-key matching (only meaningful if a Trade row still exists under this id).
  const liveBuys = all.filter((t) => t.kind === "BuyExecution" && t.ticker !== undefined && normalizeTicker(t.ticker) === ticker && !isRetracted(all, t.id));
  const liveBuyRows = liveBuys.map((t) => {
    const p = t.payload as BuyExecutionPayload;
    return { id: t.id, seq: t.seq, source: t.source, executionDate: p.executionDate, shares: p.shares, price: p.price, key: canonicalKey({ side: "BUY", ticker, date: p.executionDate, shares: p.shares, price: p.price }) };
  });
  const tradeKey = trade ? canonicalKey({ side: "BUY", ticker, date: trade.executionDate, shares: trade.shares, price: trade.entryPrice }) : undefined;
  const sameKeyLiveFacts = tradeKey ? liveBuyRows.filter((r) => r.key === tradeKey && r.id !== target.id) : [];

  // PART 4 — every fact of any source/liveness matching the Trade's exact identity (upgrade-candidate check).
  const candidates = trade
    ? all.filter((t) => {
        if (t.kind !== "BuyExecution") return false;
        if (t.ticker === undefined || normalizeTicker(t.ticker) !== ticker) return false;
        const p = t.payload as BuyExecutionPayload;
        return p.executionDate === trade.executionDate && p.shares === trade.shares && Math.abs(p.price - trade.entryPrice) < 0.01;
      })
    : [];
  const otherCandidates = candidates.filter((c) => c.id !== target.id);

  const conclusion = !trade
    ? `No live Trade row exists under this id — the legacy projection may have since deleted/reprojected it. Investigate separately: was the Trade deleted after this fact was created?`
    : otherCandidates.length > 0
      ? `${otherCandidates.length} other document(s) exist describing this exact execution (same ticker/date/shares/price) — the Provenance Upgrade path (ImportPage.tsx) should have retracted this backfill fact in favor of the higher-authority one. It did not. This points to an UPGRADE PATH FAILURE, not stale data — investigate why duplicateMatch/upgradeFact didn't fire for this pair.`
      : `NO other document (any source) has ever described this exact execution (ticker=${ticker}, date=${trade.executionDate}, shares=${trade.shares}, price=${trade.entryPrice}). The Provenance Upgrade path never had a candidate to match against — this fact staying source:"backfill" forever is CORRECT, EXPECTED behavior given no better document was ever uploaded for it. This is stale legacy data waiting on a real document, not a bug in the matching algorithm or the upgrade path.`;

  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Target fact</h3>
        <div className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs">
          <Row label="id" value={target.id} />
          <Row label="seq" value={String(target.seq)} />
          <Row label="kind" value={target.kind} />
          <Row label="source" value={target.source} />
          <Row label="ticker" value={target.ticker ?? "—"} />
          <Row label="portfolioId" value={target.portfolioId ?? "—"} />
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          Part 1 — Which writer (seq evidence)
        </h3>
        <div className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs">
          <Row label="lowest seq in DB" value={String(minSeq)} />
          <Row label="target seq" value={String(target.seq)} />
          <Row label="total backfill facts" value={String(allBackfill.length)} />
        </div>
        <p className="text-xs text-slate-400">Every backfill-sourced fact in the whole database:</p>
        <div className="space-y-1">
          {allBackfill.length === 0 ? (
            <p className="text-xs text-slate-500">None.</p>
          ) : (
            allBackfill.map((t) => <FactCard key={t.id} t={t} highlight={t.id === target.id} />)
          )}
        </div>
        <p className="text-xs text-slate-400">Facts within 5 seq of the target (what else was happening then):</p>
        <div className="space-y-1">
          {neighbors.map((t) => (
            <FactCard key={t.id} t={t} highlight={t.id === target.id} />
          ))}
        </div>
        <p className="rounded border border-amber-600/50 bg-amber-950/40 px-3 py-2 text-sm font-semibold text-amber-300">
          {writerVerdict}
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Part 2/3 — legacy Trade + canonical-key matching</h3>
        <div className="rounded border border-slate-800 bg-slate-900 px-3 py-2 text-xs">
          <Row label="Trade found?" value={trade ? "yes" : "no"} />
          {trade && (
            <>
              <Row label="Trade.ticker/date/shares/price" value={`${trade.ticker} / ${trade.executionDate} / ${trade.shares} / ${trade.entryPrice}`} />
              <Row label="Trade canonical key" value={tradeKey ?? "—"} />
            </>
          )}
        </div>
        <p className="text-xs text-slate-400">Every live BuyExecution fact for "{ticker}" and its canonical key:</p>
        <div className="space-y-1">
          {liveBuyRows.length === 0 ? (
            <p className="text-xs text-slate-500">None.</p>
          ) : (
            liveBuyRows.map((r) => (
              <FactCard
                key={r.id}
                t={{ id: r.id, seq: r.seq, kind: "BuyExecution", source: r.source, ticker, extra: `key=${r.key}` }}
                highlight={r.id === target.id}
              />
            ))
          )}
        </div>
        <p className="text-xs text-slate-400">
          Other live facts sharing the Trade's exact canonical key: <strong className="text-slate-200">{sameKeyLiveFacts.length}</strong>
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Part 4 — upgrade-candidate check (any source, live or retracted)</h3>
        <div className="space-y-1">
          {candidates.length === 0 ? (
            <p className="text-xs text-slate-500">No Trade to compare against.</p>
          ) : (
            candidates.map((c) => (
              <FactCard
                key={c.id}
                t={{ id: c.id, seq: c.seq, kind: c.kind, source: c.source, ticker, extra: isRetracted(all, c.id) ? "retracted" : "live" }}
                highlight={c.id === target.id}
              />
            ))
          )}
        </div>
      </section>

      <section className="space-y-2 border-t border-amber-700/50 pt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-amber-400">Conclusion</h3>
        <p className="text-sm text-amber-200">{conclusion}</p>
      </section>
    </div>
  );
}
