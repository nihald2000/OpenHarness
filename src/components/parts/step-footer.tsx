import React from "react";
import type { Message } from "@openharness/sdk";
import { formatCost, formatDuration, formatTokens } from "@/lib/format";

export function StepFooter({ messages }: { messages: Message[] }) {
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last) return null;

  let steps = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCost = 0;
  let modelCalls = 0;
  const toolCallIds = new Set<string>();

  for (const m of messages) {
    let msgSteps = 0;
    for (const p of m.parts) {
      if (p.type === "tool") toolCallIds.add(p.callId);
      if (p.type === "step") {
        msgSteps += 1;
        inputTokens += p.usage?.input ?? 0;
        outputTokens += p.usage?.output ?? 0;
        totalCost += p.cost ?? 0;
      }
    }
    steps += msgSteps;
    if (msgSteps === 0 && m.info.role === "assistant" && !m.info.summary && (m.info.usage || m.info.model)) {
      modelCalls += 1;
    }
    if (msgSteps === 0 && m.info.usage) {
      inputTokens += m.info.usage.input ?? 0;
      outputTokens += m.info.usage.output ?? 0;
      totalCost += m.info.cost ?? 0;
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
  if (first.info.agent) items.push(first.info.agent);
  if (first.info.model) items.push(first.info.model);
  if (steps > 0) items.push(`${steps} ${steps === 1 ? "step" : "steps"}`);
  if (toolCallIds.size > 0 || modelCalls > 0) {
    items.push(`${toolCallIds.size} tool calls · ${modelCalls} model calls · ${formatTokens(inputTokens)} in · ${formatTokens(outputTokens)} out`);
  }
  if (totalCost > 0) {
    items.push(formatCost(totalCost));
  }
  if (duration) {
    items.push(duration);
  }

  if (items.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
      {items.map((item, idx) => (
        <React.Fragment key={idx}>
          {idx > 0 && <span className="text-muted">·</span>}
          <span>{item}</span>
        </React.Fragment>
      ))}
    </div>
  );
}
