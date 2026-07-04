/**
 * One journal entry per Trade — the reflective record (as opposed to Trade's
 * own execution-time `notes`/`strategyTags`, which are set at fill time).
 */
export interface JournalEntry {
  id: string;
  tradeId: string;
  portfolioId: string;
  entryReason?: string;
  exitReason?: string;
  lessonsLearned?: string;
  strategyTags: string[];
  notes?: string;
  images: string[];
  attachments: string[];
  createdAt: string;
  updatedAt: string;
}

export function createJournalEntry(input: {
  id: string;
  tradeId: string;
  portfolioId: string;
  entryReason?: string;
  strategyTags?: string[];
  notes?: string;
}): JournalEntry {
  const now = new Date().toISOString();
  return {
    id: input.id,
    tradeId: input.tradeId,
    portfolioId: input.portfolioId,
    entryReason: input.entryReason,
    strategyTags: input.strategyTags ?? [],
    notes: input.notes,
    images: [],
    attachments: [],
    createdAt: now,
    updatedAt: now,
  };
}
