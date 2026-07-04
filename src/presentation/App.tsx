import { Route, Switch, Redirect, Router } from "wouter";
import { Sidebar } from "@presentation/components/Sidebar";
import { DashboardPage } from "@presentation/pages/DashboardPage";
import { PortfoliosPage } from "@presentation/pages/PortfoliosPage";
import { PortfolioDetailPage } from "@presentation/pages/PortfolioDetailPage";
import { TradesPage } from "@presentation/pages/TradesPage";
import { TimelinePage } from "@presentation/pages/TimelinePage";
import { JournalPage } from "@presentation/pages/JournalPage";
import { AnalyticsPage } from "@presentation/pages/AnalyticsPage";
import { ImportPage } from "@presentation/pages/ImportPage";

// import.meta.env.BASE_URL mirrors vite.config.ts's `base: "/trade-manager/"`;
// wouter needs it without the trailing slash.
const ROUTER_BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function App() {
  return (
    <Router base={ROUTER_BASE}>
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <main className="flex-1 overflow-y-auto px-6 py-6 lg:px-10 lg:py-8">
          <Switch>
            <Route path="/" component={DashboardPage} />
            <Route path="/portfolios" component={PortfoliosPage} />
            <Route path="/portfolios/:id" component={PortfolioDetailPage} />
            <Route path="/portfolios/:id/trades" component={TradesPage} />
            <Route path="/portfolios/:id/timeline" component={TimelinePage} />
            <Route path="/portfolios/:id/journal" component={JournalPage} />
            <Route path="/portfolios/:id/analytics" component={AnalyticsPage} />
            <Route path="/portfolios/:id/import" component={ImportPage} />
            <Route>
              <Redirect to="/" />
            </Route>
          </Switch>
        </main>
      </div>
    </Router>
  );
}
