import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props { children: ReactNode }
interface State { error?: Error }

/** Keeps a single page failure from taking down navigation or the user's local portfolio session. */
export class PageErrorBoundary extends Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Page rendering failed", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const ar = document.documentElement.lang === "ar";
    return (
      <div role="alert" className="mx-auto mt-16 max-w-xl rounded-2xl border border-rose-400/20 bg-rose-400/[.055] p-8 text-center">
        <AlertTriangle className="mx-auto text-rose-300" size={30} />
        <h1 className="mt-4 text-lg font-semibold text-slate-100">{ar ? "تعذر عرض هذه الصفحة" : "This page could not be displayed"}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-400">{ar ? "بياناتك المحفوظة آمنة. أعد تحميل الصفحة للمحاولة مرة أخرى." : "Your stored data is safe. Reload the page to retry the operation."}</p>
        <button onClick={() => window.location.reload()} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-4 py-2 text-sm font-semibold text-slate-950">
          <RefreshCw size={15} /> {ar ? "إعادة التحميل" : "Reload"}
        </button>
      </div>
    );
  }
}
