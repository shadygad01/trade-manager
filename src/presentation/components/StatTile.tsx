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
    <div className="group relative flex min-h-40 flex-col gap-1 overflow-hidden rounded-[1.15rem] border border-white/[.075] bg-gradient-to-br from-[#131a25]/95 to-[#090d14]/95 p-5 shadow-[0_22px_65px_rgba(0,0,0,.24)] transition-all duration-200 hover:-translate-y-1 hover:border-blue-400/25 hover:shadow-[0_30px_75px_rgba(0,0,0,.34)]">
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-blue-300/55 to-transparent opacity-70" />
      <div className="pointer-events-none absolute -end-10 -top-12 h-28 w-28 rounded-full bg-blue-500/[.07] blur-2xl" />
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[.1em] text-slate-400">{label}</span>
        {icon ? <span className="grid h-10 w-10 place-items-center rounded-xl border border-blue-300/10 bg-blue-400/[.08] text-blue-300 shadow-inner">{icon}</span> : null}
      </div>
      <span className={`mt-auto text-[1.75rem] font-semibold tracking-[-.045em] tabular-nums text-white ${valueClassName ?? ""}`}>{value}</span>
      {sublabel ? <span className="mt-0.5 text-xs text-slate-500">{sublabel}</span> : null}
    </div>
  );
}
