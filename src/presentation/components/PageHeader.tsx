import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-5 border-b border-white/[.065] pb-6">
      <div className="max-w-3xl">
        <div className="mb-2.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[.24em] text-indigo-300"><span className="h-px w-6 bg-gradient-to-r from-indigo-400 to-sky-400" />Portfolio Intelligence</div>
        <h1 className="text-[1.75rem] font-semibold tracking-[-.035em] text-white sm:text-[2rem]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 [&_button]:shadow-sm">{actions}</div> : null}
    </div>
  );
}
