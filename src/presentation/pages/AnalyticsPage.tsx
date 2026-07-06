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
import { formatPercent, signClass } from "@presentation/lib/format";
import { CATEGORICAL, CHART_GRID, CHART_SURFACE, CHART_TEXT_MUTED } from "@presentation/lib/chartColors";
import { useT } from "@presentation/i18n/translations";

export function AnalyticsPage() {
  const t = useT();
  const { id: portfolioId } = useParams<{ id: string }>();
  const portfolio = useLiveQuery(() => repos.portfolios.getById(portfolioId), [portfolioId]);
  const pageTitle = portfolio ? t("analytics.titleWithPortfolio", { name: portfolio.name }) : t("analytics.title");

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
        <PageHeader title={pageTitle} description={t("analytics.description")} />
        <p className="text-sm text-slate-500">{t("common.loading")}</p>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div>
        <PageHeader title={pageTitle} description={t("analytics.description")} />
        <EmptyState title={t("portfolioDetail.notFoundTitle")} description={t("portfolioDetail.notFoundDescription")} />
      </div>
    );
  }

  const latestMonthly = analytics.monthlyPerformance.at(-1);
  const latestAnnual = analytics.annualPerformance.at(-1);
  const hasClosedTrades = analytics.closedTradeCount > 0;
  const hasOpenPositions = analytics.openPositionStats.positionCount > 0;
  const unrealizedSublabel = t("analytics.unrealizedSublabel");
  const noTradesSublabel = t("analytics.noTradesSublabel");
  const tradeStatsSublabel = hasClosedTrades ? undefined : hasOpenPositions ? unrealizedSublabel : noTradesSublabel;

  return (
    <div>
      <PageHeader title={pageTitle} description={t("analytics.description")} />
      <PriceFreshness />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={t("analytics.winRate")}
          value={formatPercent(hasClosedTrades ? analytics.winRate : analytics.openPositionStats.winRate, 1)}
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label={t("analytics.profitFactor")}
          value={(hasClosedTrades ? analytics.profitFactor : analytics.openPositionStats.profitFactor).toFixed(2)}
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label={t("analytics.avgWinner")}
          value={formatPercent(hasClosedTrades ? analytics.avgWinner : analytics.openPositionStats.avgWinner, 1)}
          valueClassName="text-emerald-400"
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label={t("analytics.avgLoser")}
          value={formatPercent(hasClosedTrades ? analytics.avgLoser : analytics.openPositionStats.avgLoser, 1)}
          valueClassName="text-rose-400"
          sublabel={tradeStatsSublabel}
        />
        <StatTile
          label={t("analytics.avgHoldingTime")}
          value={`${(hasClosedTrades ? analytics.holdingTime : analytics.openPositionStats.avgHoldingDays).toFixed(1)}d`}
          sublabel={tradeStatsSublabel}
        />
        <StatTile label={t("analytics.exposure")} value={formatPercent(analytics.exposure, 1)} />
        <StatTile label={t("analytics.cashRatio")} value={formatPercent(analytics.cashRatio, 1)} />
        <StatTile label={t("analytics.maxDrawdown")} value={formatPercent(-analytics.drawdown, 1)} valueClassName="text-rose-400" />
        <StatTile label={t("analytics.capitalDeployment")} value={formatPercent(analytics.capitalDeployment, 1)} />
        <StatTile
          label={t("analytics.realizedReturn")}
          value={formatPercent(analytics.realizedReturnPct)}
          valueClassName={signClass(analytics.realizedReturnPct)}
          sublabel={t("analytics.cumulativeSub")}
        />
        <StatTile
          label={t("analytics.unrealizedReturn")}
          value={formatPercent(analytics.unrealizedReturnPct)}
          valueClassName={signClass(analytics.unrealizedReturnPct)}
          sublabel={t("analytics.unrealizedReturnSub")}
        />
        <StatTile
          label={t("analytics.dividendReturn")}
          value={formatPercent(analytics.dividendReturnPct)}
          valueClassName={signClass(analytics.dividendReturnPct)}
          sublabel={t("analytics.cumulativeSub")}
        />
        <StatTile
          label={t("analytics.monthlyReturnLatest")}
          value={formatPercent((latestMonthly?.realizedReturnPct ?? 0) + (latestMonthly?.dividendReturnPct ?? 0))}
          valueClassName={signClass((latestMonthly?.realizedReturnPct ?? 0) + (latestMonthly?.dividendReturnPct ?? 0))}
          sublabel={latestMonthly?.period}
        />
        <StatTile
          label={t("analytics.annualReturnLatest")}
          value={formatPercent((latestAnnual?.realizedReturnPct ?? 0) + (latestAnnual?.dividendReturnPct ?? 0))}
          valueClassName={signClass((latestAnnual?.realizedReturnPct ?? 0) + (latestAnnual?.dividendReturnPct ?? 0))}
          sublabel={latestAnnual?.period}
        />
        <StatTile
          label={t("analytics.portfolioReturn")}
          value={formatPercent(analytics.portfolioReturn)}
          valueClassName={signClass(analytics.portfolioReturn)}
          sublabel={t("analytics.portfolioReturnSub")}
        />
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("analytics.performanceChartTitle")}</h3>
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
          <EmptyState title={t("analytics.notEnoughHistoryTitle")} description={t("analytics.notEnoughHistoryDescription")} />
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          {t("analytics.performanceChartCaption")}
        </p>
      </div>

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("analytics.portfolioHealth")}</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile
            label={t("analytics.healthScore")}
            value={analytics.portfolioHealth.healthScore.toFixed(0)}
            sublabel={t("analytics.healthScoreSub")}
          />
          <StatTile
            label={t("analytics.diversification")}
            value={formatPercent(analytics.portfolioHealth.diversificationScore, 0)}
            sublabel={
              analytics.portfolioHealth.largestPositionTicker
                ? t("analytics.largestPositionSub", { ticker: analytics.portfolioHealth.largestPositionTicker, pct: formatPercent(analytics.portfolioHealth.largestPositionPct, 0) })
                : t("analytics.noOpenPositions")
            }
          />
          <StatTile label={t("analytics.openTrades")} value={String(analytics.portfolioHealth.openTradeCount)} />
          <StatTile
            label={t("analytics.largestWinnerLoser")}
            value={formatPercent(
              hasClosedTrades ? analytics.portfolioHealth.largestWinner : analytics.openPositionStats.largestWinner,
              1
            )}
            valueClassName="text-emerald-400"
            sublabel={
              hasClosedTrades
                ? formatPercent(analytics.portfolioHealth.largestLoser, 1)
                : hasOpenPositions
                  ? `${formatPercent(analytics.openPositionStats.largestLoser, 1)} · ${unrealizedSublabel}`
                  : noTradesSublabel
            }
          />
        </div>
      </div>

      {analytics.strategyAttribution.length > 0 ? (
        <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="border-b border-slate-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-200">{t("analytics.strategyAttribution")}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-start text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2">{t("analytics.colStrategy")}</th>
                  <th className="px-4 py-2 text-end">{t("analytics.colTrades")}</th>
                  <th className="px-4 py-2 text-end">{t("analytics.colWinRate")}</th>
                  <th className="px-4 py-2 text-end">{t("analytics.colProfitFactor")}</th>
                  <th className="px-4 py-2 text-end">{t("analytics.colTotalRealizedReturn")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {analytics.strategyAttribution.map((s) => (
                  <tr key={s.tag}>
                    <td className="px-4 py-2.5 font-medium text-slate-100">{s.tag}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">{s.tradeCount}</td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">
                      {s.closedAllocationCount > 0 ? formatPercent(s.winRate, 0) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-end tabular-nums text-slate-300">
                      {s.closedAllocationCount === 0 ? "—" : Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "∞"}
                    </td>
                    <td className={`px-4 py-2.5 text-end tabular-nums ${signClass(s.totalRealizedReturnPct)}`}>
                      {s.closedAllocationCount === 0 ? "—" : formatPercent(s.totalRealizedReturnPct, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-200">{t("analytics.monthlyReturn")}</h3>
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
          <EmptyState title={t("analytics.noMonthlyDataTitle")} description={t("analytics.noMonthlyDataDescription")} />
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          {t("analytics.monthlyReturnCaption")}
        </p>
      </div>
    </div>
  );
}
