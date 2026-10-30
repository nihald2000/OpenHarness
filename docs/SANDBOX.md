# OpenHarness Sandbox Architecture (`docs/SANDBOX.md`)

OpenHarness enforces a defense-in-depth security boundary where every autonomous command, file edit, or network connection executes inside an isolated sandbox (`oh-sandboxd` + OS-enforced confinement), never relying solely on prompt instructions.

## 1. Sandbox Runtimes (`packages/core/src/sandbox/`)

| Runtime ID | Isolation Mechanism | Capabilities | Default Usage |
| :--- | :--- | :--- | :--- |
| `local` | Host process (unsandboxed) | Read-only & allowlisted local tools only; no `bash`, `processes`, or `browser`. | Offline demo (`chat`). Refuses `long_task` autonomy unless `allowUnsandboxedAutonomy: true`. |
| `srt-local` | Host child process wrapped by Anthropic Sandbox Runtime (`srt`) | macOS Seatbelt / Linux `bubblewrap` + `seccomp`; persistent shell, processes, ports, Playwright browser, shadow-git checkpoints. | Local developer workstation autonomy. |
| `docker` | One hardened container per session (`openharness/sandbox:<toolchain>`) | `--cap-drop ALL`, `--security-opt no-new-privileges`, non-root user (`1000:1000`), read-only rootfs, writable `/workspace`, `/tmp`, `/memories`, `srt` wrapping inside container, `docker pause`/`unpause`. | Standard local & CI autonomous `task` and `long_task` execution. |
| `modal` | Hardware-isolated cloud microVM (`runtime="vm"`) | Dynamic outbound network switching, port tunnels, zero-cost filesystem hibernation (`snapshot_filesystem()` / `Image.from_id()`). | Cloud-scale parallel runs and long-horizon tasks. |

## 2. In-Sandbox Agent Server (`oh-sandboxd`)

`oh-sandboxd` (`packages/sandboxd/src/server.ts`) runs inside the sandbox and binds only to loopback or the sandbox private interface.
- **Authentication**: Every route except `GET /health` requires `X-Session-Key` verified with constant-time comparison (`crypto.timingSafeEqual`).
- **Process Wrapping**: Every spawned process runs through `srt --settings /oh/policy.json -- <argv>` (with `--` separating `srt` flags from the command).
- **Persistent Shell Sessions (`/shell/:sid/exec|input|interrupt`)**: Preserves `cwd` and environment variables across calls; supports idle timeouts returning `status: "still_running"` so the agent can inspect partial output, send stdin, or interrupt (`Ctrl-C`).
- **Linter-Gated File Operations (`/files/view|create|str_replace|insert|undo_edit|apply_patch`)**: Enforces unique match with whitespace-normalized fuzzy fallback and runs language-aware syntax checks after every edit.
- **Shadow-Git Checkpoints (`/checkpoints/create|diff|restore`)**: Commits workspace snapshots to `GIT_DIR=/oh/.shadow-git` with `GIT_WORK_TREE=/workspace` so the user's `.git` history is never polluted.
- **Telemetry**: Emits `sandbox.violation`, `process.output`, and `port.opened` events to the control plane.

## 3. Immutable Policy & Two-Phase Network Egress (`packages/core/src/sandbox/policy.ts`)

Each run compiles an immutable `CompiledSandboxPolicy`:
- **Filesystem Reads (Deny-then-Allow)**: Denies `~/.ssh`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, the OpenHarness data directory, and `/oh/policy.json`.
- **Filesystem Writes (Allow-Only)**: Permits writes strictly inside `/workspace`, `/tmp`, and `/memories`.
- **Mandatory Denies (Applied Last, Never Overridable)**: Blocks `.git/hooks/**`, `.git/config` (unless explicitly enabled), `.bashrc`/`.zshrc`/`.profile`, `.env*` outside test fixtures, `.mcp.json`, `.vscode/**`, `.idea/**`, `.openharness/agents|commands|skills`, and `/oh/policy.json`.
- **Two-Phase Network Policy**:
  1. **Setup Phase (`setup`)**: Allows `package-registries` (npm, PyPI, crates, Go proxy, Maven Central) and `github-read` to clone repositories, install dependencies, and run `init.sh`.
  2. **Agent Phase (`agent`)**: Switches to offline (`none`) or strict domain allowlist with HTTP method restrictions (`GET`, `HEAD`), recording a `sandbox.policy_switched` event.
  3. **Mandatory CIDR Denies**: Always blocks cloud metadata (`169.254.169.254`, `metadata.google.internal`), loopback, link-local, and RFC1918 private networks.

## 4. Brokered Secrets (`HostSecretBroker`)

Secrets never enter the sandbox environment or filesystem. Authenticated operations (`git_push`, `github_pr`) execute on the host via `HostSecretBroker` or inject headers at the egress proxy boundary for explicitly allowlisted domains, while `redactSecretsFromOutput` scrubs secret values from all tool outputs and logs.
