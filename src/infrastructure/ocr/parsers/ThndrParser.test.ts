import { describe, it, expect } from "vitest";
import { ThndrParser, normalizeDigits, parsePrice, fuzzyMatchTicker, normalizeCompanyKey, canonicalNameForTicker } from "./ThndrParser";

describe("normalizeDigits", () => {
  it("maps O/o to 0 and T/I/l to 1", () => {
    expect(normalizeDigits("1O:57PM")).toBe("10:57PM");
    expect(normalizeDigits("Tl")).toBe("11");
    expect(normalizeDigits("74")).toBe("74");
  });
});

describe("parsePrice", () => {
  it("treats the separator before the final 3 digits as the decimal point", () => {
    expect(parsePrice("76.500")).toBe(76.5);
    expect(parsePrice("76,500")).toBe(76.5); // OCR misread comma-for-period
  });

  it("treats an earlier comma as a thousands separator", () => {
    expect(parsePrice("1,976.500")).toBe(1976.5);
  });

  it("falls back to plain parse when the 3-decimal shape doesn't match", () => {
    expect(parsePrice("123")).toBe(123);
  });

  it("still recovers a comma-for-decimal misread when a trailing digit was dropped (fewer than 3 digits after the separator)", () => {
    // A real thousands separator always groups in runs of exactly 3 digits,
    // so 1-2 trailing digits after the last separator can only be a
    // misread decimal point, never a thousands group — same as the 3-digit
    // case above, just with an OCR-dropped digit.
    expect(parsePrice("76,50")).toBe(76.5);
    expect(parsePrice("76,5")).toBe(76.5);
  });
});

describe("normalizeCompanyKey", () => {
  it("uppercases and strips punctuation and common corporate suffixes", () => {
    expect(normalizeCompanyKey("Eastern Co.")).toBe("EASTERN");
    expect(normalizeCompanyKey("Orascom Construction PLC")).toBe("ORASCOM CONSTRUCTION");
  });
});

describe("fuzzyMatchTicker", () => {
  it("tolerates a couple of OCR-garbled letters in an otherwise-known company name", () => {
    // "INTERNATIONAL" -> "INTEMATIONAL" is a real observed OCR garble.
    expect(fuzzyMatchTicker("COMMERCIAL INTEMATIONAL BANK")).toBe("COMI");
    expect(fuzzyMatchTicker("ORLENTAL WEAVERS")).toBe("ORWE");
  });

  it("returns null for something unrelated", () => {
    expect(fuzzyMatchTicker("SOME RANDOM UNRELATED TEXT ENTIRELY")).toBeNull();
  });
});

describe("canonicalNameForTicker", () => {
  it("title-cases the known company name for a ticker", () => {
    expect(canonicalNameForTicker("COMI")).toBe("Commercial International Bank");
  });

  it("falls back to the ticker itself when unknown", () => {
    expect(canonicalNameForTicker("ZZZZ")).toBe("ZZZZ");
  });
});

describe("ThndrParser.parseStatementText", () => {
  const parser = new ThndrParser("2020-01-01");

  it("parses a Buy row and a Sell row, resolving company name to ticker via the known map", () => {
    const text = `
      2/2/2026   Buy Eastern Co. (50@39.3800)   -1,974.47   8,333.15
      19/2/2026  Sell EFG HOLDING (45@27.7000)   1,241.95   7,584.92
    `;
    const candidates = parser.parseStatementText(text);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ ticker: "EAST", side: "BUY", shares: 50, date: "2026-02-02" });
    expect(candidates[1]).toMatchObject({ ticker: "HRHO", side: "SELL", shares: 45, date: "2026-02-19" });
    expect(candidates[0].source).toBe("statement");
  });

  it("derives price from the Value column instead of the printed per-share price (commission adjustment)", () => {
    // 42 * 47.47 = 1993.74, but the actual amount debited was 1999.23.
    const text = "2/2/2026 Buy Arabian Cement (42@47.4700) -1,999.23 8,000.00";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.price).toBeCloseTo(1999.23 / 42, 5);
  });

  it("uses the printed price when no Value column is present", () => {
    const text = "2/2/2026 Buy Eastern Co. (50@39.3800)";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.price).toBeCloseTo(39.38, 5);
  });

  it("tolerates OCR misreading '(' as '{' without swallowing the next row", () => {
    const text = `
      2/2/2026 Buy Eastern Co. {50@39.3800) -1,974.47 8,333.15
      19/2/2026 Sell EFG HOLDING (45@27.7000) 1,241.95 7,584.92
    `;
    const candidates = parser.parseStatementText(text);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].shares).toBe(50);
    expect(candidates[1].shares).toBe(45);
  });

  it("handles a company name containing its own parenthetical", () => {
    const text = "2/2/2026 Buy Commercial International Bank (Egypt) (10@75.000) -750.00";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.ticker).toBe("COMI");
    expect(candidate.shares).toBe(10);
    expect(candidate.confidence).toBe("high");
  });

  it("resolves a company name previously missing from the known-ticker map (Arabian Cement, Orascom Construction, Orascom Development Egypt)", () => {
    const arcc = parser.parseStatementText("2/2/2026 Buy Arabian Cement (42@47.4700) -1,999.23")[0];
    expect(arcc).toMatchObject({ ticker: "ARCC", confidence: "high" });

    const oras = parser.parseStatementText("2/2/2026 Buy Orascom Construction (6@404.0000)")[0];
    expect(oras).toMatchObject({ ticker: "ORAS", confidence: "high" });

    const orhd = parser.parseStatementText("2/2/2026 Buy Orascom Development Egypt (20@23.5800)")[0];
    expect(orhd).toMatchObject({ ticker: "ORHD", confidence: "high" });
  });

  it("strips T+1 / Same Day settlement qualifiers so they never fabricate bogus ticker groups", () => {
    const text = `
      4/1/2023 Sell T+1 Aspire Cpaital Holding (3,300@0.2990 ) 982.96 31,648.505
      4/1/2023 Buy Same Day Housing & Development Bank (350@17.0371 ) -5,968.5 25,680.005
      25/1/2023 Buy Egypt Gas (100@38.6200 ) -3,867.9 33,654.472
      25/1/2023 Sell T+1 Egypt Gas (100@38.9000 ) 3,880.00 37,534.472
    `;
    const candidates = parser.parseStatementText(text);
    expect(candidates).toHaveLength(4);
    for (const c of candidates) {
      expect(c.ticker).not.toMatch(/^T\s*\+?\s*1/i);
      expect(c.ticker).not.toMatch(/same\s*day/i);
    }
    // The prefixed and unprefixed rows of the same company land in ONE group.
    expect(candidates[2].ticker).toBe(candidates[3].ticker);
    const plainHdb = parser.parseStatementText("4/1/2023 Buy Housing & Development Bank (350@17.0371 ) -5,968.5")[0];
    expect(candidates[1].ticker).toBe(plainHdb.ticker);
  });

  it("resolves the same real stock to one ticker regardless of a trailing bracketed symbol OCR'd with a different bracket glyph", () => {
    // Real observed failure: the exact same company split into two Import
    // ticker groups — "Egyptian International Pharmaceuticals (EIPICO)" from
    // one screenshot and "... {EIPICO}" from another (OCR read the bracket
    // differently) — because the un-stripped bracket became part of the
    // fallback "ticker" string itself.
    const withParen = parser.parseStatementText("2/2/2026 Buy Egyptian International Pharmaceuticals (EIPICO) (12@86.7200)")[0];
    const withBrace = parser.parseStatementText("2/2/2026 Buy Egyptian International Pharmaceuticals {EIPICO} (19@78.5600)")[0];
    expect(withParen.ticker).toBe("PHAR");
    expect(withBrace.ticker).toBe("PHAR");
    expect(withParen.confidence).toBe("high");
    expect(withBrace.confidence).toBe("high");
  });

  it("still falls back to a stable low-confidence ticker (with any trailing bracket stripped) for a genuinely unknown company", () => {
    const withParen = parser.parseStatementText("2/2/2026 Buy Some Totally Unknown Company (XYZQ) (10@75.000)")[0];
    const withBrace = parser.parseStatementText("2/2/2026 Buy Some Totally Unknown Company {XYZQ} (10@75.000)")[0];
    expect(withParen.ticker).toBe(withBrace.ticker);
    expect(withParen.confidence).toBe("low");
  });

  it("excludes non-stock instruments like Thndr's money-market product", () => {
    const text = "2/2/2026 Buy thndrsavings (16415@1.21834 EGP) -20000.00";
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });

  it("repairs OCR digit artifacts (O→0, l/I→1) inside the qty@price group only", () => {
    // "5O" = 50, "l7.35O" = 17.350 — misreads confined to numeric groups.
    const text = "2/2/2026 Buy Eastern Co. (5O@39.38OO) -1,974.47";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.shares).toBe(50);
    expect(candidate.ticker).toBe("EAST");
  });

  it("keeps the printed price when the Value column is wildly inconsistent (misread OCR)", () => {
    // 50 @ 39.38 ≈ 1,969 — a Value of 19.74 (lost digits) must not corrupt price.
    const text = "2/2/2026 Buy Eastern Co. (50@39.3800) -19.74";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.price).toBeCloseTo(39.38, 5);
  });

  it("accepts '.' as a statement date separator", () => {
    const text = "5.1.2023 Buy Eastern Co. (50@39.3800)";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.date).toBe("2023-01-05");
  });

  it("matches bilingual Buy/Sell verbs", () => {
    const text = "2/2/2026 شراء Eastern Co. (50@39.3800)";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.side).toBe("BUY");
  });

  it("returns no candidates for non-trade rows (transfers, deposits)", () => {
    const text = "2/2/2026 Cash Deposit 5,000.00 5,000.00";
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });

  it("is 'high' confidence for an exact company-name match", () => {
    const text = "2/2/2026 Buy Eastern Co. (50@39.3800)";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("high");
  });

  it("is 'medium' confidence for a fuzzy (OCR-garbled) company-name match", () => {
    // "INTEMATIONAL" is a one-letter-off OCR garble of a mapped name containing "INTERNATIONAL".
    const text = "2/2/2026 Buy Commercial INTEMATIONAL Bank (10@75.000) -750.00";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("medium");
  });

  it("is 'low' confidence when the company name doesn't resolve to any known ticker", () => {
    const text = "2/2/2026 Buy Some Totally Unknown Company (10@75.000)";
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("low");
  });

  it("drops a row whose description OCR'd down to an implausibly short fragment rather than fabricating a ticker from it", () => {
    // Real observed failure: a garbled/truncated description read as just "TE"
    // (2 characters) produced a bogus "TE" ticker group with no real meaning.
    const text = "2/2/2026 Buy TE (19@25.3000)";
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });
});

describe("ThndrParser.parseStatementText — per-trade Invoice PDF", () => {
  const parser = new ThndrParser("2020-01-01");

  // Real Thndr "Invoice" document text (a per-trade PDF email receipt,
  // fields explicitly labeled rather than inline "Buy X (qty@price)").
  const invoiceText = `
    Thndr Securities Brokerage                                  Invoice
    Shady Gadelrab Masood Ibrahim               Custodian: Thndr Technology Holding
    24/06/2026

    Security Name    Symbol Code       Transaction Type   Average Cost
    EFG HOLDING      EGS69101C011      Buy                27.09 EGP

    Transaction No.        Quantity    Price        Value
    N000248458443          39          26.98 EGP    1,052.22 EGP
                           Total Quantity   Average Price   Total Cost
                           39               26.98 EGP       1,052.22 EGP

    Fees                          Amount
    EGX Services                  0.11 EGP
    MCDR Services                 0.11 EGP
    FRA Services                  1.00 EGP
    Risk Insurance                0.05 EGP
    Brokerage & Custody Fees      1.05 EGP
    Brokerage Order Fees          2.00 EGP
    Total Fees                    4.32 EGP
    Grand Total                   1,056.54 EGP
  `;

  it("parses the invoice's labeled fields into a single high-confidence candidate", () => {
    const [candidate] = parser.parseStatementText(invoiceText);
    expect(candidate).toMatchObject({
      ticker: "HRHO",
      side: "BUY",
      shares: 39,
      price: 26.98,
      fees: 4.32,
      date: "2026-06-24",
      confidence: "high",
      source: "invoice",
      transactionNumber: "N000248458443",
    });
  });

  it("still reads the transaction number when OCR renders extra/collapsed whitespace around the header row", () => {
    const noisy = invoiceText.replace(
      "Transaction No.        Quantity    Price        Value",
      "Transaction No.Quantity Price Value",
    );
    const [candidate] = parser.parseStatementText(noisy);
    expect(candidate.transactionNumber).toBe("N000248458443");
  });

  it("leaves transactionNumber undefined when the Transaction No. row is missing entirely", () => {
    const withoutTxnRow = invoiceText.replace(
      "Transaction No.        Quantity    Price        Value\n    N000248458443          39          26.98 EGP    1,052.22 EGP\n",
      "",
    );
    const [candidate] = parser.parseStatementText(withoutTxnRow);
    expect(candidate).toBeDefined();
    expect(candidate.transactionNumber).toBeUndefined();
  });

  it("recovers a misread (zero) Average Price from Total Cost / Total Quantity", () => {
    // OCR turned "26.98" into "0" — on the invoice, Total Cost is exactly
    // shares × average price (39 × 26.98 = 1,052.22; fees are separate and
    // only appear in Grand Total), so price = 1,052.22 / 39 = 26.98.
    const broken = invoiceText.replace("39               26.98 EGP       1,052.22 EGP", "39               0 EGP       1,052.22 EGP");
    const [candidate] = parser.parseStatementText(broken);
    expect(candidate).toBeDefined();
    expect(candidate.price).toBeCloseTo(26.98, 5);
    expect(candidate.shares).toBe(39);
  });

  it("returns no candidates when the invoice's totals row is missing (rather than guessing)", () => {
    const truncated = invoiceText.split("Total Quantity")[0];
    expect(parser.parseStatementText(truncated)).toHaveLength(0);
  });
});

describe("ThndrParser orders timeline", () => {
  const parser = new ThndrParser("2020-01-01");

  // OCR-shaped text from the real account-wide "Orders" screen: status bar,
  // title, filter tabs, then rows read as "<TICKER> <total>" followed by
  // "<Buy/Sell> <Limit/Market> @<price> <status>".
  const timelineText =
    "12:11 5G Orders All Pending Completed Cancelled " +
    "SUGR 315.00 Buy Limit @45.00 Cancelled " +
    "SKPC 445.50 Buy Limit @14.85 Fulfilled " +
    "SUGR 275.52 Buy Market @45.92 Fulfilled " +
    "ORHD 337.50 Buy Limit @22.50 Fulfilled " +
    "HRHO 361.20 Buy Limit @24.08 Cancelled";

  it("recognizes an account-wide Orders timeline and not the other document shapes", () => {
    expect(parser.looksLikeOrdersTimeline(timelineText)).toBe(true);
    expect(parser.looksLikeOrdersTimeline("2/2/2026 Buy Eastern Co. (50@39.3800) -1,974.47")).toBe(false);
    expect(
      parser.looksLikeOrdersTimeline("ORAS Orascom Construction All orders Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled"),
    ).toBe(false);
  });

  it("parses each row's ticker, side, order type, price and status, deriving whole shares from total/price", () => {
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(timelineText);
    expect(unreadRowCount).toBe(0);
    expect(evidences).toHaveLength(5);
    expect(evidences[0]).toMatchObject({ ticker: "SUGR", side: "BUY", orderType: "limit", shares: 7, price: 45, status: "cancelled" });
    expect(evidences[1]).toMatchObject({ ticker: "SKPC", shares: 30, price: 14.85, status: "fulfilled", confidence: "high" });
    expect(evidences[2]).toMatchObject({ ticker: "SUGR", orderType: "market", shares: 6, totalValue: 275.52, status: "fulfilled" });
    expect(evidences[3]).toMatchObject({ ticker: "ORHD", shares: 15, status: "fulfilled" });
    expect(evidences[4]).toMatchObject({ ticker: "HRHO", shares: 15, status: "cancelled" });
  });

  it("handles the per-stock 'Completed Orders' tab — same rows behind a stats header full of non-total numbers", () => {
    const text =
      "12:09 Stocks Total Value (EGP) 44,462 +5,796.31 (14.99%) Positions Orders News Completed Orders " +
      "ABUK 943.60 Buy Market @67.40 Fulfilled " +
      "HRHO 1,042.86 Sell Market @26.74 Fulfilled " +
      "HRHO 1,052.61 Sell Limit @26.99 Cancelled";
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(text);
    expect(unreadRowCount).toBe(0);
    expect(evidences).toHaveLength(3);
    expect(evidences[0]).toMatchObject({ ticker: "ABUK", side: "BUY", shares: 14, totalValue: 943.6 });
    expect(evidences[1]).toMatchObject({ ticker: "HRHO", side: "SELL", shares: 39, price: 26.74, status: "fulfilled" });
    expect(evidences[2]).toMatchObject({ ticker: "HRHO", side: "SELL", shares: 39, status: "cancelled" });
  });

  it("accepts the total appearing after the action line instead of before it", () => {
    const text = "Orders All Pending Completed Cancelled MASR Sell Market @4.84 348.48 Fulfilled";
    const { evidences } = parser.parseOrdersTimeline(text);
    expect(evidences).toHaveLength(1);
    expect(evidences[0]).toMatchObject({ ticker: "MASR", side: "SELL", shares: 72, totalValue: 348.48 });
  });

  it("drops a row (counting it unread) when no candidate total lands on a whole share count", () => {
    const text =
      "Orders All Pending Completed Cancelled " +
      "SUGR 100.00 Buy Limit @45.00 Fulfilled " + // 100/45 is not a share count
      "SKPC 445.50 Buy Limit @14.85 Fulfilled";
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(text);
    expect(evidences).toHaveLength(1);
    expect(evidences[0].ticker).toBe("SKPC");
    expect(unreadRowCount).toBe(1);
  });

  it("skips a Pending order silently — it's not evidence of anything", () => {
    const text = "Orders All Pending Completed Cancelled COMI 1,915.20 Buy Limit @136.80 Pending";
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(text);
    expect(evidences).toHaveLength(0);
    expect(unreadRowCount).toBe(0);
  });

  it("marks an unknown 4-letter ticker code low-confidence instead of dropping it", () => {
    const text = "Orders All Pending Completed Cancelled ZZZZ 315.00 Buy Limit @45.00 Fulfilled";
    const { evidences } = parser.parseOrdersTimeline(text);
    expect(evidences).toHaveLength(1);
    expect(evidences[0]).toMatchObject({ ticker: "ZZZZ", confidence: "low" });
  });
});

describe("ThndrParser account-wide Transactions screen", () => {
  const parser = new ThndrParser("2020-01-01");

  // OCR-shaped text from the real account-wide "Transactions" screen: title,
  // filter tabs, then rows read as "<Buy/Sell> <TICKER>" followed by a
  // "<date> – <time>" and a signed net total — no share count, no per-share
  // price, unlike the per-stock Orders screen or the undated Orders timeline.
  const transactionsText =
    "5:32 Transactions Completed Pending Cancelled " +
    "Buy EHDR 17 Jan 23 – 4:24pm -378.29 " +
    "Sell RMDA 17 Jan 23 – 3:20pm 9,980.60 " +
    "Sell JUFO 17 Jan 23 – 3:20pm 737.96 " +
    "Buy ESRS 16 Jan 23 – 4:40pm -4,603.91 " +
    "Sell JUFO 16 Jan 23 – 2:49pm 250.90";

  it("recognizes the Transactions screen and not the other document shapes", () => {
    expect(parser.looksLikeOrdersTimeline(transactionsText)).toBe(true);
    expect(parser.looksLikeOrdersTimeline("2/2/2026 Buy Eastern Co. (50@39.3800) -1,974.47")).toBe(false);
    expect(
      parser.looksLikeOrdersTimeline("ORAS Orascom Construction All orders Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled"),
    ).toBe(false);
  });

  it("parses each row's ticker, side, date and signed total, with no shares/price/orderType", () => {
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(transactionsText);
    expect(unreadRowCount).toBe(0);
    expect(evidences).toHaveLength(5);
    expect(evidences[0]).toMatchObject({ ticker: "EHDR", side: "BUY", date: "2023-01-17", totalValue: 378.29, status: "fulfilled" });
    expect(evidences[0].shares).toBeUndefined();
    expect(evidences[0].price).toBeUndefined();
    expect(evidences[0].orderType).toBeUndefined();
    expect(evidences[2]).toMatchObject({ ticker: "JUFO", side: "SELL", date: "2023-01-17", totalValue: 737.96, confidence: "high" });
    expect(evidences[4]).toMatchObject({ ticker: "JUFO", side: "SELL", date: "2023-01-16", totalValue: 250.9 });
  });

  it("does not misfire on the per-stock Orders screen (ticker only in the header, never inline with Buy/Sell)", () => {
    const ordersScreenText =
      "JUFO Juhayna Food Industries " +
      "Buy • 57 shares @ EGP 8.700 09 Jan 23 – 01:09PM Fulfilled " +
      "Buy • 500 shares @ EGP 8.790 09 Jan 23 – 11:56AM Fulfilled";
    expect(parser.looksLikeOrdersTimeline(ordersScreenText)).toBe(false);
  });
});

describe("ThndrParser single Order Details screen", () => {
  const parser = new ThndrParser("2020-01-01");

  // OCR-shaped text from the real per-order "Order Details" page (opened by
  // tapping a history row): company header on top, then label/value pairs.
  // Its timestamp carries no year, so it can only become undated evidence.
  const orderDetailsText =
    "11:09 ADIB Abu Dhabi Islamic Bank - Egypt " +
    "Order State Fulfilled " +
    "Date and Time Sun 14 Jul 11:53 AM " +
    "Market Egypt " +
    "Order Type Market Buy " +
    "Price EGP 36.83 " +
    "Estimated Quantity 5 Shares " +
    "Expiry type Good till cancel";

  it("recognizes the Order Details page as an evidence-bearing document", () => {
    expect(parser.looksLikeOrdersTimeline(orderDetailsText)).toBe(true);
  });

  it("parses one undated fulfilled evidence with ticker/side/shares/price from the labels", () => {
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(orderDetailsText);
    expect(unreadRowCount).toBe(0);
    expect(evidences).toHaveLength(1);
    expect(evidences[0]).toMatchObject({
      ticker: "ADIB",
      side: "BUY",
      orderType: "market",
      shares: 5,
      price: 36.83,
      totalValue: 184.15,
      status: "fulfilled",
      confidence: "high",
    });
    expect(evidences[0].date).toBeUndefined();
  });

  it("parses a Limit Sell variant and a cancelled state correctly", () => {
    const sellText = orderDetailsText.replace("Order Type Market Buy", "Order Type Limit Sell");
    expect(parser.parseOrdersTimeline(sellText).evidences[0]).toMatchObject({ side: "SELL", orderType: "limit" });

    const cancelledText = orderDetailsText.replace("Order State Fulfilled", "Order State Cancelled");
    expect(parser.parseOrdersTimeline(cancelledText).evidences[0]).toMatchObject({ status: "cancelled" });
  });

  it("produces no evidence for a pending order's detail page", () => {
    const pendingText = orderDetailsText.replace("Order State Fulfilled", "Order State Pending");
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(pendingText);
    expect(evidences).toHaveLength(0);
    expect(unreadRowCount).toBe(0);
  });

  it("does not misfire on the other document shapes", () => {
    expect(parser.looksLikeOrdersTimeline("2/2/2026 Buy Eastern Co. (50@39.3800) -1,974.47")).toBe(false);
    const transactionsText = "Transactions Completed Buy EHDR 17 Jan 23 – 4:24pm -378.29 Sell RMDA 17 Jan 23 – 3:20pm 9,980.60";
    const parsed = parser.parseOrdersTimeline(transactionsText);
    expect(parsed.evidences.length).toBeGreaterThan(1); // still routed to the Transactions parser
  });

  it("reads a comma-grouped quantity as whole shares, never as a 3-decimal price", () => {
    const bigQtyText = orderDetailsText.replace("Estimated Quantity 5 Shares", "Estimated Quantity 1,000 Shares");
    const { evidences } = parser.parseOrdersTimeline(bigQtyText);
    expect(evidences[0]).toMatchObject({ shares: 1000, price: 36.83, totalValue: 36830 });
  });

  it("binds the page's own Price label, not an earlier 'Last trade price' in the header", () => {
    const noisyText = orderDetailsText.replace(
      "Order State Fulfilled",
      "Last trade price EGP 99.99 Order State Fulfilled",
    );
    const { evidences } = parser.parseOrdersTimeline(noisyText);
    expect(evidences[0]).toMatchObject({ price: 36.83, shares: 5 });
  });

  it("rejects an unreadable quantity token instead of guessing", () => {
    const badQtyText = orderDetailsText.replace("Estimated Quantity 5 Shares", "Estimated Quantity O.5 Shares");
    const { evidences, unreadRowCount } = parser.parseOrdersTimeline(badQtyText);
    expect(evidences).toHaveLength(0);
    expect(unreadRowCount).toBe(1);
  });
});

describe("ThndrParser.parseOrdersScreenText", () => {
  const parser = new ThndrParser("2020-01-01");
  const header = "ORAS\nOrascom Construction PLC\n";

  it("parses fulfilled rows and skips cancelled ones", () => {
    const text =
      header +
      "All orders " +
      "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled " +
      "Sell • 17 shares @ EGP 253.128 20 Aug 24 – 10:07AM Cancelled";
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ ticker: "ORAS", side: "BUY", shares: 3, date: "2026-02-11", source: "orders-screen" });
    expect(result.candidates[0].time).toBe("11:00AM");
  });

  it("tolerates a dropped/garbled bullet between the verb and quantity", () => {
    const variants = ["Buy 3 shares", "Buy*3 shares", "Buy«3 shares", "Buy3 shares"];
    for (const v of variants) {
      const text = `${header}All orders ${v} @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled`;
      const result = parser.parseOrdersScreenText(text);
      expect(result.candidates).toHaveLength(1);
    }
  });

  it("normalizes O/T/I/l digit noise in quantity and date", () => {
    const text = `${header}All orders Buy • T1 shares @ EGP 448.000 O2 Feb 26 – 11:00AM Fulfilled`;
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates[0].shares).toBe(11);
    expect(result.candidates[0].date).toBe("2026-02-02");
  });

  it("recovers a Buy row whose bullet glyph OCR'd as a stray digit instead of being dropped entirely", () => {
    // Real observed failure (RMDA screenshot): every Sell row's bullet OCR'd
    // fine as "»", but every Buy row's bullet OCR'd as "0" — a real digit —
    // which the original [^\s\d] gap pattern couldn't skip over (digits were
    // deliberately excluded from that gap), silently dropping every Buy row
    // from the screen while Sells on the same screenshot extracted fine.
    const text = `${header}All orders Buy 0 990 shares @EGP 2.790 11 Jan 23 - 10:49AM Fulfilled`;
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ side: "BUY", shares: 990, price: 2.79 });
  });

  it("does not let the misread-bullet-digit tolerance corrupt a real Sell row's own bullet-less-digit reading", () => {
    // Guard against a false positive: this pattern must not fire for a row
    // whose quantity itself genuinely starts right after the verb with no
    // separator at all (e.g. "Buy3 shares" from the existing dropped-bullet
    // test above) — already covered — nor swallow a two-digit quantity by
    // misparsing its first digit as the bullet.
    const text = `${header}All orders Sell » 17 shares @ EGP 253.128 20 Aug 24 – 10:07AM Fulfilled`;
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].shares).toBe(17);
  });

  it("flags an incomplete row when a field is missing without corrupting other rows", () => {
    const text =
      header +
      "All orders " +
      "Buy • 3 shares @ EGP 448.000 Fulfilled " + // missing date
      "Sell • 17 shares @ EGP 253.128 20 Aug 24 – 10:07AM Fulfilled";
    const result = parser.parseOrdersScreenText(text);
    expect(result.incompleteRowCount).toBe(1);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].shares).toBe(17);
  });

  it("flags statusCountMismatch when action count and status count disagree", () => {
    const text =
      header +
      "All orders " +
      "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled " +
      "Sell • 17 shares @ EGP 253.128 20 Aug 24 – 10:07AM"; // status missing entirely
    const result = parser.parseOrdersScreenText(text);
    expect(result.statusCountMismatch).toBe(true);
  });

  it("returns no candidates and no ticker guess for a non-stock header", () => {
    const text = "AZG\nAll orders Buy • 6 shares @ EGP 22.321 11 Feb 26 – 11:00AM Fulfilled";
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(0);
    expect(result.unresolvedTicker).toBeFalsy(); // a non-stock instrument resolved fine — it's excluded on purpose, not a resolution failure
  });

  it("flags unresolvedTicker when order rows are clearly present but the header resolves to no ticker at all", () => {
    const text = "All orders Buy • 6 shares @ EGP 22.321 11 Feb 26 – 11:00AM Fulfilled"; // no header text above "All orders" at all
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(0);
    expect(result.unresolvedTicker).toBe(true);
  });

  it("resolves the ticker from the company name alone when the header's ticker-code text isn't visible (a scrolled continuation screenshot)", () => {
    // Real observed failure (RMDA): a screenshot of a scrolled-down portion
    // of the per-stock Orders screen keeps "Rameda Pharmaceutical Company"
    // pinned at the top but drops the small "RMDA" code label above it —
    // resolveHeaderTicker's only fallback before RMDA was added to
    // KNOWN_EGX_TICKERS was a bare 4-letter-code scan, which found nothing
    // here and dropped every row in the file (0 candidates, whole upload
    // treated as unrecognized) even though the company name was read fine.
    const text = "Rameda Pharmaceutical Company\nAll orders Buy 0 500 shares @EGP 2.790 11 Jan 23 - 10:34AM Fulfilled";
    const result = parser.parseOrdersScreenText(text);
    expect(result.candidates).toHaveLength(1);
    // The flat orders-screen parser caps confidence at "medium" regardless of
    // how confidently the header ticker resolved (positional field-pairing
    // risk) — the ticker itself still resolves correctly, which is the fix
    // under test here.
    expect(result.candidates[0]).toMatchObject({ ticker: "RMDA", side: "BUY", shares: 500, confidence: "medium" });
  });
});

describe("ThndrParser.parseOrderRowsText (row-isolated rescan)", () => {
  const parser = new ThndrParser("2020-01-01");

  it("prefers pixel color status over an OCR'd status word", () => {
    // OCR misread "Cancelled" as "Fulfilled" in the row text, but the pixel
    // color (read independently from the image) correctly says cancelled —
    // color must win.
    const rows = [{ text: "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled", colorStatus: "cancelled" as const }];
    const result = parser.parseOrderRowsText(rows, "ORAS");
    expect(result.candidates).toHaveLength(0);
    expect(result.resolvedRowCount).toBe(1);
  });

  it("falls back to the OCR'd status word when no color was detected", () => {
    const rows = [{ text: "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM Fulfilled", colorStatus: null }];
    const result = parser.parseOrderRowsText(rows, "ORAS");
    expect(result.candidates).toHaveLength(1);
  });

  it("never produces a cross-row mispairing since each row is isolated", () => {
    const rows = [
      { text: "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM", colorStatus: "cancelled" as const },
      { text: "Sell • 17 shares @ EGP 253.128 20 Aug 24 – 10:07AM", colorStatus: "fulfilled" as const },
    ];
    const result = parser.parseOrderRowsText(rows, "ORAS");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].side).toBe("SELL");
    expect(result.candidates[0].shares).toBe(17);
    expect(result.statusCountMismatch).toBe(false);
  });

  it("counts a row with no resolvable status as incomplete, not fulfilled or cancelled", () => {
    const rows = [{ text: "Buy • 3 shares @ EGP 448.000 11 Feb 26 – 11:00AM", colorStatus: null }];
    const result = parser.parseOrderRowsText(rows, "ORAS");
    expect(result.incompleteRowCount).toBe(1);
    expect(result.resolvedRowCount).toBe(0);
  });

  it("excludes non-stock instrument tickers entirely", () => {
    const rows = [{ text: "Buy • 6 shares @ EGP 22.321 11 Feb 26 – 11:00AM Fulfilled", colorStatus: null }];
    const result = parser.parseOrderRowsText(rows, "AZG");
    expect(result.candidates).toHaveLength(0);
    expect(result.resolvedRowCount).toBe(0);
  });

  it("recovers a Buy row whose bullet glyph OCR'd as a stray digit, same as the flat parser", () => {
    const rows = [{ text: "Buy 0 500 shares @EGP 2.790 11 Jan 23 - 10:34AM Fulfilled", colorStatus: "fulfilled" as const }];
    const result = parser.parseOrderRowsText(rows, "RMDA");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ side: "BUY", shares: 500, price: 2.79 });
  });
});

describe("ThndrParser.parsePositionVerification", () => {
  const parser = new ThndrParser("2020-01-01");

  it("parses ticker, units and average cost from the position grid, in document order", () => {
    const text = `
      ORHD
      Orascom Development Egypt
      Last trade price EGP 38.20
      My current position
      Units 74
      Average cost EGP 23.73
      Purchase Value EGP 1,756.02
      Market value 2,826.80
    `;
    const [result] = parser.parsePositionVerification(text);
    expect(result).toMatchObject({ ticker: "ORHD", units: 74, avgCost: 23.73, source: "screenshot" });
  });

  it("stops scanning before Earned Cash Dividends so its EGP figures aren't mistaken for position stats", () => {
    const text = `
      ORHD
      Orascom Development Egypt
      My current position
      Units 74
      Average cost EGP 23.73
      Earned Cash Dividends
      EGP 999.99
    `;
    const [result] = parser.parsePositionVerification(text);
    expect(result.units).toBe(74);
    expect(result.avgCost).toBe(23.73);
  });

  it("returns an empty array when no ticker can be resolved", () => {
    const text = "My current position Units 74 Average cost EGP 23.73";
    expect(parser.parsePositionVerification(text)).toHaveLength(0);
  });

  it("drops a misread average cost when it doesn't reconcile against units × avgCost ≈ Purchase Value", () => {
    // A real Purchase Value of 1,756.02 (74 units) implies avgCost 23.73;
    // "273" here is a plausible OCR misread (a dropped decimal point) that
    // would otherwise silently corrupt mismatchResolver's ranking.
    const text = `
      ORHD
      Orascom Development Egypt
      My current position
      Units 74
      Average cost EGP 273
      Purchase Value EGP 1,756.02
      Market value 2,826.80
    `;
    const [result] = parser.parsePositionVerification(text);
    expect(result.units).toBe(74);
    expect(result.avgCost).toBeUndefined();
  });

  it("rejects a 2-3 letter OCR noise fragment near the header instead of fabricating a ticker from it", () => {
    // Real EGX tickers are always exactly 4 letters (see KNOWN_EGX_TICKERS) —
    // a stray 2-3 letter all-caps fragment (an OCR misread of surrounding UI
    // chrome, not the actual ticker) must never be accepted as one.
    for (const noise of ["TE", "HH", "EGF"]) {
      const text = `
        ${noise}
        My current position
        Units 74
        Average cost EGP 23.73
      `;
      expect(parser.parsePositionVerification(text)).toHaveLength(0);
    }
  });
});

describe("ThndrParser.parseDividends", () => {
  const parser = new ThndrParser("2020-01-01");

  it("parses each dated payout from the 'My position' screen's dividend history", () => {
    const text = `
      EAST
      Eastern Company
      Last trade price EGP 37.40
      My current position
      Units 175
      Average cost EGP 37.41
      Purchase Value EGP 6,546.75
      Market value 6,545.00
      Earned Cash Dividends
      Total cash dividends earned to date. Stock dividends aren't counted.
      Total EGP 209.38
      28 June 2026 EGP 64.98
      25 May 2026 EGP 144.40
    `;
    const dividends = parser.parseDividends(text);
    expect(dividends).toHaveLength(2);
    expect(dividends[0]).toMatchObject({ ticker: "EAST", date: "2026-06-28", amount: 64.98 });
    expect(dividends[1]).toMatchObject({ ticker: "EAST", date: "2026-05-25", amount: 144.4 });
  });

  it("parses a single payout without mistaking the Total line for a dated row", () => {
    const text = `
      COMI
      Commercial International Bank
      My current position
      Units 59
      Average cost EGP 128.19
      Earned Cash Dividends
      Total EGP 114.00
      15 April 2026 EGP 114.00
    `;
    const dividends = parser.parseDividends(text);
    expect(dividends).toHaveLength(1);
    expect(dividends[0]).toMatchObject({ ticker: "COMI", date: "2026-04-15", amount: 114 });
  });

  it("returns an empty array when there is no dividend history section", () => {
    const text = "ORHD\nOrascom Development Egypt\nMy current position\nUnits 74\nAverage cost EGP 23.73";
    expect(parser.parseDividends(text)).toHaveLength(0);
  });

  it("returns an empty array when no ticker can be resolved", () => {
    const text = "My current position Earned Cash Dividends Total EGP 100.00 1 Jan 2026 EGP 100.00";
    expect(parser.parseDividends(text)).toHaveLength(0);
  });
});

describe("ThndrParser tracked-date-range guard", () => {
  it("excludes trades dated before the configured cutoff", () => {
    const parser = new ThndrParser("2025-01-01");
    const text = "2/2/2024 Buy Eastern Co. (50@39.3800)";
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });

  it("includes trades dated on/after the cutoff", () => {
    const parser = new ThndrParser("2025-01-01");
    const text = "2/2/2026 Buy Eastern Co. (50@39.3800)";
    expect(parser.parseStatementText(text)).toHaveLength(1);
  });

  it("excludes far-future dates (likely an OCR misread) via the default cutoff", () => {
    const parser = new ThndrParser();
    const text = "2/2/2099 Buy Eastern Co. (50@39.3800)";
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });

  it("defaults to the product's fixed 2026-01-01 tracking start", () => {
    const parser = new ThndrParser();
    expect(parser.isWithinTrackedRange("2025-12-31")).toBe(false);
    expect(parser.isWithinTrackedRange("2026-01-01")).toBe(true);
    expect(parser.isWithinTrackedRange(new Date().toISOString().slice(0, 10))).toBe(true);
  });

  it("excludes a dividend dated before the cutoff instead of letting it through to fail at commit time", () => {
    const parser = new ThndrParser();
    const text = `
      ORAS
      Orascom Construction PLC
      My current position
      Units 9
      Average cost EGP 419.85
      Earned Cash Dividends
      Total EGP 156.54
      21 August 2024 EGP 156.54
    `;
    expect(parser.parseDividends(text)).toHaveLength(0);
  });

  it("still includes an on/after-cutoff dividend alongside an excluded pre-cutoff one", () => {
    const parser = new ThndrParser();
    const text = `
      ORAS
      Orascom Construction PLC
      My current position
      Units 9
      Average cost EGP 419.85
      Earned Cash Dividends
      Total EGP 300.00
      21 August 2024 EGP 156.54
      15 April 2026 EGP 143.46
    `;
    const dividends = parser.parseDividends(text);
    expect(dividends).toHaveLength(1);
    expect(dividends[0]).toMatchObject({ ticker: "ORAS", date: "2026-04-15", amount: 143.46 });
  });
});

describe("ThndrParser.looksLikeOwnDocument / looksLikePositionVerification", () => {
  const parser = new ThndrParser();

  it("recognizes a Thndr statement document", () => {
    expect(parser.looksLikeOwnDocument("Thndr Customer Account Statement")).toBe(true);
  });

  it("does not mistake a position-verification screen for a generic document without the marker text", () => {
    expect(parser.looksLikeOwnDocument("Some other broker's report")).toBe(false);
  });

  it("recognizes a position-verification screen only when all three markers are present", () => {
    const text = "My current position Units 74 Average cost EGP 23.73";
    expect(parser.looksLikePositionVerification(text)).toBe(true);
    expect(parser.looksLikePositionVerification("My current position")).toBe(false);
  });
});
