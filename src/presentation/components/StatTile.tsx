import type { ReactNode } from "react";

interface StatTileProps {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  valueClassName?: string;
  icon?: ReactNode;
}

export function StatTile({ label, value, sublabel, valueClassName, icon }: StatTileProps) {
  return (
    <div className="group relative flex min-h-32 flex-col gap-1 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 p-5">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-teal-400/30 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
        {icon ? <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/[.06] bg-white/[.035] text-teal-400">{icon}</span> : null}
      </div>
      <span className={`mt-auto text-2xl font-semibold tracking-[-.025em] tabular-nums text-slate-50 ${valueClassName ?? ""}`}>{value}</span>
      {sublabel ? <span className="mt-0.5 text-xs text-slate-500">{sublabel}</span> : null}
    </div>
  );
}
