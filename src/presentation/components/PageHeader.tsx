import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <div className="relative mb-9 flex flex-wrap items-end justify-between gap-5 border-b border-white/[.065] pb-7">
      <div className="max-w-3xl">
        <div className="mb-3 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[.28em] text-blue-300"><span className="h-px w-7 bg-gradient-to-r from-blue-400 to-cyan-300" />Executive Workspace</div>
        <h1 className="text-[1.9rem] font-semibold tracking-[-.045em] text-white sm:text-[2.25rem]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 [&_button]:shadow-sm">{actions}</div> : null}
      <div className="absolute -bottom-px start-0 h-px w-24 bg-gradient-to-r from-blue-400 to-transparent" />
    </div>
  );
}
