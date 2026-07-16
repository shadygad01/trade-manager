import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4 border-b border-white/[.07] pb-5">
      <div className="max-w-3xl">
        <div className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.2em] text-teal-400"><span className="h-px w-5 bg-teal-400/70" />Portfolio OS</div>
        <h1 className="text-2xl font-semibold tracking-[-.025em] text-slate-50 sm:text-[1.7rem]">{title}</h1>
        {description ? <p className="mt-1.5 text-sm leading-6 text-slate-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 [&_button]:shadow-sm">{actions}</div> : null}
    </div>
  );
}
