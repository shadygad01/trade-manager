const moneyFormatter = new Intl.NumberFormat("en-EG", {
  style: "currency",
  currency: "EGP",
  currencyDisplay: "narrowSymbol",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactMoneyFormatter = new Intl.NumberFormat("en-EG", {
  style: "currency",
  currency: "EGP",
  currencyDisplay: "narrowSymbol",
  notation: "compact",
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const cairoDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "Africa/Cairo",
});

export function formatMoney(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return moneyFormatter.format(value);
}

export function formatMoneyCompact(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return compactMoneyFormatter.format(value);
}

export function formatShares(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return numberFormatter.format(value);
}

export function formatPercent(value: number | undefined | null, decimals = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

export function formatDate(value: string | undefined | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return dateFormatter.format(d);
}

export function formatDateTime(value: string | undefined | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return dateTimeFormatter.format(d);
}

/**
 * The upstream quote timestamp (TradingView's `time` field) marks the
 * session, not the actual last-trade time — it's identical across every
 * ticker in a snapshot. EGX's regular session always ends at 14:30 Cairo
 * time, so that's what's shown rather than the raw (and misleading) hour.
 */
export function formatMarketCloseDateTime(value: string | undefined | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${cairoDateFormatter.format(d)}, 14:30`;
}

export function signClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return "text-slate-400";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}
