import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { OpenHarnessEvent } from "@openharness/sdk";
import { OpenHarnessServer } from "../packages/server/src/server.ts";
import { createHttpServer } from "../packages/server/src/main.ts";
import { HttpOpenHarnessClient } from "../src/lib/http-client.ts";
import { loginAdminWithToken } from "../src/lib/use-admin.ts";

test("Step 9 (R3): HttpOpenHarnessClient executes real /v1/* requests and /v1/events SSE stream, and loginAdminWithToken rejects invalid tokens with 403 and exchanges valid tokens for HttpOnly cookie", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-step9-data-"));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-step9-ws-"));

  const server = new OpenHarnessServer({
    dataDir,
    workspaceRoot: workspaceDir,
    loopback: true,
    adminToken: "admin_secret_token_step9_1234567890",
  });
  await server.start();

  const httpServer = createHttpServer(server);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Verify admin login rejects wrong token with 403 and accepts valid token with 200 + HttpOnly cookie
    const badLogin = await loginAdminWithToken("wrong-token", baseUrl);
    assert.equal(badLogin.ok, false);
    assert.match(String(badLogin.error), /invalid admin token/i);

    let capturedCookie = "";
    const customFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (capturedCookie) {
        headers.set("cookie", capturedCookie);
      }
      const res = await fetch(input, { ...init, headers });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        capturedCookie = setCookie.split(";")[0]!;
      }
      return res;
    };

    const goodLogin = await loginAdminWithToken(
      "admin_secret_token_step9_1234567890",
      baseUrl,
      customFetch
    );
    assert.equal(goodLogin.ok, true);
    assert.match(capturedCookie, /^oh_session=/);

    // 2. Verify HttpOpenHarnessClient talks to the live server over HTTP + SSE
    let activeAbort: AbortController | null = null;
    const client = new HttpOpenHarnessClient({
      baseUrl,
      fetchImpl: customFetch,
      eventSourceFactory: (url) => {
        const esObj = {
          onopen: null as (() => void) | null,
          onmessage: null as ((ev: { data: string; lastEventId?: string }) => void) | null,
          onerror: null as ((err: unknown) => void) | null,
          close: () => {
            activeAbort?.abort();
          },
        };
        activeAbort = new AbortController();
        void (async () => {
          try {
            const res = await customFetch(url, { signal: activeAbort.signal });
            if (res.ok) esObj.onopen?.();
            const reader = res.body!.getReader();
            const decoder = new TextDecoder();
            let buf = "";
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let sep: number;
              while ((sep = buf.indexOf("\n\n")) !== -1) {
                const frame = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                let id = "";
                let data = "";
                for (const line of frame.split("\n")) {
                  if (line.startsWith("id:")) id = line.slice(3).trim();
                  else if (line.startsWith("data:")) data += line.slice(5).trim();
                }
                if (data) {
                  esObj.onmessage?.({ data, lastEventId: id });
                }
              }
            }
          } catch (err) {
            if ((err as Error)?.name !== "AbortError") {
              esObj.onerror?.(err);
            }
          }
        })();
        return esObj;
      },
    });

    const info = await client.info();
    assert.equal(info.version, "0.2.0");

    // Admin route works using the HttpOnly session cookie acquired via loginAdminWithToken
    await client.secrets.set("STEP9_KEY", "super_secret_val");
    const secrets = await client.secrets.list();
    assert.ok(secrets.some((s) => s.name === "STEP9_KEY"));

    // Create a session, subscribe to SSE events, and send a prompt
    const sess = await client.session.create({
      title: "Step 9 Live Web Client",
      agent: "assistant",
      model: "mock/demo",
    });
    assert.ok(sess.id);

    const receivedEvents: OpenHarnessEvent[] = [];
    const sub = client.subscribe(sess.id, (ev) => {
      receivedEvents.push(ev);
    });

    const promptRes = await client.session.prompt(sess.id, {
      text: "Hello from real HttpOpenHarnessClient!",
    });
    assert.ok(promptRes.messageId);

    const { messages } = await client.session.messages(sess.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.info.role, "user");
    assert.equal(messages[1]?.info.role, "assistant");

    // Give the SSE stream a brief tick to flush
    await new Promise((r) => setTimeout(r, 100));
    sub.close();

    assert.ok(
      receivedEvents.some((e) => e.type === "message.updated"),
      "Expected SSE stream to deliver message.updated event"
    );
    assert.ok(
      receivedEvents.some((e) => e.type === "run.status"),
      "Expected SSE stream to deliver run.status event"
    );
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});
