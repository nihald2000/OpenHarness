"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowDown } from "lucide-react";
import type { Message, PermissionRequest, RunStatus } from "@openharness/sdk";
import { activityLabel, isActive } from "@/lib/format";
import { MessageList, WorkingIndicator } from "./message-row";

export function Transcript({
  messages,
  status,
  error,
  optimisticPrompt,
  permissions,
  stickTrigger,
  activityOverride,
}: {
  messages: Message[];
  status?: RunStatus;
  error?: string;
  optimisticPrompt?: string | null;
  permissions: PermissionRequest[];
  stickTrigger?: number;
  activityOverride?: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
    pinnedRef.current = true;
    setShowJump(false);
  }, []);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNearBottom = distance <= 60;
    pinnedRef.current = isNearBottom;
    setShowJump(!isNearBottom);
  };

  useEffect(() => {
    scrollToBottom(false);
  }, [stickTrigger, scrollToBottom]);

  useEffect(() => {
    if (pinnedRef.current) {
      scrollToBottom(false);
    }
  }, [messages, optimisticPrompt, status, scrollToBottom]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) {
        scrollToBottom(false);
      }
    });
    ro.observe(contentEl);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  const active = isActive(status) || Boolean(activityOverride);
  const lastMsg = messages[messages.length - 1];
  const lastMsgHasError = Boolean(lastMsg?.info.error);

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        role="log"
        aria-label="Conversation"
        className="h-full overflow-y-auto"
      >
        <div
          ref={contentRef}
          className="mx-auto max-w-3xl px-4 pt-6 pb-8 space-y-4"
        >
          <MessageList
            messages={messages}
            active={active && !optimisticPrompt}
            permissions={permissions}
          />

          {optimisticPrompt && (
            <div className="flex flex-col items-end gap-2 opacity-70">
              <div className="max-w-[85%] rounded-2xl rounded-br-md border border-accent/25 bg-accent/12 px-4 py-2.5 text-[15px] leading-relaxed text-fg whitespace-pre-wrap">
                {optimisticPrompt}
              </div>
              <WorkingIndicator label="Sending..." />
            </div>
          )}

          {activityOverride && (
            <div className="pt-1">
              <WorkingIndicator label={activityOverride} />
            </div>
          )}

          {!activityOverride &&
            active &&
            status &&
            status !== "running" && (
              <div className="pt-1">
                <WorkingIndicator label={activityLabel(status)} />
              </div>
            )}

          {!active && status === "failed" && error && !lastMsgHasError && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-xs text-danger"
            >
              <AlertCircle
                className="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span>Run failed: {error}</span>
            </div>
          )}

          {!active && status === "cancelled" && (
            <div
              role="status"
              className="rounded-xl border border-border bg-subtle px-3.5 py-2 text-xs text-muted"
            >
              Run stopped.
            </div>
          )}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-border bg-elev px-3 py-1.5 text-xs font-medium text-fg shadow-lg shadow-black/30 transition-colors hover:bg-hover animate-fade-in"
        >
          <ArrowDown className="size-3.5 text-accent" aria-hidden="true" />
          <span>Jump to latest</span>
        </button>
      )}
    </div>
  );
}
