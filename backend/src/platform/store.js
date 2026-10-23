import Database from "better-sqlite3";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";

const schema = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_sessions (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_actions (
  token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES accounts(id), title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions(id),
  title_override TEXT, description_override TEXT,
  status TEXT NOT NULL DEFAULT 'draft', access_mode TEXT NOT NULL DEFAULT 'open',
  invite_token TEXT UNIQUE NOT NULL, admission_open INTEGER NOT NULL DEFAULT 0,
  participant_limit INTEGER NOT NULL DEFAULT 100, config_json TEXT NOT NULL DEFAULT '{}',
  prolific_secret TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, started_at TEXT,
  archived INTEGER NOT NULL DEFAULT 0, model_calls_used INTEGER NOT NULL DEFAULT 0,
  CHECK (access_mode IN ('open', 'credentials', 'prolific')),
  CHECK (status IN ('draft', 'recruiting', 'starting', 'active', 'completed', 'interrupted', 'failed'))
);
CREATE INDEX IF NOT EXISTS decisions_owner ON decisions(owner_id);
CREATE INDEX IF NOT EXISTS runs_decision ON runs(decision_id);
CREATE TABLE IF NOT EXISTS account_model_usage (account_id TEXT NOT NULL REFERENCES accounts(id), day TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(account_id, day));
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, account_id TEXT, run_id TEXT, event TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

export async function openStore({
  url = process.env.DATABASE_URL,
  dataDir = process.env.CIME_DATA_DIR || "./data",
} = {}) {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      options: "-c search_path=cime_platform",
    });
    const supervisor = await pool.connect();
    try {
      const lock = await supervisor.query(
        "SELECT pg_try_advisory_lock(1128877381, 1) AS acquired",
      );
      if (!lock.rows[0].acquired) {
        throw new Error(
          "Another CIME supervisor is already using this database",
        );
      }
      await pool.query("CREATE SCHEMA IF NOT EXISTS cime_platform");
      await pool.query(schema);
      await pool.query(
        "ALTER TABLE runs ADD COLUMN IF NOT EXISTS title_override TEXT",
      );
      await pool.query(
        "ALTER TABLE runs ADD COLUMN IF NOT EXISTS description_override TEXT",
      );
      await pool.query(
        "ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_calls_used INTEGER NOT NULL DEFAULT 0",
      );
    } catch (error) {
      supervisor.release();
      await pool.end();
      throw error;
    }
    const convert = (sql) => {
      let i = 0;
      return sql.replace(/\?/g, () => `$${++i}`);
    };
    const query = async (sql, params = []) =>
      (await pool.query(convert(sql), params)).rows;
    return {
      query,
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn(
            async (sql, params = []) =>
              (await client.query(convert(sql), params)).rows,
          );
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      dropRunSchema: async (id) => {
        if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid run ID");
        await pool.query(
          `DROP SCHEMA IF EXISTS "cime_run_${id.replaceAll("-", "")}" CASCADE`,
        );
      },
      close: async () => {
        await supervisor.query("SELECT pg_advisory_unlock(1128877381, 1)");
        supervisor.release();
        await pool.end();
      },
    };
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, "platform.lock");
  try {
    const pid = Number(fs.readFileSync(lockPath, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(
        "Invalid supervisor lock; inspect platform.lock before restarting",
      );
    try {
      process.kill(pid, 0);
      throw new Error(
        "Another CIME supervisor is already using this data directory",
      );
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      fs.unlinkSync(lockPath);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const descriptor = fs.openSync(lockPath, "wx", 0o600);
  fs.writeFileSync(descriptor, String(process.pid));
  fs.closeSync(descriptor);
  let db;
  try {
    db = new Database(path.join(dataDir, "platform.db"));
  } catch (error) {
    fs.unlinkSync(lockPath);
    throw error;
  }
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  if (
    !db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .some((column) => column.name === "model_calls_used")
  )
    db.exec(
      "ALTER TABLE runs ADD COLUMN model_calls_used INTEGER NOT NULL DEFAULT 0",
    );
  for (const name of ["title_override", "description_override"]) {
    if (
      !db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .some((column) => column.name === name)
    )
      db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`);
  }
  const query = async (sql, params = []) => {
    const statement = db.prepare(sql);
    return statement.reader
      ? statement.all(...params)
      : (statement.run(...params), []);
  };
  // A mutex prevents async transactions from interleaving on the SQLite connection.
  let pending = Promise.resolve();
  const transaction = (fn) => {
    const result = pending.then(async () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn(query);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    pending = result.catch(() => {});
    return result;
  };
  return {
    query: (sql, params) => pending.then(() => query(sql, params)),
    transaction,
    close: () => {
      db.close();
      fs.unlinkSync(lockPath);
    },
  };
}
