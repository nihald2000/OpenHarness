import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { signLiveTicket, verifyLiveTicket } from "../packages/core/src/sandbox/live-ticket.ts";
import { createSandboxHubServer } from "../packages/sandboxd/src/hub.ts";

const key = "live-browser-test-key-0123456789-abcdef";

test("live browser tickets are signed, short-lived, and reject tampering", async () => {
  const token = signLiveTicket("session_123", "view", key, 1_000);
  const decoded = verifyLiveTicket(token, key);
  assert.equal(decoded?.sbx, "session_123");
  assert.equal(decoded?.mode, "view");
  assert.equal(verifyLiveTicket(`${token.slice(0, -1)}x`, key), null);
  assert.equal(verifyLiveTicket(token, `${key}wrong`), null);
  const expiredPayload = Buffer.from(JSON.stringify({
    sbx: "session_123",
    mode: "view",
    exp: Date.now() - 1,
    nonce: "0123456789abcdef0123456789abcdef",
  })).toString("base64url");
  const expiredMac = crypto.createHmac("sha256", `oh-live:${key}`).update(expiredPayload).digest("base64url");
  assert.equal(verifyLiveTicket(`${expiredPayload}.${expiredMac}`, key), null);
});

test("live browser hub requires an exact origin and consumes ticket nonces once", async () => {
  const originalVm = process.env.OH_VM_ISOLATED;
  const originalSrt = process.env.OH_DISABLE_SRT;
  process.env.OH_VM_ISOLATED = "1";
  process.env.OH_DISABLE_SRT = "1";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oh-live-hub-"));
  const hub = createSandboxHubServer({
    root: path.join(root, "workspaces"),
    sessionKey: key,
    liveAllowedOrigins: ["https://openharness-web-six.vercel.app"],
  });
  await new Promise<void>((resolve) => hub.listen(0, "127.0.0.1", resolve));
  const { port } = hub.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/sessions/init", headers: { "x-session-key": key, "x-oh-sandbox-id": "session_123", "content-type": "application/json" } }, (res) => {
      res.resume(); res.once("end", resolve);
    });
    req.once("error", reject); req.end("{}");
  });
  const base = `ws://127.0.0.1:${port}/live?ticket=`;
  const connect = (token: string, origin: string) => new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${base}${encodeURIComponent(token)}`, { origin });
    const timeout = setTimeout(() => { ws.terminate(); resolve(false); }, 1_500);
    ws.once("open", () => { clearTimeout(timeout); ws.close(); resolve(true); });
    ws.once("unexpected-response", (_req, res) => { clearTimeout(timeout); res.resume(); resolve(false); });
    ws.once("error", () => { clearTimeout(timeout); resolve(false); });
  });
  try {
    const valid = signLiveTicket("session_123", "view", key);
    assert.equal(await connect(valid, "https://evil.example"), false);
    assert.equal(await connect(valid, "https://openharness-web-six.vercel.app"), true);
    assert.equal(await connect(valid, "https://openharness-web-six.vercel.app"), false, "the same nonce cannot be replayed");
    const control = signLiveTicket("session_123", "control", key);
    assert.equal(await connect(control, "https://openharness-web-six.vercel.app"), false, "control is rejected until takeover owns the browser");
  } finally {
    await hub.closeHub();
    fs.rmSync(root, { recursive: true, force: true });
    if (originalVm === undefined) delete process.env.OH_VM_ISOLATED; else process.env.OH_VM_ISOLATED = originalVm;
    if (originalSrt === undefined) delete process.env.OH_DISABLE_SRT; else process.env.OH_DISABLE_SRT = originalSrt;
  }
});
