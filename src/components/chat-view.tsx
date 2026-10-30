import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, RefreshCw } from "lucide-react";
import { Link, useRouter } from "@/lib/router";
import {
  latestPlan,
  planProgress,
  type ContextUsage,
  type OpenHarnessEvent,
} from "@/types/sdk";
import { client } from "@/lib/client";
import { errorMessage, isActive, stringify } from "@/lib/format";
import { useApp, useCatalog, usePermissions } from "@/lib/hooks";
import {
  setPendingPrompt,
  takePendingPrompt,
} from "@/lib/pending-prompts";
import { useSession } from "@/lib/use-session";
import { CapabilitiesPanel } from "./capabilities-panel";
import { ChatHeader } from "./chat-header";
import { Composer, type ComposerHandle } from "./composer";
import { EmptyState, type SuggestionItem } from "./empty-state";
import { PermissionPrompt } from "./permission-prompt";
import { PlanDock } from "./plan-dock";
import { Transcript } from "./transcript";
import { Spinner } from "./ui";

const APPROVE_TEXT =
  "Approved. Execute the plan step by step, keeping the plan updated.";
const BUILD_AGENT = "assistant";
const NOTHING_TO_COMPACT = "Nothing to compact yet.";

export function ChatView({ sessionId }: { sessionId?: string }) {
  const router = useRouter();
  const {
    notify,
    setActiveSessionId,
    upsertSession,
    loadPermissions,
    replyPermission,
    ingestEvent,
    draft,
    setDraftField,
  } = useApp();

  const {
    commands,
    defaultAgent,
    defaultModel,
    defaultRuntime,
  } = useCatalog();

  const [settleTick, setSettleTick] = useState(0);
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [stickTrigger, setStickTrigger] = useState(0);

  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);

  const composerRef = useRef<ComposerHandle>(null);

  const handleStreamEvent = useCallback(
    (ev: OpenHarnessEvent) => {
      ingestEvent(ev);
      if (ev.type === "fix.status") {
        if (ev.phase === "succeeded") {
          notify(
            "success",
            `Fix loop passed${ev.reason ? ` - ${ev.reason}` : ""}`
          );
        } else if (ev.phase === "failed" || ev.phase === "stopped") {
          const details = (ev.reason || "").replace(/^Stopped:\s*/i, "");
          notify(
            "error",
            `Fix loop ${ev.phase}${details ? `: ${details}` : ""}`
          );
        }
      } else if (ev.type === "run.status") {
        if (!isActive(ev.status)) {
          setSettleTick((t) => t + 1);
          setCompacting(false);
          setStopping(false);
          if (ev.error === NOTHING_TO_COMPACT) {
            notify(
              "info",
              "Nothing to compact yet - the conversation is still short."
            );
          }
        }
      } else if (
        ev.type === "part.updated" &&
        ev.part.type === "compaction"
      ) {
        setCompacting(false);
        notify("success", `Context compacted - ${stringify(ev.part.compactedMessages)} messages`);
      }
    },
    [ingestEvent, notify]
  );

  const {
    session,
    messages,
    loading,
    notFound,
    deleted,
    error,
    fix,
    refreshSession,
    resetFix,
  } = useSession(sessionId, handleStreamEvent);

  const permissions = usePermissions(sessionId);

  const readOnly = Boolean(session?.parentId);
  const selectedAgent = session?.agent ?? draft.agent ?? defaultAgent;
  const selectedModel = session?.model ?? draft.model ?? defaultModel;
  const selectedRuntime = session?.runtime ?? draft.runtime ?? defaultRuntime;

  useEffect(() => {
    setActiveSessionId(sessionId ?? null);
    return () => setActiveSessionId(null);
  }, [sessionId, setActiveSessionId]);

  useEffect(() => {
    const pageTitle = session?.title || "Chat";
    document.title = `${pageTitle} - OpenHarness`;
  }, [session?.title]);

  useEffect(() => {
    if (session) {
      upsertSession(session);
    }
  }, [session, upsertSession]);

  useEffect(() => {
    if (sessionId) {
      void loadPermissions(sessionId);
    }
  }, [sessionId, loadPermissions]);

  useEffect(() => {
    if (deleted) {
      notify("info", "This session was deleted.");
      router.replace("/");
    }
  }, [deleted, notify, router]);

  const userMessageCount = useMemo(
    () => messages.filter((m) => m.info.role === "user").length,
    [messages]
  );
  const prevUserMsgCount = useRef(userMessageCount);
  useEffect(() => {
    if (userMessageCount > prevUserMsgCount.current) {
      setOptimisticPrompt(null);
    }
    prevUserMsgCount.current = userMessageCount;
  }, [userMessageCount]);

  const fetchContextUsage = useCallback(async () => {
    if (!sessionId) return;
    setContextLoading(true);
    try {
      const res = await client.session.context(sessionId);
      setContextUsage(res.contextUsage);
      setContextError(null);
    } catch (err) {
      setContextError(errorMessage(err));
    } finally {
      setContextLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    if (sessionId && !loading && !notFound) {
      void fetchContextUsage();
    }
  }, [sessionId, loading, notFound, settleTick, fetchContextUsage]);

  const sendPromptToSession = useCallback(
    async (
      targetId: string,
      text: string,
      opts?: { agent?: string; fix?: { commands: string[] } }
    ) => {
      setOptimisticPrompt(text);
      setStickTrigger((t) => t + 1);
      resetFix();
      setSending(true);
      try {
        await client.session.prompt(targetId, {
          text,
          agent: opts?.agent,
          fix: opts?.fix,
        });
      } catch (err) {
        setOptimisticPrompt(null);
        composerRef.current?.setText(text);
        notify("error", errorMessage(err));
      } finally {
        setSending(false);
      }
    },
    [notify, resetFix]
  );

  useEffect(() => {
    if (!sessionId || loading || notFound) return;
    const pending = takePendingPrompt(sessionId);
    if (pending) {
      void sendPromptToSession(sessionId, pending.text, {
        agent: pending.agent,
        fix: pending.fix,
      });
    }
  }, [sessionId, loading, notFound, sendPromptToSession]);

  const handleSend = async (
    text: string,
    fixOpts?: { commands: string[] },
    overrideAgent?: string
  ) => {
    if (sessionId) {
      await sendPromptToSession(sessionId, text, {
        agent: overrideAgent,
        fix: fixOpts,
      });
      return;
    }

    setSending(true);
    setOptimisticPrompt(text);
    setStickTrigger((t) => t + 1);
    try {
      const created = await client.session.create({
        agent: overrideAgent ?? selectedAgent,
        model: selectedModel || undefined,
        runtime: draft.runtime || undefined,
      });
      upsertSession(created);
      setPendingPrompt(created.id, {
        text,
        agent: overrideAgent,
        fix: fixOpts,
      });
      router.push(`/c/${encodeURIComponent(created.id)}`);
    } catch (err) {
      setOptimisticPrompt(null);
      composerRef.current?.setText(text);
      notify("error", `Could not start a chat: ${errorMessage(err)}`);
    } finally {
      setSending(false);
    }
  };

  const handleSelectAgent = async (agent: string) => {
    if (session) {
      try {
        const updated = await client.session.update(session.id, { agent });
        upsertSession(updated);
      } catch (err) {
        notify("error", `Could not update session: ${errorMessage(err)}`);
      }
    } else {
      setDraftField("agent", agent);
    }
  };

  const handleSelectModel = async (model: string) => {
    if (session) {
      try {
        const updated = await client.session.update(session.id, { model });
        upsertSession(updated);
      } catch (err) {
        notify("error", `Could not update session: ${errorMessage(err)}`);
      }
    } else {
      setDraftField("model", model);
    }
  };

  const handleSelectRuntime = async (runtime: string | null) => {
    if (session) {
      try {
        const updated = await client.session.update(session.id, { runtime });
        upsertSession(updated);
      } catch (err) {
        notify("error", `Could not update session: ${errorMessage(err)}`);
      }
    } else {
      setDraftField("runtime", runtime ?? undefined);
    }
  };

  const handleRenameTitle = async (title: string) => {
    if (!session) return;
    try {
      const updated = await client.session.update(session.id, { title });
      upsertSession(updated);
    } catch (err) {
      notify("error", `Could not update session: ${errorMessage(err)}`);
    }
  };

  const handleStop = async () => {
    if (!sessionId) return;
    setStopping(true);
    try {
      await client.session.abort(sessionId);
    } catch (err) {
      setStopping(false);
      notify("error", `Could not stop: ${errorMessage(err)}`);
    }
  };

  const handleCompact = async () => {
    if (!sessionId) return;
    setCompacting(true);
    try {
      await client.session.compact(sessionId);
      await fetchContextUsage();
    } catch (err) {
      if (errorMessage(err) === NOTHING_TO_COMPACT) {
        notify(
          "info",
          "Nothing to compact yet - the conversation is still short."
        );
      } else {
        notify("error", `Could not compact: ${errorMessage(err)}`);
      }
    } finally {
      setCompacting(false);
    }
  };

  const handlePickSuggestion = (s: SuggestionItem) => {
    if (s.fixCommand) {
      composerRef.current?.enableVerifyWith(s.fixCommand);
    }
    if (s.agent) {
      setDraftField("agent", s.agent);
    }
    void handleSend(
      s.prompt,
      s.fixCommand ? { commands: [s.fixCommand] } : undefined,
      s.agent
    );
  };

  const { plan, stale: planStale } = useMemo(
    () => latestPlan(messages),
    [messages]
  );
  const activeRun = isActive(session?.status) || compacting;
  const isActivePlan = Boolean(plan && !planStale && !optimisticPrompt);
  const prog = plan ? planProgress(plan) : null;

  const showApprovalBar = Boolean(
    isActivePlan &&
      plan &&
      selectedAgent === "plan" &&
      !readOnly &&
      !activeRun
  );
  const showProgressDock = Boolean(
    isActivePlan && plan && !showApprovalBar && prog && !prog.done
  );

  const handleApprovePlan = async () => {
    if (!session) return;
    try {
      const updated = await client.session.update(session.id, {
        agent: BUILD_AGENT,
      });
      upsertSession(updated);
      await sendPromptToSession(session.id, APPROVE_TEXT, {
        agent: BUILD_AGENT,
      });
    } catch (err) {
      notify("error", errorMessage(err));
    }
  };

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <ChatHeader
          session={session}
          selectedAgent={selectedAgent}
          selectedModel={selectedModel}
          selectedRuntime={selectedRuntime}
          onSelectAgent={(a) => void handleSelectAgent(a)}
          onSelectModel={(m) => void handleSelectModel(m)}
          onSelectRuntime={(r) => void handleSelectRuntime(r)}
          onRenameTitle={(t) => void handleRenameTitle(t)}
          contextUsage={contextUsage}
          contextError={contextError}
          contextLoading={contextLoading}
          onRefreshContext={() => void fetchContextUsage()}
          onCompact={() => void handleCompact()}
          compacting={compacting}
          fix={fix}
          readOnly={readOnly}
        />

        {notFound ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <h2 className="text-base font-semibold text-fg">
              Session not found
            </h2>
            <p className="mt-1 text-xs text-muted">
              It may have been deleted.
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-accent-fg hover:bg-accent-strong"
            >
              Start a new chat
            </Link>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
            <h2 className="text-base font-semibold text-fg">
              Could not load this chat
            </h2>
            <p className="mt-1 max-w-md text-xs text-danger">{error}</p>
            <button
              type="button"
              onClick={() => void refreshSession()}
              className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elev px-3 text-xs font-medium text-fg hover:bg-hover"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        ) : loading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner className="size-5 text-accent" />
          </div>
        ) : messages.length === 0 && !optimisticPrompt ? (
          <EmptyState
            selectedModel={selectedModel}
            onSelectModel={(m) => void handleSelectModel(m)}
            onPickSuggestion={handlePickSuggestion}
          />
        ) : (
          <Transcript
            messages={messages}
            status={session?.status}
            error={session?.error}
            optimisticPrompt={optimisticPrompt}
            permissions={permissions}
            stickTrigger={stickTrigger}
            activityOverride={compacting ? "Compacting context" : null}
          />
        )}

        {!notFound && !error && (
          <div className="shrink-0">
            <PermissionPrompt
              requests={permissions}
              onReply={replyPermission}
            />

            {plan && showApprovalBar && (
              <PlanDock
                plan={plan}
                mode="approval"
                busy={sending || activeRun}
                onApprove={() => void handleApprovePlan()}
                onRevise={() => composerRef.current?.focus()}
              />
            )}

            {plan && showProgressDock && (
              <PlanDock plan={plan} mode="progress" />
            )}

            {readOnly && session?.parentId ? (
              <div className="mx-auto w-full max-w-3xl px-4 pb-3">
                <div className="flex items-center justify-between rounded-xl border border-border bg-elev px-3.5 py-2.5 text-xs text-muted">
                  <span className="inline-flex items-center gap-2">
                    <Eye className="size-4" aria-hidden="true" />
                    <span>This is a read-only subagent session.</span>
                  </span>
                  <Link
                    href={`/c/${encodeURIComponent(session.parentId)}`}
                    className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline"
                  >
                    <ArrowLeft className="size-3.5" aria-hidden="true" />
                    <span>Parent chat</span>
                  </Link>
                </div>
              </div>
            ) : (
              <Composer
                ref={composerRef}
                agentName={selectedAgent}
                isPlanMode={selectedAgent === "plan"}
                commands={commands}
                active={activeRun}
                sending={sending}
                stopping={stopping}
                onSend={(t, f) => void handleSend(t, f)}
                onStop={() => void handleStop()}
              />
            )}
          </div>
        )}
      </div>

      <CapabilitiesPanel activeAgent={selectedAgent} />
    </div>
  );
}
