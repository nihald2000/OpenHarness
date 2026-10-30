# Phase 0 sandbox spike results

Validated on 2026-10-30 with Modal SDK `1.6.2` and the throwaway app
`deploy/modal/sandbox_spike.py`.

Run: <https://modal.com/apps/nihald2000/main/ap-BECZ5nF8tEYdpKWhQCcnps>

Base image: `ubuntu:24.04` + Python 3.12, Node 22.23.4, `bubblewrap` 0.9.0,
`@anthropic-ai/sandbox-runtime` 0.0.81, Playwright Chromium. Sandbox runtime
`vm`, 2 CPU / 4 GB.

## Results

| Check | Result |
| --- | --- |
| `bwrap` inside a `runtime="vm"` Sandbox | **Pass** (`bwrap-ok`) |
| `srt` offline profile blocks egress | **Pass** (`CONNECT tunnel failed, response 403`) |
| `srt` connected profile allows `example.com` | **Pass** (`200`) |
| `srt` connected profile blocks `google.com` | **Pass** (`403`) |
| Playwright Chromium launch + page render | **Pass** (`Example Domain` + body text) |
| Dynamic network policy narrows egress | **Pass** (`200` allowed, connection reset for other host) |
| `copy_from_local` / `copy_to_local` | **Pass** |
| `snapshot_filesystem()` + `Image.from_id()` restore | **Pass** (file survived) |
| Warm exec overhead | ~1.0–1.3 s per command |
| Snapshot restore startup | ~2 s |

The spike terminates both Sandboxes; no spike containers were left running.

## Decisions and gotchas for the production build

1. **Invoke `srt` with `--` before the wrapped command.**
   `srt --settings file.json -- curl -sS ...` is required. Without `--`,
   `srt`'s commander parser reads `curl -sS` as `-s S`, overrides `--settings`
   with the path `S`, and exits with `S does not exist.`

2. **Set `PLAYWRIGHT_BROWSERS_PATH` before `playwright install`.**
   The env must be present in the image layer that runs the install, otherwise
   browsers land in `/root/.cache/ms-playwright` and the runtime path is empty.

3. **Dynamic network switching uses the experimental API.**
   `reload_network_policy` does not exist. Use
   `sb._experimental_set_outbound_network_policy(...)` and create the Sandbox
   with the allowlists pre-armed (`["*"]` / `["0.0.0.0/0"]`). It is alpha and
   cannot be combined with `block_network=True`.

4. **`srt` private CIDRs belong in `network.deniedResolvedAddresses`.**
   `network.deniedDomains` only matches domain names.

5. **`srt` on Linux takes literal write paths.**
   `allowWrite` does not expand globs; list `/mnt/data`, `/tmp`, and
   `/mnt/mcp_servers/skills` explicitly.

6. **Do not put the GitHub PAT in the Sandbox environment.**
   The spike did not need it. Phase 1 should proxy GitHub calls or mint a
   short-lived scoped token, because agent-written code can read the env.

## Not yet measured

- Full toolchain image size and cold start (Rust, Go, JDK, LibreOffice,
  Playwright, Python/Node tooling).
- Playwright under `srt` (the spike launched Chromium directly).
- `create_connect_token()` / tunnel traffic.
- Memory snapshots (`_experimental_enable_snapshot=True`); Phase 0 used
  filesystem snapshots, which are the right fit for persisted skills.

## Next

Phase 1: layered production image, measured size/cold start, and a first
`/mnt/mcp_servers` code-mode bridge.
