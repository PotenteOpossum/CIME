import bcrypt from "bcrypt";
import fs from "node:fs";
import path from "node:path";
import jwt from "jsonwebtoken";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { createRouter } from "../middleware/router.js";
import { db, ensurePersonalRoomsForAllUsers } from "../config/db.js";
import { env } from "../config/env.js";
import { currentUser } from "../middleware/auth.js";
import { getSurveyDefinitions, getParticipantSurveyStatus, pendingPreSurveyParticipants } from '../services/surveyService.js';
import {
  updateDecisionSettings,
  getDecisionSettings,
  getAgentPrompt,
} from "../services/agentConfigService.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const usernameKey = (value) =>
  String(value || "").normalize("NFKC").trim().toLowerCase();
const error = (status, message) =>
  Object.assign(new Error(message), { status });
const time = () => new Date().toISOString();
let admission = { open: false, mode: "open", limit: 100 };
let admissions = Promise.resolve();
const exclusive = (task) => {
  const result = admissions.then(task);
  admissions = result.catch(() => {});
  return result;
};

export function initEnginePlatform() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_participants (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL, recovery_hash TEXT UNIQUE NOT NULL,
      prolific_pid TEXT UNIQUE, prolific_study_id TEXT, prolific_session_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS run_credentials (
      username TEXT PRIMARY KEY, password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS run_sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS run_metadata (id INTEGER PRIMARY KEY CHECK(id = 1), config_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS run_simulation (id INTEGER PRIMARY KEY CHECK(id = 1), config_json TEXT NOT NULL, running INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS run_admission (
      id INTEGER PRIMARY KEY CHECK(id = 1), admission_open INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'open', participant_limit INTEGER NOT NULL DEFAULT 100
    );
    INSERT INTO run_admission(id) VALUES (1) ON CONFLICT(id) DO NOTHING;
  `);
  if (!db.prepare("SELECT id FROM users WHERE is_admin = 1").get()) {
    db.prepare(
      "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, 1)",
    ).run("__cime_owner__", hash(randomBytes(32)));
  }
  const stored = db.prepare("SELECT * FROM run_admission WHERE id = 1").get();
  admission = {
    open: !!stored.admission_open,
    mode: stored.mode,
    limit: stored.participant_limit,
  };
}

// Plaintext codes are returned only to the organizer; storage contains hashes.
export function createSimulationRecoveryCodes(userIds) {
  return db.transaction(() =>
    userIds.map((id) => {
      const user = db
        .prepare("SELECT id, username FROM users WHERE id = ? AND is_admin = 0")
        .get(id);
      if (!user) throw error(409, "A simulated participant no longer exists");
      const recoveryCode = randomBytes(24).toString("base64url");
      db.prepare(
        `INSERT INTO run_participants(user_id, joined_at, recovery_hash)
      VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET recovery_hash = excluded.recovery_hash`,
      ).run(user.id, time(), hash(recoveryCode));
      return { ...user, recoveryCode };
    }),
  )();
}

export function issueEngineSession(user) {
  db.prepare("DELETE FROM run_sessions WHERE expires_at < ?").run(time());
  const sid = randomUUID();
  const expires = new Date(Date.now() + 7 * 86400000).toISOString();
  db.prepare(
    "INSERT INTO run_sessions(id, user_id, expires_at) VALUES (?, ?, ?)",
  ).run(sid, user.id, expires);
  return {
    token: jwt.sign(
      { id: user.id, sid, run: process.env.CIME_RUN_ID },
      env.jwtSecret,
      { algorithm: "HS256", audience: "cime-engine", expiresIn: "7d" },
    ),
    user: { id: user.id, username: user.username, is_admin: !!user.is_admin },
    runId: process.env.CIME_RUN_ID,
  };
}

export function engineRoutes() {
  const router = createRouter();
  router.use((req, _res, next) => {
    const actual = Buffer.from(req.headers["x-cime-engine-key"] || "");
    const expected = Buffer.from(process.env.CIME_ENGINE_KEY || "");
    if (
      actual.length !== expected.length ||
      !expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return next(error(403, "Forbidden"));
    next();
  });
  router.post('/survey-status', (req, res) => res.json(getParticipantSurveyStatus(req.body.userId)));
  router.get('/surveys/preflight', (_req, res) => res.json({ pending: pendingPreSurveyParticipants() }));
  router.post("/snapshot", (req, res) => {
    db.prepare(
      "INSERT INTO run_metadata(id, config_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json",
    ).run(JSON.stringify(req.body));
    res.json({ ok: true });
  });
  router.post("/models", (req, res) => {
    if (!Array.isArray(req.body.models))
      throw error(400, "Invalid model configuration");
    db.transaction(() => {
      const update = db.prepare(
        "INSERT INTO llm_call_models(call_key, model_name) VALUES (?, ?) ON CONFLICT(call_key) DO UPDATE SET model_name = excluded.model_name",
      );
      for (const model of req.body.models) {
        if (
          typeof model.call_key !== "string" ||
          typeof model.model_name !== "string"
        )
          throw error(400, "Invalid model configuration");
        update.run(model.call_key, model.model_name);
      }
    })();
    res.json({ ok: true });
  });
  router.get("/configuration", (_req, res) => {
    const templatesDir = path.join(process.env.CIME_CONFIG_DIR, "templates");
    const templateNames = fs
      .readdirSync(templatesDir)
      .filter((name) => /^[a-zA-Z0-9._-]+\.md$/.test(name));
    res.json({
      settings: getDecisionSettings(),
      surveys: getSurveyDefinitions(),
      prompts: Object.fromEntries(
        ["agent1", "agent2", "agent3"].map((key) => [key, getAgentPrompt(key)]),
      ),
      templates: Object.fromEntries(
        templateNames.map((name) => [
          name,
          fs.readFileSync(path.join(templatesDir, name), "utf8"),
        ]),
      ),
      models: db.prepare("SELECT * FROM llm_call_models").all(),
    });
  });
  router.get("/state", (_req, res) => {
    const state = db.prepare("SELECT * FROM system_state WHERE id = 1").get();
    const participants = db
      .prepare(
        `SELECT u.id, u.username, p.joined_at, p.prolific_pid, p.prolific_study_id, p.prolific_session_id FROM users u JOIN run_participants p ON p.user_id = u.id ORDER BY p.joined_at`,
      )
      .all();
    const usage = db
      .prepare(
        "SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_used), 0) AS tokens FROM llm_logs",
      )
      .get();
    res.json({ phase: state.current_phase, participants, usage, admission });
  });
  router.post("/admission", (req, res) =>
    exclusive(async () => {
      if (
        req.body.mode !== admission.mode &&
        db.prepare("SELECT COUNT(*) AS n FROM run_participants").get().n > 0
      )
        throw error(409, "Access mode is locked after participants join");
      if (
        req.body.open &&
        db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
          .current_phase !== "idle"
      )
        throw error(409, "Registration is closed for a started run");
      admission = {
        open: !!req.body.open,
        mode: req.body.mode,
        limit: req.body.limit,
      };
      db.prepare(
        "UPDATE run_admission SET admission_open = ?, mode = ?, participant_limit = ? WHERE id = 1",
      ).run(admission.open ? 1 : 0, admission.mode, admission.limit);
      res.json({ ok: true });
    }),
  );
  router.post("/discard-simulation-participants", (_req, res) => {
    db.prepare(
      "DELETE FROM users WHERE is_admin = 0 AND id NOT IN (SELECT user_id FROM run_participants)",
    ).run();
    res.json({ ok: true });
  });
  router.post("/settings", (req, res) =>
    res.json({ settings: updateDecisionSettings(req.body) }),
  );
  router.post("/session", (req, res) => {
    try {
      res.json({ user: currentUser(req.body.token) });
    } catch {
      throw error(401, "Invalid session");
    }
  });
  router.post("/owner-session", (_req, res) => {
    res.json(
      issueEngineSession(
        db
          .prepare(
            "SELECT id, username, is_admin FROM users WHERE is_admin = 1 ORDER BY id LIMIT 1",
          )
          .get(),
      ),
    );
  });
  router.post("/credentials", (req, res) =>
    exclusive(async () => {
      if (db.prepare("SELECT COUNT(*) AS n FROM run_participants").get().n > 0)
        throw error(
          409,
          "Credentials are locked after the first participant joins",
        );
      const entries = req.body.entries;
      if (
        !Array.isArray(entries) ||
        !entries.length ||
        entries.length > admission.limit
      )
        throw error(
          400,
          "Provide a participant list within the configured limit",
        );
      const seen = new Set();
      const prepared = [];
      for (const entry of entries) {
        const username = String(entry.username || "")
          .normalize("NFKC")
          .trim();
        if (
          !/^[\p{L}\p{N} _.-]{1,40}$/u.test(username) ||
          username.startsWith("__") ||
          seen.has(username.toLowerCase())
        )
          throw error(
            400,
            "Usernames must be distinct and contain 1–40 letters, numbers, spaces, dots, dashes or underscores",
          );
        seen.add(username.toLowerCase());
        const password =
          entry.password || randomBytes(12).toString("base64url");
        if (
          typeof password !== "string" ||
          password.length < 12 ||
          Buffer.byteLength(password) > 72
        )
          throw error(
            400,
            "Passwords must contain at least 12 characters and at most 72 bytes",
          );
        prepared.push({
          username,
          password,
          hash: await bcrypt.hash(password, 12),
        });
      }
      db.transaction(() => {
        db.prepare("DELETE FROM run_credentials").run();
        for (const entry of prepared)
          db.prepare(
            "INSERT INTO run_credentials(username, password_hash) VALUES (?, ?)",
          ).run(entry.username, entry.hash);
      })();
      res.json({
        credentials: prepared.map(({ username, password }) => ({
          username,
          password,
        })),
      });
    }),
  );
  router.post("/join", (req, res) =>
    exclusive(async () => {
      const body = req.body;
      if (body.recoveryCode) {
        const user = db
          .prepare(
            "SELECT u.* FROM users u JOIN run_participants p ON p.user_id = u.id WHERE p.recovery_hash = ?",
          )
          .get(hash(body.recoveryCode));
        if (!user) throw error(401, "Invalid recovery code");
        return res.json(issueEngineSession(user));
      }
      if (admission.mode === "prolific" && body.prolific) {
        const previous = db
          .prepare(
            "SELECT u.*, p.prolific_study_id, p.prolific_session_id FROM users u JOIN run_participants p ON p.user_id = u.id WHERE p.prolific_pid = ?",
          )
          .get(body.prolific.pid);
        if (previous) {
          if (
            previous.prolific_study_id !== body.prolific.study ||
            previous.prolific_session_id !== body.prolific.session
          )
            throw error(
              409,
              "This participant has already joined with another submission",
            );
          return res.json(issueEngineSession(previous));
        }
      }
      let username = String(body.username || "")
        .normalize("NFKC")
        .trim();
      if (
        !/^[\p{L}\p{N} _.-]{1,40}$/u.test(username) ||
        username.startsWith("__")
      )
        throw error(
          400,
          "Choose a username of 1–40 letters, numbers, spaces, dots, dashes or underscores",
        );
      // SQLite's LOWER() only handles ASCII case, while usernames may contain
      // Unicode letters. Compare normalized keys in JS so case variants are
      // treated consistently across SQLite and PostgreSQL-backed runs.
      const existing = db
        .prepare("SELECT * FROM users")
        .all()
        .find((user) => usernameKey(user.username) === usernameKey(username));
      let credential;
      if (admission.mode === "credentials") {
        credential = db
          .prepare("SELECT * FROM run_credentials")
          .all()
          .find((entry) => usernameKey(entry.username) === usernameKey(username));
        if (
          !credential ||
          typeof body.password !== "string" ||
          !(await bcrypt.compare(body.password, credential.password_hash))
        )
          throw error(401, "Invalid username or password");
        username = credential.username;
        if (existing && !existing.is_admin)
          return res.json(issueEngineSession(existing));
      }
      if (admission.mode === "prolific" && !body.prolific)
        throw error(403, "Prolific verification required");
      if (
        !admission.open ||
        db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
          .current_phase !== "idle"
      )
        throw error(
          409,
          "Registration is closed. Use your existing session or recovery code to reconnect.",
        );
      if (existing)
        throw error(
          409,
          "That username is already taken. Choose another or use your recovery code.",
        );
      if (
        db.prepare("SELECT COUNT(*) AS n FROM run_participants").get().n >=
        admission.limit
      )
        throw error(409, "This experiment is full");
      const recoveryCode = randomBytes(24).toString("base64url");
      const passwordHash =
        credential?.password_hash ||
        (await bcrypt.hash(randomBytes(32).toString("hex"), 10));
      let user;
      try {
        db.transaction(() => {
          const id = Number(
            db
              .prepare(
                "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, 0)",
              )
              .run(username, passwordHash).lastInsertRowid,
          );
          db.prepare(
            "INSERT INTO run_participants(user_id, joined_at, recovery_hash, prolific_pid, prolific_study_id, prolific_session_id) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            time(),
            hash(recoveryCode),
            body.prolific?.pid || null,
            body.prolific?.study || null,
            body.prolific?.session || null,
          );
          ensurePersonalRoomsForAllUsers();
          user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
        })();
      } catch (cause) {
        if (cause.code === "SQLITE_CONSTRAINT_UNIQUE")
          throw error(
            409,
            "This participant has already joined. Use the existing session or recovery code.",
          );
        throw cause;
      }
      res.status(201).json({ ...issueEngineSession(user), recoveryCode });
    }),
  );
  router.post("/revoke", (req, res) => {
    db.prepare("UPDATE run_sessions SET revoked = 1 WHERE id = ?").run(
      req.body.sid,
    );
    res.json({ ok: true });
  });
  router.post("/revoke-user", (req, res) => {
    db.prepare("UPDATE run_sessions SET revoked = 1 WHERE user_id = ?").run(
      req.body.userId,
    );
    res.json({ ok: true });
  });
  return router;
}
