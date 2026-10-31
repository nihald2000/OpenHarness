import type { CheckpointInfo, OpenHarnessEvent } from "@openharness/sdk";
import {
  condenseVerificationFailure,
  detectTestTamperingInDiff,
  getActiveSandboxDaemon,
  resolveVerificationRecipe,
  type EventBus,
  type ProviderAdapter,
  type RunState,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxRecordStore,
  type SandboxSpec,
  type StateStore,
} from "@openharness/core";

export interface RunHooksContext {
  providers: Map<string, SandboxProvider>;
  activeSandboxes: Map<string, SandboxHandle>;
  sandboxRecords: SandboxRecordStore;
  stateStore: StateStore;
  eventBus: EventBus;
  provider: ProviderAdapter;
  workspaceRoot: string;
  allowUnsandboxedAutonomy?: boolean;
  emit: (tenantId: string, sessionId: string, ev: OpenHarnessEvent) => Promise<void>;
  defaultSpecFor: (state: RunState) => SandboxSpec;
}

export function createRunHooks(ctx: RunHooksContext) {
  const getRequestFn = (handle: SandboxHandle) => {
    if (handle.transport) {
      return (method: "GET" | "POST", route: string, body?: Record<string, unknown>) =>
        handle.transport!.request(method, route, body);
    }
    const daemon = getActiveSandboxDaemon(handle.id);
    if (daemon) {
      return (method: "GET" | "POST", route: string, body?: Record<string, unknown>) =>
        daemon.handleRequest(method, route, { "x-session-key": daemon.config.sessionKey }, body);
    }
    return null;
  };

  const ensureSandbox = async (state: RunState): Promise<SandboxHandle> => {
    const session = await ctx.stateStore.getSession(state.tenantId, state.sessionId);
    const existingHandleId = state.sandboxHandleId ?? session?.sandboxHandleId;
    if (existingHandleId && ctx.activeSandboxes.has(existingHandleId)) {
      const existing = ctx.activeSandboxes.get(existingHandleId)!;
      if (existing.status === "paused") {
        const p = ctx.providers.get(existing.providerId);
        await p?.resume(existing);
        await ctx.emit(state.tenantId, state.sessionId, {
          type: "sandbox.status",
          sessionId: state.sessionId,
          runId: state.runId,
          sandboxId: existing.id,
          provider: existing.providerId,
          status: "running",
        });
      }
      state.sandboxHandleId = existing.id;
      return existing;
    }
    const runtime = state.runtime ?? session?.runtime ?? "local";

    if (
      (state.mode === "task" || state.mode === "long_task") &&
      runtime === "local" &&
      !ctx.allowUnsandboxedAutonomy
    ) {
      throw new Error(
        `${state.mode} mode requires a sandboxed runtime (srt-local, docker, or modal); set allowUnsandboxedAutonomy: true to override`
      );
    }

    const provider = ctx.providers.get(runtime);
    if (!provider) {
      throw new Error(`unknown sandbox runtime: ${runtime}`);
    }
    const health = await provider.health();
    if (!health.ok) {
      throw new Error(`sandbox runtime ${runtime} unavailable: ${health.detail ?? health.status}`);
    }

    const maxSandboxes = Number(process.env.OH_MAX_SANDBOXES ?? 3);
    if (runtime === "modal" && maxSandboxes > 0) {
      const runningModal = Array.from(ctx.activeSandboxes.values()).filter(
        (h) => h.providerId === "modal" && h.status === "running"
      );
      if (runningModal.length >= maxSandboxes) {
        const oldest = runningModal[0];
        if (oldest) {
          await provider.pause(oldest).catch(() => {});
        }
      }
    }

    const spec = ctx.defaultSpecFor(state);
    if (ctx.allowUnsandboxedAutonomy) {
      spec.allowUnsandboxedAutonomy = true;
    }
    const handle = await provider.create(spec);
    ctx.activeSandboxes.set(handle.id, handle);
    state.sandboxHandleId = handle.id;

    if (session) {
      await ctx.stateStore.saveSession(state.tenantId, {
        ...session,
        sandboxHandleId: handle.id,
        updatedAt: Date.now(),
      });
    }

    const existingRec = await ctx.sandboxRecords.get(handle.id);
    if (!existingRec) {
      await ctx.sandboxRecords.save({
        handleId: handle.id,
        providerId: handle.providerId,
        tenantId: state.tenantId,
        sessionId: state.sessionId,
        runId: state.runId,
        status: "running",
        sessionKeyEnc: "",
        cpu: spec.limits?.cpuCores ?? 2,
        memoryMiB: spec.limits?.memoryMb ?? 4096,
        createdAt: Date.now(),
        timeoutMs: (spec.limits?.timeoutSec ?? 3600) * 1000,
        billedUntil: Date.now(),
        ports: handle.ports,
        policy: handle.policy,
      });
    }

    await ctx.emit(state.tenantId, state.sessionId, {
      type: "sandbox.status",
      sessionId: state.sessionId,
      runId: state.runId,
      sandboxId: handle.id,
      provider: handle.providerId,
      status: "running",
    });

    for (const [portStr, url] of Object.entries(handle.ports ?? {})) {
      if (url) {
        state.previewUrl = url;
        await ctx.emit(state.tenantId, state.sessionId, {
          type: "preview.ready",
          sessionId: state.sessionId,
          runId: state.runId,
          port: Number(portStr),
          url,
        });
      }
    }

    return handle;
  };

  const onCreateCheckpoint = async (
    state: RunState,
    message = `Before step ${state.iteration}`,
    automatic = true
  ): Promise<CheckpointInfo | null> => {
    if (!state.sandboxHandleId) {
      return null;
    }
    const handle = ctx.activeSandboxes.get(state.sandboxHandleId);
    const reqFn = handle
      ? getRequestFn(handle)
      : (() => {
          const daemon = getActiveSandboxDaemon(state.sandboxHandleId!);
          if (!daemon) return null;
          return (method: "GET" | "POST", route: string, body?: Record<string, unknown>) =>
            daemon.handleRequest(method, route, { "x-session-key": daemon.config.sessionKey }, body);
        })();
    if (!reqFn) return null;

    const res = await reqFn("POST", "/checkpoints/create", { message });
    if (res.status !== 200 || !res.body.sha) {
      return null;
    }
    const cp: CheckpointInfo = {
      sha: String(res.body.sha),
      message,
      files: Array.isArray(res.body.files) ? (res.body.files as string[]) : [],
      paths: Array.isArray(res.body.files) ? (res.body.files as string[]) : [],
      createdAt: Date.now(),
      sessionId: state.sessionId,
      runId: state.runId,
      step: state.iteration,
      automatic,
    };
    return cp;
  };

  const onPreCheckpoint = async (
    state: RunState,
    message = `Before step ${state.iteration}`
  ): Promise<CheckpointInfo | null> => {
    const cp = await onCreateCheckpoint(state, message, true);
    if (cp) {
      await ctx.stateStore.saveCheckpointInfo(state.tenantId, state.sessionId, cp);
      await ctx.emit(state.tenantId, state.sessionId, {
        type: "checkpoint.created",
        sessionId: state.sessionId,
        runId: state.runId,
        checkpoint: cp,
      });
    }
    return cp;
  };

  const detectSandboxChecks = async (
    reqFn: (method: "GET" | "POST", route: string, body?: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>,
    fallbackRoot: string
  ): Promise<Array<{ name: string; command: string; timeoutSec?: number; expectedExitCode?: number }>> => {
    const checks: Array<{ name: string; command: string; timeoutSec?: number; expectedExitCode?: number }> = [];
    const pkgView = await reqFn("POST", "/files/view", { path: "package.json" }).catch(() => null);
    if (pkgView && pkgView.status === 200 && typeof pkgView.body.content === "string") {
      try {
        const pkg = JSON.parse(pkgView.body.content) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts ?? {};
        if (scripts.typecheck) checks.push({ name: "typecheck", command: "npm run typecheck", timeoutSec: 180 });
        if (scripts.test && !scripts.test.includes("no test specified")) {
          checks.push({ name: "test", command: "npm test", timeoutSec: 240 });
        }
        if (scripts.build) checks.push({ name: "build", command: "npm run build", timeoutSec: 240 });
      } catch {}
    }
    if (checks.length > 0) return checks;
    const recipe = resolveVerificationRecipe(fallbackRoot);
    return recipe.checks;
  };

  const onRunVerification = async (state: RunState) => {
    if (!state.sandboxHandleId) {
      return {
        passed: true,
        signature: "pass",
        condensedError: "",
        results: [],
      };
    }
    const h = await ensureSandbox(state);
    const reqFn = getRequestFn(h);
    const checks = reqFn
      ? await detectSandboxChecks(reqFn, h.workspacePath || ctx.workspaceRoot)
      : resolveVerificationRecipe(h.workspacePath || ctx.workspaceRoot).checks;

    const results: Array<{
      name: string;
      command: string;
      passed: boolean;
      exitCode: number;
      output: string;
      durationMs: number;
    }> = [];

    for (const check of checks) {
      const t0 = Date.now();
      let exitCode = 0;
      let output = "";
      if (reqFn) {
        const res = await reqFn("POST", "/shell/main/exec", {
          command: check.command,
          timeoutSec: check.timeoutSec ?? 300,
        });
        exitCode = typeof res.body.exitCode === "number" ? res.body.exitCode : res.status === 200 ? 0 : 1;
        output = `${String(res.body.stdout ?? res.body.output ?? "")}${String(res.body.stderr ?? "")}`.trim();
      }
      results.push({
        name: check.name,
        command: check.command,
        passed: exitCode === (check.expectedExitCode ?? 0),
        exitCode,
        output,
        durationMs: Date.now() - t0,
      });
    }

    if (reqFn) {
      const portsRes = await reqFn("GET", "/ports").catch(() => null);
      const openPorts = Array.isArray(portsRes?.body?.ports)
        ? (portsRes!.body.ports as Array<{ port: number; previewUrl?: string }>)
        : [];
      if (openPorts.length > 0) {
        const targetPort = openPorts[0]!.port;
        const t0 = Date.now();
        const navRes = await reqFn("POST", "/browser/navigate", {
          url: `http://127.0.0.1:${targetPort}`,
        }).catch(() => null);
        if (navRes && navRes.status === 200) {
          const logsRes = await reqFn("GET", "/browser/console_logs").catch(() => null);
          const logs = Array.isArray(logsRes?.body?.logs) ? (logsRes!.body.logs as string[]) : [];
          const errLogs = logs.filter((l) => /^\[(?:error|pageerror)\]/i.test(l));
          results.push({
            name: "browser-check",
            command: `browser_open http://127.0.0.1:${targetPort}`,
            passed: errLogs.length === 0,
            exitCode: errLogs.length === 0 ? 0 : 1,
            output: errLogs.length > 0 ? errLogs.join("\n") : `Loaded ${String(navRes.body.title ?? "")}`,
            durationMs: Date.now() - t0,
          });
        }
      }
    }

    const { signature, condensedError } = condenseVerificationFailure(results);
    await ctx.emit(state.tenantId, state.sessionId, {
      type: "verification.finished",
      sessionId: state.sessionId,
      runId: state.runId,
      passed: results.every((r) => r.passed),
      results,
    });
    return {
      passed: results.every((r) => r.passed),
      signature,
      condensedError,
      results,
    };
  };

  const onRunReviewer = async (state: RunState) => {
    let diffText = "";
    if (state.sandboxHandleId) {
      const h = ctx.activeSandboxes.get(state.sandboxHandleId);
      const reqFn = h ? getRequestFn(h) : null;
      if (reqFn) {
        const res = await reqFn("POST", "/checkpoints/diff", {
          from: state.lastCheckpoint ?? "HEAD~1",
        }).catch(() => null);
        if (res && res.status === 200) {
          diffText = String(res.body.diff ?? "");
        }
      }
    }
    const tampering = detectTestTamperingInDiff(diffText);
    return {
      verdict: tampering.tamperingDetected ? ("fail" as const) : ("pass" as const),
      issues: tampering.issues,
      tamperingDetected: tampering.tamperingDetected,
    };
  };

  const onPauseSandbox = async (state: RunState): Promise<{ snapshotId?: string }> => {
    const h = state.sandboxHandleId ? ctx.activeSandboxes.get(state.sandboxHandleId) : undefined;
    if (!h) return {};
    const p = ctx.providers.get(h.providerId);
    await p?.pause(h);
    await ctx.sandboxRecords
      .update(h.id, {
        status: h.snapshotId ? "snapshotted" : "paused",
        lastSnapshotImageId: h.snapshotId,
      })
      .catch(() => {});
    return { snapshotId: h.snapshotId };
  };

  const onResumeSandbox = async (state: RunState): Promise<{ sandboxHandleId: string }> => {
    const h = state.sandboxHandleId ? ctx.activeSandboxes.get(state.sandboxHandleId) : undefined;
    if (!h) throw new Error("no sandbox handle to resume");
    const p = ctx.providers.get(h.providerId);
    await p?.resume(h);
    await ctx.sandboxRecords.update(h.id, { status: "running" }).catch(() => {});
    return { sandboxHandleId: h.id };
  };

  return {
    ensureSandbox,
    onCreateCheckpoint,
    onPreCheckpoint,
    onRunVerification,
    onRunReviewer,
    onPauseSandbox,
    onResumeSandbox,
  };
}
