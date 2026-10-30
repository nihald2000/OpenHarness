# OpenHarness

OpenHarness is an AI agent harness and developer workspace rewritten as a modern React SPA powered by Vite and Tailwind CSS.

## Features

- **Multi-Agent Chat**: Seamlessly switch between `assistant`, `plan`, and specialized agents with model selection, runtime targeting, and quick slash commands (`/plan`, `/verify`, `/help`, `/compact`, `/clear`).
- **Interactive Execution Plans**: Draft, inspect, and approve structured execution plans with live step progress cards and a dockable plan control bar.
- **Tool Calling & Diffs**: Real-time tool execution tracking with expandable code diffs, inputs, outputs, execution duration, and error diagnostics.
- **Permission Approval Prompts**: Explicit human-in-the-loop permission dialogs for tool invocations (Allow once, Always allow, Reject).
- **Subagent Task Delegation**: Nested subagent execution cards with isolated transcript viewers and status indicators.
- **Context Window Management**: Live token accounting (input, output, reasoning, cache read), cost estimation, and one-click session compaction.
- **MCP & Plugin Architecture**: Manage Model Context Protocol (MCP) servers, install curated presets (GitHub, Filesystem, Memory, Fetch, Postgres), and attach custom runtime plugins.
- **Comprehensive Settings Suite**:
  - **General**: Default agent, model, runtime, server info, and configuration sources.
  - **Providers**: Model provider configuration (OpenAI, Gemini, Anthropic, Ollama, custom endpoints).
  - **MCP Servers**: Live status, transport selection, reconnecting, and custom server definitions.
  - **Tools & Code Mode**: Code Mode sandbox limits and registered tool inspection.
  - **Permissions**: Priority rule matrix for auto-approving or prompting tool actions.
  - **Limits**: Concurrency, token limits, auto-compaction thresholds, and verify loops.
  - **Guardrails**: PII redaction and regex pattern blocklists.
  - **Secrets**: Encrypted environment secret management with masked values.
  - **Advanced**: Masked JSON preview, configuration reload, and session controls.
- **Dark & Light Mode**: Built-in theme toggle with zero-flicker localStorage persistence.

## Development

```bash
# Install dependencies
npm install

# Start Vite dev server on port 3000
npm run dev

# Check types and build production bundle
npm run build
```
