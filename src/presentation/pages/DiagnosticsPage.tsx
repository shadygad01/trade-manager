import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@presentation/components/PageHeader";
import { diagnosticCaseRepository } from "@presentation/lib/data";

/**
 * Phase 1 placeholder (docs/DIAGNOSTICS_CENTER_SPEC.md Part 12) — only the
 * Case List shell exists so far. No case detection engine runs yet (Phase
 * 4), so this always renders empty on a fresh install; it exists to prove
 * the route/storage/gating wiring end-to-end before any detection logic is
 * built on top of it. Developer-only surface (Part 7.1) — deliberately not
 * run through the app's EN/AR translation layer.
 */
export function DiagnosticsPage() {
  const cases = useLiveQuery(() => diagnosticCaseRepository.getAll(), []);

  return (
    <div>
      <PageHeader title="Diagnostics" description="Developer Mode is on. This is the Diagnostics Center." />
      {cases === undefined ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="text-sm text-slate-500">No diagnostic cases recorded yet.</p>
      ) : (
        <ul className="space-y-2">
          {cases.map((c) => (
            <li key={c.id} className="rounded-md border border-slate-800 bg-slate-900 px-4 py-3 text-sm text-slate-200">
              <span className="font-medium">{c.severity}</span> — {c.triggerType}
              {c.ticker ? ` (${c.ticker})` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
