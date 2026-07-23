import { useT } from "@presentation/i18n/translations";

interface ExistingPortfolioHint {
  multiple: boolean;
  names: string[];
}

interface TickerSuggestionBannersProps {
  ticker: string;
  mergeSuggestion: string | undefined;
  knownTickerSuggestion: string | undefined;
  existingPortfolioHint: ExistingPortfolioHint | undefined;
  error: string | undefined;
  onRenameTicker: (ticker: string) => void;
}

export function TickerSuggestionBanners({
  ticker,
  mergeSuggestion,
  knownTickerSuggestion,
  existingPortfolioHint,
  error,
  onRenameTicker,
}: TickerSuggestionBannersProps) {
  const t = useT();
  return (
    <>
      {mergeSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-amber-500/5 px-4 py-2.5 text-xs text-amber-300">
          <span>{t("importPage.mergeSuggestionText", { ticker: mergeSuggestion })}</span>
          <button
            onClick={() => onRenameTicker(mergeSuggestion)}
            className="rounded-md border border-amber-400/40 px-2.5 py-1 font-medium text-amber-300 hover:bg-amber-500/10"
          >
            {t("importPage.mergeInto", { ticker: mergeSuggestion })}
          </button>
        </div>
      ) : null}
      {!mergeSuggestion && knownTickerSuggestion ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-cyan-500/5 px-4 py-2.5 text-xs text-cyan-300">
          <span>{t("importPage.knownTickerSuggestionText", { ticker, realTicker: knownTickerSuggestion })}</span>
          <button
            onClick={() => onRenameTicker(knownTickerSuggestion)}
            className="rounded-md border border-cyan-400/40 px-2.5 py-1 font-medium text-cyan-300 hover:bg-cyan-500/10"
          >
            {t("importPage.renameToTicker", { ticker: knownTickerSuggestion })}
          </button>
        </div>
      ) : null}
      {existingPortfolioHint ? (
        <div className="border-b border-slate-800 bg-slate-950/40 px-4 py-2 text-xs text-slate-400">
          {existingPortfolioHint.multiple
            ? t("importPage.existingPortfolioHintMultiple", { ticker, names: existingPortfolioHint.names.join(", ") })
            : t("importPage.existingPortfolioHintSingle", { ticker, name: existingPortfolioHint.names[0] })}
        </div>
      ) : null}
      {error ? <div className="border-b border-slate-800 bg-rose-500/5 px-4 py-2 text-xs text-rose-400">{error}</div> : null}
    </>
  );
}
