import { useId, useState } from "react";
import { AlertCircle, ChevronRight } from "lucide-react";
import type {
  CompactionPart,
  Message,
  Part,
  PermissionRequest,
  SkillPart,
  ToolPart,
  VerifyPart,
} from "@/types/sdk";
import { useCatalog } from "@/lib/hooks";
import { Markdown } from "./markdown";
import { CompactionDivider } from "./parts/compaction";
import { PlanCard } from "./parts/plan-card";
import { ReasoningView } from "./parts/reasoning";
import { SkillChip } from "./parts/skill-chip";
import { StepFooter } from "./parts/step-footer";
import { TaskCard } from "./parts/task-card";
import { ToolCard } from "./parts/tool-card";
import { VerifyCard } from "./parts/verify-card";

export function WorkingIndicator({ label = "Working" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 py-1 text-xs text-muted"
    >
      <span className="inline-flex items-center gap-1" aria-hidden="true">
        <span
          className="size-1.5 rounded-full bg-accent animate-bounce"
          style={{ animationDelay: "-0.3s" }}
        />
        <span
          className="size-1.5 rounded-full bg-accent animate-bounce"
          style={{ animationDelay: "-0.15s" }}
        />
        <span
          className="size-1.5 rounded-full bg-accent animate-bounce"
          style={{ animationDelay: "0s" }}
        />
      </span>
      <span>{label}</span>
    </div>
  );
}

function SyntheticDisclosure({
  texts,
  hasVerify,
}: {
  texts: string[];
  hasVerify: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (texts.length === 0) return null;

  const label = hasVerify
    ? "Fix instructions sent to the agent"
    : "Injected context";

  return (
    <div className={`mt-2 ${hasVerify ? "text-left" : "text-right"}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panelId}
        className="touch-target inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted transition-colors duration-150 ease-out hover:bg-hover hover:text-fg"
      >
        <ChevronRight
          className={`size-3.5 transition-transform duration-150 ease-out ${
            open ? "rotate-90" : ""
          }`}
          aria-hidden="true"
        />
        <span>{label}</span>
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-1 rounded-xl border border-border bg-elev p-3 text-left font-mono text-xs text-muted whitespace-pre-wrap"
        >
          {texts.join("\n\n")}
        </div>
      )}
    </div>
  );
}

function UserMessageRow({ message }: { message: Message }) {
  const regularTexts: string[] = [];
  const syntheticTexts: string[] = [];
  const verifyParts: VerifyPart[] = [];
  const skillParts: SkillPart[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.synthetic) {
        syntheticTexts.push(part.text);
      } else if (part.text.trim()) {
        regularTexts.push(part.text);
      }
    } else if (part.type === "verify") {
      verifyParts.push(part);
    } else if (part.type === "skill") {
      skillParts.push(part);
    }
  }

  const hasVerify = verifyParts.length > 0;

  return (
    <div className="flex flex-col items-end animate-fade-in">
      {regularTexts.length > 0 && (
        <div className="max-w-[85%] rounded-2xl border border-border bg-elev px-4 py-3 text-base leading-normal text-fg whitespace-pre-wrap">
          {regularTexts.join("\n\n")}
        </div>
      )}

      {skillParts.length > 0 && (
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          {skillParts.map((sp, i) => (
            <SkillChip key={i} part={sp} />
          ))}
        </div>
      )}

      {verifyParts.length > 0 && (
        <div className="w-full">
          {verifyParts.map((vp, i) => (
            <VerifyCard key={i} part={vp} />
          ))}
        </div>
      )}

      <div className="w-full">
        <SyntheticDisclosure texts={syntheticTexts} hasVerify={hasVerify} />
      </div>
    </div>
  );
}

function isPlanTool(part: ToolPart): boolean {
  return (
    part.tool === "update_plan" ||
    part.tool === "plan" ||
    part.tool === "todowrite" ||
    part.tool === "todo_write"
  );
}

function isTaskTool(part: ToolPart): boolean {
  return part.tool === "task" || part.tool === "subagent";
}

export function MessageList({
  messages,
  active = false,
  permissions = [],
  compact = false,
  depth = 0,
}: {
  messages: Message[];
  active?: boolean;
  permissions?: PermissionRequest[];
  compact?: boolean;
  depth?: number;
}) {
  const { agents } = useCatalog();

  let newestPlanCallId: string | undefined;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool" && isPlanTool(p)) {
        newestPlanCallId = p.callId;
      }
    }
  }

  const pendingCallIds = new Set(permissions.map((p) => p.callId));

  const groups: Array<
    | { kind: "user"; message: Message }
    | { kind: "summary"; message: Message }
    | { kind: "assistant"; agent: string; messages: Message[] }
  > = [];

  for (const msg of messages) {
    if (msg.info.summary) {
      groups.push({ kind: "summary", message: msg });
      continue;
    }
    if (msg.info.role === "user") {
      groups.push({ kind: "user", message: msg });
      continue;
    }
    const agentName = msg.info.agent || "assistant";
    const prev = groups[groups.length - 1];
    if (prev && prev.kind === "assistant" && prev.agent === agentName) {
      prev.messages.push(msg);
    } else {
      groups.push({
        kind: "assistant",
        agent: agentName,
        messages: [msg],
      });
    }
  }

  const lastMessage = messages[messages.length - 1];
  const showTrailingIndicator =
    active &&
    (!lastMessage ||
      lastMessage.info.role === "user" ||
      Boolean(lastMessage.completedAt));

  return (
    <div className={`flex flex-col ${compact ? "gap-4" : "gap-6"}`}>
      {groups.map((group, gIdx) => {
        if (group.kind === "user") {
          return <UserMessageRow key={group.message.info.id} message={group.message} />;
        }

        if (group.kind === "summary") {
          const compactions = group.message.parts.filter(
            (p): p is CompactionPart => p.type === "compaction"
          );
          return (
            <div key={group.message.info.id}>
              {compactions.map((cp, idx) => (
                <CompactionDivider key={idx} part={cp} />
              ))}
            </div>
          );
        }

        const agentInfo = agents.find((a) => a.name === group.agent);
        const dotColor = agentInfo?.color || "var(--accent)";
        const isLastGroup = gIdx === groups.length - 1;
        const lastInGroup = group.messages[group.messages.length - 1];
        const isGroupStreaming =
          active && isLastGroup && Boolean(lastInGroup && !lastInGroup.completedAt);

        return (
          <div
            key={group.messages[0]?.info.id ?? gIdx}
            className="flex gap-3 animate-fade-in"
          >
            <div
              className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-elev"
              aria-hidden="true"
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: dotColor }}
              />
            </div>

            <div className="min-w-0 flex-1">
              <div className="mb-1 text-xs font-semibold text-fg">
                {group.agent}
              </div>

              <div className="space-y-3">
                {group.messages.map((msg, mIdx) => {
                  const isMsgStreaming =
                    isGroupStreaming && mIdx === group.messages.length - 1;

                  const visibleParts = msg.parts.filter(
                    (p) =>
                      p.type !== "step" &&
                      !(p.type === "text" && (!p.text || p.synthetic))
                  );

                  let lastTextIdx = -1;
                  msg.parts.forEach((p, idx) => {
                    if (p.type === "text" && !p.synthetic && p.text) {
                      lastTextIdx = idx;
                    }
                  });

                  return (
                    <div key={msg.info.id} className="space-y-2">
                      {msg.parts.map((part: Part, pIdx: number) => {
                        if (part.type === "text") {
                          if (part.synthetic || !part.text) return null;
                          return (
                            <Markdown
                              key={pIdx}
                              streaming={isMsgStreaming && pIdx === lastTextIdx}
                            >
                              {part.text}
                            </Markdown>
                          );
                        }
                        if (part.type === "reasoning") {
                          return (
                            <ReasoningView
                              key={pIdx}
                              text={part.text}
                              streaming={isMsgStreaming && pIdx === msg.parts.length - 1}
                            />
                          );
                        }
                        if (part.type === "skill") {
                          return (
                            <div key={pIdx} className="my-1">
                              <SkillChip part={part} />
                            </div>
                          );
                        }
                        if (part.type === "compaction") {
                          return <CompactionDivider key={pIdx} part={part} />;
                        }
                        if (part.type === "verify") {
                          return <VerifyCard key={pIdx} part={part} />;
                        }
                        if (part.type === "tool") {
                          if (isPlanTool(part)) {
                            if (part.callId === newestPlanCallId) {
                              return (
                                <PlanCard
                                  key={part.callId || pIdx}
                                  part={part}
                                  live={isMsgStreaming}
                                />
                              );
                            }
                            return (
                              <ToolCard
                                key={part.callId || pIdx}
                                part={part}
                                needsApproval={pendingCallIds.has(part.callId)}
                              />
                            );
                          }
                          if (isTaskTool(part)) {
                            return (
                              <TaskCard
                                key={part.callId || pIdx}
                                part={part}
                                depth={depth}
                              />
                            );
                          }
                          return (
                            <ToolCard
                              key={part.callId || pIdx}
                              part={part}
                              needsApproval={pendingCallIds.has(part.callId)}
                            />
                          );
                        }
                        return null;
                      })}

                      {isMsgStreaming && visibleParts.length === 0 && (
                        <WorkingIndicator label="Thinking" />
                      )}

                      {msg.info.error && (
                        <div
                          role="alert"
                          className="mt-2 flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
                        >
                          <AlertCircle
                            className="mt-0.5 size-4 shrink-0"
                            aria-hidden="true"
                          />
                          <span>{msg.info.error}</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {!isGroupStreaming && <StepFooter messages={group.messages} />}
            </div>
          </div>
        );
      })}

      {showTrailingIndicator && <WorkingIndicator label="Working" />}
    </div>
  );
}
