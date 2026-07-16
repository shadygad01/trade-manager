import { lazy, Suspense, useEffect, useState } from "react";
import { Route, Switch, Redirect, Router } from "wouter";
import { Menu, ShieldCheck, Bell, Search } from "lucide-react";
import { Sidebar } from "@presentation/components/Sidebar";
import { PageErrorBoundary } from "@presentation/components/PageErrorBoundary";
import { useT } from "@presentation/i18n/translations";
import { useLanguage } from "@presentation/i18n/language";
import { isDeveloperModeEnabled } from "@presentation/lib/developerMode";

const DashboardPage = lazy(() => import("@presentation/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const PortfoliosPage = lazy(() => import("@presentation/pages/PortfoliosPage").then((m) => ({ default: m.PortfoliosPage })));
const PortfolioDetailPage = lazy(() =>
  import("@presentation/pages/PortfolioDetailPage").then((m) => ({ default: m.PortfolioDetailPage })),
);
const TradesPage = lazy(() => import("@presentation/pages/TradesPage").then((m) => ({ default: m.TradesPage })));
const TickerDetailPage = lazy(() =>
  import("@presentation/pages/TickerDetailPage").then((m) => ({ default: m.TickerDetailPage })),
);
const TimelinePage = lazy(() => import("@presentation/pages/TimelinePage").then((m) => ({ default: m.TimelinePage })));
const JournalPage = lazy(() => import("@presentation/pages/JournalPage").then((m) => ({ default: m.JournalPage })));
const AnalyticsPage = lazy(() => import("@presentation/pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
// The heaviest page by far: it's the only one that pulls in the OCR
// subsystem (Tesseract.js/pdfjs-dist via ImportOrchestrator), so keeping it
// lazy — on top of ImportOrchestrator's own dynamic import in data.ts —
// ensures every other page's initial load never pays for it.
const ImportPage = lazy(() => import("@presentation/pages/ImportPage").then((m) => ({ default: m.ImportPage })));
const DataPage = lazy(() => import("@presentation/pages/DataPage").then((m) => ({ default: m.DataPage })));

// import.meta.env.BASE_URL mirrors vite.config.ts's `base: "/trade-manager/"`;
// wouter needs it without the trailing slash.
const ROUTER_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

// docs/DIAGNOSTICS_CENTER_SPEC.md Part 7.1: read once at module load (the
// same "checked once at composition-root time" discipline the recorder
// wiring in presentation/lib/data.ts uses), so the route is genuinely
// absent from the router — and its lazy chunk never fetched — for the
// overwhelming majority of users who never turn Developer Mode on, not just
// hidden behind a redirect that would still ship the code.
const DEVELOPER_MODE_ENABLED = isDeveloperModeEnabled();
const DiagnosticsPage = DEVELOPER_MODE_ENABLED
  ? lazy(() => import("@presentation/pages/DiagnosticsPage").then((m) => ({ default: m.DiagnosticsPage })))
  : null;

// Below `lg`, the sidebar was a fixed-width flex sibling permanently
// squeezing every page's content into a sliver (the reported "mobile layout
// broken" bug) — it now renders as an off-canvas drawer on narrow screens,
// toggled by this hamburger bar, and reverts to the original always-visible
// layout at `lg` and up (untouched desktop behavior).
function AppShell() {
  const t = useT();
  const language = useLanguage();
  const [navOpen, setNavOpen] = useState(false);

  // Arabic reads right-to-left — the document direction has to follow the
  // chosen language so native text flow, form fields, and every directional
  // (ms-/me-/start-/end-/text-start/text-end) Tailwind utility below mirror
  // correctly, not just the translated strings themselves.
  useEffect(() => {
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.documentElement.lang = language;
  }, [language]);

  return (
    <div className="app-shell flex min-h-screen text-slate-100">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      {navOpen ? (
        <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden" onClick={() => setNavOpen(false)} />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="app-mobile-bar sticky top-0 z-30 flex items-center gap-3 border-b border-white/10 px-4 py-3 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label={t("app.openMenu")}
            className="rounded-lg border border-white/10 p-2 text-slate-300 hover:bg-white/5"
          >
            <Menu size={20} />
          </button>
          <p className="flex-1 text-sm font-semibold text-slate-100">{t("app.brand")}</p>
          <ShieldCheck size={17} className="text-teal-400" />
        </div>
        <header className="app-topbar sticky top-0 z-20 hidden h-[4.5rem] items-center justify-between border-b border-white/[.06] px-8 lg:flex">
          <div className="flex items-center gap-3">
            <div className="flex h-9 min-w-72 items-center gap-2 rounded-xl border border-white/[.07] bg-white/[.025] px-3 text-xs text-slate-500"><Search size={14} /> {t("app.brand")}</div>
          </div>
          <div className="flex items-center gap-2">
            <button aria-label="Notifications" className="grid h-9 w-9 place-items-center rounded-xl border border-white/[.07] bg-white/[.025] text-slate-400 hover:bg-white/[.06] hover:text-white"><Bell size={15} /></button>
            <div className="flex items-center gap-2 rounded-xl border border-emerald-400/15 bg-emerald-400/[.06] px-3 py-2 text-xs font-medium text-emerald-300"><ShieldCheck size={14} /> EGX · Secure</div>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8 lg:py-9 xl:px-10">
          <div className="app-content app-page">
          <PageErrorBoundary>
          <Suspense fallback={<div className="app-loading" role="status" aria-label={t("common.loading")} />}>
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/portfolios" component={PortfoliosPage} />
              <Route path="/portfolios/:id" component={PortfolioDetailPage} />
              <Route path="/portfolios/:id/trades" component={TradesPage} />
              <Route path="/portfolios/:id/tickers/:ticker" component={TickerDetailPage} />
              <Route path="/portfolios/:id/timeline" component={TimelinePage} />
              <Route path="/portfolios/:id/journal" component={JournalPage} />
              <Route path="/portfolios/:id/analytics" component={AnalyticsPage} />
              <Route path="/import" component={ImportPage} />
              <Route path="/data" component={DataPage} />
              {DiagnosticsPage ? <Route path="/diagnostics" component={DiagnosticsPage} /> : null}
              <Route>
                <Redirect to="/" />
              </Route>
            </Switch>
          </Suspense>
          </PageErrorBoundary>
          </div>
        </main>
      </div>
    </div>
  );
}

export function App() {
  return (
    <Router base={ROUTER_BASE}>
      <AppShell />
    </Router>
  );
}
