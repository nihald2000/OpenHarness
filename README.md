# OpenHarness

OpenHarness is a local-first agent harness with a Next.js chat/settings UI, a Bun API server, and a TypeScript SDK.

## Start locally

Install dependencies with `bun install`, then run the server and web app in separate terminals:

```bash
bun run server
bun run dev
```

The server listens on `http://127.0.0.1:4096`; the UI runs on `http://localhost:3000`. The default mock provider works offline. See [server setup and security](packages/server/README.md) for provider credentials, admin tokens, and tool approvals.

## CLI and evals

```bash
bun run oh help
bun run oh info
bun run oh run "Summarize the repository"
bun run eval examples/demo.eval.jsonl
```

Run the example eval suite with the server running. `oh eval` accepts JSONL prompt cases or a simple YAML list of flat case mappings, plus substring, regex, exact tool-call/success, pending-approval, and latency assertions. Eval YAML supports scalar fields and scalar lists; anchors, aliases, and nested mappings are rejected. Agent and skill Markdown frontmatter accepts nested mappings and lists, common scalar types, and inline lists; unsupported YAML features and malformed metadata cause the file to be skipped.

For Google/GitHub web sign-in, verified-email account signup, callback configuration, and deployment security notes, see [Authentication](docs/AUTHENTICATION.md).

## Build and deploy

```bash
bun run build:server
bun run build
docker compose up --build
```

See [deployment notes](docs/DEPLOYMENT.md), [API routes](docs/API.md), [configuration and environment](docs/CONFIGURATION.md), [environment template](.env.example), and [the sample config](openharness.example.json).

The distributed scaling design and migration status are tracked in [Scaling architecture](docs/SCALING.md). OIDC session ownership checks and rate/quota adapters are available when configured; Postgres state and durable worker execution are still being integrated, so the API continues to use its local session/job runtime.
