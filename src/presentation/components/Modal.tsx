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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[#02040b]/82 px-4 py-10 backdrop-blur-lg sm:items-center">
      <div
        className={`w-full ${widthClassName ?? "max-w-lg"} overflow-hidden rounded-2xl border border-indigo-300/[.12] bg-gradient-to-br from-[#111a2e] to-[#0a1120] shadow-[0_35px_120px_rgba(0,0,0,.62)]`}
      >
        <div className="flex items-center justify-between border-b border-white/[.07] bg-white/[.025] px-6 py-5">
          <h2 className="text-base font-semibold tracking-[-.01em] text-slate-100">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg border border-transparent p-1.5 text-slate-400 hover:border-white/[.08] hover:bg-white/[.05] hover:text-slate-100"
            aria-label={t("common.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-6">{children}</div>
      </div>
    </div>
  );
}
