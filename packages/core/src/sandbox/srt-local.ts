import { ManagedDaemonSandboxProvider } from "./providers.ts";
export class SrtLocalSandboxProvider extends ManagedDaemonSandboxProvider {
  constructor(opts?: any) { super("srt-local", opts); }
}
