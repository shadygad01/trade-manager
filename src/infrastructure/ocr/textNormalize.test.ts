import { describe, expect, it } from "vitest";
import { normalizeExtractedText } from "./textNormalize";

describe("normalizeExtractedText", () => {
  it("converts Eastern Arabic digits to Western", () => {
    expect(normalizeExtractedText("١٨٫٣٥")).toBe("18.35");
    expect(normalizeExtractedText("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  it("converts Extended Arabic-Indic (Persian) digits", () => {
    expect(normalizeExtractedText("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
  });

  it("maps Arabic decimal and thousands separators", () => {
    expect(normalizeExtractedText("١٬٩٧٤٫٤٧")).toBe("1,974.47");
  });

  it("strips zero-width and bidi control characters", () => {
    expect(normalizeExtractedText("1\u200B8\u200F.3\u202A5")).toBe("18.35");
    expect(normalizeExtractedText("\uFEFFBuy")).toBe("Buy");
  });

  it("normalizes exotic Unicode spaces to plain spaces", () => {
    expect(normalizeExtractedText("Buy\u00A0Eastern\u2009Co")).toBe("Buy Eastern Co");
    expect(normalizeExtractedText("1\u202F974")).toBe("1 974");
  });

  it("folds full-width characters via NFKC", () => {
    expect(normalizeExtractedText("１８．３５")).toBe("18.35");
  });

  it("leaves clean ASCII text untouched", () => {
    const s = "2/2/2026 Buy Eastern Co. (50@39.3800) -1,974.47";
    expect(normalizeExtractedText(s)).toBe(s);
  });

  it("handles empty input", () => {
    expect(normalizeExtractedText("")).toBe("");
  });
});
