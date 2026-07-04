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
    });
  });

  it("returns no candidates when the invoice's totals row is missing (rather than guessing)", () => {
    const truncated = invoiceText.split("Total Quantity")[0];
    expect(parser.parseStatementText(truncated)).toHaveLength(0);
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
    expect(result.candidates[0]).toMatchObject({ ticker: "ORAS", side: "BUY", shares: 3, date: "2026-02-11" });
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

  it("defaults to a rolling lookback rather than a fixed stale literal date", () => {
    const parser = new ThndrParser();
    expect(parser.isWithinTrackedRange("2020-01-01")).toBe(false);
    expect(parser.isWithinTrackedRange(new Date().toISOString().slice(0, 10))).toBe(true);
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
