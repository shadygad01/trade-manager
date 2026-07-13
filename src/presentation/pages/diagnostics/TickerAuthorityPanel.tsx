import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { repos } from "@presentation/lib/data";
import { isTickerFullyOfficialBrokerExcelSourced } from "@application/services/reconciliation";
import { isRetracted, resolveCurrentTicker } from "@application/services/rawTransactionFolds";
import { authorityRank } from "@application/services/evidenceAuthority";
import { normalizeTicker } from "@domain/value-objects/Ticker";
import type { RawTransaction } from "@domain/entities/RawTransaction";

const OFFICIAL_BROKER_EXCEL_RANK = authorityRank("official-broker-excel");

interface EvaluatedFact {
  id: string;
  kind: string;
  rawTicker: string | undefined;
  resolvedTicker: string | undefined;
  source: string;
  authorityRank: number;
  retracted: boolean;
  includedInEvaluation: boolean;
  exclusionReason: string | null;
  shares: number | undefined;
  portfolioId: string | undefined;
}

/**
 * TEMPORARY — single-investigation panel for the "why does checkTickerMatch
 * return no-verification for a ticker Constraint Evaluation reports as
 * Satisfied" trace. Calls the real, unmodified isTickerFullyOfficialBrokerExcelSourced
 * (reconciliation.ts) against the real repos.rawTransactions from production
 * IndexedDB for its final verdict — never re-derives that verdict — and
 * independently walks the same real primitives (isRetracted,
 * resolveCurrentTicker, authorityRank) it uses internally to expose the
 * per-fact breakdown the boolean-only function doesn't surface. Delete this
 * file and its one import line in DiagnosticsPage.tsx once the offending
 * fact is identified — not part of the permanent Diagnostics Center surface.
 */
export function TickerAuthorityPanel() {
  const [tickerInput, setTickerInput] = useState("ABUK");
  const allRawTransactions = useLiveQuery(() => repos.rawTransactions.getAll(), []);

  if (allRawTransactions === undefined) {
    return <p className="text-sm text-slate-500">Loading raw transactions…</p>;
  }

  const ticker = normalizeTicker(tickerInput);
  const all: RawTransaction[] = allRawTransactions;

  // Every BuyExecution/SellExecution fact whose RAW ticker or RESOLVED ticker
  // touches the searched ticker — a strict superset of what the real
  // function's live[] ends up containing, so a fact renamed away from or
  // into this ticker is still visible with its exclusion reason, not
  // silently dropped from the table.
  const candidates = all.filter((t) => {
    if (t.kind !== "BuyExecution" && t.kind !== "SellExecution") return false;
    const raw = t.ticker !== undefined ? normalizeTicker(t.ticker) : undefined;
    const resolved = resolveCurrentTicker(all, t);
    const resolvedNorm = resolved !== undefined ? normalizeTicker(resolved) : undefined;
    return raw === ticker || resolvedNorm === ticker;
  });

  const evaluated: EvaluatedFact[] = candidates.map((t) => {
    const retracted = isRetracted(all, t.id);
    const resolved = resolveCurrentTicker(all, t);
    const resolvedNorm = resolved !== undefined ? normalizeTicker(resolved) : undefined;
    const rank = authorityRank(t.source);

    let includedInEvaluation = false;
    let exclusionReason: string | null = null;
    if (retracted) {
      exclusionReason = "Retracted — a live Retraction fact targets this id";
    } else if (resolvedNorm === undefined) {
      exclusionReason = "resolveCurrentTicker() returned undefined";
    } else if (resolvedNorm !== ticker) {
      exclusionReason = `Resolves to a different ticker ("${resolved}") — renamed via a Correction`;
    } else {
      includedInEvaluation = true;
    }

    const shares = "shares" in t.payload ? (t.payload as { shares: number }).shares : undefined;

    return {
      id: t.id,
      kind: t.kind,
      rawTicker: t.ticker,
      resolvedTicker: resolved,
      source: t.source,
      authorityRank: rank,
      retracted,
      includedInEvaluation,
      exclusionReason,
      shares,
      portfolioId: t.portfolioId,
    };
  });

  const live = evaluated.filter((e) => e.includedInEvaluation);
  const everyMeetsBar = live.length > 0 && live.every((e) => e.authorityRank >= OFFICIAL_BROKER_EXCEL_RANK);
  // The real production verdict — called directly, never re-derived, so this
  // can never drift from what checkTickerMatch actually saw.
  const finalReturnValue = isTickerFullyOfficialBrokerExcelSourced(all, ticker);

  return (
    <div className="space-y-4 rounded-md border border-amber-700/50 bg-amber-950/20 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-300">
          TEMPORARY — isTickerFullyOfficialBrokerExcelSourced() evaluation trace
        </h2>
      </div>
      <p className="text-xs text-slate-400">
        Investigation-only panel over real production IndexedDB. Remove once the offending fact is
        identified.
      </p>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        Ticker:
        <input
          value={tickerInput}
          onChange={(e) => setTickerInput(e.target.value)}
          className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-slate-100"
        />
      </label>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-left text-slate-400">
              <th className="py-1 pr-3">id</th>
              <th className="py-1 pr-3">kind</th>
              <th className="py-1 pr-3">resolvedTicker</th>
              <th className="py-1 pr-3">source</th>
              <th className="py-1 pr-3">authorityRank</th>
              <th className="py-1 pr-3">retracted</th>
              <th className="py-1 pr-3">includedInEvaluation</th>
              <th className="py-1 pr-3">exclusionReason</th>
            </tr>
          </thead>
          <tbody>
            {evaluated.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-2 text-slate-500">
                  No BuyExecution/SellExecution facts resolve to or from "{ticker}".
                </td>
              </tr>
            ) : (
              evaluated.map((e) => (
                <tr key={e.id} className="border-b border-slate-800 text-slate-300">
                  <td className="py-1 pr-3 font-mono">{e.id}</td>
                  <td className="py-1 pr-3">{e.kind}</td>
                  <td className="py-1 pr-3">{e.resolvedTicker ?? "—"}</td>
                  <td className="py-1 pr-3">{e.source}</td>
                  <td className="py-1 pr-3">{e.authorityRank}</td>
                  <td className="py-1 pr-3">{String(e.retracted)}</td>
                  <td className={`py-1 pr-3 font-semibold ${e.includedInEvaluation ? "text-emerald-400" : "text-rose-400"}`}>
                    {String(e.includedInEvaluation)}
                  </td>
                  <td className="py-1 pr-3">{e.exclusionReason ?? "—"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="space-y-1 border-t border-slate-700 pt-3 font-mono text-xs text-slate-300">
        <div>live.length = {live.length}</div>
        <div>
          every(authorityRank &gt;= OFFICIAL_BROKER_EXCEL_RANK={OFFICIAL_BROKER_EXCEL_RANK}) = {String(everyMeetsBar)}
        </div>
        <div className="text-sm font-semibold text-amber-300">
          isTickerFullyOfficialBrokerExcelSourced("{ticker}") = {String(finalReturnValue)}
        </div>
      </div>
    </div>
  );
}
