import { demoClient, DemoOpenHarnessClient } from "./demo-client";
import { HttpOpenHarnessClient, type HttpClientOptions } from "./http-client";

export const isDemoMode = Boolean(
  typeof import.meta !== "undefined" &&
    (import.meta as any).env?.VITE_OPENHARNESS_DEMO === "1"
);

export const client = isDemoMode ? demoClient : new HttpOpenHarnessClient();

export { HttpOpenHarnessClient, DemoOpenHarnessClient, type HttpClientOptions };
