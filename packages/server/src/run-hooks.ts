import path from "node:path";
import fs from "node:fs";
import type { CheckpointInfo, OpenHarnessEvent } from "@openharness/sdk";
import {
  condenseVerificationFailure,
  detectTestTamperingInDiff,
  getActiveSandboxDaemon,
  resolveVerificationRecipe,
  supportsVisionModel,
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
  dataDir?: string;
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

  const emitSandboxRunning = async (state: RunState, handle: SandboxHandle) => {
    await ctx.emit(state.tenantId, state.sessionId, {
      type: "sandbox.status",
      sessionId: state.sessionId,
      runId: state.runId,
      sandboxId: handle.id,
      provider: handle.providerId,
      status: "running",
    });
  };

  const rehydrateModalHandle = (handleId: string, rec: NonNullable<Awaited<ReturnType<typeof ctx.sandboxRecords.get>>>): SandboxHandle => ({
    id: handleId,
    providerId: "modal",
    runId: rec.runId,
    sessionId: rec.sessionId,
    agentServerUrl: "modal:connect-token",
    sessionKey: "",
    workspacePath: "/workspace",
    memoriesPath: "/memories",
    tmpPath: "/tmp/oh",
    shadowGitDir: "/oh/.shadow-git",
    status: rec.status === "snapshotted" || rec.status === "paused" ? "paused" : "running",
    ports: rec.ports ?? {},
    policy: rec.policy,
    snapshotId: rec.lastSnapshotImageId,
  });

  const reattachModalSandbox = async (
    state: RunState,
    handleId: string
  ): Promise<SandboxHandle | undefined> => {
    const rec = await ctx.sandboxRecords.get(handleId).catch(() => null);
    if (!rec || rec.providerId !== "modal") return undefined;
    const modalProvider = ctx.providers.get("modal") as any;
    if (!modalProvider) return undefined;
    let handle = rehydrateModalHandle(handleId, rec);
    try {
      const attached = await modalProvider.attach(handleId);
      if (attached?.transport) {
        handle.status = "running";
        handle.transport = attached.transport;
        ctx.activeSandboxes.set(handleId, handle);
        state.sandboxHandleId = handleId;
        await emitSandboxRunning(state, handle);
        return handle;
      }
    } catch {
      // The sandbox may have exited while the Modal server was scaled down.
    }
    if (rec.lastSnapshotImageId) {
      handle.status = "paused";
      handle.snapshotId = rec.lastSnapshotImageId;
      try {
        await modalProvider.resume(handle);
        handle.status = "running";
        ctx.activeSandboxes.set(handleId, handle);
        state.sandboxHandleId = handleId;
        await emitSandboxRunning(state, handle);
        return handle;
      } catch {
        // Fall through and create a new sandbox if the snapshot is unavailable.
      }
    }
    return undefined;
  };

  const ensureSandbox = async (state: RunState): Promise<SandboxHandle> => {
    const session = await ctx.stateStore.getSession(state.tenantId, state.sessionId);
    const existingHandleId = state.sandboxHandleId ?? session?.sandboxHandleId;
    if (existingHandleId && ctx.activeSandboxes.has(existingHandleId)) {
      const existing = ctx.activeSandboxes.get(existingHandleId)!;
      const p = ctx.providers.get(existing.providerId);
      if (existing.status === "paused") {
        try {
          await p?.resume(existing);
          existing.status = "running";
          state.sandboxHandleId = existing.id;
          await emitSandboxRunning(state, existing);
          return existing;
        } catch {
          ctx.activeSandboxes.delete(existingHandleId);
        }
      } else if (existing.status === "running" && existing.providerId === "modal" && p) {
        const health = await p.health(existing).catch(() => ({ ok: false } as any));
        if (health.ok) {
          state.sandboxHandleId = existing.id;
          return existing;
        }
        const rec = await ctx.sandboxRecords.get(existing.id).catch(() => null);
        if (rec?.lastSnapshotImageId) {
          try {
            await p.resume(existing);
            existing.status = "running";
            state.sandboxHandleId = existing.id;
            await emitSandboxRunning(state, existing);
            return existing;
          } catch {
            // Remove the dead handle and recover from a new sandbox below.
          }
        }
        ctx.activeSandboxes.delete(existing.id);
      } else if (existing.status === "running") {
        state.sandboxHandleId = existing.id;
        return existing;
      }
    }
    if (existingHandleId && !ctx.activeSandboxes.has(existingHandleId)) {
      const attached = await reattachModalSandbox(state, existingHandleId);
      if (attached) return attached;
    }
    const modalConfigured = Boolean(process.env.OH_MODAL_SANDBOX_URL && process.env.OH_MODAL_SANDBOX_KEY && ctx.providers.has("modal"));
    const rawRuntime = state.runtime || session?.runtime || (modalConfigured ? "modal" : "local");
    const runtime = rawRuntime === "local" && modalConfigured && Boolean(process.env.MODAL_ENVIRONMENT || process.env.OPENHARNESS_WEB_GUEST === "1")
      ? "modal"
      : rawRuntime;

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
    // Modal's toModalNetwork adapter rejects open egress; keep its configured allowlist.
    if (runtime !== "modal") {
      spec.policy = {
        ...spec.policy,
        network: { ...spec.policy.network, mode: "open" },
      };
    }
    if (ctx.allowUnsandboxedAutonomy) {
      spec.allowUnsandboxedAutonomy = true;
    }
    const handle = await provider.create(spec);
    const createdSpec = spec;
    ctx.activeSandboxes.set(handle.id, handle);
    state.sandboxHandleId = handle.id;

    if (session) {
      await ctx.stateStore.saveSession(state.tenantId, {
        ...session,
        runtime: state.runtime ?? runtime,
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
        cpu: createdSpec.limits?.cpuCores ?? 2,
        memoryMiB: createdSpec.limits?.memoryMb ?? 4096,
        createdAt: Date.now(),
        timeoutMs: (createdSpec.limits?.timeoutSec ?? 3600) * 1000,
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

    for (const [portStr, url] of Object.entries(handle.providerId === "modal" ? {} : handle.ports ?? {})) {
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
      await ctx.emit(state.tenantId, state.sessionId, {
        type: "verification.finished",
        sessionId: state.sessionId,
        runId: state.runId,
        passed: true,
        results: [],
      });
      await ctx.emit(state.tenantId, state.sessionId, {
        type: "fix.status",
        sessionId: state.sessionId,
        phase: "succeeded",
        iteration: state.verifyFailures.length + 1,
        maxIterations: 5,
      });
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
      screenshotJpegBase64?: string;
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
      const processesRes = await reqFn("GET", "/processes").catch(() => null);
      const processes = Array.isArray(processesRes?.body?.processes)
        ? processesRes.body.processes as Array<{ id: string; name?: string; command?: string; port?: number; status?: string }>
        : [];
      const serverProcesses = processes.filter((process) => Number.isInteger(process.port));
      for (const process of serverProcesses) {
        const t0 = Date.now();
        const logsBefore = await reqFn("GET", `/processes/${encodeURIComponent(process.id)}/logs?since=0`).catch(() => null);
        const logCursor = Number(logsBefore?.body?.nextCursor ?? 0);
        if (process.status !== "running") {
          const logs = String(logsBefore?.body?.logs ?? "").split(/\r?\n/).slice(-30).join("\n");
          results.push({ name: `${process.name ?? process.id}:exited`, command: `process ${process.id}`, passed: false, exitCode: 1, output: logs || `Process status: ${process.status ?? "unknown"}`, durationMs: Date.now() - t0 });
          continue;
        }
        const ready = await reqFn("POST", `/processes/${encodeURIComponent(process.id)}/wait`, { port: process.port, timeoutSec: 3, path: "/" }).catch(() => null);
        const passed = Boolean(ready && ready.status < 500 && ready.body.ready === true);
        const tail = await reqFn("GET", `/processes/${encodeURIComponent(process.id)}/logs?since=${logCursor}`).catch(() => null);
        results.push({ name: `app:${process.name ?? process.id}`, command: `GET http://127.0.0.1:${process.port}/`, passed, exitCode: passed ? 0 : 1, output: passed ? `HTTP ${String(ready?.body.status ?? "<500")} at http://127.0.0.1:${process.port}/` : `${String(ready?.body.error ?? "Application did not respond")}${tail?.body.logs ? `\nlast attempts:\n${String(tail.body.logs).split(/\r?\n/).slice(-30).join("\n")}` : ""}`, durationMs: Date.now() - t0 });
      }

      const portsRes = await reqFn("GET", "/ports").catch(() => null);
      const openPorts = Array.isArray(portsRes?.body?.ports) ? portsRes.body.ports as Array<{ port: number; previewUrl?: string }> : [];
      const browserChecks = [...(state.browserChecks ?? [])];
      const touchedUi = (state.changedFiles ?? []).some((file) => /\.(?:html?|tsx?|jsx?|vue|svelte|css|scss|less)$/i.test(file));
      if (browserChecks.length === 0 && touchedUi && openPorts.length > 0) {
        const ownPort = state.previewUrl ? Number(new URL(state.previewUrl).port) : undefined;
        const port = (ownPort && openPorts.some((entry) => entry.port === ownPort) ? ownPort : undefined) ?? openPorts[openPorts.length - 1]!.port;
        browserChecks.push({ name: "smoke", port, steps: [{ goto: "/" }], createdAt: Date.now() });
      }
      const takeoverActive = state.takeoverRequested || state.takeover || state.pauseReason === "takeover";
      if (!takeoverActive) {
        for (const check of browserChecks) {
          const port = check.port ?? (state.previewUrl ? Number(new URL(state.previewUrl).port) : undefined) ?? openPorts[openPorts.length - 1]?.port;
          const t0 = Date.now();
          const before = check.port ? await reqFn("GET", `/processes?port=${check.port}`).catch(() => null) : null;
          const ownerProcess = serverProcesses.filter((process) => process.port === port).at(-1);
          const beforeLogs = ownerProcess ? await reqFn("GET", `/processes/${encodeURIComponent(ownerProcess.id)}/logs?since=0`).catch(() => null) : before;
          const beforeCursor = Number(beforeLogs?.body?.nextCursor ?? 0);
          await ctx.emit(state.tenantId, state.sessionId, { type: "verify:browser_check", sessionId: state.sessionId, check: check.name, step: 0, status: "running" });
          const runFlow = async () => reqFn("POST", "/browser/run_flow", { port, steps: check.steps, failOnConsoleErrors: check.failOnConsoleErrors });
          let response = await runFlow().catch((error) => ({ status: 503, body: { passed: false, failedStep: 0, step: check.steps[0], error: String(error), url: `http://127.0.0.1:${port ?? 0}/`, text: "", errors: [], failedRequests: [] } }));
          let result = response.body as Record<string, any>;
          if (!result.passed && /timeout|timed out/i.test(String(result.error ?? ""))) {
            response = await runFlow().catch((error) => ({ status: 503, body: { passed: false, failedStep: 0, step: check.steps[0], error: String(error), url: `http://127.0.0.1:${port ?? 0}/`, text: "", errors: [], failedRequests: [] } }));
            result = response.body as Record<string, any>;
          }
          const afterLogs = ownerProcess ? await reqFn("GET", `/processes/${encodeURIComponent(ownerProcess.id)}/logs?since=${beforeCursor}`).catch(() => null) : null;
          const backendLog = String(afterLogs?.body?.logs ?? "").split(/\r?\n/).filter(Boolean).slice(-20).join("\n");
          const evidence = [
            `Browser check "${check.name}" ${result.passed ? "passed" : `failed at step ${Number(result.failedStep ?? 0) + 1}/${check.steps.length}`}.`,
            result.passed ? "" : `error: ${String(result.error ?? "failed")}`,
            `url: ${String(result.url ?? "")}`,
            `visible text: ${String(result.text || "(empty)")}`,
            `console/page errors: ${Array.isArray(result.errors) ? result.errors.join(" | ") || "none" : "none"}`,
            `page log: ${Array.isArray(result.log) ? JSON.stringify(result.log).slice(0, 1200) : "(empty)"}`,
            `failed requests: ${Array.isArray(result.failedRequests) ? result.failedRequests.join(" | ") || "none" : "none"}`,
            ownerProcess ? `backend: ${ownerProcess.name ?? ownerProcess.id} (log lines since check start)\n${backendLog || "(no new backend output)"}` : "",
          ].filter(Boolean).join("\n");
          const passed = response.status < 500 && result.passed === true;
          let screenshotJpegBase64: string | undefined;
          if (!passed && typeof result.screenshotJpegBase64 === "string" && result.screenshotJpegBase64.length > 200) {
            if (ctx.dataDir) {
              const artifacts = path.join(ctx.dataDir, "artifacts");
              fs.mkdirSync(artifacts, { recursive: true });
              fs.writeFileSync(path.join(artifacts, `verify_${state.runId}_${state.iteration}_${check.name.replace(/[^a-z0-9_-]/gi, "_")}.jpg`), Buffer.from(result.screenshotJpegBase64, "base64"));
            }
            if (supportsVisionModel(state.model)) screenshotJpegBase64 = result.screenshotJpegBase64;
          }
          const stepIndex = Math.max(0, Number(result.failedStep ?? check.steps.length - 1));
          await ctx.emit(state.tenantId, state.sessionId, { type: "verify:browser_check", sessionId: state.sessionId, check: check.name, step: stepIndex, status: passed ? "passed" : "failed" });
          results.push({ name: `browser:${check.name}`, command: `browser_check ${check.name}`, passed, exitCode: passed ? 0 : 1, output: evidence, durationMs: Date.now() - t0, ...(screenshotJpegBase64 ? { screenshotJpegBase64 } : {}) });
          if (!passed && /log\s?in|signin|captcha|verify|otp/i.test(`${result.error ?? ""} ${result.text ?? ""}`)) {
            state.takeoverRequested = true;
            state.takeover = { reason: "Browser verification requires a human login or verification step", instructions: "Take control of the browser, complete the login/CAPTCHA/2FA step, then return control.", requestedBy: "agent", requestedAt: Date.now() };
            break;
          }
        }
      }
    }

    const { signature, condensedError } = condenseVerificationFailure(results);
    const passed = results.every((r) => r.passed);
    await ctx.emit(state.tenantId, state.sessionId, {
      type: "verification.finished",
      sessionId: state.sessionId,
      runId: state.runId,
      passed,
      results: results.map(({ screenshotJpegBase64: _screenshot, ...result }) => result),
    });
    await ctx.emit(state.tenantId, state.sessionId, {
      type: "fix.status",
      sessionId: state.sessionId,
      phase: passed ? "succeeded" : "fixing",
      iteration: state.verifyFailures.length + 1,
      maxIterations: 5,
    });
    return {
      passed,
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
    const browserTampering = state.browserCheckTampering ?? [];
    return {
      verdict: tampering.tamperingDetected || browserTampering.length ? ("fail" as const) : ("pass" as const),
      issues: [...tampering.issues, ...browserTampering.map((name) => `Browser check definition was changed: ${name}`)],
      tamperingDetected: tampering.tamperingDetected || browserTampering.length > 0,
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
