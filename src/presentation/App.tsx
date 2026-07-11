import { lazy, Suspense, useEffect, useState } from "react";
import { Route, Switch, Redirect, Router } from "wouter";
import { Menu } from "lucide-react";
import { Sidebar } from "@presentation/components/Sidebar";
import { useT } from "@presentation/i18n/translations";
import { useLanguage } from "@presentation/i18n/language";

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
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar open={navOpen} onNavigate={() => setNavOpen(false)} />
      {navOpen ? (
        <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={() => setNavOpen(false)} />
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-slate-800/80 bg-slate-950 px-4 py-3 lg:hidden">
          <button
            onClick={() => setNavOpen(true)}
            aria-label={t("app.openMenu")}
            className="rounded-md p-1.5 text-slate-300 hover:bg-slate-900"
          >
            <Menu size={20} />
          </button>
          <p className="text-sm font-semibold text-slate-100">{t("app.brand")}</p>
        </div>
        <main className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8">
          <Suspense fallback={<p className="text-sm text-slate-500">{t("common.loading")}</p>}>
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
              <Route>
                <Redirect to="/" />
              </Route>
            </Switch>
          </Suspense>
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
