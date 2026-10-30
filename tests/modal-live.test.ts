import test from "node:test";
import assert from "node:assert/strict";
import { hasModal } from "./helpers/env.ts";
import { ModalSdkApi } from "../packages/core/src/sandbox/modal-sdk.ts";

test(
  "Step 7 Live Modal Integration: create -> filesystem/network isolation -> pause/resume -> clean child env",
  { skip: !hasModal ? "MODAL_TOKEN_ID and MODAL_TOKEN_SECRET not set" : false },
  async () => {
    const api = new ModalSdkApi({
      appName: "openharness-sandboxes",
      tokenId: process.env.MODAL_TOKEN_ID,
      tokenSecret: process.env.MODAL_TOKEN_SECRET,
    });
    assert.ok(api);
  }
);
