# Modal TypeScript SDK Spike Results (`scripts/modal-spike.ts`)

1. **SDK Surface (`modal >= 0.11.1`)**:
   - `sb.sandboxId`, `image.imageId`, `client.sandboxes.list({ tags })`, `sb.createConnectToken(port, { userMetadata: string })`, `runtime: "vm"`, and `sb.snapshotFilesystem({ ttlMs })` verified.
2. **Connect Token & Port 8080**:
   - `createConnectToken(8080, ...)` authenticates at Modal's edge; raw public tunnel URLs for port `8080` are stripped from `ports` so only preview ports (`3000`, `5173`, `8000`) are exposed.
3. **Two-Layer Egress Enforcement**:
   - Modal enforces coarse TLS/SNI domain allowlists (`outboundDomainAllowlist` + `outboundCidrAllowlist: []`), blocking plain HTTP and non-allowlisted TLS domains.
   - Inside the VM, `oh-sandboxd` runs all child processes under `srt --settings /oh/srt-settings.json` with `setpriv --reuid 1000 --regid 1000 --no-new-priviles`.
4. **Two-Phase Network Architecture**:
   - Setup phase runs in a dedicated setup sandbox with `SETUP_DOMAINS` allowlisted, snapshots the resulting filesystem via `snapshotFilesystem`, and caches the image ID keyed by SHA-256 of the base image + packed workspace tarball + setup commands.
   - Agent phase boots from that cached snapshot with the strict agent network policy.
