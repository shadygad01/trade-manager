import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseThndrOrdersWorkbook } from "./ThndrOrdersWorkbookParser";

type Row = (string | number | null)[];

function buildWorkbook(rows: Row[]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

const TITLE_ROW: Row = ["Your Orders"];

describe("parseThndrOrdersWorkbook", () => {
  it("is not recognized when the title cell doesn't say Your Orders", async () => {
    const buffer = buildWorkbook([["Some Other Report"], ["EAST", "Buy Limit", "Good Till Cancel", "37.00 EGP", "34/34", "FULFILLED"]]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.ok).toBe(false);
  });

  it("parses a fulfilled buy and a fulfilled sell under their ticker sections", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["EAST"],
      ["08 Jul ’26 - 10:58 AM", "Buy Limit", "Good Till Cancel", "37.00 EGP", "34/34", "FULFILLED"],
      ["ABUK"],
      ["30 Jun ’26 - 10:00 AM", "Sell Market SETTLED", "Good Till Cancel", "67.40 EGP", "14/14", "FULFILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.ok).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]).toMatchObject({
      ticker: "EAST",
      side: "BUY",
      shares: 34,
      price: 37,
      date: "2026-07-08",
      confidence: "high",
      source: "official-broker-excel",
    });
    expect(result.candidates[1]).toMatchObject({ ticker: "ABUK", side: "SELL", shares: 14, price: 67.4, date: "2026-06-30" });
  });

  it("never creates a trade for a cancelled, rejected, or expired order", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["HRHO"],
      ["28 Jun ’26 - 11:20 AM", "Sell Limit SETTLED", "Good Till Cancel", "26.99 EGP", "0/39", "CANCELLED"],
      ["28 Jun ’26 - 11:20 AM", "Buy Limit", "Good Till Cancel", "26.99 EGP", "0/39", "REJECTED"],
      ["28 Jun ’26 - 11:20 AM", "Buy Limit", "Good Till Cancel", "26.99 EGP", "0/39", "EXPIRED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(0);
    expect(result.cancelledOrders).toHaveLength(3);
    expect(result.cancelledOrders.map((c) => c.brokerStatus)).toEqual(["CANCELLED", "REJECTED", "EXPIRED"]);
    expect(result.cancelledOrders.every((c) => c.source === "official-broker-excel")).toBe(true);
  });

  it("uses only the executed quantity for a partially filled order, as a normal final candidate (no confirmation gate — the executed count is printed directly by the broker, not an uncertain OCR/AI read)", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["COMI"],
      ["16 Jan ’23 - 10:13 AM", "Buy Limit", "Good Till Cancel", "24.58 EGP", "187/200", "PARTIALLY FILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ shares: 187, source: "official-broker-excel" });
    expect(result.candidates[0].needsConfirmation).toBeUndefined();
  });

  it("skips a cash-amount ('invest by EGP amount') order since it prints no share count", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["FIRE"],
      ["28 Jun ’26 - 10:09 AM", "Buy Market", "Good Till Cancel", "135.00 EGP", "-", "FULFILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/cash-amount/i);
  });

  it("skips order rows whose preceding ticker header wasn't a recognizable ticker code", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["EGCH_r3"],
      ["21 Apr ’24 - 11:37 AM", "Sell Limit SETTLED", "Good Till Cancel", "2.53 EGP", "455/455", "FULFILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(0);
    expect(result.warnings.join(" ")).toMatch(/ticker section/i);
  });

  it("recovers a fully-filled quantity that Excel auto-converted into a date (e.g. '12/12' displayed as '12-Dec')", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["ABUK"],
      ["06 Dec ’22 - 11:14 AM", "Sell Limit SETTLED", "Good Till Cancel", "1.08 EGP", "12-Dec", "FULFILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ shares: 12 });
  });

  it("recovers a partially-filled quantity that Excel auto-converted into a month-year date (e.g. '7/50' displayed as 'Jul-50')", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["ABUK"],
      ["19 Feb ’23 - 10:34 AM", "Sell Limit SETTLED", "Good Till Day", "154.01 EGP", "Jul-50", "PARTIALLY FILLED"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ shares: 7 });
    expect(result.candidates[0].needsConfirmation).toBeUndefined();
  });

  it("never creates a candidate for a pending (not-yet-executed) order", async () => {
    const buffer = buildWorkbook([
      TITLE_ROW,
      ["EAST"],
      ["08 Jul ’26 - 10:58 AM", "Buy Limit", "Good Till Cancel", "37.00 EGP", "0/34", "PENDING"],
    ]);
    const result = await parseThndrOrdersWorkbook(buffer);
    expect(result.candidates).toHaveLength(0);
    expect(result.cancelledOrders).toHaveLength(0);
  });
});
