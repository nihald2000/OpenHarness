import type {
  ConfirmationPolicy,
  PermissionReply,
  PermissionRequest,
  RiskLevel,
} from "@openharness/sdk";
import type {
  PolicyDecision,
  PolicyGate,
  RegisteredTool,
  RunState,
} from "../agent/deps.ts";

const RISK_ORDER: Record<RiskLevel, number> = {
  low: 1,
  medium: 2,
  high: 3,
  unknown: 4,
};

export function maxRiskLevel(a: RiskLevel, b?: RiskLevel): RiskLevel {
  if (!b) return a;
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/**
 * Splits a shell command into all sub-commands across `&&`, `||`, `;`, `|`,
 * subshells `$(...)`, backticks, `xargs`, `sh -c "..."`, `bash -c "..."`, and `eval "..."` (§9 G.3).
 */
export function splitShellSubcommands(command: string): string[] {
  const results: string[] = [];
  if (!command || !command.trim()) return results;

  const queue: string[] = [command.trim()];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    // Extract $(...) subshells
    const subshellMatches = current.matchAll(/\$\(([^)]+)\)/g);
    for (const m of subshellMatches) {
      if (m[1]) queue.push(m[1].trim());
    }

    // Extract backtick subshells `...`
    const backtickMatches = current.matchAll(/`([^`]+)`/g);
    for (const m of backtickMatches) {
      if (m[1]) queue.push(m[1].trim());
    }

    // Extract `sh -c "..."`, `bash -c "..."`, `zsh -c "..."`, `eval "..."`
    const nestedShellMatches = current.matchAll(
      /\b(?:(?:ba|z)?sh\s+-c|eval)\s+(?:["']([\s\S]*?)["']|(\S+))/g
    );
    for (const m of nestedShellMatches) {
      const inner = (m[1] ?? m[2] ?? "").trim();
      if (inner) queue.push(inner);
    }

    // Split top-level operators `&&`, `||`, `;`, `|` outside quotes
    const parts = splitTopLevelShellOperators(current);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      results.push(trimmed);

      // Check `xargs <cmd>`
      const xargsMatch = trimmed.match(/^xargs\s+(?:-[A-Za-z0-9]+\s+)*(.+)$/);
      if (xargsMatch && xargsMatch[1]) {
        results.push(xargsMatch[1].trim());
      }
    }
  }

  return results;
}

function splitTopLevelShellOperators(input: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote: string | null = null;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      buf += ch;
      if (ch === "\\" && i + 1 < input.length) {
        buf += input[++i]!;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      buf += ch;
      continue;
    }
    if (ch === "(") {
      parenDepth++;
      buf += ch;
      continue;
    }
    if (ch === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      buf += ch;
      continue;
    }
    if (parenDepth === 0) {
      if ((ch === "&" && input[i + 1] === "&") || (ch === "|" && input[i + 1] === "|")) {
        out.push(buf);
        buf = "";
        i += 1;
        continue;
      }
      if (ch === ";" || ch === "|") {
        out.push(buf);
        buf = "";
        continue;
      }
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/**
 * Deterministic risk classifier for any tool call and its arguments (§9 G.3).
 */
export function classifyToolCallRisk(
  toolName: string,
  input: Record<string, unknown>,
  opts?: {
    readOnly?: boolean;
    knownAllowedDomains?: string[];
    modelSelfAssessedRisk?: RiskLevel;
  }
): { risk: RiskLevel; reason?: string } {
  let computed: RiskLevel = opts?.readOnly ? "low" : "medium";
  let reason: string | undefined;

  if (toolName === "bash" || toolName === "shell" || toolName === "process_start") {
    const rawCmd = Array.isArray(input.command)
      ? input.command.join(" ")
      : String(input.command ?? "");

    // Check piped curl/wget to sh/bash directly on the full command
    if (/\b(?:curl|wget)\b[\s\S]*?\|\s*(?:ba|z)?sh\b/i.test(rawCmd)) {
      computed = "high";
      reason = "Piping remote script directly into shell (curl/wget | sh)";
    }

    const subcommands = splitShellSubcommands(rawCmd);
    for (const sub of subcommands) {
      if (/\brm\s+(?:-[A-Za-z]*[rf][A-Za-z]*\s+|--recursive|--force)/i.test(sub)) {
        computed = "high";
        reason = `Destructive recursive/forced removal in subcommand: "${sub}"`;
        break;
      }
      if (/\bgit\s+push\b[\s\S]*?(?:--force|-f\b)/i.test(sub)) {
        computed = "high";
        reason = `Force git push in subcommand: "${sub}"`;
        break;
      }
      if (/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[A-Za-z]*f/i.test(sub)) {
        computed = "high";
        reason = `Destructive git reset/clean in subcommand: "${sub}"`;
        break;
      }
      if (/\bchmod\s+-R\b|\bchown\s+-R\b/i.test(sub)) {
        computed = "high";
        reason = `Recursive permission change in subcommand: "${sub}"`;
        break;
      }
      if (/\b(?:npm\s+publish|yarn\s+publish|pnpm\s+publish|cargo\s+publish|twine\s+upload)\b/i.test(sub)) {
        computed = "high";
        reason = `Package registry publish in subcommand: "${sub}"`;
        break;
      }
      if (/(?:>{1,2}|\btee\s+|\btouch\s+)\s*\/(?:etc|usr|var|root|bin|sbin)\b/.test(sub)) {
        computed = "high";
        reason = `Write outside workspace in subcommand: "${sub}"`;
        break;
      }
    }
  } else if (
    toolName === "write_file" ||
    toolName === "edit" ||
    toolName === "apply_patch"
  ) {
    const targetPath = String(input.path ?? input.patch ?? "");
    if (
      /(?:^|\/)(?:\.github\/workflows\/|\.openharness\/verify\.json|Dockerfile|docker-compose)/i.test(
        targetPath
      )
    ) {
      computed = "high";
      reason = `Modifying CI/verification/container config: "${targetPath.slice(0, 80)}"`;
    } else if (targetPath.startsWith("/") && !targetPath.startsWith("/workspace") && !targetPath.startsWith("/tmp") && !targetPath.startsWith("/memories")) {
      computed = "high";
      reason = `Write outside workspace: "${targetPath}"`;
    }
  } else if (toolName === "git_push" || toolName === "github_pr") {
    computed = "high";
    reason = `External repository mutation (${toolName})`;
  } else if (toolName === "webfetch" || toolName === "browser_navigate") {
    const urlStr = String(input.url ?? "");
    try {
      const host = new URL(urlStr).hostname.toLowerCase();
      const known = (opts?.knownAllowedDomains ?? []).map((d) => d.toLowerCase());
      if (known.length > 0 && !known.includes(host) && host !== "127.0.0.1" && host !== "localhost") {
        computed = "high";
        reason = `Network request to newly seen domain "${host}"`;
      }
    } catch {
      computed = "unknown";
      reason = `Unparseable URL "${urlStr}"`;
    }
  }

  const effective = maxRiskLevel(computed, opts?.modelSelfAssessedRisk);
  return { risk: effective, reason };
}

/**
 * Wraps untrusted external content with explicit provenance delimiters (§9 G.4).
 */
export function wrapUntrustedContent(content: string, provenance: string): string {
  return `<untrusted_data provenance="${provenance}">\n${content}\n</untrusted_data>`;
}

export interface RiskPolicyGateOptions {
  osEnforcedSandbox: boolean;
  isOsEnforced?: (state: RunState) => boolean;
  defaultConfirmationPolicy?: ConfirmationPolicy;
  initialPreTaintAllowedDomains?: string[];
}

/**
 * Central PolicyGate enforcing:
 * - Risk-graded confirmation (`always`, `risky`, `never` — `never` allowed ONLY in OS-enforced sandbox) (§9 G.3)
 * - Scoped `always` grants (which can NEVER auto-approve `high` risk) (§9 G.3)
 * - Taint tracking for untrusted external content (`webfetch`, `browser_*`, remote MCP, issue bodies) (§9 G.4)
 */
export class RiskPolicyGate implements PolicyGate {
  private opts: RiskPolicyGateOptions;
  private alwaysApprovedTools = new Set<string>();

  constructor(opts: RiskPolicyGateOptions) {
    this.opts = opts;
  }

  resolveConfirmationPolicy(state: RunState): ConfirmationPolicy {
    const osEnforced = this.opts.isOsEnforced
      ? this.opts.isOsEnforced(state)
      : this.opts.osEnforcedSandbox;
    const requested =
      state.confirmationPolicy ??
      this.opts.defaultConfirmationPolicy ??
      (osEnforced && state.mode !== "chat" ? "risky" : "always");

    // Fail closed: `never` is allowed ONLY inside an OS-enforced sandbox (§0 rule 10, §9 G.3)
    if (requested === "never" && !osEnforced) {
      return "risky";
    }
    return requested;
  }

  async evaluateToolCall(
    tool: RegisteredTool,
    input: Record<string, unknown>,
    state: RunState
  ): Promise<PolicyDecision> {
    const knownDomains =
      state.preTaintAllowedDomains.length > 0
        ? state.preTaintAllowedDomains
        : this.opts.initialPreTaintAllowedDomains ?? ["localhost", "127.0.0.1"];

    const { risk, reason } = classifyToolCallRisk(tool.name, input, {
      readOnly: tool.readOnly,
      knownAllowedDomains: knownDomains,
      modelSelfAssessedRisk: input._risk as RiskLevel | undefined,
    });

    // Taint exfiltration guard (§9 G.4):
    // Once context is tainted by untrusted external content, outbound network to domains not allowlisted
    // before taint occurred OR brokered secret tools (git_push, github_pr) ALWAYS require confirmation!
    if (state.tainted) {
      if (tool.name === "git_push" || tool.name === "github_pr") {
        return {
          action: "ask",
          risk: "high",
          reason: `Context is tainted by untrusted content (${state.taintSources.join(", ")}); brokered tool "${tool.name}" requires explicit human confirmation.`,
          pattern: tool.name,
        };
      }

      const urlCandidates: string[] = [];
      if (typeof input.url === "string") urlCandidates.push(input.url);
      if (typeof input.command === "string") {
        const matches = input.command.match(/https?:\/\/[^\s"';|&)+]+/g);
        if (matches) urlCandidates.push(...matches);
      }

      for (const u of urlCandidates) {
        try {
          const host = new URL(u).hostname.toLowerCase();
          const preAllowed = knownDomains.map((d) => d.toLowerCase());
          if (!preAllowed.includes(host)) {
            return {
              action: "ask",
              risk: "high",
              reason: `Tainted context attempted outbound network connection to newly seen domain "${host}" (taint sources: ${state.taintSources.join(", ")})`,
              pattern: `${tool.name}:${host}`,
            };
          }
        } catch {
          // ignore
        }
      }
    }

    // Read-only low-risk tools run without confirmation
    if (tool.readOnly && risk === "low") {
      return { action: "allow", risk };
    }

    // `always` rules can NEVER auto-approve `high` or `unknown` risk (§9 G.3)
    if (
      this.alwaysApprovedTools.has(tool.name) &&
      risk !== "high" &&
      risk !== "unknown"
    ) {
      return { action: "allow", risk };
    }

    const policy = this.resolveConfirmationPolicy(state);
    if (policy === "never") {
      return { action: "allow", risk };
    }
    if (policy === "risky") {
      if (risk === "high" || risk === "unknown") {
        return {
          action: "ask",
          risk,
          reason: reason ?? `Tool "${tool.name}" classified as ${risk} risk`,
          pattern: tool.name,
        };
      }
      return { action: "allow", risk };
    }

    // `always` policy: ask on every mutating call (or high/unknown risk)
    return {
      action: "ask",
      risk,
      reason: reason ?? `Mutating tool "${tool.name}" requires confirmation under 'always' policy`,
      pattern: tool.name,
    };
  }

  async recordPermissionReply(
    request: PermissionRequest,
    reply: PermissionReply
  ): Promise<void> {
    // `always` rules persist narrowly scoped approval, but never for `high` risk (§9 G.3)
    if (reply === "always" && request.risk !== "high" && request.risk !== "unknown") {
      this.alwaysApprovedTools.add(request.permission);
    }
  }
}
