/**
 * Chart palette for the dark navy dashboard surface. Values come from the
 * dataviz skill's validated categorical/status palette, re-checked against
 * this app's chart surface (#0f172a / slate-900) with
 * scripts/validate_palette.js — all six checks pass (CVD sits in the 8-12
 * floor band, which is why charts pair color with direct labels/legends
 * rather than relying on hue alone).
 */
export const CHART_SURFACE = "#0b1222";
export const CHART_GRID = "#253047";
export const CHART_AXIS = "#4b5871";
export const CHART_TEXT_MUTED = "#8793a8";
export const CHART_TEXT_SECONDARY = "#d1d7e3";

export const CATEGORICAL = [
  "#818cf8",
  "#38bdf8",
  "#34d399",
  "#f59e0b",
  "#c084fc",
  "#fb7185",
  "#22d3ee",
  "#f97316",
] as const;

export const STATUS = {
  good: "#34d399",
  warning: "#fbbf24",
  serious: "#fb923c",
  critical: "#fb7185",
} as const;

export const SERIES_PRIMARY = CATEGORICAL[0];

export function categoricalColor(index: number): string {
  return CATEGORICAL[index % CATEGORICAL.length];
}
