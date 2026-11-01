import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { compileSandboxPolicy, PinnedModalSandboxProvider } from "../packages/core/src/index.ts";
import { createSandboxHubServer } from "../packages/sandboxd/src/hub.ts";

test("pinned Modal hub starts instantly, isolates sessions, proxies previews, and reattaches deterministically", async () => {
  const originalVm = process.env.OH_VM_ISOLATED;
  const originalDisableSrt = process.env.OH_DISABLE_SRT;
  process.env.OH_VM_ISOLATED = "1";
  process.env.OH_DISABLE_SRT = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-pinned-modal-hub-"));
  const hub = createSandboxHubServer({ root: path.join(root, "workspaces"), sessionKey: "hub-test-key" });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  const auth = (sandboxId: string) => ({ "x-session-key": "hub-test-key", "x-oh-sandbox-id": sandboxId });
  const call = async (sandboxId: string, method: string, route: string, body?: unknown) => fetch(`${endpoint}${route}`, {
    method,
    headers: {
      ...auth(sandboxId),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let processId = "";
  try {
    let healthResponse: Response | undefined;
    let health: any;
    let fastestHealthMs = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 5 && fastestHealthMs >= 50; attempt++) {
      const started = performance.now();
      healthResponse = await fetch(`${endpoint}/health`);
      health = await healthResponse.json() as any;
      fastestHealthMs = Math.min(fastestHealthMs, performance.now() - started);
    }
    assert.ok(healthResponse);
    assert.equal(healthResponse.status, 200);
    assert.equal(healthResponse.headers.get("x-oh-daemon"), "1");
    assert.equal(health.mode, "pinned-hub");
    assert.equal(health.activeSandboxes, 0);
    assert.ok(fastestHealthMs < 50, `unauthenticated health must respond within 50ms (fastest=${fastestHealthMs.toFixed(1)}ms)`);

    const invalid = await call("bad/id", "POST", "/sessions/init", {});
    assert.equal(invalid.status, 400);
    for (const id of ["sess_a", "sess_b"]) {
      assert.equal((await call(id, "POST", "/sessions/init", {})).status, 200);
    }

    const created = await call("sess_a", "POST", "/files/create", { path: "hello.js", content: "console.log('tenant a');\n" });
    assert.equal(created.status, 200);
    const filesA = await (await call("sess_a", "POST", "/search/glob", { pattern: "**/*" })).json() as any;
    const filesB = await (await call("sess_b", "POST", "/search/glob", { pattern: "**/*" })).json() as any;
    assert.deepEqual(filesA.matches, ["hello.js"]);
    assert.deepEqual(filesB.matches, []);

    const shell = await (await call("sess_a", "POST", "/shell/main/exec", { command: "echo 42", timeoutSec: 15 })).json() as any;
    assert.equal(shell.exitCode, 0);
    assert.match(shell.output, /42/);
    const diff = await (await call("sess_a", "POST", "/checkpoints/diff", {})).json() as any;
    assert.deepEqual(diff.files, ["hello.js"]);
    assert.match(diff.diff, /console\.log\('tenant a'\)/);

    const previewPort = 23561;
    const command = `node -e 'require("http").createServer((req,res)=>res.end("hub-preview-ok")).listen(${previewPort},"0.0.0.0")'`;
    const processResponse = await call("sess_a", "POST", "/processes", { command, port: previewPort });
    assert.equal(processResponse.status, 200);
    processId = String((await processResponse.json() as any).processId ?? "");
    let previewText = "";
    for (let attempt = 0; attempt < 25; attempt++) {
      const preview = await fetch(`${endpoint}/preview/${previewPort}/hello?mode=test`);
      if (preview.ok) {
        previewText = await preview.text();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(previewText, "hub-preview-ok");

    const unauthenticated = await fetch(`${endpoint}/files/create`, { method: "POST" });
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get("x-oh-daemon"), "1");
    const wrongKey = await fetch(`${endpoint}/sessions/init`, {
      method: "POST", headers: { "x-session-key": "wrong", "x-oh-sandbox-id": "sess_wrong" }, body: "{}",
    });
    assert.equal(wrongKey.status, 401);

    const spec: any = {
      runId: "run-pinned",
      sessionId: "persistent-session",
      tenantId: "tenant-a",
      workspace: { type: "empty" },
      policy: compileSandboxPolicy({ runId: "run-pinned", phase: "agent", workspacePath: "/workspace", networkMode: "open" }),
      exposedPorts: [previewPort, 8080],
    };
    const providerA = new PinnedModalSandboxProvider({ endpointUrl: endpoint, sharedKey: "hub-test-key" });
    const handle = await providerA.create(spec);
    assert.equal(handle.id, "modal_tenant-a_persistent-session");
    assert.equal(handle.ports[previewPort], `${endpoint}/preview/${previewPort}/`);
    assert.equal(handle.ports[8080], undefined);
    await handle.transport!.request("POST", "/files/create", { path: "persist.txt", content: "kept" });

    const providerB = new PinnedModalSandboxProvider({ endpointUrl: endpoint, sharedKey: "hub-test-key" });
    const attached = await providerB.attach(handle.id);
    const persistentFiles = await attached.transport.request("POST", "/search/glob", { pattern: "**/*" });
    assert.deepEqual(persistentFiles.body.matches, ["persist.txt"]);
  } finally {
    if (processId) await call("sess_a", "DELETE", `/processes/${encodeURIComponent(processId)}`).catch(() => {});
    await hub.closeHub();
    fs.rmSync(root, { recursive: true, force: true });
    if (originalVm === undefined) delete process.env.OH_VM_ISOLATED; else process.env.OH_VM_ISOLATED = originalVm;
    if (originalDisableSrt === undefined) delete process.env.OH_DISABLE_SRT; else process.env.OH_DISABLE_SRT = originalDisableSrt;
  }
});
