import React from "react";
import type { Message } from "@openharness/sdk";
import { formatDuration, formatTokens } from "@/lib/format";

export function StepFooter({ messages }: { messages: Message[] }) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let modelCalls = 0;
  const toolCallIds = new Set<string>();

  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool") toolCallIds.add(p.callId);
      if (p.type === "step") {
        inputTokens += p.usage?.input ?? 0;
        outputTokens += p.usage?.output ?? 0;
      }
    }
    if (!m.parts.some((p) => p.type === "step") && m.info.role === "assistant" && !m.info.summary && (m.info.usage || m.info.model)) {
      modelCalls += 1;
    }
    if (!m.parts.some((p) => p.type === "step") && m.info.usage) {
      inputTokens += m.info.usage.input ?? 0;
      outputTokens += m.info.usage.output ?? 0;
    }
  }

  const startMs =
    typeof first.createdAt === "number"
      ? first.createdAt
      : new Date(first.createdAt).getTime();
  const endMs = last.completedAt
    ? typeof last.completedAt === "number"
      ? last.completedAt
      : new Date(last.completedAt).getTime()
    : undefined;
  const duration =
    endMs && startMs && endMs >= startMs
      ? formatDuration(endMs - startMs)
      : "";

  const items: string[] = [];
  items.push(`${toolCallIds.size} tool calls · ${modelCalls} model calls · ${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out${duration ? ` · ${duration}` : ""}`);

  if (items.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
      {items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}
