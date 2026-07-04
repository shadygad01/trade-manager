import type { EquityPoint } from "./equityCurve";
import { bucketReturns, type PeriodReturn } from "./shared";

export type { PeriodReturn };

export function annualReturn(equityCurve: EquityPoint[]): PeriodReturn[] {
  return bucketReturns(equityCurve, 4);
}
