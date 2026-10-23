import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import Database from "better-sqlite3";
import { openStore } from "./store.js";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (entries, value, index, all) =>
        value.startsWith("--")
          ? [...entries, [value.slice(2), all[index + 1]]]
          : entries,
      [],
    ),
);
if (!args.source || !args.owner) {
  console.error(
    'Usage: npm run import:legacy -- --source /absolute/path/chat.db --owner admin@example.com [--title "Legacy experiment"] [--config-dir /path/agent-config] [--prompts-dir /path/prompts] [--logs-dir /path/logs]',
  );
  process.exit(1);
}
const directory = path.resolve(process.env.CIME_DATA_DIR || "data");
const store = await openStore({ dataDir: directory });
let source, target;
try {
  const [account] = await store.query(
    "SELECT id FROM accounts WHERE email = ? AND verified = 1",
    [args.owner.trim().toLowerCase()],
  );
  if (!account)
    throw new Error(
      "Create and verify the owning administrator account before importing",
    );
  const id = randomUUID();
  const decisionId = randomUUID();
  const runDir = path.join(directory, "runs", id);
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  source = new Database(path.resolve(args.source), {
    readonly: true,
    fileMustExist: true,
  });
  const snapshot = path.join(runDir, "legacy-source.db");
  await source.backup(snapshot);
  source.close();
  source = new Database(snapshot, { readonly: true });
  process.env.CIME_DB_PATH = path.join(runDir, "chat.db");
  process.env.CIME_RUN_SCHEMA = `cime_run_${id.replaceAll("-", "")}`;
  process.env.CIME_CONFIG_DIR = path.join(runDir, "agent-config");
  process.env.CIME_LOG_DIR = path.join(runDir, "logs");
  const tables = source
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => /^[a-z_]+$/.test(name));
  if (!process.env.DATABASE_URL)
    await fs.copyFile(snapshot, process.env.CIME_DB_PATH);
  const storage = await import("../config/db.js");
  target = storage.db;
  storage.initDb();
  if (process.env.DATABASE_URL) {
    const targetTables = new Set(
      target
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    const copyTables = tables.filter((name) => targetTables.has(name));
    target.transaction(() => {
      target.exec(`TRUNCATE ${copyTables.join(", ")} RESTART IDENTITY CASCADE`);
      for (const table of copyTables) {
        const targetColumns = new Set(
          target
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((column) => column.name),
        );
        const columns = source
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((column) => column.name)
          .filter((column) => targetColumns.has(column));
        const insert = target.prepare(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        );
        for (const row of source.prepare(`SELECT * FROM ${table}`).all())
          insert.run(...columns.map((column) => row[column]));
        if (
          columns.includes("id") &&
          target
            .prepare(
              `SELECT pg_get_serial_sequence('${table}', 'id') AS sequence`,
            )
            .get().sequence
        )
          target
            .prepare(
              `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1), COUNT(*) > 0) FROM ${table}`,
            )
            .get();
        const count = target
          .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
          .get().n;
        if (
          Number(count) !==
          source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
        )
          throw new Error(`Row-count mismatch in ${table}`);
      }
    })();
  }
  const { initEnginePlatform } = await import("./engineRoutes.js");
  initEnginePlatform();
  const legacyState = target
    .prepare("SELECT * FROM system_state WHERE id = 1")
    .get();
  const participants = target
    .prepare("SELECT * FROM users WHERE is_admin = 0")
    .all();
  target.transaction(() => {
    for (const user of participants) {
      const recovery = createHash("sha256")
        .update(randomBytes(32))
        .digest("hex");
      target
        .prepare(
          "INSERT INTO run_participants(user_id, joined_at, recovery_hash) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING",
        )
        .run(user.id, new Date().toISOString(), recovery);
      target
        .prepare(
          "INSERT INTO run_credentials(username, password_hash) VALUES (?, ?) ON CONFLICT(username) DO NOTHING",
        )
        .run(user.username, user.password_hash);
    }
    target
      .prepare(
        "UPDATE run_admission SET mode = 'credentials', admission_open = 0 WHERE id = 1",
      )
      .run();
  })();
  for (const [argument, folder, fallback] of [
    ["config-dir", "agent-config", "agent-config"],
    ["prompts-dir", "prompts", "prompts"],
    ["logs-dir", "logs", null],
  ]) {
    const from = args[argument] || (fallback ? path.resolve(fallback) : null);
    if (from)
      await fs.cp(path.resolve(from), path.join(runDir, folder), {
        recursive: true,
      });
  }
  const config = {
    globalQuestion: legacyState.global_question,
    decisionContext: legacyState.decision_context,
    generalDescription: legacyState.general_description,
    importedLegacyPhase: legacyState.current_phase,
    importNote:
      "Imported as historical data. The source was backed up read-only; no earlier runs were inferred from timestamps.",
  };
  await store.transaction(async (query) => {
    await query(
      "INSERT INTO decisions(id, owner_id, title, description, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        decisionId,
        account.id,
        args.title || "Imported CIME experiment",
        "Historical experiment imported from the legacy database",
        new Date().toISOString(),
      ],
    );
    await query(
      "INSERT INTO runs(id, decision_id, status, access_mode, invite_token, config_json, created_at, archived) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
      [
        id,
        decisionId,
        legacyState.current_phase === "completed" ? "completed" : "interrupted",
        "credentials",
        randomBytes(32).toString("base64url"),
        JSON.stringify(config),
        new Date().toISOString(),
      ],
    );
  });
  console.log(
    `Imported ${participants.length} participants into archived run ${id}. Source data was not modified.`,
  );
} catch (error) {
  console.error(
    `Import failed: ${error.message}. The original source is unchanged.`,
  );
  process.exitCode = 1;
} finally {
  source?.close();
  target?.close();
  await store.close();
}
