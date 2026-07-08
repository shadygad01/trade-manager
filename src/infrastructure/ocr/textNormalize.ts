/**
 * Central text normalization applied to ALL raw extracted text (OCR output,
 * PDF text layer, CSV bytes) before any parser sees it. Parsers' regexes are
 * written against clean Western-digit ASCII-ish text; real documents arrive
 * with Eastern Arabic numerals, Arabic decimal/thousands separators, hidden
 * bidi control characters, and exotic Unicode spaces that silently break
 * those regexes. Normalizing once here — instead of per-parser — keeps every
 * extraction path equally robust without touching parser logic.
 */

// Eastern Arabic (٠-٩, U+0660-0669) and Extended Arabic-Indic / Persian
// (۰-۹, U+06F0-06F9) digits → Western digits.
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_ZERO = 0x06f0;

export function normalizeExtractedText(raw: string): string {
  if (!raw) return raw;
  return (
    raw
      // Canonical decomposition first: full-width digits/letters, ligatures,
      // and presentation forms fold to their plain equivalents.
      .normalize("NFKC")
      // Zero-width chars and bidi control marks: invisible to the eye but
      // fatal to regexes that expect adjacent characters ("1<RLM>8" ≠ "18").
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      // Every exotic Unicode space (NBSP, thin space, narrow NBSP, ...)
      // becomes a plain space so \s and literal-space patterns both match.
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " ")
      // Arabic decimal separator (٫ U+066B) → "." and Arabic thousands
      // separator (٬ U+066C) → "," so "١٨٫٣٥" ends up as "18.35".
      .replace(/\u066B/g, ".")
      .replace(/\u066C/g, ",")
      // Eastern Arabic / Persian digits → Western digits.
      .replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (ch) => {
        const code = ch.charCodeAt(0);
        return String(code >= EXTENDED_ARABIC_ZERO ? code - EXTENDED_ARABIC_ZERO : code - ARABIC_INDIC_ZERO);
      })
  );
}
