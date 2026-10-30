import { ManagedDaemonSandboxProvider } from "./providers.ts";
export class ModalSandboxProvider extends ManagedDaemonSandboxProvider {
  constructor(opts?: any) { super("modal", opts); }
}
