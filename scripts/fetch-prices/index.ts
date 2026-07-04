import { writeFile, mkdir } from "node:fs/promises";
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

async function fetchFromYahoo(ticker: string): Promise<number | undefined> {
  const response = await fetch(YAHOO_CHART_URL(ticker), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!response.ok) {
    throw new Error(`Yahoo responded ${response.status} for ${ticker}`);
  }
  const data = await response.json();
  const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price !== "number") {
    throw new Error(`Yahoo returned no regularMarketPrice for ${ticker}`);
  }
  return price;
}

async function fetchFromTradingView(ticker: string): Promise<number | undefined> {
  const response = await fetch(TRADINGVIEW_SCAN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols: { tickers: [`EGX:${ticker}`], query: { types: [] } },
      columns: ["close"],
    }),
  });
  if (!response.ok) {
    throw new Error(`TradingView responded ${response.status} for ${ticker}`);
  }
  const data = await response.json();
  const close = data?.data?.[0]?.d?.[0];
  if (typeof close !== "number") {
    throw new Error(`TradingView returned no close for ${ticker}`);
  }
  return close;
}

/**
 * Two-step fallback chain: Yahoo first, TradingView second. A ticker only
 * ends up missing from the snapshot if both public endpoints fail, and one
 * flaky ticker never blocks the rest of the batch.
 */
async function fetchPrice(ticker: string): Promise<number | undefined> {
  try {
    return await fetchFromYahoo(ticker);
  } catch (yahooError) {
    try {
      return await fetchFromTradingView(ticker);
    } catch (tradingViewError) {
      console.error(
        `[fetch-prices] Failed to fetch ${ticker} from both providers:`,
        (yahooError as Error).message,
        "|",
        (tradingViewError as Error).message
      );
      return undefined;
    }
  }
}

async function main(): Promise<void> {
  const prices: Record<string, number> = {};
  const failed: string[] = [];

  for (const { ticker } of KNOWN_EGX_TICKERS) {
    const price = await fetchPrice(ticker);
    if (price === undefined) {
      failed.push(ticker);
    } else {
      prices[ticker] = price;
    }
  }

  const snapshot = {
    asOf: new Date().toISOString(),
    prices,
  };

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

  console.log(
    `[fetch-prices] Wrote ${Object.keys(prices).length}/${KNOWN_EGX_TICKERS.length} prices to ${OUTPUT_PATH}`
  );
  if (failed.length > 0) {
    console.warn(`[fetch-prices] Failed tickers (both providers): ${failed.join(", ")}`);
  }
}

main().catch((error) => {
  console.error("[fetch-prices] Fatal error:", error);
  process.exitCode = 1;
});
