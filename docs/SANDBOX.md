# OpenHarness Sandbox Architecture (`oh-sandboxd`, `srt-local`, `docker`, `modal`)

OpenHarness enforces a strict fail-closed sandbox model across four runtime providers:

| Provider | Isolation Mechanism | OS Enforced | Network Policy | Snapshots / Pause |
|---|---|---|---|---|
| `local` | Host workspace containment (`resolveInside` realpath checks). Refuses `task` and `long_task` modes unless `allowUnsandboxedAutonomy: true`. | `false` | `open` | No |
| `srt-local` | Host child processes wrapped by Anthropic Sandbox Runtime (`srt --settings <srt.json> -- <argv>`) with scrubbed `BASE_ENV`. Fails closed (`503`) if `srt` is missing when `requireSrt: true`. | `true` (when `srt` installed) | `allowlist` / `none` | Local directory snapshot + shadow-git |
| `docker` | Hardened rootless container (`--cap-drop ALL --security-opt no-new-privileges --read-only`) running `oh-sandboxd`. | `true` (when Docker daemon running) | `allowlist` / `none` | Container commit / directory snapshot + shadow-git |
| `modal` | Modal cloud microVM (`ModalSandboxProvider`) running `/usr/local/bin/oh-sandboxd` with `srt` defense-in-depth, Modal `cidr_allowlist` / `block_network` egress rules, and short-lived `connectToken` HTTPS transport. | `true` | `allowlist` / `none` | `snapshotFilesystem` image snapshots + 23h rollover |

## 1. Two-Phase Sandbox Provisioning (`setup` -> `agent`)

1. **Setup Phase (`phase: "setup"`)**:
   - Allowed domains include package registries (`registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `crates.io`, `proxy.golang.org`, `github.com`).
   - Workspace files are materialized (`local` tar.gz stream, `git clone`, or restored `snapshot` image) and `setupCommands` execute.
   - On Modal, the resulting filesystem is snapshotted (`snapshotFilesystem`) and cached in `SandboxRecordStore` by a SHA-256 key over `(baseImageId, workspaceHash, setupCommands)`.
2. **Agent Phase (`phase: "agent"`)**:
   - Boots from the cached setup image with network locked down (`blockNetwork: true` when `mode === "none"`, or `cidrAllowlist` resolved at launch when `mode === "allowlist"`).
   - Starts `/usr/local/bin/oh-sandboxd` on port `8080` with a 64-hex random `OH_SESSION_KEY` (stored encrypted via AES-256-GCM in `SandboxRecordStore`, never exposed on `SandboxHandle`).

## 2. `oh-sandboxd` Confinement & Idempotency (`packages/sandboxd`)

- **Process Confinement (`packages/sandboxd/src/config.ts`)**:
  - Every child process (`execShell`, `startBackgroundProcess`, `runShadowGit`, `execIpython`, `runPostEditSyntaxCheck`) is spawned through `spawnConfined` in a detached process group (`detached: true`) so timeouts and `/processes/stop-all` kill the entire process tree (`process.kill(-pid, signal)`).
  - Child environments are built from a minimal `BASE_ENV` (`PATH`, `HOME`, `LANG`, `TERM`) and scrubbed against `SECRETISH` (`/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE|BEARER|MODAL_|OPENAI_|ANTHROPIC_|AWS_|GITHUB_)/i`).
- **`srt` Schema Translation (`toSrtSettings`)**:
  - Translates OpenHarness `CompiledSandboxPolicy` into the exact schema expected by `@anthropic-ai/sandbox-runtime`:
    - `filesystem.denyRead` (`~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`)
    - `filesystem.allowWrite` (`/workspace`, `/tmp`, `/memories`)
    - `filesystem.denyWrite` (`.git/hooks`, `.git/config`, `.bashrc`, `.profile`, `.env`, `.mcp.json`, `.vscode`, `.idea`, `.openharness/agents`, `.openharness/commands`, `.openharness/skills`, `/oh/policy.json`)
    - `network.allowedDomains` / `network.deniedDomains`
- **Request Idempotency (`HttpDaemonTransport`)**:
  - `HttpDaemonTransport` attaches a UUID `x-oh-request-id` to every request, verifies the `x-oh-daemon: 1` response header, re-mints Modal connect tokens on edge `401` responses, and `oh-sandboxd` deduplicates identical `POST` request IDs for 10 minutes.

## 3. Lifecycle Management (`packages/core/src/sandbox/modal-lifecycle.ts`)

- **Pause / Hibernation**: Stops background processes (`/processes/stop-all`), creates a shadow-git checkpoint (`/checkpoints/create`), snapshots the microVM filesystem (`snapshotFilesystem`), and terminates the microVM while preserving the same `SandboxHandle.id`.
- **Resume**: Boots a fresh microVM from `lastSnapshotImageId` under the same `handleId` so `RunState.sandboxHandleId` and all checkpoints remain valid.
- **23-Hour Rollover (`rollover`)**: Snapshots and replaces sandboxes approaching Modal's 24-hour hard lifetime limit (`createdAt + 23h`).
- **Orphan Reaper (`reapOrphanModalSandboxes`)**: Lists live Modal sandboxes tagged `oh=1` and terminates any sandbox without a matching `running`/`starting`/`setup` record.
