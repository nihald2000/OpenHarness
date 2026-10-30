import { getActiveSandboxDaemon } from "./providers.ts";
export class SandboxRestClient {
  readonly handleId: string;
  readonly sessionKey: string;
  constructor(handleId: string, sessionKey: string) {
    this.handleId = handleId;
    this.sessionKey = sessionKey;
  }
  async request(method: string, path: string, body?: Record<string, unknown>) {
    const daemon = getActiveSandboxDaemon(this.handleId);
    if (!daemon) throw new Error(`Sandbox daemon not active: ${this.handleId}`);
    return daemon.handleRequest(method, path, { "x-session-key": this.sessionKey }, body);
  }
}
