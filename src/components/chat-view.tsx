import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Eye, RefreshCw } from "lucide-react";
import { Link, useRouter } from "@/lib/router";
import {
  latestPlan,
  planProgress,
  type ContextUsage,
  type OpenHarnessEvent,
} from "@openharness/sdk";
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
import { Composer, type ComposerHandle, type SelectedAttachment } from "./composer";
import { EmptyState } from "./empty-state";
import { PermissionPrompt } from "./permission-prompt";
import { PlanDock } from "./plan-dock";
import { Transcript } from "./transcript";
import { Spinner } from "./ui";
import { LiveBrowser, type BrowserDockState } from "./live-browser";
import { StudioCanvas } from "./studio-canvas";

const APPROVE_TEXT =
  "Approved. Execute the plan step by step, keeping the plan updated.";
const BUILD_AGENT = "assistant";
const NOTHING_TO_COMPACT = "Nothing to compact yet.";

function maskModalPreviewUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("/preview/")) {
    return `${window.location.origin}${value}`;
  }
  try {
    const url = new URL(value);
    if (
      url.hostname.endsWith(".modal.run") &&
      url.hostname.includes("openharness-sandboxd-sandboxd") &&
      url.pathname.startsWith("/preview/")
    ) {
      return `${window.location.origin}${url.pathname}${url.search}${url.hash}`;
    }
    if (
      (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "0.0.0.0") &&
      url.port &&
      url.port !== "3000" &&
      url.port !== "4096" &&
      url.port !== "8080"
    ) {
      return `${window.location.origin}/preview/${url.port}${url.pathname === "/" ? "/" : url.pathname}${url.search}${url.hash}`;
    }
  } catch {
    // Keep non-URL values out of the preview link state.
  }
  return value;
}

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
    models,
    runtimes,
    defaultAgent,
    defaultModel,
    defaultRuntime,
    loading: catalogLoading,
  } = useCatalog();

  const [settleTick, setSettleTick] = useState(0);
  const [optimisticPrompt, setOptimisticPrompt] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [takeover, setTakeover] = useState<{ runId: string; reason: string; instructions?: string } | null>(null);
  const [takeoverNote, setTakeoverNote] = useState("");
  const [takeoverBusy, setTakeoverBusy] = useState(false);
  const [browserDock, setBrowserDock] = useState<BrowserDockState>("closed");
  const [studioOpen, setStudioOpen] = useState(false);
  const [studioTargetPath, setStudioTargetPath] = useState<string | undefined>();
  const [browserVerification, setBrowserVerification] = useState<{ check: string; status: "running" | "passed" | "failed" } | null>(null);
  const [dockWidth, setDockWidth] = useState(() => {
    try { return Math.max(360, Math.min(1100, Number(localStorage.getItem("oh.dockWidth")) || window.innerWidth * 0.5)); }
    catch { return Math.max(360, Math.min(1100, window.innerWidth * 0.5)); }
  });
  const browserAutoOpened = useRef(false);
  const [waitingForRunSlot, setWaitingForRunSlot] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [stickTrigger, setStickTrigger] = useState(0);

  const [runMode, setRunMode] = useState<"task" | "ask">(() => {
    try { return localStorage.getItem("oh-default-mode") === "ask" ? "ask" : "task"; } catch { return "task"; }
  });
  const [pendingQuestion, setPendingQuestion] = useState<{
    runId: string;
    questionId: string;
    question: string;
    options?: string[];
  } | null>(null);
  const [questionAnswer, setQuestionAnswer] = useState("");
  const [runError, setRunError] = useState<{
    runId?: string;
    code?: string;
    message: string;
    recoverable?: boolean;
  } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [changedFiles, setChangedFiles] = useState<string[]>([]);
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);

  const composerRef = useRef<ComposerHandle>(null);
  const pendingStateRevision = useRef(0);
  useEffect(() => {
    const listener = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) { composerRef.current?.setText(prompt); composerRef.current?.focus(); }
    };
    window.addEventListener("oh:try-fix", listener);
    return () => window.removeEventListener("oh:try-fix", listener);
  }, []);
  useEffect(() => {
    const listener = (event: Event) => {
      const filePath = (event as CustomEvent<{ path?: string }>).detail?.path;
      if (!filePath) return;
      setStudioTargetPath(filePath);
      setStudioOpen(true);
      setBrowserDock("closed");
    };
    window.addEventListener("oh:open-artifact", listener);
    return () => window.removeEventListener("oh:open-artifact", listener);
  }, []);

  const handleStreamEvent = useCallback(
    (ev: OpenHarnessEvent) => {
      ingestEvent(ev);
      if (ev.type === "run.status" && ev.status === "running") setWaitingForRunSlot(false);
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
      } else if (ev.type === "question.requested") {
        pendingStateRevision.current += 1;
        setPendingQuestion({
          runId: ev.runId,
          questionId: ev.questionId,
          question: ev.question,
          options: ev.options,
        });
      } else if (ev.type === "question.answered") {
        pendingStateRevision.current += 1;
        setPendingQuestion(null);
        setQuestionAnswer("");
      } else if (ev.type === "takeover.requested") {
        setTakeover({ runId: ev.runId, reason: ev.reason, instructions: ev.instructions });
        setStudioOpen(false);
        setBrowserDock("expanded");
      } else if (ev.type === "verify:browser_check") {
        setBrowserVerification({ check: ev.check, status: ev.status });
      } else if (
        ev.type === "part.updated" &&
        ev.part.type === "tool" &&
        (ev.part.tool.startsWith("browser_") || ev.part.tool === "process_start" || ev.part.tool === "preview_url" || ev.part.tool === "request_takeover")
      ) {
        const outObj = ev.part.output && typeof ev.part.output === "object" ? (ev.part.output as Record<string, unknown>) : undefined;
        if (typeof outObj?.previewUrl === "string") {
          setPreviewUrl(maskModalPreviewUrl(outObj.previewUrl));
        }
        setStudioOpen(false);
        if (ev.part.tool === "request_takeover") {
          setBrowserDock("expanded");
        } else if (!browserAutoOpened.current) {
          browserAutoOpened.current = true;
          setBrowserDock("docked");
        }
      } else if (ev.type === "preview.ready") {
        pendingStateRevision.current += 1;
        setPreviewUrl(maskModalPreviewUrl(ev.url));
        setStudioOpen(false);
        if (!browserAutoOpened.current) {
          browserAutoOpened.current = true;
          setBrowserDock("docked");
        }
      } else if (ev.type === "run.completed") {
        pendingStateRevision.current += 1;
        if (ev.changedFiles) setChangedFiles(ev.changedFiles);
        if (ev.previewUrl) setPreviewUrl(maskModalPreviewUrl(ev.previewUrl));
      } else if (ev.type === "run.error") {
        setRunError({
          runId: ev.runId,
          code: ev.code ?? ev.error?.code,
          message: ev.message ?? ev.error?.message ?? "Run failed",
          recoverable: ev.recoverable ?? ev.error?.recoverable ?? true,
        });
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
  const artifactCountSeen = useRef(0);
  const artifactSessionSeen = useRef(sessionId);
  const artifactTrackingReady = useRef(false);
  useEffect(() => {
    const count = messages.reduce((total, message) => total + message.parts.reduce((sum, part) => {
      if (part.type !== "tool") return sum;
      const artifacts = part.metadata?.artifacts;
      if (!Array.isArray(artifacts)) return sum;
      const studioArtifacts = artifacts.filter((a: any) => a && a.kind && a.kind !== "html");
      return sum + studioArtifacts.length;
    }, 0), 0);
    if (artifactSessionSeen.current !== sessionId) {
      artifactSessionSeen.current = sessionId;
      artifactCountSeen.current = count;
      artifactTrackingReady.current = true;
      setStudioOpen(false);
      return;
    }
    if (!artifactTrackingReady.current) {
      artifactCountSeen.current = count;
      artifactTrackingReady.current = true;
      return;
    }
    if (count > artifactCountSeen.current && !takeover) {
      setStudioOpen(true);
      setBrowserDock("closed");
    }
    artifactCountSeen.current = count;
  }, [messages, sessionId, takeover]);

  const permissions = usePermissions(sessionId);

  const readOnly = Boolean(session?.parentId);
  const selectedAgent = session?.agent ?? draft.agent ?? defaultAgent;
  const sessionModelConfigured =
    !session || models.some((model) => model.id === session.model);
  const draftModel = draft.model && models.some((model) => model.id === draft.model)
    ? draft.model
    : "";
  const selectedModel =
    session?.model && sessionModelConfigured
      ? session.model
      : draftModel || defaultModel;
  const selectedModelConfigured =
    sessionModelConfigured && models.some((model) => model.id === selectedModel);
  const selectedRuntime = session?.runtime ?? draft.runtime ?? defaultRuntime;
  const selectedRuntimeInfo = runtimes.find((runtime) => runtime.id === selectedRuntime);
  const runtimeReady = runMode === "ask" || Boolean(selectedRuntimeInfo?.active);

  useEffect(() => {
    setActiveSessionId(sessionId ?? null);
    return () => setActiveSessionId(null);
  }, [sessionId, setActiveSessionId]);

  useEffect(() => {
    pendingStateRevision.current += 1;
    setPendingQuestion(null);
    setQuestionAnswer("");
    setPreviewUrl(null);
    setChangedFiles([]);
    setTakeover(null);
    setTakeoverNote("");
    setBrowserDock("closed");
    setBrowserVerification(null);
    browserAutoOpened.current = false;
  }, [sessionId]);

  const requestTakeover = async () => {
    const runId = session?.activeRunId ?? session?.runId;
    if (!runId || takeoverBusy) return;
    setTakeoverBusy(true);
    setBrowserDock("expanded");
    try {
      const result = await client.runs.takeover(runId, { reason: "User requested browser control" });
      setTakeover({ runId: result.runId ?? runId, reason: "You have browser control. Return control when finished." });
    } catch (err) { notify("error", errorMessage(err)); }
    finally { setTakeoverBusy(false); }
  };

  const returnTakeover = async () => {
    if (!takeover || takeoverBusy) return;
    setTakeoverBusy(true);
    try {
      await client.runs.returnBrowserControl(takeover.runId, takeoverNote);
      setTakeover(null);
      setTakeoverNote("");
      setBrowserDock("docked");
      await refreshSession();
    } catch (err) { notify("error", errorMessage(err)); }
    finally { setTakeoverBusy(false); }
  };

  useEffect(() => {
    if (!sessionId || loading || notFound) return;
    let cancelled = false;
    const revisionAtRequest = pendingStateRevision.current;
    void client.session.pending(sessionId).then((pending) => {
      if (cancelled || revisionAtRequest !== pendingStateRevision.current) return;
      setPendingQuestion(
        pending.runId && pending.pendingQuestion
          ? { ...pending.pendingQuestion, runId: pending.runId }
          : null
      );
      setPreviewUrl(maskModalPreviewUrl(pending.previewUrl));
      setChangedFiles(pending.changedFiles ?? []);
    }).catch((err) => {
      if (!cancelled) notify("error", `Could not restore run state: ${errorMessage(err)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, loading, notFound, notify]);

  useEffect(() => {
    if (!sessionId || loading || notFound) return;
    let cancelled = false;
    const refreshRunState = async () => {
      const revisionAtRequest = pendingStateRevision.current;
      try {
        const pending = await client.session.pending(sessionId);
        if (cancelled) return;
        if (revisionAtRequest === pendingStateRevision.current) {
          setPendingQuestion(
            pending.runId && pending.pendingQuestion
              ? { ...pending.pendingQuestion, runId: pending.runId }
              : null
          );
          setPreviewUrl(maskModalPreviewUrl(pending.previewUrl));
          setChangedFiles(pending.changedFiles ?? []);
        }
      } catch {
        // SSE remains the primary update path; polling repairs missed events.
      }
      if (!cancelled) await loadPermissions(sessionId);
    };
    void refreshRunState();
    if (!isActive(session?.status)) return () => { cancelled = true; };
    const timer = setInterval(() => void refreshRunState(), 2_500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, session?.status, loading, notFound, loadPermissions]);

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
      opts?: { agent?: string; fix?: { commands: string[] }; attachmentIds?: string[]; selectedFiles?: SelectedAttachment[] }
    ) => {
      setOptimisticPrompt(text || (opts?.selectedFiles?.length ? `Attached ${opts.selectedFiles.length} file${opts.selectedFiles.length === 1 ? "" : "s"}` : null));
      setStickTrigger((t) => t + 1);
      resetFix();
      setSending(true);
      try {
        setRunError(null);
        await client.session.prompt(targetId, {
          text,
          agent: opts?.agent,
          mode: runMode,
          clientTurnId: `turn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          fix: opts?.fix,
          attachments: opts?.attachmentIds,
        });
      void refreshSession();
      setTimeout(() => void refreshSession(), 1_500);
      } catch (err) {
        setOptimisticPrompt(null);
        composerRef.current?.setText(text);
        if (opts?.selectedFiles?.length) composerRef.current?.restoreAttachments(opts.selectedFiles);
        notify("error", errorMessage(err));
      } finally {
        setSending(false);
      }
    },
    [notify, resetFix, runMode, refreshSession]
  );

  useEffect(() => {
    if (!sessionId || loading || notFound) return;
    const pending = takePendingPrompt(sessionId);
    if (pending) {
      void sendPromptToSession(sessionId, pending.text, {
        agent: pending.agent,
        fix: pending.fix,
        attachmentIds: pending.attachmentIds,
      });
    }
  }, [sessionId, loading, notFound, sendPromptToSession]);

  const handleSend = async (
    text: string,
    fixOpts?: { commands: string[] },
    selectedFiles: SelectedAttachment[] = [],
    overrideAgent?: string
  ) => {
    if (selectedFiles.length === 0) {
      const command = text.trim();
      if (command === "/compact") {
        if (!sessionId) {
          notify("info", "Nothing to compact yet - the conversation is still short.");
          return;
        }
        await handleCompact();
        return;
      }
      if (command === "/plan" || command.startsWith("/plan ")) {
        await handleSelectAgent("plan");
        const remainingText = command.slice("/plan".length).trimStart();
        if (!remainingText) {
          notify("info", "Switched to plan mode.");
          return;
        }
        await handleSend(remainingText, fixOpts, selectedFiles, "plan");
        return;
      }
    }
    if (!selectedModelConfigured) {
      composerRef.current?.setText(text);
      if (selectedFiles.length) composerRef.current?.restoreAttachments(selectedFiles);
      notify(
        "info",
        models.length === 0
          ? "Configure a model provider in Settings before starting a chat."
          : "Choose a configured model before starting a chat."
      );
      return;
    }
    if (!runtimeReady) {
      composerRef.current?.setText(text);
      if (selectedFiles.length) composerRef.current?.restoreAttachments(selectedFiles);
      notify(
        "info",
        !selectedRuntime
          ? "Choose an available runtime or configure a default runtime in Settings."
          : runMode === "task"
            ? "Code mode requires an active sandbox runtime. Configure Modal, Docker, or SRT before starting a task."
            : "The selected runtime is unavailable. Choose an active runtime or configure one in Settings."
      );
      return;
    }

    if (sessionId) {
      setSending(true);
      const uploadedIds: string[] = [];
      try {
        if (selectedFiles.length) {
          setUploadProgress({ completed: 0, total: selectedFiles.length });
          for (let index = 0; index < selectedFiles.length; index++) {
            const item = selectedFiles[index]!;
            const uploaded = await client.session.uploadAttachment(sessionId, {
              file: item.file,
              path: item.relativePath,
              groupId: item.groupId,
            });
            uploadedIds.push(uploaded.id);
            setUploadProgress({ completed: index + 1, total: selectedFiles.length });
          }
        }
        await sendPromptToSession(sessionId, text, {
          agent: overrideAgent,
          fix: fixOpts,
          attachmentIds: uploadedIds,
          selectedFiles,
        });
      } catch (err) {
        await Promise.all(uploadedIds.map((id) => client.session.deleteAttachment(sessionId, id).catch(() => {})));
        composerRef.current?.setText(text);
        if (selectedFiles.length) composerRef.current?.restoreAttachments(selectedFiles);
        notify("error", errorMessage(err));
      } finally {
        setSending(false);
        setUploadProgress(null);
      }
      return;
    }

    setSending(true);
    setOptimisticPrompt(text || (selectedFiles.length ? `Attached ${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"}` : null));
    setStickTrigger((t) => t + 1);
    let createdId: string | undefined;
    const uploadedIds: string[] = [];
    try {
      const created = await client.session.create({
        agent: overrideAgent ?? selectedAgent,
        model: selectedModel || undefined,
        runtime: draft.runtime || undefined,
      });
      createdId = created.id;
      upsertSession(created);
      if (selectedFiles.length) {
        setUploadProgress({ completed: 0, total: selectedFiles.length });
        for (let index = 0; index < selectedFiles.length; index++) {
          const item = selectedFiles[index]!;
          const uploaded = await client.session.uploadAttachment(created.id, {
            file: item.file,
            path: item.relativePath,
            groupId: item.groupId,
          });
          uploadedIds.push(uploaded.id);
          setUploadProgress({ completed: index + 1, total: selectedFiles.length });
        }
      }
      setPendingPrompt(created.id, {
        text,
        agent: overrideAgent,
        fix: fixOpts,
        attachmentIds: uploadedIds,
      });
      router.push(`/c/${encodeURIComponent(created.id)}`);
    } catch (err) {
      if (createdId) {
        await Promise.all(uploadedIds.map((id) => client.session.deleteAttachment(createdId!, id).catch(() => {})));
        await client.session.delete(createdId).catch(() => {});
      }
      setOptimisticPrompt(null);
      composerRef.current?.setText(text);
      if (selectedFiles.length) composerRef.current?.restoreAttachments(selectedFiles);
      notify("error", `Could not start a chat: ${errorMessage(err)}`);
    } finally {
      setSending(false);
      setUploadProgress(null);
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

  const handleContinueBudgetRun = async () => {
    if (!session?.runId) return;
    try {
      const result = await client.runs.resume(session.runId);
      if (result.queued) setWaitingForRunSlot(true);
      await refreshSession();
    } catch (err) {
      notify("error", `Could not continue run: ${errorMessage(err)}`);
    }
  };

  const handleQuestionAnswer = async (answer: string) => {
    if (!pendingQuestion || !answer.trim() || questionSubmitting) return;
    setQuestionSubmitting(true);
    try {
      const result = await client.runs.answer(pendingQuestion.runId, answer.trim());
      if (result.queued) {
        setWaitingForRunSlot(true);
        notify("info", "Waiting for a free slot. This run will resume automatically.");
      }
      setPendingQuestion(null);
      setQuestionAnswer("");
    } catch (err) {
      notify("error", errorMessage(err));
    } finally {
      setQuestionSubmitting(false);
    }
  };

  const handleDownloadArchive = async () => {
    if (!sessionId) return;
    try {
      const archive = await client.session.archive(sessionId);
      const binary = atob(archive.archiveBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/gzip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = archive.filename || `${sessionId}.tar.gz`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify("error", `Could not download the session archive: ${errorMessage(err)}`);
    }
  };

  const handleCompact = async () => {
    if (!sessionId) return;
    setCompacting(true);
    try {
      await client.session.compact(sessionId);
      await refreshSession();
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
    <div className="grid min-w-0 flex-1 overflow-hidden bg-bg" style={{ gridTemplateColumns: (browserDock === "docked" || studioOpen) && window.matchMedia("(min-width: 768px)").matches ? `minmax(360px, 1fr) 4px minmax(360px, ${dockWidth}px)` : "minmax(0, 1fr)" }}>
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
          onOpenBrowser={() => { setStudioOpen(false); setBrowserDock((current) => current === "closed" ? "docked" : "closed"); }}
          onOpenStudio={() => { setBrowserDock("closed"); setStudioOpen((current) => !current); }}
        />

        {notFound ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center animate-fade-in">
            <h2 className="text-base font-semibold tracking-tight text-fg">
              Session not found
            </h2>
            <p className="mt-1 text-xs text-muted">
              It may have been deleted.
            </p>
            <Link
              href="/"
              className="mt-4 inline-flex h-8 items-center rounded-lg bg-accent px-3 text-xs font-medium text-accent-fg transition-colors duration-150 ease-out hover:bg-accent-strong"
            >
              Start a new chat
            </Link>
          </div>
        ) : error ? (
          <div className="flex flex-1 flex-col items-center justify-center p-6 text-center animate-fade-in">
            <h2 className="text-base font-semibold tracking-tight text-fg">
              Could not load this chat
            </h2>
            <p className="mt-1 max-w-md text-xs text-danger">{error}</p>
            <button
              type="button"
              onClick={() => void refreshSession()}
              className="touch-target mt-4 inline-flex h-8 items-center gap-2 rounded-lg border border-border bg-elev px-3 text-xs font-medium text-fg transition-colors duration-150 ease-out hover:bg-hover"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              <span>Retry</span>
            </button>
          </div>
        ) : loading ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-xs text-muted"
            role="status"
          >
            <Spinner className="size-5 text-muted" />
            <span>Loading conversation...</span>
          </div>
        ) : messages.length === 0 && !optimisticPrompt ? (
          <EmptyState onChooseDemo={(agent, prompt) => {
            setRunMode("task");
            try { localStorage.setItem("oh-default-mode", "task"); } catch {}
            void handleSelectAgent(agent);
            composerRef.current?.setText(prompt);
          }} />
        ) : (
          <Transcript
            messages={messages}
            sessionId={sessionId ?? undefined}
            status={session?.status}
            phase={session?.phase}
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
            {waitingForRunSlot && (
              <div className="mx-auto mb-3 w-full max-w-[720px] rounded-xl border border-border bg-elev px-4 py-3 text-xs text-muted max-[420px]:mx-0 max-[420px]:max-w-none">
                Waiting for a free slot. This run will resume automatically.
              </div>
            )}

            {!takeover && (session?.status === "running" || session?.status === "awaiting_input") && session.sandboxHandleId && (
              <div className="mx-auto mb-3 w-full max-w-[720px] px-4 text-right">
                <button type="button" disabled={takeoverBusy} onClick={() => void requestTakeover()} className="rounded-lg border border-border bg-elev px-3 py-1.5 text-xs font-medium text-fg hover:bg-hover">{takeoverBusy ? "Requesting…" : "Take control of browser"}</button>
              </div>
            )}

            {pendingQuestion && (
              <div className="mx-auto mb-3 w-full max-w-[720px] px-4">
                <div className="rounded-xl border border-accent/40 bg-elev p-4 shadow-sm">
                  <div className="text-xs font-semibold uppercase tracking-wider text-accent">
                    Clarifying Question
                  </div>
                  <p className="mt-1 text-sm text-fg">{pendingQuestion.question}</p>
                  {pendingQuestion.options && pendingQuestion.options.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {pendingQuestion.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          onClick={() => setQuestionAnswer(opt)}
                          aria-pressed={questionAnswer === opt}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${questionAnswer === opt ? "border-accent bg-accent/15 text-accent" : "border-border bg-bg text-fg hover:bg-hover"}`}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <form
                    className="mt-3 flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!questionAnswer.trim()) return;
                      const ans = questionAnswer.trim();
                      void handleQuestionAnswer(ans);
                    }}
                  >
                    <input
                      type="text"
                      value={questionAnswer}
                      onChange={(e) => setQuestionAnswer(e.target.value)}
                      disabled={questionSubmitting}
                      placeholder="Type your answer..."
                      className="flex-1 rounded-lg border border-border bg-bg px-3 py-1.5 text-xs text-fg"
                    />
                    <button
                      type="submit"
                      disabled={!questionAnswer.trim() || questionSubmitting}
                      className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:bg-accent-strong"
                    >
                      {questionSubmitting ? "Submitting…" : "Submit"}
                    </button>
                  </form>
                </div>
              </div>
            )}

            {runError && (
              <div className="mx-auto mb-3 w-full max-w-[720px] px-4">
                <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 px-4 py-3 text-xs">
                  <div>
                    <span className="font-semibold text-danger">
                      {runError.code || "RUN_ERROR"}:{" "}
                    </span>
                    <span className="text-fg">{runError.message}</span>
                  </div>
                  {(runError.recoverable !== false && (runError.runId || session?.runId)) && (
                    <button
                      type="button"
                      onClick={() => {
                        const rId = runError.runId ?? session?.runId;
                        if (!rId) return;
                        setRunError(null);
                        void client.runs
                          .retry(rId)
                          .catch((err) => notify("error", errorMessage(err)));
                      }}
                      className="shrink-0 rounded-lg border border-border bg-elev px-3 py-1.5 font-medium text-fg hover:bg-hover"
                    >
                      Retry Run
                    </button>
                  )}
                </div>
              </div>
            )}

            {(changedFiles.length > 0 || previewUrl) && (
              <section
                aria-label="Run Results"
                className="mx-auto mb-3 w-full max-w-[720px] rounded-xl border border-success/35 bg-success/5 px-4 py-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-success">
                      Run Results
                    </h3>
                    {changedFiles.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {changedFiles.map((file) => (
                          <button
                            type="button"
                            key={file}
                            onClick={() => { setStudioTargetPath(file); setStudioOpen(true); setBrowserDock("closed"); }}
                            className="max-w-full truncate rounded-md border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg hover:border-accent hover:text-accent"
                            title={file}
                          >
                            {file}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {previewUrl && (
                      <a
                        href={previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-accent px-3 py-2 text-xs font-semibold text-accent-fg hover:bg-accent-strong"
                      >
                        Open Preview ↗
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDownloadArchive()}
                      className="rounded-lg border border-border bg-elev px-3 py-2 text-xs font-semibold text-fg hover:bg-hover"
                    >
                      Download Archive (.tar.gz)
                    </button>
                  </div>
                </div>
              </section>
            )}

            <div className="mx-auto mb-1 flex w-full max-w-[720px] items-center justify-between px-4 text-xs text-muted">
              <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-elev p-0.5">
                <button
                  type="button"
                  onClick={() => { setRunMode("task"); try { localStorage.setItem("oh-default-mode", "task"); } catch {} }}
                  aria-pressed={runMode === "task"}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    runMode === "task" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  Code
                </button>
                <button
                  type="button"
                  onClick={() => { setRunMode("ask"); try { localStorage.setItem("oh-default-mode", "ask"); } catch {} }}
                  aria-pressed={runMode === "ask"}
                  className={`rounded-md px-2.5 py-1 font-medium ${
                    runMode === "ask" ? "bg-accent text-accent-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  Ask
                </button>
              </div>
              {previewUrl && (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-accent hover:underline"
                >
                  Live Preview ↗
                </a>
              )}
            </div>

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
              <div className="mx-auto w-full max-w-[720px] px-4 pb-3">
                <div className="flex items-center justify-between rounded-xl border border-border bg-elev px-4 py-3 text-xs text-muted">
                  <span className="inline-flex items-center gap-2">
                    <Eye className="size-4" aria-hidden="true" />
                    <span>This is a read-only subagent session.</span>
                  </span>
                  <Link
                    href={`/c/${encodeURIComponent(session.parentId)}`}
                    className="inline-flex items-center gap-1 font-medium text-accent hover:underline"
                  >
                    <ArrowLeft className="size-3.5" aria-hidden="true" />
                    <span>Parent chat</span>
                  </Link>
                </div>
              </div>
            ) : (
              <>
                {!catalogLoading && !selectedModelConfigured && messages.length > 0 && (
                  <div
                    className="mx-auto mb-3 w-full max-w-[720px] rounded-xl border border-border bg-elev px-4 py-3 text-xs text-muted"
                    role="status"
                  >
                    {models.length === 0
                      ? "No model provider is configured. Add a provider in Settings to continue this chat."
                      : "This chat’s model is unavailable. Choose a configured model from the Model menu to continue."}
                    {" "}
                    <Link href="/settings" className="font-medium text-accent hover:underline">
                      Open model settings
                    </Link>
                  </div>
                )}
                {!runtimeReady && selectedModelConfigured && (
                  <div
                    className="mx-auto mb-3 w-full max-w-[720px] rounded-xl border border-border bg-elev px-4 py-3 text-xs text-muted"
                    role="status"
                  >
                    {!selectedRuntime
                      ? "No runtime is selected. Configure a default runtime in Settings → General or choose an available runtime above."
                      : runMode === "task"
                        ? "Code mode needs an active sandbox runtime. Configure Modal, Docker, or SRT before running tasks."
                        : "The selected runtime is unavailable. Choose an active runtime or configure it in Settings."}
                    {" "}
                    <Link href="/settings" className="font-medium text-accent hover:underline">
                      Open runtime settings
                    </Link>
                  </div>
                )}
                {session?.pauseReason === "paused_budget" && session.runId && (
                  <div className="mx-auto mb-3 flex w-full max-w-[720px] items-center justify-between rounded-xl border border-accent/30 bg-elev px-4 py-3 text-xs text-muted max-[420px]:max-w-none max-[420px]:mx-0">
                    <span>Paused at the run input-token budget. Continue to start a fresh budget window.</span>
                    <button type="button" onClick={() => void handleContinueBudgetRun()} className="ml-3 rounded-lg bg-accent px-3 py-1.5 font-semibold text-accent-fg">Continue</button>
                  </div>
                )}
                <Composer
                  ref={composerRef}
                  agentName={selectedAgent}
                  isPlanMode={selectedAgent === "plan"}
                  commands={commands}
                  active={activeRun}
                  sending={sending}
                  uploadProgress={uploadProgress}
                  stopping={stopping}
                  disabled={!selectedModelConfigured || !runtimeReady}
                  onSend={(t, f, files) => void handleSend(t, f, files)}
                  onStop={() => void handleStop()}
                />
              </>
            )}
          </div>
        )}
      </div>

      {studioOpen && sessionId && <StudioCanvas
        sessionId={sessionId}
        files={changedFiles}
        initialPath={studioTargetPath}
        onClose={() => { setStudioOpen(false); setStudioTargetPath(undefined); }}
        onCreate={(prompt) => void handleSend(prompt)}
        onEdit={(prompt) => window.dispatchEvent(new CustomEvent("oh:try-fix", { detail: { prompt } }))}
      />}
      <CapabilitiesPanel
        activeAgent={selectedAgent}
        sessionId={sessionId}
        previewUrl={previewUrl}
        refreshToken={`${session?.status ?? ""}:${messages.length}:${changedFiles.length}`}
        onOpenBrowserDock={() => setBrowserDock("docked")}
      />
      {sessionId && !studioOpen && <LiveBrowser
        sessionId={sessionId}
        runId={takeover?.runId ?? session?.activeRunId ?? session?.runId}
        previewUrl={previewUrl}
        state={browserDock}
        setState={setBrowserDock}
        control={Boolean(takeover)}
        takeover={takeover}
        takeoverNote={takeoverNote}
        onTakeoverNote={setTakeoverNote}
        onVoiceNote={(transcript) => setTakeoverNote((current) => current ? `${current}${/\s$/.test(current) ? "" : " "}${transcript}` : transcript)}
        takeoverBusy={takeoverBusy}
        onTakeControl={!takeover && session?.sandboxHandleId && (session.status === "running" || session.status === "awaiting_input") ? () => void requestTakeover() : undefined}
        onReturnControl={() => void returnTakeover()}
        onDockWidthChange={setDockWidth}
        verifyLabel={browserVerification?.status === "running" ? browserVerification.check : undefined}
      />}
    </div>
  );
}
