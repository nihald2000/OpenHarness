import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenHarnessEvent } from "@openharness/sdk";
import {
  createInitialRunState,
  ModelAgnosticProviderAdapter,
  StandardToolRouter,
} from "../packages/core/src/index.ts";
import { runSubagent } from "../packages/server/src/subagents.ts";

test("Step 6 (M5): runSubagent executes a real multi-turn tool loop, forbids write/delegate tools for explore, and emits delegated_task parts", async () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "oh-subagent-ws-"));
  fs.writeFileSync(
    path.join(workspaceDir, "secret-route.ts"),
    "export const AUTH_ENDPOINT = '/v1/auth/callback';\n",
    "utf8"
  );

  let subagentTurn = 0;
  let advertisedToolNames: string[] = [];
  let sawFileContentInTurn2 = false;

  const provider = new ModelAgnosticProviderAdapter({
    transport: async (payload) => {
      subagentTurn += 1;
      if (subagentTurn === 1) {
        advertisedToolNames = (payload.tools ?? []).map((t: any) => t.function?.name ?? t.name);
        return {
          text: "Reading secret-route.ts",
          tool_calls: [
            {
              id: "call_sub_1",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "secret-route.ts" }),
              },
            },
          ],
          usage: { prompt_tokens: 40, completion_tokens: 15 },
        };
      }
      const msgDump = JSON.stringify(payload.messages ?? []);
      if (msgDump.includes("/v1/auth/callback")) {
        sawFileContentInTurn2 = true;
      }
      return {
        text: "Found AUTH_ENDPOINT = '/v1/auth/callback' in secret-route.ts.",
        tool_calls: [],
        usage: { prompt_tokens: 60, completion_tokens: 20 },
      };
    },
  });

  const toolRouter = new StandardToolRouter({
    workspaceRoot: workspaceDir,
    sandboxEnabled: true,
  });

  const emitted: OpenHarnessEvent[] = [];
  const state = createInitialRunState({
    runId: "run_parent_1",
    sessionId: "sess_parent_1",
    model: "gpt-4o",
    mode: "task",
    phase: "building",
  });

  const res = await runSubagent({
    input: {
      agent: "explore",
      prompt: "Find AUTH_ENDPOINT in secret-route.ts",
    },
    ctx: {
      runId: state.runId,
      sessionId: state.sessionId,
      tenantId: "default",
      workspaceRoot: workspaceDir,
      state,
    },
    provider,
    toolRouter,
    emit: async (_tenantId, _sessionId, ev) => {
      emitted.push(ev);
    },
  });

  assert.equal(res.error, undefined);
  assert.equal(sawFileContentInTurn2, true, "Subagent must see real read_file tool result on turn 2");
  assert.equal(advertisedToolNames.includes("read_file"), true);
  assert.equal(advertisedToolNames.includes("write_file"), false, "Explore subagent must not have write_file");
  assert.equal(advertisedToolNames.includes("delegate"), false, "Subagent must not recursively delegate");

  const out = res.output as { status: string; report: string };
  assert.equal(out.status, "completed");
  assert.match(out.report, /\/v1\/auth\/callback/);

  const delegatedEvents = emitted.filter(
    (e) => e.type === "part.updated" && e.part.type === "delegated_task"
  );
  assert.equal(delegatedEvents.length, 2, "Must emit running and completed delegated_task parts");
});
