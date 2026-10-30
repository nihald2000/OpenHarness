import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const node = process.execPath;
const run = (label, args) => {
  const result = spawnSync(node, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    throw new Error(`${label} failed`);
  }
};

try {
  run("TypeScript check", ["node_modules/typescript/bin/tsc", "--noEmit"]);
  if (process.argv.includes("--build")) {
    run("Vite production build", ["node_modules/vite/bin/vite.js", "build"]);
  }
} catch (error) {
  console.error(error.message);
  process.exit(process.exitCode || 1);
}
