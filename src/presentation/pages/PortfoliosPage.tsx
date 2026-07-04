import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "wouter";
import { Plus, Briefcase, ArrowRight } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { createPortfolioAndSave } from "@application/services/PortfolioService";
import type { PortfolioKind } from "@domain/entities/Portfolio";
import { computePositions } from "@application/services/TradeService";
import { PageHeader } from "@presentation/components/PageHeader";
import { EmptyState } from "@presentation/components/EmptyState";
import { Modal } from "@presentation/components/Modal";
import { formatMoney } from "@presentation/lib/format";

const KINDS: PortfolioKind[] = ["Investment", "Trading", "Swing", "Experiments", "Retirement", "Education", "Custom"];

export function PortfoliosPage() {
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [modalOpen, setModalOpen] = useState(false);

  const summaries = useLiveQuery(async () => {
    if (!portfolios) return undefined;
    const priceMap = await repos.prices.getAllPrices();
    const map = new Map<string, number>();
    for (const p of portfolios) {
      const positions = await computePositions(repos, p.id, priceMap);
      const marketValue = positions.reduce((sum: number, pos) => sum + (pos.marketValue ?? pos.costBasis), 0);
      map.set(p.id, marketValue);
    }
    return map;
  }, [portfolios]);

  return (
    <div>
      <PageHeader
        title="Portfolios"
        description="Every book you track, from long-term investing to short-term swing trades."
        actions={
          <button
            onClick={() => setModalOpen(true)}
            className="flex items-center gap-1.5 rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-cyan-400"
          >
            <Plus size={16} /> New Portfolio
          </button>
        }
      />

      {portfolios && portfolios.length === 0 ? (
        <EmptyState
          icon={<Briefcase size={28} />}
          title="No portfolios yet"
          description="Create a portfolio to start recording trades, cash movements and analytics."
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950"
            >
              Create your first portfolio
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(portfolios ?? []).map((p) => (
            <Link
              key={p.id}
              href={`/portfolios/${p.id}`}
              className="group rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition-colors hover:border-cyan-500/40 hover:bg-slate-900"
            >
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold text-slate-50">{p.name}</p>
                  <span className="mt-1 inline-block rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-400">
                    {p.kind === "Custom" ? p.customKindLabel || "Custom" : p.kind}
                  </span>
                </div>
                <ArrowRight size={16} className="text-slate-600 group-hover:text-cyan-400" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Cash</p>
                  <p className="tabular-nums text-slate-200">{formatMoney(p.cash)}</p>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-500">Invested</p>
                  <p className="tabular-nums text-slate-200">{formatMoney(summaries?.get(p.id) ?? 0)}</p>
                </div>
              </div>
              {p.notes ? <p className="mt-3 line-clamp-2 text-xs text-slate-500">{p.notes}</p> : null}
            </Link>
          ))}
        </div>
      )}

      <CreatePortfolioModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  );
}

function CreatePortfolioModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PortfolioKind>("Investment");
  const [customKindLabel, setCustomKindLabel] = useState("");
  const [initialCash, setInitialCash] = useState("0");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setKind("Investment");
    setCustomKindLabel("");
    setInitialCash("0");
    setNotes("");
    setError(null);
  }

  async function handleSubmit() {
    if (!name.trim()) {
      setError("Give the portfolio a name.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createPortfolioAndSave(repos, {
        name: name.trim(),
        kind,
        customKindLabel: kind === "Custom" ? customKindLabel.trim() || undefined : undefined,
        initialCash: Number.parseFloat(initialCash) || 0,
        notes: notes.trim() || undefined,
      });
      reset();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create portfolio.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title="Create Portfolio"
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
    >
      <div className="space-y-3">
        <label className="block text-xs text-slate-400 space-y-1">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            placeholder="e.g. Core Egyptian Equities"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Kind
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as PortfolioKind)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {kind === "Custom" ? (
          <label className="block text-xs text-slate-400 space-y-1">
            Custom label
            <input
              value={customKindLabel}
              onChange={(e) => setCustomKindLabel(e.target.value)}
              className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
            />
          </label>
        ) : null}
        <label className="block text-xs text-slate-400 space-y-1">
          Initial cash (EGP)
          <input
            type="number"
            value={initialCash}
            onChange={(e) => setInitialCash(e.target.value)}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        <label className="block text-xs text-slate-400 space-y-1">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="block w-full rounded border border-slate-700 bg-slate-800 px-2 py-1.5 text-sm text-slate-100"
          />
        </label>
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="rounded-md bg-cyan-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-cyan-400 disabled:opacity-50"
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
