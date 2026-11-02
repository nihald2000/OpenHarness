import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SandboxDaemon } from "../packages/sandboxd/src/server.ts";
import { toSrtSettings, assertEnforcementAvailable } from "../packages/sandboxd/src/config.ts";
import { compileSandboxPolicy } from "../packages/core/src/sandbox/policy.ts";

test("Step 6 (S2, S3, S10): spawnConfined scrubs secret env vars from shell and background children, fails closed (503) when srt is required and absent, validates srt settings schema, and deduplicates x-oh-request-id", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oh-confine-"));
  const workspacePath = path.join(base, "workspace");
  const memoriesPath = path.join(base, "memories");
  const tmpPath = path.join(base, "tmp");
  const shadowGitDir = path.join(base, ".shadow-git");

  // Inject secret env vars into host process.env to prove child processes NEVER see them
  process.env.OPENAI_API_KEY = "sk-host-secret-openai-key";
  process.env.OH_SESSION_KEY = "oh-host-session-secret";
  process.env.MODAL_TOKEN_SECRET = "modal-host-secret";
  process.env.GITHUB_TOKEN = "ghp-host-secret";
  process.env.GIT_DIR = "host-git-dir";
  process.env.GIT_WORK_TREE = "host-git-work-tree";
  process.env.GIT_INDEX_FILE = "host-git-index";
  process.env.SSH_ASKPASS = "host-askpass";

  const policy = compileSandboxPolicy({
    runId: "run_confine",
    phase: "agent",
    workspacePath,
    memoriesPath,
    tmpPath,
    networkMode: "allowlist",
    additionalAllowedDomains: ["registry.npmjs.org"],
  });

  try {
    // 1. toSrtSettings validates schema and rejects open network mode
    const srtSettings = toSrtSettings(policy);
    assert.deepEqual(srtSettings.network.allowDomains, ["registry.npmjs.org"]);
    assert.equal(srtSettings.network.allowLocalBinding, true);
    assert.equal(srtSettings.mandatoryDenySearchDepth, 3);
    assert.ok(Array.isArray(srtSettings.filesystem.allowWrite));
    assert.ok(Array.isArray(srtSettings.filesystem.denyWrite));

    const openPolicy = compileSandboxPolicy({
      runId: "run_open",
      phase: "agent",
      workspacePath,
      memoriesPath,
      tmpPath,
      networkMode: "open",
    });
    assert.throws(() => toSrtSettings(openPolicy), /Open egress is not allowed/);

    // 2. assertEnforcementAvailable throws when checkFn returns false
    assert.throws(() => assertEnforcementAvailable(() => false), /srt is not installed/);

    // 3. When requireSrt: true and srt is absent, /health returns osEnforced: false and exec returns 503
    const strictDaemon = new SandboxDaemon({
      sessionId: "sess_strict",
      runId: "run_strict",
      sessionKey: "key_strict",
      workspacePath,
      memoriesPath,
      tmpPath,
      shadowGitDir,
      requireSrt: true,
      policy,
    });
    const strictHealth = await strictDaemon.handleRequest("GET", "/health", {});
    assert.equal(strictHealth.headers["x-oh-daemon"], "1");
    if (!strictHealth.body.osEnforced) {
      assert.equal(strictHealth.status, 503);
      assert.equal(strictHealth.body.ok, false);
      const strictExec = await strictDaemon.handleRequest(
        "POST",
        "/shell/main/exec",
        { "x-session-key": "key_strict" },
        { command: "echo hi" }
      );
      assert.equal(strictExec.status, 503);
      const strictBg = await strictDaemon.handleRequest(
        "POST",
        "/processes",
        { "x-session-key": "key_strict" },
        { command: "sleep 1" }
      );
      assert.equal(strictBg.status, 503);
    }
    await strictDaemon.close();

    // 4. Child processes in execShell and startBackgroundProcess cannot see host secrets + x-oh-request-id idempotency
    const daemon = new SandboxDaemon({
      sessionId: "sess_env",
      runId: "run_env",
      sessionKey: "key_env",
      workspacePath,
      memoriesPath,
      tmpPath,
      shadowGitDir,
      requireSrt: false,
      policy,
    });

    const envRes = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      { "x-session-key": "key_env" },
      {
        command:
          'echo "OPENAI=${OPENAI_API_KEY:-EMPTY};SESSION=${OH_SESSION_KEY:-EMPTY};MODAL=${MODAL_TOKEN_SECRET:-EMPTY};GH=${GITHUB_TOKEN:-EMPTY};GITDIR=${GIT_DIR:-EMPTY};GITWT=${GIT_WORK_TREE:-EMPTY};GITINDEX=${GIT_INDEX_FILE:-EMPTY};ASKPASS=${SSH_ASKPASS:-EMPTY};PYTHON=${PYTHONUNBUFFERED:-EMPTY};GITPROMPT=${GIT_TERMINAL_PROMPT:-EMPTY}"',
      }
    );
    assert.equal(envRes.status, 200);
    assert.equal(envRes.headers["x-oh-daemon"], "1");
    assert.match(String(envRes.body.output), /OPENAI=EMPTY;SESSION=EMPTY;MODAL=EMPTY;GH=EMPTY;GITDIR=EMPTY;GITWT=EMPTY;GITINDEX=EMPTY;ASKPASS=EMPTY;PYTHON=1;GITPROMPT=0/);

    // Verify background process also has scrubbed env
    const bgRes = await daemon.handleRequest(
      "POST",
      "/processes",
      { "x-session-key": "key_env" },
      {
        command: 'echo "BG_OPENAI=${OPENAI_API_KEY:-EMPTY};BG_MODAL=${MODAL_TOKEN_SECRET:-EMPTY}"',
      }
    );
    assert.equal(bgRes.status, 200);
    let logsRes: Awaited<ReturnType<typeof daemon.handleRequest>> | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise((r) => setTimeout(r, 100));
      logsRes = await daemon.handleRequest(
        "GET",
        `/processes/${String(bgRes.body.id)}/logs`,
        { "x-session-key": "key_env" }
      );
      if (/BG_OPENAI=EMPTY;BG_MODAL=EMPTY/.test(String(logsRes.body.logs))) break;
    }
    assert.ok(logsRes);
    assert.match(String(logsRes.body.logs), /BG_OPENAI=EMPTY;BG_MODAL=EMPTY/);

    // 5. Idempotency via x-oh-request-id: retried POST runs command only once
    const counterFile = path.join(workspacePath, "counter.txt");
    fs.writeFileSync(counterFile, "0", "utf8");
    const incCmd = "c=$(cat counter.txt); echo $((c + 1)) > counter.txt; cat counter.txt";

    const r1 = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      { "x-session-key": "key_env", "x-oh-request-id": "req_idem_123" },
      { command: incCmd }
    );
    const r2 = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      { "x-session-key": "key_env", "x-oh-request-id": "req_idem_123" },
      { command: incCmd }
    );
    assert.equal(r1.body.output, "1");
    assert.equal(r2.body.output, "1");
    assert.equal(fs.readFileSync(counterFile, "utf8").trim(), "1");

    await daemon.close();
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OH_SESSION_KEY;
    delete process.env.MODAL_TOKEN_SECRET;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    delete process.env.GIT_INDEX_FILE;
    delete process.env.SSH_ASKPASS;
    for (let attempt = 0; ; attempt++) {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EBUSY", "EPERM"].includes(code ?? "") || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
