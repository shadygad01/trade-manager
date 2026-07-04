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
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
        {icon ? <span className="text-slate-500">{icon}</span> : null}
      </div>
      <span className={`text-2xl font-semibold tabular-nums text-slate-50 ${valueClassName ?? ""}`}>{value}</span>
      {sublabel ? <span className="text-xs text-slate-500">{sublabel}</span> : null}
    </div>
  );
}
