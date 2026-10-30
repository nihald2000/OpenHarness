import fs from "node:fs";
import { parseArgs } from "node:util";
import { SandboxDaemon } from "./server.ts";
import { assertEnforcementAvailable, writeSrtSettings } from "./config.ts";

const isMain = process.argv[1]?.endsWith("main.ts") || process.argv[1]?.endsWith("oh-sandboxd");

if (isMain) {
  const { values } = parseArgs({
    options: {
      host: { type: "string", default: "0.0.0.0" },
      port: { type: "string", default: "8080" },
    },
  });
  const take = (k: string): string => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const sessionKey = take("OH_SESSION_KEY");
  const sessionId = take("OH_SESSION_ID");
  const runId = take("OH_RUN_ID");
  const policy = JSON.parse(Buffer.from(take("OH_POLICY_B64"), "base64").toString("utf8"));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("MODAL_")) delete process.env[k];
  }

  assertEnforcementAvailable();
  fs.mkdirSync("/oh", { recursive: true });
  fs.writeFileSync("/oh/policy.json", JSON.stringify(policy), { mode: 0o444 });
  writeSrtSettings("/oh/srt-settings.json", policy);

  const daemon = new SandboxDaemon({
    sessionId,
    runId,
    sessionKey,
    policy,
    workspacePath: "/workspace",
    memoriesPath: "/memories",
    tmpPath: "/tmp/oh",
    shadowGitDir: "/oh/.shadow-git",
    policyFilePath: "/oh/policy.json",
    srtSettingsPath: "/oh/srt-settings.json",
    runAs: { uid: 1000, gid: 1000 },
    requireSrt: true,
  });
  await daemon.listen(Number(values.port), values.host);
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => void daemon.close().then(() => process.exit(0)));
  }
}
