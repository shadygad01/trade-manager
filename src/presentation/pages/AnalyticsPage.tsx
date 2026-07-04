import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Cell,
} from "recharts";
import { repos } from "@presentation/lib/data";
import { computeAnalytics } from "@application/analytics/AnalyticsEngine";
import { PageHeader } from "@presentation/components/PageHeader";
import { StatTile } from "@presentation/components/StatTile";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatMoney, formatPercent, signClass } from "@presentation/lib/format";
import { CATEGORICAL, CHART_GRID, CHART_SURFACE, CHART_TEXT_MUTED, STATUS } from "@presentation/lib/chartColors";

export function AnalyticsPage() {
  const { id: portfolioId } = useParams<{ id: string }>();

  const analytics = useLiveQuery(async () => {
    const [portfolio, trades, allocations, timelineEvents, priceMap] = await Promise.all([
      repos.portfolios.getById(portfolioId),
      repos.trades.getByPortfolio(portfolioId),
      repos.tradeAllocations.getByPortfolio(portfolioId),
      repos.timeline.getByPortfolio(portfolioId),
      repos.prices.getAllPrices(),
    ]);
    if (!portfolio) return undefined;
    return computeAnalytics({ trades, allocations, timelineEvents, priceMap, cash: portfolio.cash });
  }, [portfolioId]);

  if (analytics === undefined) {
    return (
      <div>
        <PageHeader title="Analytics" description="Performance, risk and behavioral stats for this portfolio." />
        <p className="text-sm text-slate-500">Loading…</p>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div>
        <PageHeader title="Analytics" description="Performance, risk and behavioral stats for this portfolio." />
        <EmptyState title="Portfolio not found" description="It may have been deleted." />
      </div>
    );
  }

  const drawdownSeries = analytics.equityCurve.map((point, i, arr) => {
    const peak = Math.max(...arr.slice(0, i + 1).map((p) => p.equity));
    const drawdownPct = peak > 0 ? ((point.equity - peak) / peak) * 100 : 0;
    return { date: point.date, drawdownPct };
  });

  const latestMonthly = analytics.monthlyReturn.at(-1);
  const latestAnnual = analytics.annualReturn.at(-1);

  return (
    <div>
      <PageHeader title="Analytics" description="Performance, risk and behavioral stats for this portfolio." />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Win Rate" value={formatPercent(analytics.winRate, 1)} />
        <StatTile label="Profit Factor" value={analytics.profitFactor.toFixed(2)} />
        <StatTile label="Avg Winner" value={formatMoney(analytics.avgWinner)} valueClassName="text-emerald-400" />
        <StatTile label="Avg Loser" value={formatMoney(analytics.avgLoser)} valueClassName="text-rose-400" />
        <StatTile label="Avg Holding Time" value={`${analytics.holdingTime.toFixed(1)}d`} />
        <StatTile label="Exposure" value={formatPercent(analytics.exposure, 1)} />
        <StatTile label="Cash Ratio" value={formatPercent(analytics.cashRatio, 1)} />
        <StatTile label="Max Drawdown" value={formatPercent(-analytics.drawdown, 1)} valueClassName="text-rose-400" />
        <StatTile label="Capital Deployment" value={formatPercent(analytics.capitalDeployment, 1)} />
        <StatTile
          label="Monthly Return (latest)"
          value={formatPercent(latestMonthly?.returnPct ?? 0)}
          valueClassName={signClass(latestMonthly?.returnPct ?? 0)}
          sublabel={latestMonthly?.period}
        />
        <StatTile
          label="Annual Return (latest)"
          value={formatPercent(latestAnnual?.returnPct ?? 0)}
          valueClassName={signClass(latestAnnual?.returnPct ?? 0)}
          sublabel={latestAnnual?.period}
        />
        <StatTile
          label="Portfolio Return"
          value={formatPercent(analytics.portfolioReturn)}
          valueClassName={signClass(analytics.portfolioReturn)}
          sublabel="Since inception, net of deposits/withdrawals"
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Equity Curve</h3>
          {analytics.equityCurve.length > 1 ? (
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={analytics.equityCurve}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
                <YAxis tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} width={64} />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
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
          <h3 className="mb-3 text-sm font-semibold text-slate-200">Drawdown</h3>
          {drawdownSeries.length > 1 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={drawdownSeries}>
                <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
                <YAxis
                  tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART_GRID }}
                  tickFormatter={(v: number) => `${v}%`}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                />
                <Area type="monotone" dataKey="drawdownPct" stroke={STATUS.critical} fill={STATUS.critical} fillOpacity={0.18} name="Drawdown %" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState title="Not enough history yet" description="Drawdown is derived from the equity curve." />
          )}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Monthly Return</h3>
        {analytics.monthlyReturn.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={analytics.monthlyReturn}>
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
                {analytics.monthlyReturn.map((entry) => (
                  <Cell key={entry.period} fill={entry.returnPct >= 0 ? STATUS.good : STATUS.critical} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState title="No monthly data yet" description="Monthly returns populate once trades span multiple months." />
        )}
      </div>
    </div>
  );
}
