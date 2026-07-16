import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="relative flex min-h-64 flex-col items-center justify-center gap-4 overflow-hidden rounded-2xl border border-dashed border-indigo-300/15 bg-gradient-to-br from-[#10182a]/80 to-[#090f1d]/80 px-6 py-16 text-center shadow-[inset_0_1px_0_rgba(255,255,255,.025)]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(99,102,241,.09),transparent_58%)]" />
      {icon ? <div className="relative grid h-13 w-13 place-items-center rounded-2xl border border-indigo-300/15 bg-indigo-400/[.08] text-indigo-300 shadow-[0_14px_35px_rgba(49,46,129,.18)]">{icon}</div> : null}
      <div className="relative space-y-1.5">
        <p className="text-base font-semibold tracking-[-.015em] text-slate-100">{title}</p>
        {description ? <p className="max-w-md text-sm leading-6 text-slate-500">{description}</p> : null}
      </div>
      {action ? <div className="relative mt-1">{action}</div> : null}
    </div>
  );
}
