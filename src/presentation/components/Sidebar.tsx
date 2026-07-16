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
import { isDeveloperModeEnabled, toggleDeveloperModeAndReload } from "@presentation/lib/developerMode";

export function Sidebar({ open, onNavigate }: { open: boolean; onNavigate: () => void }) {
  const t = useT();
  const language = useLanguage();
  const [, dashboardParams] = useRoute("/");
  const [, portfolioParams] = useRoute("/portfolios/:id/:rest?");
  const [location] = useLocation();
  const portfolios = useLiveQuery(() => repos.portfolios.getAll(), []);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Read once — same "reload required to take effect" contract as every
  // other consumer of this flag (developerMode.ts's own doc comment), so a
  // live in-render subscription would be misleading: the button/link below
  // can't change state without the reload it itself triggers.
  const developerModeOn = isDeveloperModeEnabled();

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
      className={`fixed inset-y-0 start-0 z-50 flex h-screen w-[17.5rem] shrink-0 flex-col border-e border-white/[.07] bg-[#090e19]/95 text-slate-300 shadow-2xl shadow-black/30 backdrop-blur-xl transition-transform duration-200 lg:sticky lg:top-0 lg:translate-x-0 lg:shadow-none ${
        open ? "translate-x-0" : "max-lg:-translate-x-full max-lg:rtl:translate-x-full"
      }`}
    >
      <div className="flex items-center gap-3 border-b border-white/[.07] px-5 py-5">
        <div className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-teal-300/20 bg-gradient-to-br from-teal-400/20 to-blue-500/10 text-sm font-bold text-teal-300 shadow-[0_0_28px_rgba(45,212,191,.08)]">
          PO
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold tracking-[-.01em] text-slate-50 leading-none">{t("app.brand")}</p>
          <p className="mt-1 text-[10px] uppercase tracking-[.13em] text-slate-500">{t("sidebar.tagline")}</p>
        </div>
        <button
          onClick={() => languageStore.set(language === "en" ? "ar" : "en")}
          title={t("sidebar.languageToggle")}
          className="flex items-center gap-1 rounded-lg border border-white/[.08] bg-white/[.025] px-2 py-1.5 text-xs font-medium text-slate-400 hover:border-white/15 hover:bg-white/[.05] hover:text-slate-50"
        >
          <Languages size={13} />
          {t("sidebar.languageToggle")}
        </button>
      </div>

      <nav className="px-3 py-4">
        <Link
          href="/import"
          onClick={onNavigate}
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
            location.startsWith("/import") ? "border border-teal-400/10 bg-teal-400/10 text-teal-300" : "border border-transparent text-slate-400 hover:bg-white/[.04] hover:text-slate-100"
          }`}
        >
          <UploadCloud size={16} />
          {t("sidebar.import")}
        </Link>
        <Link
          href="/"
          onClick={onNavigate}
          className={`mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
            dashboardParams ? "border border-teal-400/10 bg-teal-400/10 text-teal-300" : "border border-transparent text-slate-400 hover:bg-white/[.04] hover:text-slate-100"
          }`}
        >
          <LayoutDashboard size={16} />
          {t("sidebar.dashboard")}
        </Link>
        <Link
          href="/portfolios"
          onClick={onNavigate}
          className="mt-1 flex items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-slate-400 hover:bg-white/[.04] hover:text-slate-100"
        >
          <Briefcase size={16} />
          {t("sidebar.portfolios")}
        </Link>
        <Link
          href="/data"
          onClick={onNavigate}
          className={`mt-1 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors ${
            location.startsWith("/data") ? "border border-teal-400/10 bg-teal-400/10 text-teal-300" : "border border-transparent text-slate-400 hover:bg-white/[.04] hover:text-slate-100"
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
                className="flex w-full items-center justify-between rounded-xl border border-white/[.08] bg-white/[.035] px-3 py-2.5 text-start hover:border-white/[.14]"
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
                  className={`mt-1 flex items-center gap-3 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    isActive ? "border-teal-400/10 bg-teal-400/10 text-teal-300" : "border-transparent text-slate-400 hover:bg-white/[.04] hover:text-slate-100"
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

      <div className="mx-3 mb-3 rounded-xl border border-white/[.06] bg-white/[.025] px-3 py-3 text-[10px] leading-4 text-slate-500">
        <div className="mb-1 flex items-center gap-2 font-medium text-slate-400"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />Local-first & secure</div>
        {t("sidebar.footer")}
      </div>

      {/* Developer-only utility, deliberately not run through the EN/AR
          translation layer — same precedent as DiagnosticsPage.tsx itself.
          Visible (not hidden) by design: reliability over discoverability,
          the opposite tradeoff of the Ctrl+Alt+Shift+D shortcut this
          complements. Reads the flag once at render (see above) — the
          reload this triggers is what actually changes which branch shows. */}
      {developerModeOn ? (
        <Link
          href="/diagnostics"
          onClick={onNavigate}
          className="border-t border-slate-800/80 px-5 py-2.5 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-900 hover:text-slate-300"
        >
          Diagnostics
        </Link>
      ) : (
        <button
          onClick={toggleDeveloperModeAndReload}
          className="border-t border-slate-800/80 px-5 py-2.5 text-start text-xs font-medium text-slate-500 transition-colors hover:bg-slate-900 hover:text-slate-300"
        >
          Developer
        </button>
      )}
    </aside>
  );
}
