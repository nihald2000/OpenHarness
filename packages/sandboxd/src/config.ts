import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { CompiledSandboxPolicy } from "../../core/src/sandbox/policy.ts";

export const BASE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: "/home/agent",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
};

export const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|MODAL|AWS|GITHUB)/i;

/** srt's own settings schema (sandbox-runtime src/sandbox/sandbox-config.ts). */
export function toSrtSettings(p: CompiledSandboxPolicy) {
  if (p.network.mode === "open") {
    throw new Error("Open egress is not allowed for sandboxed execution");
  }
  const domains = p.network.mode === "none" ? [] : p.network.allowedDomains;
  return {
    network: {
      allowDomains: domains,
      allowedDomains: domains,
      denyDomains: [],
      denyResolvedAddresses: p.network.denyResolvedAddresses,
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: p.filesystem.denyRead,
      allowRead: p.filesystem.allowRead,
      allowWrite: p.filesystem.allowWrite,
      denyWrite: p.filesystem.mandatoryDeny,
      allowGitConfig: Boolean(p.filesystem.allowGitConfigWrite),
    },
    mandatoryDenySearchDepth: 3,
  };
}

export type ConfineConfig = {
  srtSettingsPath: string;
  runAs?: { uid: number; gid: number };
  useSrt?: boolean;
};

export function isSrtInstalled(): boolean {
  return spawnSync("srt", ["--version"], { encoding: "utf8" }).status === 0;
}

export function assertEnforcementAvailable(checkFn: () => boolean = isSrtInstalled): void {
  if (!checkFn()) {
    throw new Error("srt is not installed; refusing to execute (fail closed)");
  }
}

export function buildCleanEnv(userEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV };
  for (const [k, v] of Object.entries(userEnv)) {
    if (/^[A-Z_][A-Z0-9_]*$/i.test(k) && !SECRETISH.test(k) && typeof v === "string") {
      env[k] = v;
    }
  }
  return env;
}

export function spawnConfined(
  cfg: ConfineConfig,
  command: string,
  cwd: string,
  userEnv: Record<string, string> = {}
): ChildProcess {
  const env = buildCleanEnv(userEnv);
  const useSrt = cfg.useSrt ?? isSrtInstalled();
  let argv: string[];
  if (useSrt) {
    const drop = cfg.runAs
      ? [
          "setpriv",
          "--reuid",
          String(cfg.runAs.uid),
          "--regid",
          String(cfg.runAs.gid),
          "--init-groups",
          "--no-new-privs",
          "--",
        ]
      : [];
    argv = [
      ...drop,
      "srt",
      "--settings",
      cfg.srtSettingsPath,
      "--",
      "bash",
      "--noprofile",
      "--norc",
      "-c",
      command,
    ];
  } else {
    argv = ["bash", "--noprofile", "--norc", "-c", command];
  }
  return spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
}

export function spawnConfinedArgv(
  argv: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000
): { status: number; stdout: string; stderr: string } {
  const env = { ...buildCleanEnv(), ...extraEnv };
  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function killConfinedProcessGroup(child: ChildProcess | undefined, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child || !child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // ignore already exited
    }
  }
}

export function writeSrtSettings(filePath: string, policy: CompiledSandboxPolicy): void {
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(toSrtSettings(policy), null, 2), {
    mode: 0o444,
  });
}
