import path from "node:path";
import os from "node:os";

export type NetworkPresetName = "package-registries" | "github-read" | "docs";

export const NETWORK_ALLOWLIST_PRESETS: Record<NetworkPresetName, string[]> = {
  "package-registries": [
    "registry.npmjs.org",
    "*.npmjs.org",
    "pypi.org",
    "files.pythonhosted.org",
    "crates.io",
    "static.crates.io",
    "proxy.golang.org",
    "sum.golang.org",
    "repo.maven.apache.org",
  ],
  "github-read": [
    "github.com",
    "api.github.com",
    "raw.githubusercontent.com",
    "objects.githubusercontent.com",
  ],
  docs: [
    "developer.mozilla.org",
    "nodejs.org",
    "docs.python.org",
    "pkg.go.dev",
    "docs.rs",
  ],
};

/**
 * Private, loopback, link-local, and cloud metadata CIDRs/IPs that are ALWAYS denied (§5 C.4).
 */
export const MANDATORY_DENIED_ADDRESSES: readonly string[] = [
  "169.254.169.254",
  "169.254.169.254/32",
  "169.254.0.0/16",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "127.0.0.0/8",
  "100.64.0.0/10",
  "fc00::/7",
  "fe80::/10",
  "metadata.google.internal",
] as const;

/**
 * Mandatory filesystem write/read deny patterns applied last and never overridable (§5 C.4).
 */
export const MANDATORY_FS_DENY_PATTERNS: readonly string[] = [
  ".git/hooks",
  ".git/hooks/**",
  ".git/config",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".profile",
  ".mcp.json",
  ".vscode",
  ".vscode/**",
  ".idea",
  ".idea/**",
  ".openharness/agents",
  ".openharness/agents/**",
  ".openharness/commands",
  ".openharness/commands/**",
  ".openharness/skills",
  ".openharness/skills/**",
  "/oh/policy.json",
] as const;

export interface EgressHeaderInjectionRule {
  domain: string;
  headerName: string;
  secretRef: string;
}

export interface CompiledSandboxPolicy {
  version: 1;
  runId: string;
  phase: "setup" | "agent";
  filesystem: {
    denyRead: string[];
    allowRead: string[];
    allowWrite: string[];
    mandatoryDeny: string[];
    allowGitConfigWrite?: boolean;
  };
  network: {
    mode: "none" | "allowlist" | "open";
    allowedDomains: string[];
    allowedMethods: string[];
    deniedResolvedAddresses: string[];
    headerInjectionRules: EgressHeaderInjectionRule[];
  };
}

export interface CompilePolicyInput {
  runId: string;
  phase?: "setup" | "agent";
  workspacePath?: string;
  memoriesPath?: string;
  tmpPath?: string;
  dataDir?: string;
  allowGitConfigWrite?: boolean;
  networkMode?: "none" | "allowlist" | "open";
  presets?: NetworkPresetName[];
  additionalAllowedDomains?: string[];
  allowedMethods?: string[];
  headerInjectionRules?: EgressHeaderInjectionRule[];
}

/**
 * Compiles an immutable, fail-closed sandbox policy for a run (§5 C.4).
 */
export function compileSandboxPolicy(input: CompilePolicyInput): CompiledSandboxPolicy {
  const phase = input.phase ?? "agent";
  const workspacePath = path.resolve(input.workspacePath ?? "/workspace");
  const memoriesPath = path.resolve(input.memoriesPath ?? "/memories");
  const tmpPath = path.resolve(input.tmpPath ?? "/tmp");
  const homeDir = os.homedir();
  const dataDir = path.resolve(input.dataDir ?? ".openharness");

  const denyRead = [
    path.join(homeDir, ".ssh"),
    path.join(homeDir, ".aws"),
    path.join(homeDir, ".config", "gcloud"),
    path.join(homeDir, ".kube"),
    path.join(homeDir, ".npmrc"),
    path.join(homeDir, ".pypirc"),
    "/root/.ssh",
    "/root/.aws",
    "/root/.config/gcloud",
    "~/.ssh",
    "~/.aws",
    "~/.config/gcloud",
    dataDir,
    "/oh/policy.json",
  ];

  const allowRead = [workspacePath, memoriesPath, tmpPath, "/usr", "/bin", "/lib", "/etc"];
  const allowWrite = [workspacePath, memoriesPath, tmpPath];

  const mandatoryDeny = MANDATORY_FS_DENY_PATTERNS.filter(
    (p) => !(input.allowGitConfigWrite && p === ".git/config")
  );

  // Determine network policy for setup vs agent phase
  const presets =
    input.presets ?? (phase === "setup" ? ["package-registries", "github-read"] : []);
  const domainSet = new Set<string>();
  for (const preset of presets) {
    const list = NETWORK_ALLOWLIST_PRESETS[preset];
    if (list) {
      for (const d of list) domainSet.add(d.toLowerCase());
    }
  }
  for (const extra of input.additionalAllowedDomains ?? []) {
    if (extra && typeof extra === "string") {
      domainSet.add(extra.toLowerCase());
    }
  }

  const allowedDomains = Array.from(domainSet);
  const mode =
    input.networkMode ??
    (phase === "setup"
      ? "allowlist"
      : allowedDomains.length > 0
      ? "allowlist"
      : "none");

  const allowedMethods = (input.allowedMethods ?? (phase === "setup" ? ["GET", "HEAD"] : ["GET", "HEAD"])).map(
    (m) => m.toUpperCase()
  );

  return {
    version: 1,
    runId: input.runId,
    phase,
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      mandatoryDeny,
      allowGitConfigWrite: Boolean(input.allowGitConfigWrite),
    },
    network: {
      mode,
      allowedDomains,
      allowedMethods,
      deniedResolvedAddresses: [...MANDATORY_DENIED_ADDRESSES],
      headerInjectionRules: input.headerInjectionRules ?? [],
    },
  };
}

/**
 * Checks if a filesystem read or write is permitted under the compiled policy (§5 C.4).
 * Enforces:
 * 1. Mandatory denies applied LAST (never overridable)
 * 2. Reads: deny-then-allow
 * 3. Writes: allow-only (/workspace, /tmp, /memories)
 */
export function evaluateFilesystemAccess(
  policy: CompiledSandboxPolicy,
  targetPath: string,
  operation: "read" | "write",
  workspaceRoot = policy.filesystem.allowWrite[0] ?? "/workspace"
): { allowed: boolean; kind?: "fs_read" | "fs_write" | "mandatory_deny"; reason?: string } {
  const rawNormalized = targetPath.replace(/\\/g, "/");
  const resolved = rawNormalized.startsWith("~")
    ? rawNormalized.replace(/^~/, os.homedir().replace(/\\/g, "/"))
    : path.resolve(workspaceRoot, targetPath).replace(/\\/g, "/");

  const relToWorkspace = path.relative(path.resolve(workspaceRoot), resolved).replace(/\\/g, "/");

  // 1. Check mandatory denies first/last (never overridable)
  if (isMandatoryDeniedPath(rawNormalized, resolved, relToWorkspace, policy.filesystem.allowGitConfigWrite)) {
    return {
      allowed: false,
      kind: "mandatory_deny",
      reason: `Mandatory sandbox deny rule blocked ${operation} on "${targetPath}"`,
    };
  }

  // 2. Check denyRead for both read and write
  for (const denied of policy.filesystem.denyRead) {
    const normDenied = denied.startsWith("~")
      ? denied.replace(/^~/, os.homedir().replace(/\\/g, "/"))
      : path.resolve(denied).replace(/\\/g, "/");
    if (
      rawNormalized === denied ||
      rawNormalized.startsWith(denied + "/") ||
      resolved === normDenied ||
      resolved.startsWith(normDenied + "/")
    ) {
      return {
        allowed: false,
        kind: operation === "read" ? "fs_read" : "fs_write",
        reason: `Sandbox denyRead blocked ${operation} on protected path "${targetPath}"`,
      };
    }
  }

  if (operation === "write") {
    // 3. Writes are strictly allow-only (/workspace, /tmp, /memories)
    const allowedWrite = policy.filesystem.allowWrite.some((allowedRoot) => {
      const normRoot = path.resolve(allowedRoot).replace(/\\/g, "/");
      return resolved === normRoot || resolved.startsWith(normRoot + "/");
    });
    if (!allowedWrite) {
      return {
        allowed: false,
        kind: "fs_write",
        reason: `Sandbox allow-only write policy blocked write outside allowed roots (${policy.filesystem.allowWrite.join(", ")}): "${targetPath}"`,
      };
    }
  }

  return { allowed: true };
}

function isMandatoryDeniedPath(
  rawPath: string,
  resolvedPath: string,
  relToWorkspace: string,
  allowGitConfigWrite?: boolean
): boolean {
  const candidates = [rawPath, resolvedPath, relToWorkspace];
  for (const c of candidates) {
    if (c === "/oh/policy.json" || c.endsWith("/oh/policy.json")) return true;
    if (/(?:^|\/)\.git\/hooks(?:\/|$)/.test(c)) return true;
    if (!allowGitConfigWrite && /(?:^|\/)\.git\/config$/.test(c)) return true;
    if (/(?:^|\/)\.(?:bashrc|bash_profile|zshrc|profile)$/.test(c)) return true;
    if (/(?:^|\/)\.mcp\.json$/.test(c)) return true;
    if (/(?:^|\/)\.(?:vscode|idea)(?:\/|$)/.test(c)) return true;
    if (/(?:^|\/)\.openharness\/(?:agents|commands|skills)(?:\/|$)/.test(c)) return true;
    // Block .env* outside test/fixture paths
    if (/(?:^|\/)\.env(?:\.[A-Za-z0-9_.-]+)?$/.test(c)) {
      if (!/(?:test|fixture|example|sample)/i.test(c) && !c.endsWith(".env.example")) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Checks if an outbound network request is permitted under the compiled policy (§5 C.4).
 * Blocks non-allowlisted domains, private/metadata IPs (169.254.169.254, RFC1918), and disallowed HTTP methods.
 */
export function evaluateNetworkAccess(
  policy: CompiledSandboxPolicy,
  urlOrHost: string,
  method = "GET",
  resolvedIp?: string
): { allowed: boolean; kind?: "network"; reason?: string } {
  let host = urlOrHost.trim().toLowerCase();
  try {
    if (host.includes("://")) {
      const parsed = new URL(host);
      host = parsed.hostname.toLowerCase();
    } else if (host.includes("/")) {
      host = host.split("/")[0]!.split(":")[0]!;
    } else if (host.includes(":")) {
      host = host.split(":")[0]!;
    }
  } catch {
    return { allowed: false, kind: "network", reason: `Malformed network target "${urlOrHost}"` };
  }

  // 1. Always block cloud metadata and private/loopback IP literals regardless of mode (§5 C.4)
  if (isDeniedIpOrHost(host) || (resolvedIp && isDeniedIpOrHost(resolvedIp))) {
    return {
      allowed: false,
      kind: "network",
      reason: `Blocked connection to forbidden private/metadata address "${resolvedIp || host}"`,
    };
  }

  // 2. Check network mode
  if (policy.network.mode === "none") {
    return {
      allowed: false,
      kind: "network",
      reason: `Outbound network is disabled in current sandbox policy (target: "${host}")`,
    };
  }

  // 3. Check HTTP method restriction
  const upperMethod = method.toUpperCase();
  if (
    policy.network.allowedMethods.length > 0 &&
    !policy.network.allowedMethods.includes(upperMethod)
  ) {
    return {
      allowed: false,
      kind: "network",
      reason: `HTTP method "${upperMethod}" is not permitted by sandbox network policy (${policy.network.allowedMethods.join(", ")})`,
    };
  }

  // 4. Check domain allowlist when in allowlist mode
  if (policy.network.mode === "allowlist") {
    const matched = policy.network.allowedDomains.some((pattern) => {
      const p = pattern.toLowerCase();
      if (p.startsWith("*.")) {
        const suffix = p.slice(1); // .example.com
        return host.endsWith(suffix) || host === p.slice(2);
      }
      return host === p;
    });
    if (!matched) {
      return {
        allowed: false,
        kind: "network",
        reason: `Domain "${host}" is not in the sandbox network allowlist`,
      };
    }
  }

  return { allowed: true };
}

function isDeniedIpOrHost(hostOrIp: string): boolean {
  const h = hostOrIp.trim().toLowerCase();
  if (
    h === "169.254.169.254" ||
    h === "metadata.google.internal" ||
    h === "localhost" ||
    h === "::1" ||
    h.startsWith("169.254.") ||
    h.startsWith("127.") ||
    h.startsWith("10.") ||
    h.startsWith("192.168.") ||
    h.startsWith("fe80:") ||
    h.startsWith("fc00:") ||
    h.startsWith("fd00:")
  ) {
    return true;
  }
  // Check 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  const m172 = h.match(/^172\.(\d+)\.\d+\.\d+$/);
  if (m172) {
    const secondOctet = Number.parseInt(m172[1]!, 10);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

/**
 * Formats the `srt` command-line wrapper arguments (`srt --settings /oh/policy.json -- <argv>`) (§5 C.2).
 * Note the mandatory `--` separator before `<argv>` (PHASE0 gotcha 1).
 */
export function buildSrtCommandArgs(policyFilePath: string, argv: string[]): string[] {
  return ["srt", "--settings", policyFilePath, "--", ...argv];
}

/**
 * Redacts known secret values and common credential patterns from any tool output or log (§5 C.5).
 */
export function redactSecretsFromOutput(text: string, secretValues: string[] = []): string {
  if (!text) return text;
  let redacted = text;
  for (const secret of secretValues) {
    if (secret && secret.length >= 4) {
      redacted = redacted.split(secret).join("[REDACTED_SECRET]");
    }
  }
  // Redact common token shapes (sk-..., ghp_..., gho_..., Bearer ...)
  redacted = redacted
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED_TOKEN]");
  return redacted;
}
