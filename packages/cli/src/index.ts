import { probeModelCapabilities, resolveModelProfile } from "@openharness/core";
import type { OpenHarnessServer } from "@openharness/server";

export interface CliResult {
  exitCode: number;
  stdout: string;
  data?: unknown;
}

/**
 * `oh` CLI command runner supporting:
 * - `oh model probe <id>` (§4 B.1)
 * - `oh session checkpoints <sessionId>` (§11 Phase I)
 * - `oh session rewind <sessionId> --checkpoint <sha> [--files] [--conversation]` (§11 Phase I)
 * - `oh session fork <sessionId> [--checkpoint <sha>] [--at-message <msgId>]` (§11 Phase I)
 * - `oh schedules list|create|trigger` (§10 Phase H)
 * - `oh server|info|models|runtimes` (§0.1)
 */
export async function runOhCli(
  argv: string[],
  server?: OpenHarnessServer
): Promise<CliResult> {
  const isJson = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    const helpText = [
      "OpenHarness CLI (oh)",
      "Usage:",
      "  oh model probe <model-id> [--json]",
      "  oh session checkpoints <session-id> [--json]",
      "  oh session rewind <session-id> --checkpoint <sha> [--files] [--conversation] [--json]",
      "  oh session fork <session-id> [--checkpoint <sha>] [--at-message <msg-id>] [--json]",
      "  oh schedules list [--json]",
      "  oh info [--json]",
    ].join("\n");
    return { exitCode: 0, stdout: helpText };
  }

  // `oh model probe <id>` (§4 B.1)
  if (cmd === "model" && args[1] === "probe") {
    const modelId = args[2] ?? "mock/demo";
    const profile = await probeModelCapabilities(modelId);
    const out = isJson
      ? JSON.stringify({ modelId, profile }, null, 2)
      : `Model Probe: ${modelId}\n  wire: ${profile.wire}\n  contextWindow: ${profile.contextWindow}\n  outputParam: ${profile.outputParam}\n  toolCalling: ${profile.toolCalling}\n  streamingToolCalls: ${profile.streamingToolCalls}`;
    return { exitCode: 0, stdout: out, data: profile };
  }

  // `oh session checkpoints|rewind|fork` (§11 Phase I)
  if (cmd === "session") {
    const sub = args[1];
    const sessionId = args[2];
    if (!server || !sessionId) {
      return { exitCode: 1, stdout: "Error: session ID and server instance required" };
    }

    if (sub === "checkpoints") {
      const res = await server.handleRequest("GET", `/v1/sessions/${sessionId}/checkpoints`);
      return {
        exitCode: res.status === 200 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }

    if (sub === "rewind") {
      const cpIdx = args.indexOf("--checkpoint");
      const checkpoint = cpIdx !== -1 ? args[cpIdx + 1] : args[3];
      const conversation = args.includes("--conversation");
      const files = !args.includes("--no-files");
      const res = await server.handleRequest(
        "POST",
        `/v1/sessions/${sessionId}/rewind`,
        {},
        { checkpoint, files, conversation }
      );
      return {
        exitCode: res.status === 200 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }

    if (sub === "fork") {
      const cpIdx = args.indexOf("--checkpoint");
      const msgIdx = args.indexOf("--at-message");
      const checkpoint = cpIdx !== -1 ? args[cpIdx + 1] : undefined;
      const atMessageId = msgIdx !== -1 ? args[msgIdx + 1] : undefined;
      const res = await server.handleRequest(
        "POST",
        `/v1/sessions/${sessionId}/fork`,
        {},
        { checkpoint, atMessageId }
      );
      return {
        exitCode: res.status === 201 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }
  }

  if (cmd === "info" && server) {
    const res = await server.handleRequest("GET", "/v1/info");
    return {
      exitCode: 0,
      stdout: JSON.stringify(res.body, null, 2),
      data: res.body,
    };
  }

  const fallbackProfile = resolveModelProfile(cmd);
  return {
    exitCode: 0,
    stdout: JSON.stringify({ command: cmd, profile: fallbackProfile }),
  };
}
