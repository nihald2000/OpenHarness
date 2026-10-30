import crypto from "node:crypto";

export type DaemonResponse = { status: number; body: any };

export interface SandboxTransport {
  request(
    method: string,
    path: string,
    body?: unknown,
    o?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<DaemonResponse>;
}

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

  constructor(
    sessionKey: string,
    mint: () => Promise<{ url: string; token: string }>
  ) {
    this.sessionKey = sessionKey;
    this.mint = mint;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    o: { timeoutMs?: number; signal?: AbortSignal } = {}
  ): Promise<DaemonResponse> {
    const requestId = crypto.randomUUID();
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
          method,
          signal,
          body: body === undefined ? undefined : JSON.stringify(body),
          headers: {
            authorization: `Bearer ${this.token.token}`,
            "x-session-key": this.sessionKey,
            "x-oh-request-id": requestId,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
        });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < 3 && !o.signal?.aborted) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      clearTimeout(timer);
      const fromDaemon = res.headers.get("x-oh-daemon") === "1";
      if (!fromDaemon && (res.status === 401 || res.status === 403) && attempt < 2) {
        this.token = undefined;
        continue;
      }
      if (!fromDaemon && res.status === 502 && attempt < 4) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const text = await res.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { error: text.slice(0, 500) };
      }
      return { status: res.status, body: parsed };
    }
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
      method,
      path,
      { "x-session-key": this.sessionKey, "x-oh-request-id": crypto.randomUUID() },
      body as Record<string, unknown> | undefined
    );
    return { status: res.status, body: res.body };
  }
}
