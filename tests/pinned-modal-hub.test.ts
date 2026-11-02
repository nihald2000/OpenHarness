import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
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
  const hub = createSandboxHubServer({ root: path.join(root, "workspaces"), sessionKey: "hub-test-key-aaaaaaaaaaaaaaaaaaaaaaaa" });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  const sessionKey = "hub-test-key-aaaaaaaaaaaaaaaaaaaaaaaa";
  const auth = (sandboxId: string) => ({ "x-session-key": sessionKey, "x-oh-sandbox-id": sandboxId });
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
    const previewScript = `require("http").createServer((q,s)=>s.end("hub-preview-ok")).listen(${previewPort},"0.0.0.0")`;
    const command = `node -e ${JSON.stringify(previewScript)}`;
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
    const providerA = new PinnedModalSandboxProvider({ endpointUrl: endpoint, sharedKey: sessionKey });
    const brandedProvider = new PinnedModalSandboxProvider({
      endpointUrl: endpoint,
      sharedKey: sessionKey,
      previewBaseUrl: "https://openharness-web-six.vercel.app",
    });
    assert.equal(brandedProvider.resolveTunnelUrl("modal_test", 3000), "https://openharness-web-six.vercel.app/preview/3000/");
    const handle = await providerA.create(spec);
    assert.equal(handle.id, "modal_tenant-a_persistent-session");
    assert.equal(handle.ports[previewPort], `${endpoint}/preview/${previewPort}/`);
    assert.equal(handle.ports[8080], undefined);
    await handle.transport!.request("POST", "/files/create", { path: "persist.txt", content: "kept" });

    const providerB = new PinnedModalSandboxProvider({ endpointUrl: endpoint, sharedKey: sessionKey });
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

test("pinned hub backgrounds foreground dev servers, rewrites preview navigation, and filters cache files", async () => {
  const originalVm = process.env.OH_VM_ISOLATED;
  const originalDisableSrt = process.env.OH_DISABLE_SRT;
  process.env.OH_VM_ISOLATED = "1";
  process.env.OH_DISABLE_SRT = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-pinned-modal-polish-"));
  const workspaces = path.join(root, "workspaces");
  const sessionKey = "polish-test-key-aaaaaaaaaaaaaaaaaaaaaa";
  const hub = createSandboxHubServer({ root: workspaces, sessionKey });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  const sandboxId = "sess_polish";
  const auth = { "x-session-key": sessionKey, "x-oh-sandbox-id": sandboxId };
  const call = async (method: string, route: string, body?: unknown) => fetch(`${endpoint}${route}`, {
    method,
    headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let processId = "";
  let assetServer: http.Server | undefined;
  try {
    assert.equal((await call("POST", "/sessions/init", {})).status, 200);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(workspaces, sandboxId)).mode & 0o777, 0o700);
    }

    await call("POST", "/files/create", { path: "hello.py", content: "print('hello')\n" });
    await call("POST", "/files/create", { path: "index.html", content: "<link rel=\"stylesheet\" href=\"/style.css\">" });
    await call("POST", "/files/create", { path: "style.css", content: "body { color: rgb(1, 2, 3); }" });
    const workspace = hub.daemons.get(sandboxId)!.config.workspacePath;
    fs.mkdirSync(path.join(workspace, "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "__pycache__", "hello.cpython-311.pyc"), Buffer.from([0, 1, 2, 3]));

    const files = await (await call("POST", "/search/glob", { pattern: "**/*" })).json() as any;
    assert.ok(files.matches.includes("hello.py"));
    assert.ok(!files.matches.some((file: string) => file.includes("__pycache__") || file.endsWith(".pyc")));
    const diff = await (await call("POST", "/checkpoints/diff", {})).json() as any;
    assert.ok(diff.files.includes("hello.py"));
    assert.ok(!diff.files.some((file: string) => file.includes("__pycache__") || file.endsWith(".pyc")));

    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const python = process.platform === "win32" ? "python" : "python3";
    const startedAt = Date.now();
    const shell = await (await call("POST", "/shell/main/exec", {
      command: `${python} -m http.server ${port} --bind 0.0.0.0`,
      timeoutSec: 20,
    })).json() as any;
    assert.ok(Date.now() - startedAt < 3_000, "foreground dev server should be promoted promptly");
    assert.equal(shell.exitCode, 0);
    assert.equal(shell.port, port, "positional http.server port should register immediately");
    processId = String(shell.backgroundProcessId ?? "");
    assert.ok(processId);

    const navigated = await call("POST", "/browser/navigate", {
      url: `${endpoint}/preview/${port}/`,
    });
    assert.equal(navigated.status, 200);
    const navigation = await navigated.json() as any;
    assert.equal(navigation.url, `http://127.0.0.1:${port}/`);

    const barePreview = await fetch(`${endpoint}/preview/${port}`, { redirect: "manual" });
    assert.equal(barePreview.status, 302);
    assert.equal(barePreview.headers.get("location"), `/preview/${port}/`);

    assetServer = http.createServer((req, res) => {
      if (req.url === "/style.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { color: rgb(1, 2, 3); }");
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => assetServer!.listen(0, "127.0.0.1", resolve));
    const assetPort = (assetServer.address() as { port: number }).port;
    const asset = await fetch(`${endpoint}/style.css`, {
      headers: { referer: `${endpoint}/preview/${assetPort}/` },
    });
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /rgb\(1, 2, 3\)/);
  } finally {
    if (processId) await call("DELETE", `/processes/${encodeURIComponent(processId)}`).catch(() => {});
    if (assetServer?.listening) await new Promise<void>((resolve) => assetServer!.close(() => resolve()));
    await hub.closeHub();
    fs.rmSync(root, { recursive: true, force: true });
    if (originalVm === undefined) delete process.env.OH_VM_ISOLATED; else process.env.OH_VM_ISOLATED = originalVm;
    if (originalDisableSrt === undefined) delete process.env.OH_DISABLE_SRT; else process.env.OH_DISABLE_SRT = originalDisableSrt;
  }
});

test("root hub runs sessions as distinct uids, blocks cross-session paths and proc env, and returns file ownership", {
  skip: process.platform !== "linux" || process.getuid?.() !== 0,
}, async () => {
  const oldVm = process.env.OH_VM_ISOLATED;
  const oldDisableSrt = process.env.OH_DISABLE_SRT;
  process.env.OH_VM_ISOLATED = "1";
  process.env.OH_DISABLE_SRT = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-hub-uid-")).replace(/\\/g, "/");
  const workspaces = path.join(root, "workspaces");
  const key = "root-hub-test-key-aaaaaaaaaaaaaaaaaaaa";
  const hub = createSandboxHubServer({ root: workspaces, sessionKey: key });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const address = hub.address() as { port: number };
  const endpoint = `http://127.0.0.1:${address.port}`;
  const call = (id: string, method: string, route: string, body?: unknown) => fetch(`${endpoint}${route}`, {
    method,
    headers: { "x-session-key": key, "x-oh-sandbox-id": id, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    for (const id of ["uid_session_a", "uid_session_b"]) assert.equal((await call(id, "POST", "/sessions/init", {})).status, 200);
    const a = hub.daemons.get("uid_session_a")!;
    const b = hub.daemons.get("uid_session_b")!;
    const aStat = fs.statSync(a.config.workspacePath);
    const bStat = fs.statSync(b.config.workspacePath);
    assert.notEqual(aStat.uid, bStat.uid);
    assert.equal(aStat.mode & 0o777, 0o700);

    const created = await call("uid_session_a", "POST", "/files/create", { path: "editable.txt", content: "created by API\n" });
    assert.equal(created.status, 200);
    const edit = await (await call("uid_session_a", "POST", "/shell/main/exec", { command: "echo shell-edit >> editable.txt", timeoutSec: 10 })).json() as any;
    assert.equal(edit.exitCode, 0, edit.output);
    assert.match(fs.readFileSync(path.join(a.config.workspacePath, "editable.txt"), "utf8"), /shell-edit/);

    const probe = async (command: string) => await (await call("uid_session_a", "POST", "/shell/main/exec", { command, timeoutSec: 10 })).json() as any;
    assert.notEqual((await probe("cat /proc/1/environ")).exitCode, 0);
    assert.notEqual((await probe(`ls ${b.config.workspacePath}`)).exitCode, 0);
    assert.notEqual((await probe(`cat /proc/${process.pid}/environ`)).exitCode, 0);
  } finally {
    await hub.closeHub();
    fs.rmSync(root, { recursive: true, force: true });
    if (oldVm === undefined) delete process.env.OH_VM_ISOLATED; else process.env.OH_VM_ISOLATED = oldVm;
    if (oldDisableSrt === undefined) delete process.env.OH_DISABLE_SRT; else process.env.OH_DISABLE_SRT = oldDisableSrt;
  }
});
