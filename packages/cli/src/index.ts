import {
  probeModelCapabilities,
  resolveModelProfile,
  runEvalSuite,
} from "@openharness/core";
import type { OpenHarnessServer } from "@openharness/server";

export interface CliResult {
  exitCode: number;
  stdout: string;
  data?: unknown;
}

/**
 * `oh` CLI command runner (§0.1, §4 B.1, §11 Phase I, §12 Phase J, §13 Phase K):
 * - `oh run --mode long_task --sandbox docker --budget-usd 20 "<objective>"`
 * - `oh runs`
 * - `oh run attach <runId>`
 * - `oh run pause|resume|extend <runId>`
 * - `oh sandbox ls|shell|destroy`
 * - `oh model probe <id>`
 * - `oh session checkpoints|rewind|fork`
 * - `oh eval [smoke-20|long-horizon|model-compat]`
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
      '  oh run [--mode chat|task|long_task] [--sandbox local|srt-local|docker|modal] [--budget-usd <num>] "<objective>" [--json]',
      "  oh runs [--json]",
      "  oh run attach <run-id> [--json]",
      "  oh run pause|resume|extend|cancel <run-id> [--json]",
      "  oh sandbox ls|shell|destroy [<sandbox-id>] [--cmd <command>] [--json]",
      "  oh model probe <model-id> [--json]",
      "  oh session checkpoints <session-id> [--json]",
      "  oh session rewind <session-id> --checkpoint <sha> [--files] [--conversation] [--json]",
      "  oh session fork <session-id> [--checkpoint <sha>] [--at-message <msg-id>] [--json]",
      "  oh eval [smoke-20|long-horizon|model-compat] [--k <num>] [--judge] [--json]",
      "  oh schedules list [--json]",
      "  oh info [--json]",
    ].join("\n");
    return { exitCode: 0, stdout: helpText };
  }

  // `oh model probe <id>` (§4 B.1, §13 Phase K)
  if (cmd === "model" && args[1] === "probe") {
    const modelId = args[2] ?? "mock/demo";
    const profile = await probeModelCapabilities(modelId);
    const out = isJson
      ? JSON.stringify({ modelId, profile }, null, 2)
      : `Model Probe: ${modelId}\n  wire: ${profile.wire}\n  contextWindow: ${profile.contextWindow}\n  outputParam: ${profile.outputParam}\n  toolCalling: ${profile.toolCalling}\n  streamingToolCalls: ${profile.streamingToolCalls}`;
    return { exitCode: 0, stdout: out, data: profile };
  }

  // `oh eval [suite]` (§12 Phase J)
  if (cmd === "eval") {
    const suiteArg = args[1];
    const suiteName =
      suiteArg === "long-horizon" || suiteArg === "model-compat"
        ? suiteArg
        : "smoke-20";
    const kIdx = args.indexOf("--k");
    const k = kIdx !== -1 && args[kIdx + 1] ? Number.parseInt(args[kIdx + 1]!, 10) : 3;
    const enableLlmJudge = args.includes("--judge");
    const report = await runEvalSuite(suiteName, { k, enableLlmJudge });
    return {
      exitCode: report.passHatKRate > 0 ? 0 : 1,
      stdout: JSON.stringify(report, null, 2),
      data: report,
    };
  }

  // `oh runs` (§13 Phase K)
  if (cmd === "runs") {
    if (!server) {
      return { exitCode: 0, stdout: JSON.stringify({ runs: [] }), data: { runs: [] } };
    }
    const res = await server.handleRequest("GET", "/v1/runs");
    return {
      exitCode: res.status === 200 ? 0 : 1,
      stdout: JSON.stringify(res.body, null, 2),
      data: res.body,
    };
  }

  // `oh run ...` (§13 Phase K)
  if (cmd === "run") {
    const sub = args[1];

    // Subcommands: `oh run attach|pause|resume|extend|cancel <runId>`
    if (
      sub === "attach" ||
      sub === "pause" ||
      sub === "resume" ||
      sub === "extend" ||
      sub === "cancel"
    ) {
      const runId = args[2] ?? "";
      if (!server || !runId) {
        return { exitCode: 1, stdout: "Error: server and runId required" };
      }
      if (sub === "attach") {
        const res = await server.handleRequest("GET", `/v1/runs/${runId}`);
        return {
          exitCode: res.status === 200 ? 0 : 1,
          stdout: JSON.stringify(res.body, null, 2),
          data: res.body,
        };
      }
      if (sub === "extend") {
        const res = await server.handleRequest(
          "POST",
          `/v1/runs/${runId}/resume`,
          {},
          { extend: true }
        );
        return {
          exitCode: res.status === 200 ? 0 : 1,
          stdout: JSON.stringify(res.body, null, 2),
          data: res.body,
        };
      }
      const res = await server.handleRequest("POST", `/v1/runs/${runId}/${sub}`, {}, {});
      return {
        exitCode: res.status === 200 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }

    // `oh run --mode long_task --sandbox docker --budget-usd 20 "<objective>"` (§13 Phase K)
    let mode: "chat" | "task" | "long_task" = "chat";
    let sandbox = "local";
    let budgetUsd: number | undefined;
    let objective = "";

    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--mode" && args[i + 1]) {
        mode = args[++i] as "chat" | "task" | "long_task";
      } else if (a === "--sandbox" && args[i + 1]) {
        sandbox = args[++i]!;
      } else if (a === "--budget-usd" && args[i + 1]) {
        budgetUsd = Number.parseFloat(args[++i]!);
      } else if (!a.startsWith("--")) {
        objective = a;
      }
    }

    if (!server) {
      const summary = {
        mode,
        sandbox,
        budgetUsd,
        objective,
        status: "started",
      };
      return { exitCode: 0, stdout: JSON.stringify(summary, null, 2), data: summary };
    }

    const sessRes = await server.handleRequest("POST", "/v1/sessions", {}, {
      title: objective.slice(0, 60) || "CLI Run",
      runtime: sandbox,
      mode,
    });
    const session = sessRes.body as { id: string };
    const promptRes = await server.handleRequest(
      "POST",
      `/v1/sessions/${session.id}/prompt`,
      {},
      {
        text: objective,
        mode,
        sandbox,
        budgetUsd,
      }
    );
    const outData = {
      sessionId: session.id,
      ...(promptRes.body as Record<string, unknown>),
      mode,
      sandbox,
      budgetUsd,
    };
    return {
      exitCode: promptRes.status === 202 ? 0 : 1,
      stdout: JSON.stringify(outData, null, 2),
      data: outData,
    };
  }

  // `oh sandbox ls|shell|destroy` (§13 Phase K)
  if (cmd === "sandbox") {
    const sub = args[1] ?? "ls";
    if (!server) {
      return { exitCode: 0, stdout: JSON.stringify({ sandboxes: [] }), data: { sandboxes: [] } };
    }
    if (sub === "ls") {
      const res = await server.handleRequest("GET", "/v1/sandboxes");
      return {
        exitCode: res.status === 200 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }
    if (sub === "shell") {
      const sbId = args[2] ?? "default";
      const cmdIdx = args.indexOf("--cmd");
      const command = cmdIdx !== -1 && args[cmdIdx + 1] ? args[cmdIdx + 1]! : "pwd";
      const res = await server.handleRequest(
        "POST",
        `/v1/sandboxes/${sbId}/shell`,
        {},
        { command }
      );
      return {
        exitCode: res.status === 200 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }
    if (sub === "destroy") {
      const sbId = args[2] ?? "default";
      const res = await server.handleRequest("DELETE", `/v1/sandboxes/${sbId}`);
      return {
        exitCode: res.status === 200 || res.status === 204 ? 0 : 1,
        stdout: JSON.stringify(res.body, null, 2),
        data: res.body,
      };
    }
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
