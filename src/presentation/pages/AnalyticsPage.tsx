import { useLiveQuery } from "dexie-react-hooks";
import { useParams } from "wouter";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { repos } from "@presentation/lib/data";
import { computeAnalytics } from "@application/analytics/AnalyticsEngine";
import { PageHeader } from "@presentation/components/PageHeader";
import { PriceFreshness } from "@presentation/components/PriceFreshness";
import { StatTile } from "@presentation/components/StatTile";
import { EmptyState } from "@presentation/components/EmptyState";
import { formatMoney, formatPercent, signClass } from "@presentation/lib/format";
import { CATEGORICAL, CHART_GRID, CHART_SURFACE, CHART_TEXT_MUTED } from "@presentation/lib/chartColors";

export function AnalyticsPage() {
  const { id: portfolioId } = useParams<{ id: string }>();

  const analytics = useLiveQuery(async () => {
    const [portfolio, trades, allocations, timelineEvents, priceMap, journalEntries] = await Promise.all([
      repos.portfolios.getById(portfolioId),
      repos.trades.getByPortfolio(portfolioId),
      repos.tradeAllocations.getByPortfolio(portfolioId),
      repos.timeline.getByPortfolio(portfolioId),
      repos.prices.getAllPrices(),
      repos.journal.getByPortfolio(portfolioId),
    ]);
    if (!portfolio) return undefined;
    const tickers = Array.from(new Set(trades.map((t) => t.ticker)));
    const priceHistory = Object.fromEntries(
      await Promise.all(tickers.map(async (ticker) => [ticker, await repos.prices.getPriceHistory(ticker)] as const))
    );
    return computeAnalytics({ trades, allocations, timelineEvents, priceMap, cash: portfolio.cash, journalEntries, priceHistory });
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

  const latestMonthly = analytics.monthlyPerformance.at(-1);
  const latestAnnual = analytics.annualPerformance.at(-1);
  const hasClosedTrades = analytics.closedTradeCount > 0;
  const hasOpenPositions = analytics.openPositionStats.positionCount > 0;
  const unrealizedSublabel = "Unrealized — positions not closed";
  const noTradesSublabel = "No trades yet";
  const tradeStatsSublabel = hasClosedTrades ? undefined : hasOpenPositions ? unrealizedSublabel : noTradesSublabel;

  return (
    <div>
      <PageHeader title="Analytics" description="Performance, risk and behavioral stats for this portfolio." />
      <PriceFreshness />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Win Rate"
          value={formatPercent(hasClosedTrades ? analytics.winRate : analytics.openPositionStats.winRate, 1)}
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label="Profit Factor"
          value={(hasClosedTrades ? analytics.profitFactor : analytics.openPositionStats.profitFactor).toFixed(2)}
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label="Avg Winner"
          value={formatMoney(hasClosedTrades ? analytics.avgWinner : analytics.openPositionStats.avgWinner)}
          valueClassName="text-emerald-400"
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label="Avg Loser"
          value={formatMoney(hasClosedTrades ? analytics.avgLoser : analytics.openPositionStats.avgLoser)}
          valueClassName="text-rose-400"
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label="Avg Holding Time"
          value={`${(hasClosedTrades ? analytics.holdingTime : analytics.openPositionStats.avgHoldingDays).toFixed(1)}d`}
          sublabel={tradeStatsSublabel}
        />
        <StatTile label="Exposure" value={formatPercent(analytics.exposure, 1)} />
        <StatTile label="Cash Ratio" value={formatPercent(analytics.cashRatio, 1)} />
        <StatTile label="Max Drawdown" value={formatPercent(-analytics.drawdown, 1)} valueClassName="text-rose-400" />
        <StatTile label="Capital Deployment" value={formatPercent(analytics.capitalDeployment, 1)} />
        <StatTile
          label="Realized Return"
          value={formatPercent(analytics.realizedReturnPct)}
          valueClassName={signClass(analytics.realizedReturnPct)}
          sublabel="Cumulative, % of cost basis invested"
        />
        <StatTile
          label="Unrealized Return"
          value={formatPercent(analytics.unrealizedReturnPct)}
          valueClassName={signClass(analytics.unrealizedReturnPct)}
          sublabel="Open positions, today's price only"
        />
        <StatTile
          label="Dividend Return"
          value={formatPercent(analytics.dividendReturnPct)}
          valueClassName={signClass(analytics.dividendReturnPct)}
          sublabel="Cumulative, % of cost basis invested"
        />
        <StatTile
          label="Monthly Return (latest)"
          value={formatPercent((latestMonthly?.realizedReturnPct ?? 0) + (latestMonthly?.dividendReturnPct ?? 0))}
          valueClassName={signClass((latestMonthly?.realizedReturnPct ?? 0) + (latestMonthly?.dividendReturnPct ?? 0))}
          sublabel={latestMonthly?.period}
        />
        <StatTile
          label="Annual Return (latest)"
          value={formatPercent((latestAnnual?.realizedReturnPct ?? 0) + (latestAnnual?.dividendReturnPct ?? 0))}
          valueClassName={signClass((latestAnnual?.realizedReturnPct ?? 0) + (latestAnnual?.dividendReturnPct ?? 0))}
          sublabel={latestAnnual?.period}
        />
        <StatTile
          label="Portfolio Return"
          value={formatPercent(analytics.portfolioReturn)}
          valueClassName={signClass(analytics.portfolioReturn)}
          sublabel="Since inception: realized + dividend, % of cost basis invested"
        />
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Realized + Dividend Return</h3>
        {analytics.performanceCurve.length > 1 ? (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={analytics.performanceCurve}>
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
                formatter={(v: number) => formatPercent(v)}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: "#c3c2b7" }} />
              <Line type="monotone" dataKey="realizedReturnPct" stroke={CATEGORICAL[0]} strokeWidth={2} dot={false} name="Realized %" />
              <Line type="monotone" dataKey="dividendReturnPct" stroke={CATEGORICAL[1]} strokeWidth={2} dot={false} name="Dividend %" />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState title="Not enough history yet" description="This fills in as sells close and dividends are recorded." />
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Both lines are % of cost basis invested (money actually spent buying, never a deposit or withdrawal) — never
          raw cash. Unrealized P/L on still-open positions isn&apos;t part of this cumulative curve; see the
          Unrealized Return stat above for today&apos;s snapshot, or the Monthly Return chart below for its
          month-by-month history.
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Portfolio Health</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Health Score"
            value={analytics.portfolioHealth.healthScore.toFixed(0)}
            sublabel="0-100, higher is better"
          />
          <StatTile
            label="Diversification"
            value={formatPercent(analytics.portfolioHealth.diversificationScore, 0)}
            sublabel={
              analytics.portfolioHealth.largestPositionTicker
                ? `Largest: ${analytics.portfolioHealth.largestPositionTicker} (${formatPercent(analytics.portfolioHealth.largestPositionPct, 0)})`
                : "No open positions"
            }
          />
          <StatTile label="Open Trades" value={String(analytics.portfolioHealth.openTradeCount)} />
          <StatTile
            label="Largest Winner / Loser"
            value={formatMoney(
              hasClosedTrades ? analytics.portfolioHealth.largestWinner : analytics.openPositionStats.largestWinner
            )}
            valueClassName="text-emerald-400"
            sublabel={
              hasClosedTrades
                ? formatMoney(analytics.portfolioHealth.largestLoser)
                : hasOpenPositions
                  ? `${formatMoney(analytics.openPositionStats.largestLoser)} · ${unrealizedSublabel}`
                  : noTradesSublabel
            }
          />
        </div>
      </div>

      {analytics.strategyAttribution.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="border-b border-slate-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-200">Strategy Attribution</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">Strategy</th>
                  <th className="px-4 py-2 text-right">Trades</th>
                  <th className="px-4 py-2 text-right">Win Rate</th>
                  <th className="px-4 py-2 text-right">Profit Factor</th>
                  <th className="px-4 py-2 text-right">Total Realized P/L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {analytics.strategyAttribution.map((s) => (
                  <tr key={s.tag}>
                    <td className="px-4 py-2.5 font-medium text-slate-100">{s.tag}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">{s.tradeCount}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      {s.closedAllocationCount > 0 ? formatPercent(s.winRate, 0) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-300">
                      {s.closedAllocationCount === 0 ? "—" : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"}
                    </td>
                    <td className={`px-4 py-2.5 text-right tabular-nums ${signClass(s.totalRealizedPnl)}`}>
                      {formatMoney(s.totalRealizedPnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">Monthly Return</h3>
        {analytics.monthlyPerformance.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={analytics.monthlyPerformance}>
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
              <Legend wrapperStyle={{ fontSize: 12, color: "#c3c2b7" }} />
              <Bar dataKey="realizedReturnPct" name="Realized %" stackId="month" fill={CATEGORICAL[0]} radius={[3, 3, 0, 0]} />
              <Bar dataKey="dividendReturnPct" name="Dividend %" stackId="month" fill={CATEGORICAL[1]} radius={[3, 3, 0, 0]} />
              <Bar dataKey="unrealizedReturnPct" name="Unrealized %" stackId="month" fill={CATEGORICAL[2]} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <EmptyState title="No monthly data yet" description="Populates from the portfolio's first trade onward." />
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          Every calendar month is shown, including months with no closed trade — an open position still moves the
          Unrealized bar using that month's own historical closing price, never today's price blended in.
        </p>
      </div>
    </div>
  );
}
