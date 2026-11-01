import crypto from "node:crypto";

export type DaemonResponse = { status: number; body: any; daemon?: boolean };

export interface SandboxTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    o?: { timeoutMs?: number; signal?: AbortSignal; maxRetries?: number }
  ): Promise<DaemonResponse>;
}

export type DaemonTransport = SandboxTransport;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal {
  const active = signals.filter((s): s is AbortSignal => Boolean(s));
  if (typeof (AbortSignal as any).any === "function") {
    return (AbortSignal as any).any(active);
  }
  const ctrl = new AbortController();
  for (const s of active) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      return ctrl.signal;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

export class HttpDaemonTransport implements SandboxTransport {
  private token?: { url: string; token: string };
  private sessionKey: string;
  private mint: () => Promise<{ url: string; token: string }>;
  private onActivity?: () => void;

  constructor(
    sessionKey: string,
    mint: () => Promise<{ url: string; token: string }>,
    onActivity?: () => void
  ) {
    this.sessionKey = sessionKey;
    this.mint = mint;
    this.onActivity = onActivity;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    o: { timeoutMs?: number; signal?: AbortSignal; maxRetries?: number } = {}
  ): Promise<DaemonResponse> {
    this.onActivity?.();
    const requestId = crypto.randomUUID();
    const maxRetries = o.maxRetries ?? 2;
    for (let attempt = 0; ; attempt++) {
      this.token ??= await this.mint();
      const timeoutCtrl = new AbortController();
      const timer = setTimeout(
        () => timeoutCtrl.abort(new Error("daemon request timeout")),
        o.timeoutMs ?? 120_000
      );
      const signal = combineSignals([timeoutCtrl.signal, o.signal]);
      let res: Response;
      try {
        res = await fetch(`${this.token.url.replace(/\/$/, "")}${path}`, {
          method: method.toUpperCase(),
          signal,
          body: body === undefined || method.toUpperCase() === "GET" ? undefined : JSON.stringify(body),
          headers: {
            ...(this.token.token ? { authorization: `Bearer ${this.token.token}` } : {}),
            "x-session-key": this.sessionKey,
            "x-oh-request-id": requestId,
            ...(body === undefined || method.toUpperCase() === "GET"
              ? {}
              : { "content-type": "application/json" }),
          },
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries && !o.signal?.aborted) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        this.token = undefined;
        throw err;
      }
      clearTimeout(timer);
      const fromDaemon = res.headers.get("x-oh-daemon") === "1";
      if (!fromDaemon && [401, 403, 404, 502, 503, 504].includes(res.status)) {
        this.token = undefined;
        if (attempt < maxRetries) {
          if (res.status >= 502) await sleep(250 * 2 ** attempt);
          continue;
        }
      }
      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
      return { status: res.status, body: parsed, daemon: fromDaemon };
    }
  }
}

export class ModalExecDaemonTransport implements SandboxTransport {
  private ref: { exec(argv: string[], options?: { timeoutMs?: number; workdir?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> };
  private sessionKey: string;
  private port: number;
  private onActivity?: () => void;

  constructor(
    ref: { exec(argv: string[], options?: { timeoutMs?: number; workdir?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }> },
    sessionKey: string,
    port = 8080,
    onActivity?: () => void
  ) {
    this.ref = ref;
    this.sessionKey = sessionKey;
    this.port = port;
    this.onActivity = onActivity;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    o: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<DaemonResponse> {
    if (o.signal?.aborted) throw o.signal.reason ?? new Error("request aborted");
    this.onActivity?.();
    const requestId = crypto.randomUUID();
    const payloadB64 = body === undefined || method.toUpperCase() === "GET"
      ? ""
      : Buffer.from(JSON.stringify(body), "utf8").toString("base64");
    const script = `
      const [method, path, port, key, reqId, b64] = process.argv.slice(1);
      const headers = { "x-session-key": key, "x-oh-request-id": reqId };
      let reqBody;
      if (b64) {
        reqBody = Buffer.from(b64, "base64");
        headers["content-type"] = "application/json";
      }
      const res = await fetch(\`http://127.0.0.1:\${port}\${path}\`, { method, headers, body: reqBody });
      const text = await res.text();
      process.stdout.write(JSON.stringify({ status: res.status, daemon: res.headers.get("x-oh-daemon"), text }));
    `;
    const execRes = await this.ref.exec(
      ["node", "--input-type=module", "-e", script, method.toUpperCase(), path, String(this.port), this.sessionKey, requestId, payloadB64],
      { timeoutMs: o.timeoutMs ?? 120_000, workdir: "/tmp" }
    );
    if (execRes.exitCode !== 0) {
      throw new Error((execRes.stderr || execRes.stdout || `Modal exec request exited ${execRes.exitCode}`).slice(-4_000));
    }
    let envelope: { status: number; daemon: string | null; text: string };
    try {
      envelope = JSON.parse(execRes.stdout);
    } catch {
      throw new Error(`Invalid Modal exec daemon response: ${execRes.stdout.slice(-1_000)}`);
    }
    let parsed: any;
    try { parsed = JSON.parse(envelope.text); }
    catch { parsed = { error: envelope.text.slice(0, 500) }; }
    return { status: envelope.status, body: parsed, daemon: envelope.daemon === "1" };
  }
}

export class FallbackSandboxTransport implements SandboxTransport {
  private channels: Array<{ name: string; transport: SandboxTransport }>;
  private activeIndex = 0;

  constructor(channels: Array<{ name: string; transport: SandboxTransport }>) {
    if (!channels.length) throw new Error("FallbackSandboxTransport requires at least one channel");
    this.channels = channels;
  }

  get activeChannel(): string { return this.channels[this.activeIndex]!.name; }

  async request(
    method: string,
    path: string,
    body?: unknown,
    o: { timeoutMs?: number; signal?: AbortSignal; maxRetries?: number } = {}
  ): Promise<DaemonResponse> {
    let lastResponse: DaemonResponse | undefined;
    let lastError: unknown;
    const start = Math.min(this.activeIndex, this.channels.length - 1);
    for (let offset = 0; offset < this.channels.length; offset++) {
      const index = (start + offset) % this.channels.length;
      const channel = this.channels[index]!;
      try {
        const response = await channel.transport.request(method, path, body, {
          ...o,
          maxRetries: o.maxRetries ?? 0,
        });
        const proxyFailure = response.status >= 502 ||
          (response.status === 404 && response.daemon !== true);
        if (proxyFailure) {
          lastResponse = response;
          this.activeIndex = (index + 1) % this.channels.length;
          continue;
        }
        if ([401, 403].includes(response.status) && response.daemon !== true) {
          lastResponse = response;
          this.activeIndex = (index + 1) % this.channels.length;
          continue;
        }
        this.activeIndex = index;
        return response;
      } catch (err) {
        lastError = err;
        this.activeIndex = (index + 1) % this.channels.length;
      }
    }
    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "All sandbox transports failed"));
  }
}

export class InProcessTestTransport implements SandboxTransport {
  private daemon: {
    handleRequest(
      method: string,
      path: string,
      headers: Record<string, string | undefined>,
      body?: Record<string, unknown>
    ): Promise<{ status: number; body: Record<string, unknown> }>;
  };
  private sessionKey: string;

  constructor(
    daemon: {
      handleRequest(
        method: string,
        path: string,
        headers: Record<string, string | undefined>,
        body?: Record<string, unknown>
      ): Promise<{ status: number; body: Record<string, unknown> }>;
    },
    sessionKey: string
  ) {
    this.daemon = daemon;
    this.sessionKey = sessionKey;
  }

  async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<DaemonResponse> {
    const res = await this.daemon.handleRequest(
      method.toUpperCase(),
      path,
      { "x-session-key": this.sessionKey, "x-oh-request-id": crypto.randomUUID() },
      body as Record<string, unknown> | undefined
    );
    return { status: res.status, body: res.body };
  }
}
