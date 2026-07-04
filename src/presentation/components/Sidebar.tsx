import { Link, useRoute, useLocation } from "wouter";
import { useLiveQuery } from "dexie-react-hooks";
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Clock,
  BookOpen,
  BarChart3,
  UploadCloud,
  ChevronDown,
} from "lucide-react";
import { useMemo, useState } from "react";
import { repos } from "@presentation/lib/data";

const NAV_ITEMS = [
  { key: "holdings", label: "Holdings", icon: Briefcase, suffix: "" },
  { key: "trades", label: "Trades", icon: ArrowLeftRight, suffix: "/trades" },
  { key: "timeline", label: "Timeline", icon: Clock, suffix: "/timeline" },
  { key: "journal", label: "Journal", icon: BookOpen, suffix: "/journal" },
  { key: "analytics", label: "Analytics", icon: BarChart3, suffix: "/analytics" },
  { key: "import", label: "Import", icon: UploadCloud, suffix: "/import" },
] as const;

export function Sidebar() {
  const [, dashboardParams] = useRoute("/");
  const [, portfolioParams] = useRoute("/portfolios/:id/:rest*");
  const [location] = useLocation();
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const activePortfolioId = portfolioParams?.id;
  const activePortfolio = useMemo(
    () => portfolios?.find((p) => p.id === activePortfolioId),
    [portfolios, activePortfolioId],
  );

  return (
    <aside className="flex h-screen w-64 shrink-0 flex-col border-r border-slate-800/80 bg-slate-950 text-slate-300">
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-400 font-bold">
          P
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-50 leading-none">Portfolio OS</p>
          <p className="text-[11px] text-slate-500 mt-0.5">Trade & Portfolio Manager</p>
        </div>
      </div>

      <nav className="px-3 py-3">
        <Link
          href="/"
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            dashboardParams ? "bg-cyan-500/10 text-cyan-400" : "text-slate-300 hover:bg-slate-900 hover:text-slate-50"
          }`}
        >
          <LayoutDashboard size={16} />
          Dashboard
        </Link>
        <Link
          href="/portfolios"
          className="mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-slate-50"
        >
          <Briefcase size={16} />
          Portfolios
        </Link>
      </nav>

      <div className="mt-2 flex-1 overflow-y-auto px-3 pb-4">
        {activePortfolioId ? (
          <div>
            <div className="relative mb-2">
              <button
                onClick={() => setSwitcherOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-left"
              >
                <span className="truncate text-sm font-medium text-slate-100">
                  {activePortfolio?.name ?? "Portfolio"}
                </span>
                <ChevronDown size={14} className="shrink-0 text-slate-500" />
              </button>
              {switcherOpen && portfolios ? (
                <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-800 bg-slate-900 shadow-xl">
                  {portfolios.map((p) => (
                    <Link
                      key={p.id}
                      href={`/portfolios/${p.id}`}
                      onClick={() => setSwitcherOpen(false)}
                      className={`block truncate px-3 py-2 text-sm hover:bg-slate-800 ${
                        p.id === activePortfolioId ? "text-cyan-400" : "text-slate-300"
                      }`}
                    >
                      {p.name}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
            <p className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Portfolio
            </p>
            {NAV_ITEMS.map((item) => {
              const href = `/portfolios/${activePortfolioId}${item.suffix}`;
              const isActive = item.suffix === "" ? location === href : location.startsWith(href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  href={href}
                  className={`mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive ? "bg-cyan-500/10 text-cyan-400" : "text-slate-300 hover:bg-slate-900 hover:text-slate-50"
                  }`}
                >
                  <Icon size={16} />
                  {item.label}
                </Link>
              );
            })}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
            Select a portfolio to see trades, timeline, journal, analytics and import tools.
          </div>
        )}
      </div>

      <div className="border-t border-slate-800/80 px-5 py-3 text-[11px] text-slate-600">
        Data stays in this browser (IndexedDB). No servers, no accounts.
      </div>
    </aside>
  );
}
