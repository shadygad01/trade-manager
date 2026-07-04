/**
 * Chart palette for the dark navy dashboard surface. Values come from the
 * dataviz skill's validated categorical/status palette, re-checked against
 * this app's chart surface (#0f172a / slate-900) with
 * scripts/validate_palette.js — all six checks pass (CVD sits in the 8-12
 * floor band, which is why charts pair color with direct labels/legends
 * rather than relying on hue alone).
 */
export const CHART_SURFACE = "#0f172a";
export const CHART_GRID = "#293548";
export const CHART_AXIS = "#3f4c63";
export const CHART_TEXT_MUTED = "#8891a3";
export const CHART_TEXT_SECONDARY = "#c3c2b7";

export const CATEGORICAL = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#22a022",
  "#9085e9",
  "#e66767",
  "#d55181",
  "#d95926",
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
