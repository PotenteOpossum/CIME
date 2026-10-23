import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
const { openStore } = await import("../src/platform/store.js");

test("legacy import preserves source bytes and participant/message records", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  process.env.CIME_DB_PATH = path.join(directory, "source.db");
  const { db, initDb, ensurePersonalRoomsForAllUsers } =
    await import("../src/config/db.js");
  initDb();
  db.prepare(
    "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, 0)",
  ).run("Legacy participant", "stored-password-hash");
  ensurePersonalRoomsForAllUsers();
  const room = db.prepare("SELECT id FROM rooms").get();
  db.prepare(
    "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, 1, ?, ?)",
  ).run(room.id, "Historical message", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "UPDATE system_state SET global_question = 'Legacy question', current_phase = 'completed'",
  ).run();
  db.close();
  const sourceBytes = await fs.readFile(process.env.CIME_DB_PATH);
  const dataDir = path.join(directory, "platform");
  const store = await openStore({ dataDir });
  await store.query(
    "INSERT INTO accounts(id, email, name, password_hash, verified, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    ["owner", "owner@example.test", "Owner", "hash", "now"],
  );
  await store.close();
  const result = await promisify(execFile)(
    process.execPath,
    [
      "src/platform/importLegacy.js",
      "--source",
      process.env.CIME_DB_PATH,
      "--owner",
      "owner@example.test",
    ],
    {
      cwd: path.resolve("."),
      env: { ...process.env, CIME_DATA_DIR: dataDir },
      timeout: 15000,
    },
  );
  assert.match(result.stdout, /Imported 1 participants/);
  assert.deepEqual(await fs.readFile(process.env.CIME_DB_PATH), sourceBytes);
  const reopened = await openStore({ dataDir });
  const [run] = await reopened.query("SELECT * FROM runs");
  assert.equal(run.archived, 1);
  assert.equal(run.status, "completed");
  await reopened.close();
  const imported = new Database(path.join(dataDir, "runs", run.id, "chat.db"), {
    readonly: true,
  });
  assert.equal(
    imported.prepare("SELECT text FROM messages").get().text,
    "Historical message",
  );
  assert.equal(
    imported.prepare("SELECT username FROM run_credentials").get().username,
    "Legacy participant",
  );
  imported.close();
});
