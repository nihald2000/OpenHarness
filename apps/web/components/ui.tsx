"use client";

import React from "react";
import { Loader2 } from "lucide-react";
import type { ConnectionStatus, RunStatus } from "@openharness/sdk";

export function Spinner({ className = "size-3.5" }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} aria-hidden="true" />;
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "border-border bg-subtle text-muted",
  accent: "border-accent/40 bg-accent/10 text-accent",
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  danger: "border-danger/40 bg-danger/10 text-danger",
};

export function Badge({
  tone = "neutral",
  size = "sm",
  children,
  className = "",
  title,
}: {
  tone?: BadgeTone;
  size?: "sm" | "md";
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  const sizeCls =
    size === "md"
      ? "px-2.5 py-0.5 text-xs leading-5"
      : "px-2 py-0.5 text-[11px] leading-4";
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border font-medium whitespace-nowrap ${sizeCls} ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

const STATUS_META: Record<
  RunStatus,
  { label: string; color: string; pulse?: boolean }
> = {
  idle: { label: "Idle", color: "bg-muted" },
  queued: { label: "Queued", color: "bg-accent", pulse: true },
  running: { label: "Running", color: "bg-accent", pulse: true },
  awaiting_permission: {
    label: "Awaiting approval",
    color: "bg-warning",
    pulse: true,
  },
  verifying: { label: "Verifying", color: "bg-accent", pulse: true },
  completed: { label: "Completed", color: "bg-success" },
  failed: { label: "Failed", color: "bg-danger" },
  cancelled: { label: "Cancelled", color: "bg-muted" },
};

export function StatusDot({ status = "idle" }: { status?: RunStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.idle;
  return (
    <span
      role="status"
      aria-label={meta.label}
      title={meta.label}
      className="relative inline-flex size-2 shrink-0 items-center justify-center"
    >
      {meta.pulse && (
        <span
          className={`absolute inset-0 rounded-full ${meta.color} animate-ping opacity-35`}
          aria-hidden="true"
        />
      )}
      <span className={`relative size-2 rounded-full ${meta.color}`} />
    </span>
  );
}

export function ConnectionIndicator({
  status,
  hideLabelOnMobile = false,
}: {
  status: ConnectionStatus;
  hideLabelOnMobile?: boolean;
}) {
  const map: Record<
    ConnectionStatus,
    { label: string; dot: string; pulse?: boolean }
  > = {
    open: { label: "Live", dot: "bg-success" },
    connecting: { label: "Connecting", dot: "bg-warning", pulse: true },
    reconnecting: { label: "Reconnecting", dot: "bg-warning", pulse: true },
    closed: { label: "Offline", dot: "bg-danger" },
  };
  const info = map[status] ?? map.closed;
  return (
    <span
      role="status"
      aria-live="polite"
      title={`Stream: ${info.label}`}
      className="inline-flex items-center gap-1.5 text-xs text-muted"
    >
      <span className="relative inline-flex size-2 shrink-0">
        {info.pulse && (
          <span
            className={`absolute inset-0 rounded-full ${info.dot} animate-ping opacity-35`}
            aria-hidden="true"
          />
        )}
        <span className={`relative size-2 rounded-full ${info.dot}`} />
      </span>
      <span className={hideLabelOnMobile ? "hidden md:inline" : ""}>
        {info.label}
      </span>
    </span>
  );
}

export function IconButton({
  label,
  onClick,
  active,
  disabled,
  size = "sm",
  children,
  className = "",
  type = "button",
}: {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  size?: "sm" | "md";
  children: React.ReactNode;
  className?: string;
  type?: "button" | "submit";
}) {
  const dim = size === "md" ? "size-8" : "size-7";
  const activeCls = active ? "bg-hover text-fg" : "text-muted";
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`inline-flex ${dim} shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40 ${activeCls} ${className}`}
    >
      {children}
    </button>
  );
}

export function BrandLogo({ className = "size-6" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <defs>
        <linearGradient
          id="oh-brand-grad"
          x1="0"
          y1="0"
          x2="64"
          y2="64"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#406eff" />
          <stop offset="100%" stopColor="#8b55ff" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="28" fill="url(#oh-brand-grad)" />
      <circle cx="32" cy="32" r="26" stroke="#ffffff" strokeWidth="5" />
      <path
        d="M32 12v8M32 44v8M12 32h8M44 32h8"
        stroke="#ffffff"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}
