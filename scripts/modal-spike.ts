import fs from "node:fs/promises";
import { ModalClient } from "modal";

async function runSpike() {
  if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
    console.log("Skipping live Modal spike: MODAL_TOKEN_ID / MODAL_TOKEN_SECRET not set.");
    return;
  }
  const modal = new ModalClient();
  const app = await modal.apps.fromName("openharness-spike", { createIfMissing: true });
  const manifest = JSON.parse(await fs.readFile("deploy/modal/image-manifest.json", "utf8"));
  const image = await modal.images.fromId(manifest.sandboxImage ?? manifest.imageId);
  const runId = `spike-${Date.now()}`;
  const sb = await (modal.sandboxes as any).create(app, image, {
    runtime: "vm",
    timeoutMs: 600_000,
    outboundDomainAllowlist: [],
    outboundCidrAllowlist: [],
    command: ["/usr/local/bin/oh-sandboxd", "--host", "0.0.0.0", "--port", "8080"],
    env: {
      OH_SESSION_KEY: `spike-${runId}`,
      OH_SESSION_ID: "spike",
      OH_RUN_ID: runId,
      OH_POLICY_B64: Buffer.from(JSON.stringify({ network: { mode: "none", allowedDomains: [], denyResolvedAddresses: [] }, filesystem: { allowRead: ["/workspace"], allowWrite: ["/workspace"], denyRead: [], mandatoryDeny: [] } })).toString("base64"),
    },
  });
  try {
    console.log("id", sb.sandboxId);
    const tok = await sb.createConnectToken(8080, { userMetadata: JSON.stringify({ runId }) });
    console.log("token?", Boolean(tok?.token));
    const r = await fetch(`${tok.url.replace(/\/$/, "")}/health`, {
      headers: { authorization: `Bearer ${tok.token}` },
    });
    console.log("health status", r.status);
    const p = await sb.exec(["bash", "-c", "curl -sS -m 5 https://example.com || echo BLOCKED"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    console.log(await p.stdout.readText(), await p.wait());
  } finally {
    await sb.terminate();
  }
}

void runSpike();
