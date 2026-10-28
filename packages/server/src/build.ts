import { mkdir } from "node:fs/promises";

try {
  await mkdir("../../dist", { recursive: true });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const child = Bun.spawn(
  ["bun", "build", "--compile", "src/main.ts", "--outfile", "../../dist/openharness"],
  { stdout: "inherit", stderr: "inherit" },
);
const exitCode = await child.exited;
if (exitCode !== 0) globalThis.process.exitCode = exitCode;
