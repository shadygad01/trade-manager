import { describe, it, expect } from "vitest";
import { CsvStatementParser } from "./CsvStatementParser";

describe("CsvStatementParser.looksLikeOwnDocument", () => {
  const parser = new CsvStatementParser("2020-01-01");

  it("recognizes a CSV with the required columns", () => {
    const text = "Date,Ticker,Type,Quantity,Price\n2026-02-19,COMI,Buy,100,50.5";
    expect(parser.looksLikeOwnDocument(text)).toBe(true);
  });

  it("does not recognize plain prose", () => {
    expect(parser.looksLikeOwnDocument("This is just some random text.")).toBe(false);
  });

  it("never claims to be a position-verification screen", () => {
    expect(parser.looksLikePositionVerification()).toBe(false);
  });
});

describe("CsvStatementParser.parseStatementText", () => {
  const parser = new CsvStatementParser("2020-01-01");

  it("parses a comma-delimited CSV with a Buy and a Sell row", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,COMI,Buy,100,50.5", "2026-03-01,HRHO,Sell,40,27.7"].join("\n");
    const candidates = parser.parseStatementText(text);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ ticker: "COMI", side: "BUY", shares: 100, price: 50.5, date: "2026-02-19" });
    expect(candidates[1]).toMatchObject({ ticker: "HRHO", side: "SELL", shares: 40, price: 27.7, date: "2026-03-01" });
  });

  it("parses a semicolon-delimited CSV", () => {
    const text = ["Date;Symbol;Side;Shares;Price", "2026-02-19;COMI;Buy;100;50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate).toMatchObject({ ticker: "COMI", shares: 100, price: 50.5 });
  });

  it("accepts d/m/y dates in addition to ISO dates", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "19/2/2026,COMI,Buy,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.date).toBe("2026-02-19");
  });

  it("reads optional fees and taxes columns when present", () => {
    const text = ["Date,Ticker,Type,Quantity,Price,Fees,Taxes", "2026-02-19,COMI,Buy,100,50.5,15,5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.fees).toBe(15);
    expect(candidate.taxes).toBe(5);
  });

  it("defaults side to BUY when the type column doesn't say Sell", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,COMI,Executed,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.side).toBe("BUY");
  });

  it("marks a row high confidence when both the ticker is recognized and the side was stated explicitly", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,COMI,Buy,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("high");
  });

  it("downgrades confidence when the ticker isn't recognized, even though the column match itself is structured", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,ZZZZ,Buy,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("medium");
  });

  it("downgrades confidence when the side was defaulted rather than stated explicitly, even for a known ticker", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,COMI,Executed,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("medium");
  });

  it("marks a row low confidence when neither the ticker nor the side is trustworthy", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "2026-02-19,ZZZZ,Executed,100,50.5"].join("\n");
    const [candidate] = parser.parseStatementText(text);
    expect(candidate.confidence).toBe("low");
  });

  it("returns nothing when required columns are missing", () => {
    const text = ["Name,Notes", "COMI,some note"].join("\n");
    expect(parser.parseStatementText(text)).toHaveLength(0);
  });

  it("skips malformed rows without throwing", () => {
    const text = ["Date,Ticker,Type,Quantity,Price", "not-a-date,COMI,Buy,100,50.5", "2026-02-19,HRHO,Buy,10,20"].join("\n");
    const candidates = parser.parseStatementText(text);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].ticker).toBe("HRHO");
  });

  it("excludes rows outside the tracked date range", () => {
    const recentParser = new CsvStatementParser("2026-01-01");
    const text = ["Date,Ticker,Type,Quantity,Price", "2020-01-01,COMI,Buy,100,50.5"].join("\n");
    expect(recentParser.parseStatementText(text)).toHaveLength(0);
  });
});

describe("CsvStatementParser other BrokerParser methods", () => {
  const parser = new CsvStatementParser("2020-01-01");

  it("has empty implementations for screenshot-only concepts", () => {
    expect(parser.parseOrdersScreenText().candidates).toEqual([]);
    expect(parser.parsePositionVerification()).toEqual([]);
    expect(parser.resolveHeaderTicker()).toBeNull();
    expect(parser.parseOrderRowsText([]).candidates).toEqual([]);
  });
});
