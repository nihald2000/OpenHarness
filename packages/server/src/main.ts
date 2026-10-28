import { createServer } from "./server.ts";
import { resolve } from "node:path";

const hostname = process.env.OPENHARNESS_HOST ?? "127.0.0.1";
const port = Number(process.env.OPENHARNESS_PORT ?? 4096);
if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("OPENHARNESS_PORT must be an integer from 0 to 65535");
const repositoryRoot = resolve(import.meta.dir, "../../..");
process.env.OPENHARNESS_WORKSPACE ??= repositoryRoot;
process.env.OPENHARNESS_DATA_DIR ??= resolve(repositoryRoot, ".openharness");

const server = createServer({ hostname, port });
console.log(`OpenHarness server listening on http://${hostname}:${server.port}`);
console.log(`Workspace: ${process.env.OPENHARNESS_WORKSPACE ?? process.cwd()}`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void server.shutdown().then(() => process.exit(0)).catch((error) => {
    console.error("OpenHarness shutdown failed.", error);
    process.exitCode = 1;
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
