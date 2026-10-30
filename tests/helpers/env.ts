import { spawnSync } from "node:child_process";

const ok = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { encoding: "utf8" }).status === 0;

export const hasBash = ok("bash", ["-c", "true"]);
export const hasDocker = ok("docker", ["--version"]);
export const hasModal = Boolean(
  process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET
);
export const hasSrt = ok("srt", ["--version"]);
export const hasPosixBash = process.platform !== "win32" && hasBash;
