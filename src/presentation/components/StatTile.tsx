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
    <div className="group relative flex min-h-36 flex-col gap-1 overflow-hidden rounded-2xl border border-white/[.075] bg-gradient-to-br from-[#111a2e]/95 to-[#0a1120]/90 p-5 shadow-[0_18px_50px_rgba(0,0,0,.16)] transition-all duration-200 hover:-translate-y-0.5 hover:border-indigo-400/25 hover:shadow-[0_24px_60px_rgba(0,0,0,.24)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-indigo-300/50 to-transparent opacity-60" />
      <div className="pointer-events-none absolute -end-10 -top-12 h-28 w-28 rounded-full bg-indigo-500/[.055] blur-2xl" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[.1em] text-slate-400">{label}</span>
        {icon ? <span className="grid h-9 w-9 place-items-center rounded-xl border border-indigo-300/10 bg-indigo-400/[.08] text-indigo-300">{icon}</span> : null}
      </div>
      <span className={`mt-auto text-[1.65rem] font-semibold tracking-[-.035em] tabular-nums text-white ${valueClassName ?? ""}`}>{value}</span>
      {sublabel ? <span className="mt-0.5 text-xs text-slate-500">{sublabel}</span> : null}
    </div>
  );
}
