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
  Database,
  Languages,
} from "lucide-react";
import { useMemo, useState } from "react";
import { repos } from "@presentation/lib/data";
import { useT } from "@presentation/i18n/translations";
import { useLanguage, languageStore } from "@presentation/i18n/language";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const t = useT();
  const language = useLanguage();
  const [, dashboardParams] = useRoute("/");
  const [, portfolioParams] = useRoute("/portfolios/:id/:rest?");
  const [location] = useLocation();
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  const NAV_ITEMS = [
    { key: "holdings", label: t("sidebar.holdings"), icon: Briefcase, suffix: "" },
    { key: "trades", label: t("sidebar.trades"), icon: ArrowLeftRight, suffix: "/trades" },
    { key: "timeline", label: t("sidebar.timeline"), icon: Clock, suffix: "/timeline" },
    { key: "journal", label: t("sidebar.journal"), icon: BookOpen, suffix: "/journal" },
    { key: "analytics", label: t("sidebar.analytics"), icon: BarChart3, suffix: "/analytics" },
  ] as const;

  const activePortfolioId = portfolioParams?.id;
  const activePortfolio = useMemo(
    () => portfolios?.find((p) => p.id === activePortfolioId),
    [portfolios, activePortfolioId],
  );
  // Archived portfolios are hidden from the switcher — a user navigating
  // day-to-day shouldn't see them cluttering the list — but the active one
  // still resolves above so viewing an archived portfolio directly still
  // shows its real name in the header instead of falling back to "Portfolio".
  const switcherPortfolios = useMemo(() => portfolios?.filter((p) => !p.archivedAt || p.id === activePortfolioId), [portfolios, activePortfolioId]);

  return (
    <aside
      className={`fixed inset-y-0 start-0 z-50 flex h-screen w-64 shrink-0 flex-col border-e border-slate-800/80 bg-slate-950 text-slate-300 transition-transform duration-200 lg:static lg:translate-x-0 ${
        open ? "translate-x-0" : "max-lg:-translate-x-full max-lg:rtl:translate-x-full"
      }`}
    >
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-5 py-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-400 font-bold">
          P
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-50 leading-none">{t("app.brand")}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">{t("sidebar.tagline")}</p>
        </div>
        <button
          onClick={() => languageStore.set(language === "en" ? "ar" : "en")}
          title={t("sidebar.languageToggle")}
          className="flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-xs font-medium text-slate-300 hover:bg-slate-900 hover:text-slate-50"
        >
          <Languages size={13} />
          {t("sidebar.languageToggle")}
        </button>
      </div>

      <nav className="px-3 py-3">
        <Link
          href="/import"
          onClick={onNavigate}
          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            location.startsWith("/import") ? "bg-cyan-500/10 text-cyan-400" : "text-slate-300 hover:bg-slate-900 hover:text-slate-50"
          }`}
        >
          <UploadCloud size={16} />
          {t("sidebar.import")}
        </Link>
        <Link
          href="/"
          onClick={onNavigate}
          className={`mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            dashboardParams ? "bg-cyan-500/10 text-cyan-400" : "text-slate-300 hover:bg-slate-900 hover:text-slate-50"
          }`}
        >
          <LayoutDashboard size={16} />
          {t("sidebar.dashboard")}
        </Link>
        <Link
          href="/portfolios"
          onClick={onNavigate}
          className="mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-900 hover:text-slate-50"
        >
          <Briefcase size={16} />
          {t("sidebar.portfolios")}
        </Link>
        <Link
          href="/data"
          onClick={onNavigate}
          className={`mt-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            location.startsWith("/data") ? "bg-cyan-500/10 text-cyan-400" : "text-slate-300 hover:bg-slate-900 hover:text-slate-50"
          }`}
        >
          <Database size={16} />
          {t("sidebar.data")}
        </Link>
      </nav>

      <div className="mt-2 flex-1 overflow-y-auto px-3 pb-4">
        {activePortfolioId ? (
          <div>
            <div className="relative mb-2">
              <button
                onClick={() => setSwitcherOpen((v) => !v)}
                className="flex w-full items-center justify-between rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-start"
              >
                <span className="truncate text-sm font-medium text-slate-100">
                  {activePortfolio?.name ?? t("sidebar.portfolioFallback")}
                </span>
                <ChevronDown size={14} className="shrink-0 text-slate-500" />
              </button>
              {switcherOpen && switcherPortfolios ? (
                <div className="absolute z-10 mt-1 w-full rounded-md border border-slate-800 bg-slate-900 shadow-xl">
                  {switcherPortfolios.map((p) => (
                    <Link
                      key={p.id}
                      href={`/portfolios/${p.id}`}
                      onClick={() => {
                        setSwitcherOpen(false);
                        onNavigate();
                      }}
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
              {t("sidebar.portfolioSectionLabel")}
            </p>
            {NAV_ITEMS.map((item) => {
              const href = `/portfolios/${activePortfolioId}${item.suffix}`;
              const isActive = item.suffix === "" ? location === href : location.startsWith(href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.key}
                  href={href}
                  onClick={onNavigate}
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
            {t("sidebar.noPortfolioSelected")}
          </div>
        )}
      </div>

      <div className="border-t border-slate-800/80 px-5 py-3 text-[11px] text-slate-600">
        {t("sidebar.footer")}
      </div>
    </aside>
  );
}
