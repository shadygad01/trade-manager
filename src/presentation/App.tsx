import { lazy, Suspense } from "react";
import { Route, Switch, Redirect, Router } from "wouter";
import { Sidebar } from "@presentation/components/Sidebar";

const DashboardPage = lazy(() => import("@presentation/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })));
const PortfoliosPage = lazy(() => import("@presentation/pages/PortfoliosPage").then((m) => ({ default: m.PortfoliosPage })));
const PortfolioDetailPage = lazy(() =>
  import("@presentation/pages/PortfolioDetailPage").then((m) => ({ default: m.PortfolioDetailPage })),
);
const TradesPage = lazy(() => import("@presentation/pages/TradesPage").then((m) => ({ default: m.TradesPage })));
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

export function App() {
  return (
    <Router base={ROUTER_BASE}>
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
          <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
            <Switch>
              <Route path="/" component={DashboardPage} />
              <Route path="/portfolios" component={PortfoliosPage} />
              <Route path="/portfolios/:id" component={PortfolioDetailPage} />
              <Route path="/portfolios/:id/trades" component={TradesPage} />
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
    </Router>
  );
}
