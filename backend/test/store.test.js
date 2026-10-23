import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { openStore } from "../src/platform/store.js";

test("a second supervisor cannot share live SQLite data, and orderly restart works", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "cime-store-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await openStore({ url: "", dataDir: directory });
  await assert.rejects(
    openStore({ url: "", dataDir: directory }),
    /Another CIME supervisor/,
  );
  await first.close();
  const restarted = await openStore({ url: "", dataDir: directory });
  await restarted.close();
});
