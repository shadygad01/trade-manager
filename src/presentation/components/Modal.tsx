import type { ReactNode } from "react";
import { X } from "lucide-react";
import { useT } from "@presentation/i18n/translations";

interface ModalProps {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  widthClassName?: string;
}

export function Modal({ title, open, onClose, children, widthClassName }: ModalProps) {
  const t = useT();
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/70 px-4 py-10 backdrop-blur-sm">
      <div
        className={`w-full ${widthClassName ?? "max-w-lg"} rounded-xl border border-slate-800 bg-slate-900 shadow-2xl`}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
