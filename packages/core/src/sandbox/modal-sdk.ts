import { ModalClient } from "modal";
import type { ModalApi, ModalCreateParams, ModalSandboxRef } from "./modal-api.ts";

export class ModalSdkApi implements ModalApi {
  private client: ModalClient;
  private appName: string;
  private app?: Promise<any>;

  constructor(o: {
    appName: string;
    tokenId?: string;
    tokenSecret?: string;
    environment?: string;
  }) {
    this.client = new ModalClient({
      tokenId: o.tokenId,
      tokenSecret: o.tokenSecret,
      environment: o.environment,
    });
    this.appName = o.appName;
  }

  private getApp() {
    return (this.app ??= this.client.apps.fromName(this.appName, {
      createIfMissing: true,
    }));
  }

  async create(p: ModalCreateParams): Promise<ModalSandboxRef> {
    const [app, image] = await Promise.all([
      this.getApp(),
      this.client.images.fromId(p.imageId),
    ]);
    const { imageId: _ignored, ...params } = p;
    return wrap(await (this.client.sandboxes as any).create(app, image, params));
  }

  async fromId(id: string): Promise<ModalSandboxRef> {
    return wrap(await (this.client.sandboxes as any).fromId(id));
  }

  async *list(tags: Record<string, string>): AsyncIterable<ModalSandboxRef> {
    for await (const sb of (this.client.sandboxes as any).list({ tags })) {
      yield wrap(sb);
    }
  }
}

function wrap(sb: any): ModalSandboxRef {
  return {
    id: sb.sandboxId,
    poll: () => sb.poll(),
    async exec(argv, o = {}) {
      const p = await sb.exec(argv, {
        timeoutMs: o.timeoutMs,
        workdir: o.workdir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        p.stdout.readText(),
        p.stderr.readText(),
      ]);
      return { exitCode: await p.wait(), stdout, stderr };
    },
    writeBytes: (path, data) => sb.filesystem.writeBytes(path, data),
    readBytes: (path) => sb.filesystem.readBytes(path),
    connectToken: (port, meta) =>
      sb.createConnectToken(port, { userMetadata: JSON.stringify(meta) }),
    async tunnels() {
      const t = await sb.tunnels();
      return Object.fromEntries(
        Object.entries(t).map(([port, tun]: [string, any]) => [
          Number(port),
          tun.url,
        ])
      );
    },
    async snapshotFilesystem(ttlMs) {
      return (await sb.snapshotFilesystem({ ttlMs })).imageId;
    },
    terminate: () => sb.terminate(),
  };
}
