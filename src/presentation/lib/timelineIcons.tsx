import {
  ArrowDownCircle,
  ArrowUpCircle,
  Scissors,
  Wallet,
  Banknote,
  Repeat,
  Landmark,
  CircleDollarSign,
  StickyNote,
  type LucideIcon,
} from "lucide-react";
import type { TimelineEventType } from "@domain/entities/TimelineEvent";

export const TIMELINE_ICONS: Record<TimelineEventType, LucideIcon> = {
  Buy: ArrowUpCircle,
  Sell: ArrowDownCircle,
  PartialSell: Scissors,
  Deposit: Wallet,
  Withdrawal: Banknote,
  Dividend: CircleDollarSign,
  Split: Repeat,
  RightsIssue: Landmark,
  CashAdjustment: CircleDollarSign,
  Note: StickyNote,
};

export const TIMELINE_COLORS: Record<TimelineEventType, string> = {
  Buy: "text-emerald-400 bg-emerald-400/10",
  Sell: "text-rose-400 bg-rose-400/10",
  PartialSell: "text-rose-300 bg-rose-300/10",
  Deposit: "text-sky-400 bg-sky-400/10",
  Withdrawal: "text-amber-400 bg-amber-400/10",
  Dividend: "text-violet-400 bg-violet-400/10",
  Split: "text-cyan-400 bg-cyan-400/10",
  RightsIssue: "text-cyan-400 bg-cyan-400/10",
  CashAdjustment: "text-slate-300 bg-slate-300/10",
  Note: "text-slate-400 bg-slate-400/10",
};
