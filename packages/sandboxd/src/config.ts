import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CompiledSandboxPolicy } from "../../core/src/sandbox/policy.ts";

export const BASE_ENV: Readonly<Record<string, string>> = {
  PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: "/home/agent",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  LANG: "C.UTF-8",
  TERM: "xterm-256color",
  PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright",
  PYTHONUNBUFFERED: "1",
};

export const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|MODAL|AWS|GITHUB)/i;
const BLOCKED_USER_ENV = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "SSH_ASKPASS",
]);

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
      denyResolvedAddresses: p.network.deniedResolvedAddresses,
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
  homePath?: string;
  tmpPath?: string;
  useSrt?: boolean;
  srtProbe?: (settingsPath: string) => boolean;
};

const srtCapabilityCache = new Map<string, boolean>();

export function isVmIsolated(): boolean {
  return process.env.OH_VM_ISOLATED === "1";
}

export function isSrtInstalled(): boolean {
  return spawnSync("srt", ["--version"], { encoding: "utf8" }).status === 0;
}

export function assertEnforcementAvailable(
  checkFn: () => boolean = () => isVmIsolated() || isSrtInstalled()
): void {
  if (isVmIsolated()) return;
  if (!checkFn()) {
    throw new Error("srt is not installed; refusing to execute (fail closed)");
  }
}

export function canExecuteUnderSrt(
  srtSettingsPath: string,
  probeOverride?: (settingsPath: string) => boolean
): boolean {
  if (!probeOverride && !isSrtInstalled()) return false;
  const cached = srtCapabilityCache.get(srtSettingsPath);
  if (cached !== undefined && !probeOverride) return cached;
  const probe = probeOverride
    ? probeOverride(srtSettingsPath)
    : spawnSync(
        "srt",
        ["--settings", srtSettingsPath, "--", gitBashExecutable(), "--noprofile", "--norc", "-c", "true"],
        { encoding: "utf8", timeout: 4_000, env: buildCleanEnv() }
      ).status === 0;
  srtCapabilityCache.set(srtSettingsPath, probe);
  return probe;
}

export function buildCleanEnv(userEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV };
  if (process.platform === "win32") {
    const gitRoot = findGitForWindowsRoot();
    const gitPath = gitRoot
      ? [path.join(gitRoot, "usr", "bin"), path.join(gitRoot, "bin"), path.join(gitRoot, "mingw64", "bin")]
      : [];
    env.PATH = [...gitPath, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
  }
  for (const [k, v] of Object.entries(userEnv)) {
    if (
      /^[A-Z_][A-Z0-9_]*$/i.test(k) &&
      !SECRETISH.test(k) &&
      !BLOCKED_USER_ENV.has(k.toUpperCase()) &&
      typeof v === "string"
    ) {
      env[k] = v;
    }
  }
  return env;
}

function findGitForWindowsRoot(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const candidates = [
    process.env.GIT_ROOT,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Git") : undefined,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"]!, "Git") : undefined,
    ...(process.env.PATH ?? "").split(path.delimiter).map((entry) => {
      const dir = entry.replace(/[\\/]+$/, "");
      const leaf = path.basename(dir).toLowerCase();
      return leaf === "cmd" || leaf === "bin" ? path.dirname(dir) : dir;
    }),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((root) => fs.existsSync(path.join(root, "bin", "bash.exe")));
}

export function gitBashExecutable(): string {
  if (process.platform !== "win32") return "bash";
  const root = findGitForWindowsRoot();
  return root ? path.join(root, "bin", "bash.exe") : "bash";
}

export function pythonExecutable(): string {
  if (process.platform !== "win32") return "python3";
  const py3 = spawnSync("python3", ["--version"], { stdio: "ignore", windowsHide: true });
  return py3.error || py3.status !== 0 ? "python" : "python3";
}

export function spawnConfined(
  cfg: ConfineConfig,
  command: string,
  cwd: string,
  userEnv: Record<string, string> = {}
): ChildProcess {
  const sessionEnv = { ...userEnv };
  if (cfg.runAs && cfg.homePath) {
    sessionEnv.HOME = cfg.homePath;
    sessionEnv.npm_config_cache = path.join(cfg.homePath, ".npm");
    sessionEnv.XDG_CACHE_HOME = path.join(cfg.homePath, ".cache");
  }
  if (cfg.runAs && cfg.tmpPath) sessionEnv.TMPDIR = cfg.tmpPath;
  const env = buildCleanEnv(sessionEnv);
  if (!cfg.runAs || !cfg.homePath) env.HOME = cwd;
  env.GIT_CEILING_DIRECTORIES = process.env.OH_WORKSPACES_ROOT
    ? path.resolve(process.env.OH_WORKSPACES_ROOT)
    : path.dirname(path.resolve(cwd));
  const disableSrt = process.env.OH_DISABLE_SRT === "1";
  const requestedSrt = disableSrt ? false : cfg.useSrt ?? isSrtInstalled();
  const useSrt = !disableSrt && requestedSrt && !(isVmIsolated() && !canExecuteUnderSrt(cfg.srtSettingsPath, cfg.srtProbe));
  const drop = cfg.runAs && process.platform === "linux" && process.getuid?.() === 0
    ? ["setpriv", "--reuid", String(cfg.runAs.uid), "--regid", String(cfg.runAs.gid), "--clear-groups", "--no-new-privs", "--"]
    : [];
  const shell = [
      gitBashExecutable(),
      "--noprofile",
      "--norc",
      "-c",
      command,
    ];
  let argv: string[];
  if (useSrt) {
    argv = [
      ...drop,
      "srt",
      "--settings",
      cfg.srtSettingsPath,
      "--",
      ...shell,
    ];
  } else {
    argv = [...drop, ...shell];
  }
  return spawn(argv[0]!, argv.slice(1), { cwd, env, detached: true });
}

export function spawnConfinedArgv(
  argv: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
  timeoutMs = 30_000,
  confine?: ConfineConfig
): { status: number; stdout: string; stderr: string } {
  const sessionEnv: Record<string, string> = { ...extraEnv };
  if (confine?.runAs && confine.homePath) {
    sessionEnv.HOME = confine.homePath;
    sessionEnv.npm_config_cache = path.join(confine.homePath, ".npm");
    sessionEnv.XDG_CACHE_HOME = path.join(confine.homePath, ".cache");
  }
  if (confine?.runAs && confine.tmpPath) sessionEnv.TMPDIR = confine.tmpPath;
  const env = { ...buildCleanEnv(sessionEnv), ...extraEnv };
  if (!confine?.runAs || !confine.homePath) env.HOME = env.HOME || cwd;
  const disableSrt = process.env.OH_DISABLE_SRT === "1";
  const requestedSrt = !confine || disableSrt ? false : confine.useSrt ?? isSrtInstalled();
  const useSrt =
    Boolean(confine) &&
    !disableSrt &&
    requestedSrt &&
    !(isVmIsolated() && !canExecuteUnderSrt(confine!.srtSettingsPath, confine!.srtProbe));
  const drop =
    confine?.runAs && process.platform === "linux" && process.getuid?.() === 0
      ? [
          "setpriv",
          "--reuid",
          String(confine.runAs.uid),
          "--regid",
          String(confine.runAs.gid),
          "--clear-groups",
          "--no-new-privs",
          "--",
        ]
      : [];
  const fullArgv = useSrt
    ? [...drop, "srt", "--settings", confine!.srtSettingsPath, "--", ...argv]
    : [...drop, ...argv];
  const res = spawnSync(fullArgv[0]!, fullArgv.slice(1), {
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
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
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
