import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="relative flex min-h-56 flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-14 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(45,212,191,.055),transparent_55%)]" />
      {icon ? <div className="relative grid h-12 w-12 place-items-center rounded-xl border border-white/[.07] bg-white/[.035] text-teal-400">{icon}</div> : null}
      <div className="relative space-y-1.5">
        <p className="text-sm font-semibold text-slate-200">{title}</p>
        {description ? <p className="max-w-md text-sm leading-6 text-slate-500">{description}</p> : null}
      </div>
      {action ? <div className="relative mt-1">{action}</div> : null}
    </div>
  );
}
