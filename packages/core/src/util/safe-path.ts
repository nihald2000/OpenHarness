import fs from "node:fs";
import path from "node:path";

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/** Resolve `input` inside `root`, canonicalising symlinks of the nearest existing ancestor. Throws on escape. */
export function resolveInside(root: string, input: string): string {
  if (typeof input !== "string" || input.includes("\0")) {
    throw new PathEscapeError("invalid path");
  }
  const realRoot = fs.realpathSync.native(root);
  const candidate = path.resolve(realRoot, input);
  let existing = candidate;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    tail.unshift(path.basename(existing));
    existing = parent;
  }
  const resolved = path.join(fs.realpathSync.native(existing), ...tail);
  const rel = path.relative(realRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new PathEscapeError(`path escapes the workspace: ${input}`);
  }
  return resolved;
}
