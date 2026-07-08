import { describe, it, expect } from "vitest";
import { tickerForCompanyNameFallback } from "./knownTickers";

describe("tickerForCompanyNameFallback", () => {
  it("maps a company-name-fallback group back to its real EGX symbol", () => {
    expect(tickerForCompanyNameFallback("DELTA SUGAR")).toBe("SUGR");
    expect(tickerForCompanyNameFallback("MEDINET MASR HOUSING")).toBe("MASR");
    expect(tickerForCompanyNameFallback("Orascom Development Egypt")).toBe("ORHD");
    expect(tickerForCompanyNameFallback("First Investment & Real Estate Development")).toBe("FIRE");
  });

  it("never matches a real ticker symbol — only multi-word company names qualify as fallbacks", () => {
    expect(tickerForCompanyNameFallback("SUGR")).toBeUndefined();
    expect(tickerForCompanyNameFallback("COMI")).toBeUndefined();
  });

  it("returns undefined for an unknown company name rather than guessing", () => {
    expect(tickerForCompanyNameFallback("SOME UNKNOWN COMPANY")).toBeUndefined();
  });
});
