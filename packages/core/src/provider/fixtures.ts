import fs from "node:fs";
import path from "node:path";
import type { ModelProfile } from "./profiles.ts";
import type { ProviderRequestWirePayload, RawProviderResponse } from "./adapter.ts";

export interface RecordedProviderFixture {
  id: string;
  provider: "openai" | "anthropic" | "meta-llama" | "ollama" | "fireworks" | string;
  model: string;
  requestMatcher?: {
    model?: string;
    containsText?: string;
  };
  response: RawProviderResponse;
}

/**
 * Built-in recorded HTTP fixtures for OpenAI, Anthropic, Meta Llama compat,
 * Ollama, and Fireworks response shapes (§12 Phase J, §16 Testing requirements).
 */
export const BUILT_IN_PROVIDER_FIXTURES: Record<string, RecordedProviderFixture> = {
  openai: {
    id: "fixture-openai-gpt4o",
    provider: "openai",
    model: "gpt-4o",
    response: {
      text: "Inspecting workspace with OpenAI native tool call.",
      tool_calls: [
        {
          id: "call_openai_01",
          function: {
            name: "read_file",
            arguments: '{"path":"package.json"}',
          },
        },
      ],
      usage: { prompt_tokens: 180, completion_tokens: 28 },
    },
  },
  anthropic: {
    id: "fixture-anthropic-claude",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    response: {
      thinking: "Checking repository files using read_file.",
      text: "Let's read package.json.",
      tool_calls: [
        {
          id: "toolu_01anthropic",
          name: "read_file",
          arguments: { path: "package.json" },
        },
      ],
      usage: {
        prompt_tokens: 210,
        completion_tokens: 42,
        cache_read_input_tokens: 128,
      },
    },
  },
  "meta-llama": {
    id: "fixture-meta-llama-4",
    provider: "meta-llama",
    model: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    response: {
      text: "Calling read_file on package.json",
      tool_calls: [
        {
          // Llama compat often omits call id and emits trailing comma JSON
          function: {
            name: "read_file",
            arguments: '{"path": "package.json", }',
          },
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 30 },
    },
  },
  ollama: {
    id: "fixture-ollama-local-llama",
    provider: "ollama",
    model: "local-llama",
    response: {
      // Ollama / OSS models frequently emit <tool_call> XML blocks and omit usage
      text: '<tool_call>{"name": "read_file", "arguments": {"path": "package.json"}}</tool_call>',
      tool_calls: [],
    },
  },
  fireworks: {
    id: "fixture-fireworks-llama",
    provider: "fireworks",
    model: "fireworks/llama-v3p3-70b-instruct",
    response: {
      reasoning_content: "Using read_file to inspect package.json",
      text: "Reading package.json",
      tool_calls: [
        {
          id: "call_fw_1",
          function: {
            name: "read_file",
            arguments: "{'path': 'package.json'}",
          },
        },
      ],
      usage: { prompt_tokens: 165, completion_tokens: 33 },
    },
  },
};

/**
 * Record/replay cassette manager for deterministic provider HTTP tests (§12 Phase J).
 */
export class ProviderFixtureRecorder {
  private fixtures: RecordedProviderFixture[] = [];
  private cursor = 0;

  constructor(initialFixtures?: RecordedProviderFixture[]) {
    if (initialFixtures) {
      this.fixtures = [...initialFixtures];
    }
  }

  record(fixture: RecordedProviderFixture): void {
    this.fixtures.push(structuredClone(fixture));
  }

  saveToFile(filePath: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.fixtures, null, 2), "utf8");
  }

  static loadFromFile(filePath: string): ProviderFixtureRecorder {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RecordedProviderFixture[];
    return new ProviderFixtureRecorder(raw);
  }

  createReplayTransport(): (
    payload: ProviderRequestWirePayload,
    profile: ModelProfile
  ) => Promise<RawProviderResponse> {
    return async (payload) => {
      const byModel = this.fixtures.find(
        (f, idx) => idx >= this.cursor && f.model === payload.model
      );
      if (byModel) {
        this.cursor = this.fixtures.indexOf(byModel) + 1;
        return structuredClone(byModel.response);
      }
      const fallback =
        this.fixtures[this.cursor] ??
        this.fixtures[this.fixtures.length - 1] ??
        BUILT_IN_PROVIDER_FIXTURES.openai!;
      this.cursor += 1;
      return structuredClone(fallback.response);
    };
  }
}
