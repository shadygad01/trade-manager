import { languageStore } from "@presentation/i18n/language";

/**
 * `-u-nu-latn` pins Western digits even under the Arabic locale — an
 * Egyptian trading app's numbers stay in the same digit system a user
 * already reads on their broker statements regardless of UI language; only
 * month names/currency-symbol placement change with `ar-EG`.
 */
const LOCALE = { en: "en-EG", ar: "ar-EG-u-nu-latn" } as const;
const DATE_LOCALE = { en: "en-GB", ar: "ar-EG-u-nu-latn" } as const;

function currentLocale(map: Record<"en" | "ar", string>): string {
  return map[languageStore.get()];
}

const moneyFormatters = new Map<string, Intl.NumberFormat>();
function moneyFormatter(): Intl.NumberFormat {
  const locale = currentLocale(LOCALE);
  let f = moneyFormatters.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EGP",
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    moneyFormatters.set(locale, f);
  }
  return f;
}

const compactMoneyFormatters = new Map<string, Intl.NumberFormat>();
function compactMoneyFormatter(): Intl.NumberFormat {
  const locale = currentLocale(LOCALE);
  let f = compactMoneyFormatters.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EGP",
      currencyDisplay: "narrowSymbol",
      notation: "compact",
      maximumFractionDigits: 1,
    });
    compactMoneyFormatters.set(locale, f);
  }
  return f;
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
function numberFormatter(): Intl.NumberFormat {
  const locale = languageStore.get() === "ar" ? "ar-EG-u-nu-latn" : "en-US";
  let f = numberFormatters.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    numberFormatters.set(locale, f);
  }
  return f;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(): Intl.DateTimeFormat {
  const locale = currentLocale(DATE_LOCALE);
  let f = dateFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric" });
    dateFormatters.set(locale, f);
  }
  return f;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormatter(): Intl.DateTimeFormat {
  const locale = currentLocale(DATE_LOCALE);
  let f = dateTimeFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    dateTimeFormatters.set(locale, f);
  }
  return f;
}

const cairoDateFormatters = new Map<string, Intl.DateTimeFormat>();
function cairoDateFormatter(): Intl.DateTimeFormat {
  const locale = currentLocale(DATE_LOCALE);
  let f = cairoDateFormatters.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", timeZone: "Africa/Cairo" });
    cairoDateFormatters.set(locale, f);
  }
  return f;
}

export function formatMoney(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return moneyFormatter().format(value);
}

export function formatMoneyCompact(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return compactMoneyFormatter().format(value);
}

export function formatShares(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return numberFormatter().format(value);
}

export function formatPercent(value: number | undefined | null, decimals = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

export function formatDate(value: string | undefined | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return dateFormatter().format(d);
}

export function formatDateTime(value: string | undefined | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return dateTimeFormatter().format(d);
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
  return `${cairoDateFormatter().format(d)}, 14:30`;
}

export function signClass(value: number | undefined | null): string {
  if (value === undefined || value === null || Number.isNaN(value) || value === 0) return "text-slate-400";
  return value > 0 ? "text-emerald-400" : "text-rose-400";
}
