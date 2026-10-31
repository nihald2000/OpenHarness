import fs from "node:fs";
import { parseArgs } from "node:util";
import { SandboxDaemon } from "./server.ts";
import { compileSandboxPolicy } from "../../core/src/sandbox/policy.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "0.0.0.0" },
    port: { type: "string", default: "8080" },
  },
});

const sessionKey = process.env.OH_SESSION_KEY ?? "dev-session-key";
const sessionId = process.env.OH_SESSION_ID ?? "sess_default";
const runId = process.env.OH_RUN_ID ?? "run_default";
const policy = process.env.OH_POLICY_B64
  ? JSON.parse(Buffer.from(process.env.OH_POLICY_B64, "base64").toString("utf8"))
  : compileSandboxPolicy({
      runId,
      phase: "agent",
      workspacePath: "/workspace",
      networkMode: "allowlist",
    });

for (const k of Object.keys(process.env)) {
  if (k.startsWith("MODAL_")) delete process.env[k];
}

fs.mkdirSync("/workspace", { recursive: true });
fs.mkdirSync("/memories", { recursive: true });
fs.mkdirSync("/tmp/oh", { recursive: true });
fs.mkdirSync("/oh/.shadow-git", { recursive: true });

const daemon = new SandboxDaemon({
  sessionId,
  runId,
  sessionKey,
  policy,
  workspacePath: "/workspace",
  memoriesPath: "/memories",
  tmpPath: "/tmp/oh",
  shadowGitDir: "/oh/.shadow-git",
});

await daemon.listen(Number(values.port), values.host);
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => void daemon.close().then(() => process.exit(0)));
}
