import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_EGX_TICKERS } from "@domain/value-objects/knownTickers";

const YAHOO_CHART_URL = (ticker: string) =>
  `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.CA`;
const TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/egypt/scan";

const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/price-snapshot.json"
);
const HISTORY_OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../public/price-history.json"
);

/** How far back to backfill the very first time a ticker has no history yet. */
const BACKFILL_RANGE = "2y";

interface Quote {
  price: number;
  /** Market time of the quote (Yahoo's regularMarketTime) — after the EGX session this IS the official close time; during the session it's the live tick time. Absent when the provider doesn't report one. */
  quotedAt?: string;
  source: "yahoo" | "tradingview";
}

async function fetchFromYahoo(ticker: string): Promise<Quote> {
  const response = await fetch(YAHOO_CHART_URL(ticker), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    throw new Error(`Yahoo responded ${response.status} for ${ticker}`);
  }
  const data = await response.json();
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== "number") {
    throw new Error(`Yahoo returned no regularMarketPrice for ${ticker}`);
  }
  const marketTime = meta?.regularMarketTime;
  return {
    price,
    quotedAt: typeof marketTime === "number" ? new Date(marketTime * 1000).toISOString() : undefined,
    source: "yahoo",
  };
}

/** UTC calendar day of an ISO timestamp, used as the key for one day's closing price. */
export function historyDateKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Yahoo's chart endpoint returns parallel arrays (one epoch-seconds timestamp
 * per trading day, one close per day, same index) rather than a day->close
 * map — a null close (Yahoo does emit gaps) is dropped rather than recorded
 * as zero.
 */
export function parseYahooHistory(data: unknown): Record<string, number> {
  const result = data as {
    chart?: { result?: [{ timestamp?: number[]; indicators?: { quote?: [{ close?: (number | null)[] }] } }] };
  };
  const chartResult = result?.chart?.result?.[0];
  const timestamps = chartResult?.timestamp ?? [];
  const closes = chartResult?.indicators?.quote?.[0]?.close ?? [];
  const history: Record<string, number> = {};
  timestamps.forEach((epochSeconds, index) => {
    const close = closes[index];
    if (typeof close === "number") {
      history[historyDateKey(new Date(epochSeconds * 1000).toISOString())] = close;
    }
  });
  return history;
}

async function fetchYahooHistory(ticker: string, range: string): Promise<Record<string, number>> {
  const response = await fetch(`${YAHOO_CHART_URL(ticker)}?range=${range}&interval=1d`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    throw new Error(`Yahoo responded ${response.status} for ${ticker} history`);
  }
  return parseYahooHistory(await response.json());
}

async function tradingViewScan(ticker: string, columns: string[]): Promise<(number | null)[]> {
  const response = await fetch(TRADINGVIEW_SCAN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols: { tickers: [`EGX:${ticker}`], query: { types: [] } },
      columns,
    }),
  });
  if (!response.ok) {
    throw new Error(`TradingView responded ${response.status} for ${ticker}`);
  }
  const data = await response.json();
  const row = data?.data?.[0]?.d;
  if (!Array.isArray(row)) {
    throw new Error(`TradingView returned no data row for ${ticker}`);
  }
  return row;
}

async function fetchFromTradingView(ticker: string): Promise<Quote> {
  let close: unknown;
  let time: unknown;
  try {
    [close, time] = await tradingViewScan(ticker, ["close", "time"]);
  } catch {
    [close] = await tradingViewScan(ticker, ["close"]);
  }
  if (typeof close !== "number") {
    throw new Error(`TradingView returned no close for ${ticker}`);
  }
  const epochMs = typeof time === "number" ? (time > 1e12 ? time : time * 1000) : undefined;
  return {
    price: close,
    quotedAt: epochMs !== undefined ? new Date(epochMs).toISOString() : undefined,
    source: "tradingview",
  };
}

/**
 * A provider can fail two ways: an outright error, or "succeeding" with
 * years-old data — Yahoo's EGX coverage did exactly that (every ticker's
 * regularMarketTime frozen in mid-2024 while the request returned 200), so
 * a plain error-only fallback chain happily wrote a whole snapshot of stale
 * prices. A quote only counts as fresh if the provider reports a market
 * time within the EGX's longest normal quiet stretch; TradingView (which
 * actively covers the EGX) is asked first, Yahoo second, and the first
 * FRESH quote wins. If neither is provably fresh, the newest stale quote
 * still gets written rather than nothing — the app's PriceFreshness
 * indicator is what tells the user it's outdated.
 */
const MAX_QUOTE_AGE_DAYS = 7;

function isFresh(quote: Quote): boolean {
  if (!quote.quotedAt) return false;
  return Date.now() - new Date(quote.quotedAt).getTime() <= MAX_QUOTE_AGE_DAYS * 86_400_000;
}

async function fetchPrice(ticker: string): Promise<Quote | undefined> {
  const candidates: Quote[] = [];
  const errors: string[] = [];
  for (const provider of [fetchFromTradingView, fetchFromYahoo]) {
    try {
      const quote = await provider(ticker);
      if (isFresh(quote)) return quote;
      candidates.push(quote);
    } catch (error) {
      errors.push((error as Error).message);
    }
  }
  if (candidates.length > 0) {
    // A quote with no market time is unknown-freshness; one with a stale
    // market time is KNOWN stale — unknown beats known-stale, in provider
    // preference order.
    const unknown = candidates.find((c) => !c.quotedAt);
    const pick = unknown ?? candidates.reduce((a, b) => ((a.quotedAt ?? "") >= (b.quotedAt ?? "") ? a : b));
    console.warn(`[fetch-prices] No provably fresh quote for ${ticker} — using ${pick.source} (${pick.quotedAt ?? "no quote time"})`);
    return pick;
  }
  console.error(`[fetch-prices] Failed to fetch ${ticker} from both providers:`, errors.join(" | "));
  return undefined;
}

async function loadExistingHistory(): Promise<Record<string, Record<string, number>>> {
  try {
    return JSON.parse(await readFile(HISTORY_OUTPUT_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  const prices: Record<string, number> = {};
  const quotes: Record<string, Quote> = {};
  const failed: string[] = [];
  const history = await loadExistingHistory();

  for (const { ticker } of KNOWN_EGX_TICKERS) {
    const quote = await fetchPrice(ticker);
    if (quote === undefined) {
      failed.push(ticker);
    } else {
      prices[ticker] = quote.price;
      quotes[ticker] = quote;
    }

    // Day-by-day history accumulates going forward from each run (no extra
    // API calls — it reuses the quote already fetched above) and gets a
    // one-time backfill the first time a ticker has no recorded history at
    // all, via Yahoo's own range/interval bulk-history endpoint (same
    // provider already used for current prices, not a new source).
    if (!history[ticker] || Object.keys(history[ticker]).length === 0) {
      try {
        history[ticker] = await fetchYahooHistory(ticker, BACKFILL_RANGE);
      } catch (error) {
        console.warn(`[fetch-prices] Could not backfill history for ${ticker}: ${(error as Error).message}`);
        history[ticker] = history[ticker] ?? {};
      }
    }
    if (quote !== undefined) {
      const dateKey = historyDateKey(quote.quotedAt ?? new Date().toISOString());
      history[ticker][dateKey] = quote.price;
    }
  }

  // `prices` is kept alongside the richer `quotes` so an already-deployed
  // bundle (which only reads `prices`) keeps working across a format bump.
  const snapshot = {
    asOf: new Date().toISOString(),
    prices,
    quotes,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
  await writeFile(HISTORY_OUTPUT_PATH, JSON.stringify(history, null, 2) + "\n", "utf-8");

  console.log(
    `[fetch-prices] Wrote ${Object.keys(prices).length}/${KNOWN_EGX_TICKERS.length} prices to ${OUTPUT_PATH}`
  );
  console.log(`[fetch-prices] Updated day-by-day history at ${HISTORY_OUTPUT_PATH}`);
  if (failed.length > 0) {
    console.warn(`[fetch-prices] Failed tickers (both providers): ${failed.join(", ")}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("[fetch-prices] Fatal error:", error);
    process.exitCode = 1;
  });
}
