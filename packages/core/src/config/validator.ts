export const ALLOWED_TOP_LEVEL_CONFIG_KEYS = new Set([
  "$schema",
  "model",
  "smallModel",
  "defaultAgent",
  "defaultRuntime",
  "mode",
  "providers",
  "agents",
  "sandbox",
  "limits",
  "context",
  "compaction",
  "verify",
  "confirmation",
  "stuckDetection",
  "schedules",
  "mcp",
  "plugins",
  "permissions",
  "guardrails",
  "codeMode",
  "advanced",
  "skills",
  "commands",
  "prompt",
  "hooks",
]);

const ALLOWED_NESTED_KEYS: Record<string, Set<string>> = {
  mode: new Set(["default"]),
  sandbox: new Set([
    "default",
    "allowUnsandboxedAutonomy",
    "docker",
    "modal",
    "filesystem",
    "network",
    "pauseIdleTtlSec",
  ]),
  "sandbox.docker": new Set(["image", "cpus", "memoryMb", "diskMb"]),
  "sandbox.modal": new Set([
    "app",
    "appName",
    "runtime",
    "idleTtlSec",
    "environment",
    "imageManifest",
    "cpu",
    "memoryMiB",
    "timeoutMs",
    "bootTimeoutMs",
    "setupCommandTimeoutMs",
    "snapshotTtlMs",
    "envCacheTtlDays",
    "encryptedPorts",
    "inboundCidrAllowlist",
    "maxConcurrentSandboxes",
    "reaperIntervalMs",
    "pricing",
  ]),
  "sandbox.modal.pricing": new Set(["cpuCoreSecondUsd", "memoryMiBSecondUsd"]),
  "sandbox.filesystem": new Set(["extraAllowWrite", "extraDenyRead"]),
  "sandbox.network": new Set(["setupPresets", "agentPresets", "allowedDomains", "methods"]),
  context: new Set([
    "clearAfterTurns",
    "recitationEveryTurns",
    "keepRecentTokens",
    "handoffAtRatio",
    "precompute",
  ]),
  verify: new Set(["commands", "maxIterations", "noProgressLimit", "e2e", "auto"]),
  confirmation: new Set(["policy", "unattended"]),
  "confirmation.unattended": new Set(["onConfirm"]),
  stuckDetection: new Set([
    "actionObservation",
    "actionError",
    "monologue",
    "alternating",
    "malformed",
    "compactions",
  ]),
};

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedConfig: Record<string, unknown>;
}

/**
 * Fail-closed configuration validator for `openharness.json` (§0 rule 10, §14).
 * Rejects unknown top-level and nested configuration keys and validates policy values.
 */
export function validateOpenHarnessConfig(
  rawConfig: unknown
): ConfigValidationResult {
  const errors: string[] = [];
  if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    return {
      valid: false,
      errors: ["Configuration root must be a JSON object"],
      sanitizedConfig: {},
    };
  }

  const cfg = rawConfig as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(cfg)) {
    if (!ALLOWED_TOP_LEVEL_CONFIG_KEYS.has(key)) {
      errors.push(`Unknown top-level configuration key "${key}" (fail-closed)`);
      continue;
    }

    const nestedAllowed = ALLOWED_NESTED_KEYS[key];
    if (nestedAllowed && value && typeof value === "object" && !Array.isArray(value)) {
      const subObj = value as Record<string, unknown>;
      for (const [subKey, subVal] of Object.entries(subObj)) {
        if (!nestedAllowed.has(subKey)) {
          errors.push(`Unknown configuration key "${key}.${subKey}" (fail-closed)`);
        }
        const deepAllowed = ALLOWED_NESTED_KEYS[`${key}.${subKey}`];
        if (deepAllowed && subVal && typeof subVal === "object" && !Array.isArray(subVal)) {
          for (const deepKey of Object.keys(subVal as Record<string, unknown>)) {
            if (!deepAllowed.has(deepKey)) {
              errors.push(`Unknown configuration key "${key}.${subKey}.${deepKey}" (fail-closed)`);
            }
          }
        }
      }
    }

    sanitized[key] = value;
  }

  // Validate confirmation.policy
  const conf = cfg.confirmation as { policy?: string; unattended?: { onConfirm?: string } } | undefined;
  if (conf?.policy && !["always", "risky", "never"].includes(conf.policy)) {
    errors.push(`Invalid confirmation.policy "${conf.policy}"; must be "always" | "risky" | "never"`);
  }
  if (
    conf?.unattended?.onConfirm &&
    !["deny", "pause"].includes(conf.unattended.onConfirm)
  ) {
    errors.push(
      `Invalid confirmation.unattended.onConfirm "${conf.unattended.onConfirm}"; must be "deny" | "pause"`
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedConfig: sanitized,
  };
}
