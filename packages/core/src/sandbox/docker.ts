import { ManagedDaemonSandboxProvider, computeDockerRuntimeImageTag, buildDockerRunArgs } from "./providers.ts";
export { computeDockerRuntimeImageTag, buildDockerRunArgs };
export class DockerSandboxProvider extends ManagedDaemonSandboxProvider {
  constructor(opts?: any) { super("docker", opts); }
}
