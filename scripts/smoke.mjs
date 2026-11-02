// End-to-end guest-cookie smoke test. Usage: node scripts/smoke.mjs <base-url>
const base = (process.argv[2] ?? "").replace(/\/$/, "");
if (!base) throw new Error("usage: node scripts/smoke.mjs <base-url>");
const ok = async (response, what) => {
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status} ${await response.text()}`);
  return response;
};

await ok(await fetch(`${base}/health`), "health");
const guest = await ok(await fetch(`${base}/v1/guest/session`), "guest session");
const cookie = (guest.headers.get("set-cookie") ?? "").split(";")[0];
if (!cookie) throw new Error("guest session did not set a cookie");
const headers = { cookie, "content-type": "application/json" };

const hold = await fetch(`${base}/v1/internal/hold`);
if (hold.status !== 404) throw new Error(`/v1/internal/hold must be hidden, got ${hold.status}`);

const session = await (await ok(await fetch(`${base}/v1/sessions`, {
  method: "POST", headers, body: JSON.stringify({ title: "smoke", model: "mock/demo", mode: "ask" }),
}), "create session")).json();
const sent = await (await ok(await fetch(`${base}/v1/sessions/${encodeURIComponent(session.id)}/prompt`, {
  method: "POST", headers, body: JSON.stringify({ text: "smoke test", mode: "ask" }),
}), "prompt")).json();

const deadline = Date.now() + 60_000;
for (;;) {
  const run = await (await ok(await fetch(`${base}/v1/runs/${encodeURIComponent(sent.runId)}`, { headers }), "get run")).json();
  const phase = run.phase ?? run.status ?? run.state?.phase;
  if (phase === "completed") {
    console.log("smoke ok", session.id, sent.runId);
    break;
  }
  if (phase === "failed" || phase === "cancelled") throw new Error(`run ${phase}: ${JSON.stringify(run).slice(0, 500)}`);
  if (Date.now() > deadline) throw new Error(`timeout, last phase=${phase}`);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}
