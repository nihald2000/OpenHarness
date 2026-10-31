#!/usr/bin/env node
// scripts/e2e-modal.mjs -- End-to-end verification against a deployed OpenHarness Modal backend
const BASE_URL = (process.env.OH_URL || process.env.VITE_OPENHARNESS_URL || "http://127.0.0.1:4096").replace(/\/$/, "");
const ACCESS_KEY = process.env.OH_ACCESS_KEY || "";

const headers = {
  "content-type": "application/json",
  ...(ACCESS_KEY ? { "x-oh-key": ACCESS_KEY } : {}),
};

async function req(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function main() {
  console.log(`[E2E] Checking health at ${BASE_URL}/health ...`);
  const health = await req("GET", "/health");
  console.log(`[E2E] Health OK:`, health);

  const runtimes = await req("GET", "/v1/runtimes");
  console.log(`[E2E] Runtimes:`, runtimes.map((r) => `${r.id}(active=${r.active})`).join(", "));

  const session = await req("POST", "/v1/sessions", {
    title: "E2E Modal Coding Agent Smoke Test",
    mode: "task",
    runtime: runtimes.find((r) => r.id === "modal" && r.active) ? "modal" : "local",
  });
  console.log(`[E2E] Created session: ${session.id} (runtime=${session.runtime})`);

  const promptRes = await req("POST", `/v1/sessions/${session.id}/prompt`, {
    text: "Create a small Node.js module in add.js that exports add(a, b), write a test in add.test.js, and run it.",
    mode: "task",
    clientTurnId: `e2e_${Date.now()}`,
  });
  console.log(`[E2E] Started run:`, promptRes);

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const s = await req("GET", `/v1/sessions/${session.id}`);
    if (s.status === "completed" || s.status === "idle") {
      console.log(`[E2E] Session completed!`);
      break;
    }
    if (s.status === "failed" || s.status === "cancelled") {
      throw new Error(`Run ended in status ${s.status}: ${s.error || ""}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const files = await req("GET", `/v1/sessions/${session.id}/files`);
  console.log(`[E2E] Workspace files (${files.files.length}):`, files.files.slice(0, 10));

  const diff = await req("GET", `/v1/sessions/${session.id}/diff`);
  console.log(`[E2E] Changed files:`, diff.changed);

  const archive = await req("GET", `/v1/sessions/${session.id}/archive`);
  console.log(`[E2E] Archive generated: ${archive.filename} (${(archive.archiveBase64 || "").length} base64 chars)`);
  console.log(`[E2E] PASS`);
}

main().catch((err) => {
  console.error(`[E2E] FAIL:`, err);
  process.exit(1);
});
