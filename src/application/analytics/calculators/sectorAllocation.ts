import { UNCLASSIFIED_SECTOR } from "@domain/value-objects/knownSectors";

export interface SectorAllocationSlice {
  sector: string;
  marketValue: number;
  percentage: number;
}

export interface SectorPositionInput {
  /** A position's sector is taken from its open trades, which share one ticker and should therefore agree on sector. */
  sector?: string;
  marketValue?: number;
  costBasis: number;
}

/**
 * Groups open-position value by sector. A position with no resolvable
 * sector (an unmapped ticker with no manual override) is folded into an
 * honest "Unclassified" bucket rather than guessed at — and that bucket is
 * always sorted last regardless of its size, since it isn't a real
 * category competing with the others for rank.
 */
export function sectorAllocation(positions: SectorPositionInput[]): SectorAllocationSlice[] {
  const byUSector = new Map<string, number>();
  let total = 0;
  for (const position of positions) {
    const value = position.marketValue ?? position.costBasis;
    if (value <= 0) continue;
    const sector = position.sector ?? UNCLASSIFIED_SECTOR;
    byUSector.set(sector, (byUSector.get(sector) ?? 0) + value);
    total += value;
  }

  const slices = [...byUSector.entries()].map(([sector, marketValue]) => ({
    sector,
    marketValue,
    percentage: total > 0 ? (marketValue / total) * 100 : 0,
  }));

  slices.sort((a, b) => {
    if (a.sector === UNCLASSIFIED_SECTOR) return 1;
    if (b.sector === UNCLASSIFIED_SECTOR) return -1;
    return b.marketValue - a.marketValue;
  });

  return slices;
}
