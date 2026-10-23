import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
const { openStore } = await import("../src/platform/store.js");
const { reserveModelCall } = await import("../src/platform/modelBudget.js");

test("model reservations enforce per-admin and per-run limits atomically", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-budget-"));
  const store = await openStore({ dataDir: directory });
  t.after(async () => {
    await store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await store.query(
    "INSERT INTO accounts(id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
    ["owner", "owner@example.test", "Owner", "hash", "now"],
  );
  await store.query(
    "INSERT INTO decisions(id, owner_id, title, created_at) VALUES (?, ?, ?, ?)",
    ["decision", "owner", "Decision", "now"],
  );
  for (const id of ["a", "b"])
    await store.query(
      "INSERT INTO runs(id, decision_id, invite_token, created_at) VALUES (?, ?, ?, ?)",
      [id, "decision", id, "now"],
    );
  process.env.MAX_LLM_CALLS_PER_RUN = "2";
  process.env.MAX_LLM_CALLS_PER_ADMIN_DAY = "3";
  assert.equal(await reserveModelCall(store, "a"), 1);
  assert.equal(await reserveModelCall(store, "a"), 2);
  await assert.rejects(reserveModelCall(store, "a"), { status: 429 });
  assert.equal(await reserveModelCall(store, "b"), 1);
  await assert.rejects(reserveModelCall(store, "b"), { status: 429 });
  const [run] = await store.query(
    "SELECT model_calls_used FROM runs WHERE id = ?",
    ["b"],
  );
  assert.equal(run.model_calls_used, 1);
  const [usage] = await store.query("SELECT calls FROM account_model_usage");
  assert.equal(usage.calls, 3);
});
