export type PortfolioKind =
  | "Investment"
  | "Trading"
  | "Swing"
  | "Experiments"
  | "Retirement"
  | "Education"
  | "Custom";

export interface Portfolio {
  id: string;
  name: string;
  kind: PortfolioKind;
  /** Free-form label shown instead of `kind` when kind === "Custom". */
  customKindLabel?: string;
  currency: "EGP";
  /** Cash balance, in Money-parseable form (see Money value object) for storage. */
  cash: number;
  createdAt: string;
  archivedAt?: string;
  notes?: string;
}

export function createPortfolio(input: {
  id: string;
  name: string;
  kind: PortfolioKind;
  customKindLabel?: string;
  initialCash?: number;
  notes?: string;
}): Portfolio {
  return {
    id: input.id,
    name: input.name,
    kind: input.kind,
    customKindLabel: input.customKindLabel,
    currency: "EGP",
    cash: input.initialCash ?? 0,
    createdAt: new Date().toISOString(),
    notes: input.notes,
  };
}
