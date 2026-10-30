import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { ModalSandboxRef } from "./modal-api.ts";

export const AGENT = {
  args: [
    "setpriv",
    "--clear-groups",
    "--init-groups",
    "--reset-env",
    "-",
    "env",
    "HOME=/home/agent",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "--",
    "bash",
  ],
  env: [] as string[],
};

const EXCLUDES = [
  "node_modules",
  ".git/objects/pack/*.tmp",
  ".openharness",
  "dist",
  "next",
  ".next",
  "__pycache__",
  ".env",
  ".env.*",
];
const MAX_UPLOAD = 500 * 1024 * 1024;

export function sha256(data: string | Uint8Array): crypto.Hash {
  return crypto.createHash("sha256").update(data);
}

export async function packLocal(dir: string): Promise<Uint8Array> {
  const args = [
    "-czf",
    "-",
    ...EXCLUDES.flatMap((e) => [`--exclude=${e}`]),
    "-C",
    dir,
    ".",
  ];
  const child = spawn("tar", args);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of child.stdout) {
    const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
    size += buf.length;
    if (size > MAX_UPLOAD) {
      child.kill();
      throw new Error("workspace exceeds 500 MB; use a git source");
    }
    chunks.push(buf);
  }
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? 1)));
  if (code !== 0) throw new Error(`tar exited ${code}`);
  return Buffer.concat(chunks);
}

export type WorkspaceSource =
  | { kind: "local"; path: string; prepackedTar?: Uint8Array }
  | { kind: "git"; url: string; ref: string }
  | { kind: "snapshot"; imageId: string }
  | { type: "bind" | "copy" | "git" | "empty"; hostPath?: string; gitUrl?: string; ref?: string };

export async function materializeWorkspace(
  sb: ModalSandboxRef,
  ws: any,
  fetchGitTarball?: (url: string, ref: string) => Promise<Uint8Array>
): Promise<void> {
  let strip = 0;
  const kind = ws.kind ?? (ws.type === "bind" || ws.type === "copy" ? "local" : ws.type);
  const localPath = ws.path ?? ws.hostPath;

  if (kind === "empty") return;
  if (kind === "local" && localPath) {
    const tarball = ws.prepackedTar ?? (await packLocal(localPath));
    await sb.writeBytes("/tmp/oh/src.tar.gz", tarball);
  } else if (kind === "git") {
    if (!fetchGitTarball) {
      throw new Error("fetchGitTarball broker is required for git workspace sources");
    }
    const tarball = await fetchGitTarball(ws.url ?? ws.gitUrl, ws.ref ?? "HEAD");
    await sb.writeBytes("/tmp/oh/src.tar.gz", tarball);
    strip = 1;
  } else {
    throw new Error(`unsupported workspace source ${String(kind)}`);
  }

  const r = await sb.exec(
    [
      "bash",
      "-lc",
      `set -o pipefail; tar -xzf /tmp/oh/src.tar.gz -C /workspace --no-same-owner --strip-components=${strip}`,
    ],
    { timeoutMs: 600_000 }
  );
  if (r.exitCode !== 0) {
    throw new Error(`workspace extract failed: ${r.stderr.slice(-2_000)}`);
  }
}
