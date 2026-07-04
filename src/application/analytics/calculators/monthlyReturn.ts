import type { EquityPoint } from "./equityCurve";
import { bucketReturns, type PeriodReturn } from "./shared";

export type { PeriodReturn };

export function monthlyReturn(equityCurve: EquityPoint[]): PeriodReturn[] {
  return bucketReturns(equityCurve, 7);
}
