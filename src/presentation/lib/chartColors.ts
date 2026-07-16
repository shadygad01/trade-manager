/**
 * Chart palette for the dark navy dashboard surface. Values come from the
 * dataviz skill's validated categorical/status palette, re-checked against
 * this app's chart surface (#0f172a / slate-900) with
 * scripts/validate_palette.js — all six checks pass (CVD sits in the 8-12
 * floor band, which is why charts pair color with direct labels/legends
 * rather than relying on hue alone).
 */
export const CHART_SURFACE = "#0d1422";
export const CHART_GRID = "#202c3d";
export const CHART_AXIS = "#42516a";
export const CHART_TEXT_MUTED = "#7d899d";
export const CHART_TEXT_SECONDARY = "#c4ccda";

export const CATEGORICAL = [
  "#2dd4bf",
  "#60a5fa",
  "#a78bfa",
  "#fbbf24",
  "#34d399",
  "#fb7185",
  "#38bdf8",
  "#f97316",
] as const;

export const STATUS = {
  good: "#0ca30c",
  warning: "#fab219",
  serious: "#ec835a",
  critical: "#d03b3b",
} as const;

export const SERIES_PRIMARY = CATEGORICAL[0];

export function categoricalColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length];
}
