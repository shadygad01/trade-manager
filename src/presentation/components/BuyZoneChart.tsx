import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } from "recharts";
import { getTradeStatus, type Trade, type TradeStatus } from "@domain/entities/Trade";
import { STATUS, CATEGORICAL, CHART_GRID, CHART_TEXT_MUTED, CHART_AXIS, CHART_SURFACE } from "@presentation/lib/chartColors";
import { formatDate, formatMoney, formatShares } from "@presentation/lib/format";

// STATUS.good is the only status color that passes the dataviz skill's
// validator on this dark surface (STATUS.warning fails the lightness-band
// check standalone — see scripts/validate_palette.js) — so "partial" is
// encoded as the same validated hue at reduced opacity (a sanctioned
// secondary encoding) rather than introducing an unvalidated color, and
// "closed" reuses the existing neutral CHART_AXIS token instead of a new hue.
const STATUS_COLOR: Record<TradeStatus, string> = {
  open: STATUS.good,
  partial: STATUS.good,
  closed: CHART_AXIS,
};

const STATUS_OPACITY: Record<TradeStatus, number> = {
  open: 1,
  partial: 0.5,
  closed: 1,
};

const STATUS_LABEL: Record<TradeStatus, string> = {
  open: "Open",
  partial: "Partial",
  closed: "Closed",
};

interface BuyZoneChartProps {
  /** All trades for one ticker, any status — this doubles as the "Sell Map": each lot's status is shown by color and counted in the legend. */
  trades: Trade[];
  currentPrice?: number;
}

/**
 * Buy Zone visualization: one bar per Buy lot at its entry price, so an
 * investor sees exactly where capital entered the market relative to today's
 * price — Average Cost alone hides this. Bar color doubles as the Sell Map
 * (open/partial/closed), since a lot's status is exactly the fact a "sell
 * map" needs to convey.
 */
export function BuyZoneChart({ trades, currentPrice }: BuyZoneChartProps) {
  const sorted = [...trades].sort((a, b) => a.executionDate.localeCompare(b.executionDate));
  const data = sorted.map((t) => ({
    label: formatDate(t.executionDate),
    price: t.entryPrice,
    shares: t.shares,
    remainingShares: t.remainingShares,
    status: getTradeStatus(t),
  }));

  const counts: Record<TradeStatus, number> = { open: 0, partial: 0, closed: 0 };
  for (const t of sorted) counts[getTradeStatus(t)] += 1;

  if (data.length === 0) {
    return <p className="text-sm text-slate-500">No trades recorded for this ticker yet.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 text-xs text-slate-400">
        {(Object.keys(STATUS_LABEL) as TradeStatus[]).map((status) => (
          <span key={status} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: STATUS_COLOR[status], opacity: STATUS_OPACITY[status] }}
            />
            {STATUS_LABEL[status]} ({counts[status]})
          </span>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(140, data.length * 34)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
          <CartesianGrid stroke={CHART_GRID} strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
            tickFormatter={(v: number) => formatMoney(v)}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={{ fill: CHART_TEXT_MUTED, fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: CHART_GRID }}
            width={72}
          />
          <Tooltip
            contentStyle={{ background: CHART_SURFACE, border: "1px solid #293548", borderRadius: 8 }}
            labelStyle={{ color: "#c3c2b7" }}
            formatter={(value: number, _name, entry) => [
              formatMoney(value),
              `Entry price · ${formatShares(entry.payload.remainingShares)}/${formatShares(entry.payload.shares)} shares remaining`,
            ]}
          />
          {currentPrice !== undefined ? (
            <ReferenceLine
              x={currentPrice}
              stroke={CATEGORICAL[0]}
              strokeDasharray="4 4"
              label={{ value: `Current ${formatMoney(currentPrice)}`, position: "insideTopRight", fill: CHART_TEXT_MUTED, fontSize: 11 }}
            />
          ) : null}
          <Bar dataKey="price" radius={[0, 3, 3, 0]}>
            {data.map((d, i) => (
              <Cell key={i} fill={STATUS_COLOR[d.status]} fillOpacity={STATUS_OPACITY[d.status]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
