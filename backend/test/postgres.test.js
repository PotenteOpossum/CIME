import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgres://pglite-test-only";
process.env.CIME_RUN_SCHEMA = "cime_run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-pg-test-"));
if (!process.env.TEST_DATABASE_URL)
  process.env.CIME_PGLITE_TEST_DIR = directory;

test(
  "complete engine schema and voting SQL run on PostgreSQL semantics",
  { timeout: 120000 },
  async (t) => {
    const { db, initDb, ensurePersonalRoomsForAllUsers } =
      await import("../src/config/db.js");
    t.after(async () => {
      db.close();
      await fs.rm(directory, { recursive: true, force: true });
    });
    assert.equal(db.constructor.name, "PostgresDatabase");
    initDb();
    initDb(); // Idempotent schema migrations and model defaults.
    const { initEnginePlatform } =
      await import("../src/platform/engineRoutes.js");
    initEnginePlatform();
    // Compile all static engine read queries, including later voting phases,
    // against PostgreSQL to catch incompatibilities outside the startup path.
    let compiledQueries = 0;
    for (const folder of ["routes", "services"]) {
      for (const file of await fs.readdir(
        new URL(`../src/${folder}/`, import.meta.url),
      )) {
        if (!file.endsWith(".js")) continue;
        const source = await fs.readFile(
          new URL(`../src/${folder}/${file}`, import.meta.url),
          "utf8",
        );
        const literals = source.matchAll(
          /\.prepare\(\s*(`[^`]*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\)/g,
        );
        for (const [_, literal] of literals) {
          if (literal.includes("${")) continue;
          const sql = vm.runInNewContext(literal);
          if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /sqlite_master/.test(sql))
            continue;
          const parameterCount = (sql.match(/'(?:''|[^'])*'|\?/g) || []).filter(
            (token) => token === "?",
          ).length;
          try {
            db.prepare(`EXPLAIN ${sql}`).all(
              ...Array(parameterCount).fill(null),
            );
            compiledQueries++;
          } catch (error) {
            throw new Error(`${folder}/${file}: ${error.message} in ${sql}`, {
              cause: error,
            });
          }
        }
      }
    }
    assert.ok(compiledQueries > 50, "Compile the engine query inventory");
    const userId = db
      .prepare(
        "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, 0)",
      )
      .run("Alice", "hash").lastInsertRowid;
    ensurePersonalRoomsForAllUsers();
    const room = db
      .prepare("SELECT id FROM rooms WHERE name = ?")
      .get("Alice-personal");
    const poll = db
      .prepare(
        "INSERT INTO polls(room_id, question, created_at) VALUES (?, ?, ?)",
      )
      .run(room.id, "Question?", new Date().toISOString()).lastInsertRowid;
    const option = db
      .prepare("INSERT INTO poll_options(poll_id, option_text) VALUES (?, ?)")
      .run(poll, "Yes").lastInsertRowid;
    db.prepare(
      "INSERT OR REPLACE INTO swipe_votes(poll_id, user_id, option_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(poll, userId, option, "right", "now");
    db.prepare(
      "INSERT OR REPLACE INTO swipe_votes(poll_id, user_id, option_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(poll, userId, option, "left", "later");
    assert.equal(
      db
        .prepare("SELECT swipe_direction FROM swipe_votes WHERE poll_id = ?")
        .get(poll).swipe_direction,
      "left",
    );
    assert.equal(
      db
        .prepare(
          "INSERT OR IGNORE INTO convergence_agreements(room_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .run(room.id, userId, "now").changes,
      1,
    );
    assert.equal(
      db
        .prepare(
          "INSERT OR IGNORE INTO convergence_agreements(room_id, user_id, created_at) VALUES (?, ?, ?)",
        )
        .run(room.id, userId, "now").changes,
      0,
    );
    assert.throws(
      db.transaction(() => {
        db.prepare(
          "INSERT INTO users(username, password_hash) VALUES (?, ?)",
        ).run("Rolled back", "hash");
        throw new Error("rollback");
      }),
      /rollback/,
    );
    assert.equal(
      db.prepare("SELECT id FROM users WHERE username = ?").get("Rolled back"),
      undefined,
    );
    const value = "Text with ? and 'quotes'";
    db.prepare(
      "INSERT INTO messages(room_id, text, timestamp) VALUES (?, ?, 'now?')",
    ).run(room.id, value);
    assert.equal(
      db.prepare("SELECT text FROM messages WHERE room_id = ?").get(room.id)
        .text,
      value,
    );
  },
);
