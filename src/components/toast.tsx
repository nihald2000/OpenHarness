import React from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp } from "@/lib/hooks";

export function Toasts() {
  const { toasts, dismissToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="assertive"
      className="fixed right-3 bottom-3 z-50 flex w-[min(24rem,calc(100vw-1.5rem))] flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => {
        const isError = toast.kind === "error";
        const isSuccess = toast.kind === "success";
        const borderCls = isError
          ? "border-danger/50"
          : isSuccess
            ? "border-success/50"
            : "border-border";
        const Icon = isError
          ? AlertCircle
          : isSuccess
            ? CheckCircle2
            : Info;
        const iconColor = isError
          ? "text-danger"
          : isSuccess
            ? "text-success"
            : "text-accent";

        return (
          <div
            key={toast.id}
            role={isError ? "alert" : "status"}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border ${borderCls} bg-elev p-3 text-xs text-fg shadow-xl shadow-black/25 animate-fade-in`}
          >
            <Icon
              className={`mt-0.5 size-4 shrink-0 ${iconColor}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 leading-relaxed break-words">
              {toast.message}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              title="Dismiss notification"
              className="rounded-md p-0.5 text-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
