import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/40 px-6 py-14 text-center">
      {icon ? <div className="text-slate-600">{icon}</div> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-200">{title}</p>
        {description ? <p className="max-w-sm text-sm text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
