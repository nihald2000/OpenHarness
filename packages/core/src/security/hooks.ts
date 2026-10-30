export type HookEventName =
  | "preToolUse"
  | "postToolUse"
  | "preCompact"
  | "sessionStart"
  | "stop";

export interface HookContext {
  event: HookEventName;
  runId: string;
  sessionId: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
}

export interface HookDecision {
  action: "allow" | "deny" | "modify" | "annotate";
  reason?: string;
  modifiedInput?: Record<string, unknown>;
  annotation?: string;
}

export interface HookAuditLogEntry {
  timestamp: number;
  hookName: string;
  event: HookEventName;
  decision: HookDecision;
}

export type HookHandler = (ctx: HookContext) => Promise<HookDecision> | HookDecision;

/**
 * Deterministic lifecycle HookRunner (`preToolUse`, `postToolUse`, `preCompact`, `sessionStart`, `stop`)
 * with full audit logging (§9 G.5).
 */
export class HookRunner {
  private handlers = new Map<HookEventName, Array<{ name: string; fn: HookHandler }>>();
  readonly auditLog: HookAuditLogEntry[] = [];

  register(event: HookEventName, name: string, fn: HookHandler): void {
    const list = this.handlers.get(event) ?? [];
    list.push({ name, fn });
    this.handlers.set(event, list);
  }

  async runHooks(ctx: HookContext): Promise<{
    allowed: boolean;
    reason?: string;
    input: Record<string, unknown>;
    annotations: string[];
  }> {
    const list = this.handlers.get(ctx.event) ?? [];
    let currentInput = { ...(ctx.input ?? {}) };
    const annotations: string[] = [];

    for (const h of list) {
      const decision = await h.fn({ ...ctx, input: currentInput });
      this.auditLog.push({
        timestamp: Date.now(),
        hookName: h.name,
        event: ctx.event,
        decision,
      });

      if (decision.action === "deny") {
        return {
          allowed: false,
          reason: decision.reason ?? `Denied by hook "${h.name}"`,
          input: currentInput,
          annotations,
        };
      }
      if (decision.action === "modify" && decision.modifiedInput) {
        currentInput = { ...decision.modifiedInput };
      }
      if (decision.action === "annotate" && decision.annotation) {
        annotations.push(decision.annotation);
      }
    }

    return {
      allowed: true,
      input: currentInput,
      annotations,
    };
  }
}
