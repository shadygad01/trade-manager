import { useMemo } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "wouter";
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  Legend,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  BarChart,
  Bar,
} from "recharts";
import { TrendingUp, TrendingDown, Wallet, PieChart as PieChartIcon, Layers, CircleDollarSign } from "lucide-react";
import { repos } from "@presentation/lib/data";
import { computePositions, type PositionAggregate } from "@application/services/TradeService";
import { computeAnalytics } from "@application/analytics/AnalyticsEngine";
import { sectorAllocation } from "@application/analytics/calculators/sectorAllocation";
import { UNCLASSIFIED_SECTOR } from "@domain/value-objects/knownSectors";
import { realizedPnlMicros } from "@domain/entities/TradeAllocation";
import type { AnalyticsResult, EquityPoint, PeriodReturn } from "@presentation/lib/types";
import type { Portfolio } from "@domain/entities/Portfolio";
import { StatTile } from "@presentation/components/StatTile";
import { PageHeader } from "@presentation/components/PageHeader";
import { PriceFreshness } from "@presentation/components/PriceFreshness";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatMoney, formatMoneyCompact, formatPercent, signClass } from "@presentation/lib/format";
import { CATEGORICAL, categoricalColor, CHART_AXIS, CHART_GRID, CHART_TEXT_MUTED, CHART_SURFACE, STATUS } from "@presentation/lib/chartColors";

const MAX_COMPARED_PORTFOLIOS = CATEGORICAL.length;

interface PortfolioSummary {
  portfolio: Portfolio;
  positions: PositionAggregate[];
  analytics: AnalyticsResult;
  marketValue: number;
  costBasis: number;
  realizedPnl: number;
  unrealizedPnl: number;
  dividends: number;
}

function mergeEquityCurves(curves: EquityPoint[][]): EquityPoint[] {
  const allDates = Array.from(new Set(curves.flatMap((c) => c.map((p) => p.date)))).sort();
  return allDates.map((date) => {
    const equity = curves.reduce((sum, curve) => {
      let last = 0;
      for (const point of curve) {
        if (point.date <= date) last = point.equity;
        else break;
      }
      return sum + last;
    }, 0);
    return { date, equity };
  });
}

/** Rebases an equity curve to start at 100 so portfolios of very different sizes can share one axis (never a dual-axis chart) as growth %, not raw EGP. */
function indexEquityCurve(curve: EquityPoint[]): { date: string; index: number }[] {
  if (curve.length === 0) return [];
  const base = curve[0].equity;
  if (base === 0) return curve.map((p) => ({ date: p.date, index: 100 }));
  return curve.map((p) => ({ date: p.date, index: (p.equity / base) * 100 }));
}

function mergeIndexedCurves(portfolios: { name: string; curve: EquityPoint[] }[]): Record<string, number | string>[] {
  const indexed = portfolios.map((p) => ({ name: p.name, points: indexEquityCurve(p.curve) }));
  const allDates = Array.from(new Set(indexed.flatMap((p) => p.points.map((pt) => pt.date)))).sort();
  return allDates.map((date) => {
    const row: Record<string, number | string> = { date };
    for (const p of indexed) {
      let last: number | undefined;
      for (const pt of p.points) {
        if (pt.date <= date) last = pt.index;
        else break;
      }
      if (last !== undefined) row[p.name] = last;
    }
    return row;
  });
}

function mergeMonthlyReturns(series: PeriodReturn[][]): { period: string; returnPct: number }[] {
  const byPeriod = new Map<string, number[]>();
  for (const s of series) {
    for (const point of s) {
      const arr = byPeriod.get(point.period) ?? [];
      arr.push(point.returnPct);
      byPeriod.set(point.period, arr);
    }
  }
  return Array.from(byPeriod.entries())
    .map(([period, values]) => ({ period, returnPct: values.reduce((a, b) => a + b, 0) / values.length }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export function DashboardPage() {
  const dashboard = useLiveQuery(async () => {
    const portfolios = await repos.portfolios.getAll();
    const priceMap = await repos.prices.getAllPrices();
    const summaries: PortfolioSummary[] = await Promise.all(
      portfolios.map(async (portfolio) => {
        const [positions, trades, allocations, timelineEvents] = await Promise.all([
          computePositions(repos, portfolio.id, priceMap),
          repos.trades.getByPortfolio(portfolio.id),
          repos.tradeAllocations.getByPortfolio(portfolio.id),
          repos.timeline.getByPortfolio(portfolio.id),
        ]);
        const analytics = computeAnalytics({ trades, allocations, timelineEvents, priceMap, cash: portfolio.cash });
        const tradeMap = new Map(trades.map((t) => [t.id, t]));
        const realizedPnl = allocations.reduce((sum: number, alloc) => {
          const trade = tradeMap.get(alloc.tradeId);
          if (!trade) return sum;
          return sum + realizedPnlMicros(alloc, trade) / 1_000_000;
        }, 0);
        const marketValue = positions.reduce((sum, p) => sum + (p.marketValue ?? p.costBasis), 0);
        const costBasis = positions.reduce((sum, p) => sum + p.costBasis, 0);
        const unrealizedPnl = positions.reduce((sum, p) => sum + (p.unrealizedPnl ?? 0), 0);
        const dividends = timelineEvents.reduce((sum, e) => (e.type === "Dividend" ? sum + (e.amount ?? 0) : sum), 0);
        return { portfolio, positions, analytics, marketValue, costBasis, realizedPnl, unrealizedPnl, dividends };
      }),
    );
    return summaries;
  }, []);

  const totals = useMemo(() => {
    if (!dashboard) return undefined;
    const totalCash = dashboard.reduce((s, d) => s + d.portfolio.cash, 0);
    const totalMarketValue = dashboard.reduce((s, d) => s + d.marketValue, 0);
    const totalCostBasis = dashboard.reduce((s, d) => s + d.costBasis, 0);
    const totalRealizedPnl = dashboard.reduce((s, d) => s + d.realizedPnl, 0);
    const totalUnrealizedPnl = dashboard.reduce((s, d) => s + d.unrealizedPnl, 0);
    const totalDividends = dashboard.reduce((s, d) => s + d.dividends, 0);
    const totalAssets = totalCash + totalMarketValue;
    const totalValueWeightedReturn =
      totalAssets > 0
        ? dashboard.reduce((s, d) => s + d.analytics.portfolioReturn * (d.marketValue + d.portfolio.cash), 0) /
          totalAssets
        : 0;
    const capitalDeployment =
      dashboard.length > 0 ? dashboard.reduce((s, d) => s + d.analytics.capitalDeployment, 0) / dashboard.length : 0;
    const best = dashboard.reduce<PortfolioSummary | undefined>(
      (acc, d) => (!acc || d.analytics.portfolioReturn > acc.analytics.portfolioReturn ? d : acc),
      undefined,
    );
    const worst = dashboard.reduce<PortfolioSummary | undefined>(
      (acc, d) => (!acc || d.analytics.portfolioReturn < acc.analytics.portfolioReturn ? d : acc),
      undefined,
    );
    const equityCurve = mergeEquityCurves(dashboard.map((d) => d.analytics.equityCurve));
    const monthlyReturn = mergeMonthlyReturns(dashboard.map((d) => d.analytics.monthlyReturn));
    const comparedPortfolios = dashboard.slice(0, MAX_COMPARED_PORTFOLIOS);
    const comparisonData = mergeIndexedCurves(
      comparedPortfolios.map((d) => ({ name: d.portfolio.name, curve: d.analytics.equityCurve })),
    );
    const sectorSlices = sectorAllocation(
      dashboard.flatMap((d) =>
        d.positions.map((p) => ({ sector: p.openTrades[0]?.sector, marketValue: p.marketValue, costBasis: p.costBasis })),
      ),
    );
    return {
      totalCash,
      totalMarketValue,
      totalCostBasis,
      totalRealizedPnl,
      totalUnrealizedPnl,
      totalDividends,
      totalAssets,
      totalValueWeightedReturn,
      capitalDeployment,
      best,
      worst,
      equityCurve,
      monthlyReturn,
      comparedPortfolios,
      comparisonData,
      sectorSlices,
    };
  }, [dashboard]);

  if (!dashboard || !totals) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Portfolio-wide overview across every portfolio." />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (dashboard.length === 0) {
    return (
      <div>
        <PageHeader title="Dashboard" description="Portfolio-wide overview across every portfolio." />
        <EmptyState
          title="No portfolios yet"
          description="Create your first portfolio to start tracking trades and performance."
          action={
            <Link href="/portfolios" className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">
              Create a portfolio
            </Link>
          }
        />
      </div>
    );
  }

  const allocationData = dashboard.map((d) => ({
    name: d.portfolio.name,
    value: d.marketValue + d.portfolio.cash,
  }));

  return (
    <div>
      <PageHeader title="Dashboard" description="Portfolio-wide overview across every portfolio." />
      <PriceFreshness />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Total Portfolio Value"
          value={formatMoney(totals.totalAssets)}
          sublabel={`${formatMoney(totals.totalMarketValue)} invested + ${formatMoney(totals.totalCash)} cash`}
          icon={<Wallet size={16} />}
        />
        <StatTile
          label="Total Return"
          value={formatPercent(totals.totalValueWeightedReturn)}
          valueClassName={signClass(totals.totalValueWeightedReturn)}
          sublabel="Value-weighted across portfolios"
          icon={totals.totalValueWeightedReturn >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
        />
        <StatTile
          label="Realized P/L"
          value={formatMoney(totals.totalRealizedPnl)}
          valueClassName={signClass(totals.totalRealizedPnl)}
          sublabel="From closed lots"
        />
        <StatTile
          label="Unrealized P/L"
          value={formatMoney(totals.totalUnrealizedPnl)}
          valueClassName={signClass(totals.totalUnrealizedPnl)}
          sublabel="Mark-to-market on open positions"
        />
        <StatTile
          label="Total Dividends"
          value={formatMoney(totals.totalDividends)}
          sublabel="Cash received across all portfolios"
          icon={<CircleDollarSign size={16} />}
        />
        <StatTile
          label="Cash Allocation"
          value={formatPercent(totals.totalAssets > 0 ? (totals.totalCash / totals.totalAssets) * 100 : 0, 1)}
          sublabel={formatMoney(totals.totalCash)}
          icon={<Layers size={16} />}
        />
        <StatTile
          label="Capital Deployment"
          value={formatPercent(totals.capitalDeployment, 1)}
          sublabel="Average share of capital deployed"
        />
        <StatTile
          label="Best Portfolio"
          value={totals.best ? totals.best.portfolio.name : "—"}
          valueClassName={totals.best ? signClass(totals.best.analytics.portfolioReturn) : undefined}
          sublabel={totals.best ? formatPercent(totals.best.analytics.portfolioReturn) : undefined}
        />
        <StatTile
          label="Worst Portfolio"
          value={totals.worst ? totals.worst.portfolio.name : "—"}
          valueClassName={totals.worst ? signClass(totals.worst.analytics.portfolioReturn) : undefined}
          sublabel={totals.worst ? formatPercent(totals.worst.analytics.portfolioReturn) : undefined}
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Combined Equity Curve</h3>
          {totals.equityCurve.length > 1 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={totals.equityCurve} style={{ background: CHART_SURFACE }}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
                <YAxis
                  tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART_GRID }}
                  tickFormatter={(v: number) => formatMoneyCompact(v)}
                  width={64}
                />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                  labelStyle={{ color: "#c3c2b7" }}
                  formatter={(v: number) => formatMoney(v)}
                />
                <Line type="monotone" dataKey="equity" stroke={CATEGORICAL[0]} strokeWidth={2} dot={false} name="Equity" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="Not enough history yet" description="The equity curve fills in as trades and cash events accumulate." />
          )}
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-200">
            <PieChartIcon size={14} /> Portfolio Allocation
          </h3>
          {allocationData.some((d) => d.value > 0) ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={allocationData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {allocationData.map((entry, i) => (
                    <Cell key={entry.name} fill={CATEGORICAL[i % CATEGORICAL.length]} stroke={CHART_SURFACE} strokeWidth={2} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12, color: "#c3c2b7" }} />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                  formatter={(v: number) => formatMoney(v)}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="No value yet" description="Fund a portfolio and record trades to see allocation." />
          )}
        </div>
      </div>

      {totals.comparedPortfolios.length > 1 ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Portfolio Comparison</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={totals.comparisonData}>
              <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
              <YAxis
                tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: CHART_GRID }}
                tickFormatter={(v: number) => `${v}`}
                width={48}
              />
              <Tooltip
                contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                labelStyle={{ color: "#c3c2b7" }}
                formatter={(v: number) => v.toFixed(1)}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "#c3c2b7" }} />
              {totals.comparedPortfolios.map((d, i) => (
                <Line
                  key={d.portfolio.id}
                  type="monotone"
                  dataKey={d.portfolio.name}
                  stroke={categoricalColor(i)}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
          <p className="mt-2 text-[11px] text-slate-500">
            Each portfolio&apos;s equity indexed to 100 at its first data point, so portfolios of very different sizes
            can be compared as growth rather than raw EGP on one axis.
            {dashboard.length > MAX_COMPARED_PORTFOLIOS ? ` Showing the first ${MAX_COMPARED_PORTFOLIOS} portfolios.` : ""}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Monthly Performance</h3>
          {totals.monthlyReturn.length > 0 ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={totals.monthlyReturn}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="period" tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
                <YAxis
                  tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART_GRID }}
                  tickFormatter={(v: number) => `${v}%`}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                  formatter={(v: number) => formatPercent(v)}
                />
                <Bar dataKey="returnPct" name="Return %" radius={[3, 3, 0, 0]}>
                  {totals.monthlyReturn.map((entry) => (
                    <Cell key={entry.period} fill={entry.returnPct >= 0 ? STATUS.good : STATUS.critical} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="No monthly data yet" description="Monthly returns populate once trades span multiple months." />
          )}
          <p className="mt-2 text-[11px] text-slate-500">
            Simple average of each portfolio&apos;s monthly return (not money-weighted across portfolios).
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Sector Allocation</h3>
          {totals.sectorSlices.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie
                  data={totals.sectorSlices}
                  dataKey="marketValue"
                  nameKey="sector"
                  innerRadius={60}
                  outerRadius={95}
                  paddingAngle={2}
                >
                  {totals.sectorSlices.map((entry, i) => (
                    <Cell
                      key={entry.sector}
                      fill={entry.sector === UNCLASSIFIED_SECTOR ? CHART_AXIS : CATEGORICAL[i % CATEGORICAL.length]}
                      stroke={CHART_SURFACE}
                      strokeWidth={2}
                    />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12, color: "#c3c2b7" }} />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                  formatter={(v: number) => formatMoney(v)}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState
              title="No open positions yet"
              description="Sector allocation fills in once a portfolio holds open positions."
            />
          )}
          {totals.sectorSlices.some((s) => s.sector === UNCLASSIFIED_SECTOR) ? (
            <p className="mt-2 text-[11px] text-slate-500">
              &ldquo;Unclassified&rdquo; covers tickers outside the known-sector map — never guessed at.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
