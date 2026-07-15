import { useLiveQuery } from "dexie-react-hooks";
import { PageHeader } from "@presentation/components/PageHeader";
import { diagnosticCaseRepository, diagnosticEventRepository } from "@presentation/lib/data";
import type { DiagnosticEvent } from "@domain/entities/diagnostics/DiagnosticEvent";
// TEMPORARY — see each panel's own doc comment. Delete these imports and
// their usages below once removed.

const RECENT_EVENT_LIMIT = 200;

function summarize(event: DiagnosticEvent): string {
  switch (event.kind) {
    case "SessionEvent":
      return `[${event.workflowStep ?? "?"}] ${event.label}`;
    case "WriteTrace":
      return `Write (${event.valueSource}) ${event.table}/${event.objectId} — ${event.writer}.${event.function} — ${event.reason}`;
    case "ReadTrace":
      return `Read ${event.reader}.${event.function}${event.decision ? ` — ${event.decision}` : ""}`;
    case "DecisionTrace":
      return `Decision (${event.decisionType}) ${event.reader}.${event.function} — ${event.decision} — in: ${event.inputSummary} — out: ${event.outputSummary}`;
    case "RuleExecution":
      return `Rule ${event.ruleName} — ${event.passed ? "PASS" : "FAIL"} — ${event.reason}`;
    case "PerfSample":
      return `Perf ${event.operation} — ${event.durationMs}ms`;
  }
}

/**
 * Phase 2 (docs/DIAGNOSTICS_CENTER_SPEC.md Part 12) — adds a raw Session
 * Recorder / Writer Trace list on top of Phase 1's Case List shell (still
 * empty — no case detection engine exists yet, Phase 4). This is
 * deliberately the RAW event log, not a curated view: proving the
 * instrumentation wired in this phase (TradeService.ts's recordBuy/
 * recordSell, the top-level workflow handlers) actually reaches storage
 * end-to-end, before any summarization/grouping logic is built on top.
 * Developer-only surface (Part 7.1) — deliberately not run through the
 * app's EN/AR translation layer.
 */
export function DiagnosticsPage() {
  const cases = useLiveQuery(() => diagnosticCaseRepository.getAll(), []);
  const events = useLiveQuery(() => diagnosticEventRepository.getRecent(RECENT_EVENT_LIMIT), []);

  return (
    <div className="space-y-8">
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

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-300">Recent Events (Session Recorder / Writer Trace)</h2>
        {events === undefined ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-500">
            No events recorded yet — record a Buy or Sell, confirm an Import row, or reset all data to see events here.
          </p>
        ) : (
          <ol className="space-y-1 font-mono text-xs text-slate-400">
            {events.map((event) => (
              <li key={event.id} className="border-b border-slate-900 py-1">
                <span className="text-slate-600">#{event.seq}</span> <span className="text-slate-500">{event.recordedAt}</span>{" "}
                {summarize(event)}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
