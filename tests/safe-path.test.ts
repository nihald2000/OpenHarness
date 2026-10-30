import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInside, PathEscapeError } from "../packages/core/src/util/safe-path.ts";
import { SandboxToolRouter } from "../packages/core/src/tools/catalog.ts";

test("Step 2 (S1): resolveInside and fallback tools block .., ../../outside.txt, absolute paths, external symlinks, and sibling-prefix directories", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "oh-safepath-"));
  const root = path.join(base, "workspace");
  const evilSibling = path.join(base, "workspace-evil");
  const outsideFile = path.join(base, "outside.txt");
  const evilFile = path.join(evilSibling, "secret.txt");

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(evilSibling, { recursive: true });
  fs.writeFileSync(outsideFile, "DO_NOT_TOUCH", "utf8");
  fs.writeFileSync(evilFile, "SIBLING_SECRET", "utf8");
  fs.writeFileSync(path.join(root, "inside.txt"), "hello world", "utf8");
  fs.symlinkSync(outsideFile, path.join(root, "link-outside.txt"));

  try {
    // 1. Direct resolveInside checks
    assert.equal(
      resolveInside(root, "inside.txt"),
      path.join(fs.realpathSync.native(root), "inside.txt")
    );
    assert.throws(() => resolveInside(root, ".."), PathEscapeError);
    assert.throws(() => resolveInside(root, "../../outside.txt"), PathEscapeError);
    assert.throws(() => resolveInside(root, outsideFile), PathEscapeError);
    assert.throws(() => resolveInside(root, "link-outside.txt"), PathEscapeError);
    assert.throws(() => resolveInside(root, "../workspace-evil/secret.txt"), PathEscapeError);
    assert.throws(() => resolveInside(root, "bad\0file.txt"), PathEscapeError);

    // 2. Fallback tool router checks (no daemon)
    const router = new SandboxToolRouter({
      workspaceRoot: root,
      sandboxEnabled: false,
    });
    const dummyCtx: any = {
      runId: "run_safepath",
      sessionId: "sess_safepath",
      step: 1,
      workspaceRoot: root,
      state: { features: [] },
    };

    const editEscape = await router.execute(
      "edit",
      { path: "../outside.txt", old_str: "DO_NOT_TOUCH", new_str: "PWNED" },
      "call_1",
      dummyCtx
    );
    assert.ok(editEscape.error, "edit outside workspace must fail");
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "DO_NOT_TOUCH");

    const editSymlink = await router.execute(
      "edit",
      { path: "link-outside.txt", old_str: "DO_NOT_TOUCH", new_str: "PWNED" },
      "call_2",
      dummyCtx
    );
    assert.ok(editSymlink.error, "edit via external symlink must fail");
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "DO_NOT_TOUCH");

    const editSibling = await router.execute(
      "edit",
      { path: "../workspace-evil/secret.txt", old_str: "SIBLING_SECRET", new_str: "PWNED" },
      "call_3",
      dummyCtx
    );
    assert.ok(editSibling.error, "edit on sibling-prefix directory must fail");
    assert.equal(fs.readFileSync(evilFile, "utf8"), "SIBLING_SECRET");

    const listParent = await router.execute("list", { path: ".." }, "call_4", dummyCtx);
    assert.ok(listParent.error, "list .. must fail");

    const readAbs = await router.execute("read_file", { path: outsideFile }, "call_5", dummyCtx);
    assert.ok(readAbs.error, "read_file with outside absolute path must fail");

    const wcEscape = await router.execute("word_count", { path: "../outside.txt" }, "call_6", dummyCtx);
    assert.ok(wcEscape.error, "word_count outside workspace must fail");

    const memEscape = await router.execute(
      "memory",
      { command: "create", path: "../../outside.txt", file_text: "PWNED" },
      "call_7",
      dummyCtx
    );
    assert.ok(memEscape.error, "memory escape must fail");
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "DO_NOT_TOUCH");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
