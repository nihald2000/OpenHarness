import React from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useApp } from "@/lib/hooks";

export function Toasts() {
  const { toasts, dismissToast } = useApp();

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="assertive"
      className="fixed right-4 bottom-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => {
        const isError = toast.kind === "error";
        const isSuccess = toast.kind === "success";
        const borderCls = isError
          ? "border-danger/35"
          : isSuccess
            ? "border-success/35"
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
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border ${borderCls} bg-bg p-3 text-xs text-fg shadow-menu animate-fade-in`}
          >
            <Icon
              className={`mt-0.5 size-4 shrink-0 ${iconColor}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 leading-normal break-words">
              {toast.message}
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              aria-label="Dismiss notification"
              title="Dismiss notification"
              className="touch-target inline-flex size-6 items-center justify-center rounded-lg text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
