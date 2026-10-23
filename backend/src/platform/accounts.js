import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { createRouter } from "../middleware/router.js";
import { env } from "../config/env.js";
import {
  accountAuth,
  randomToken,
  hashToken,
  fail,
  now,
  publicAccount,
  rateLimit,
} from "./security.js";
import { sendAccountMail } from "./mail.js";

export function accountRoutes(store, { dataDir, publicUrl, onLogout }) {
  const router = createRouter();
  const authenticate = accountAuth(store);
  const limited = rateLimit({
    limit: Number(process.env.ACCOUNT_RATE_LIMIT || 12),
    windowMs: 60000,
  });
  const passwordValid = (value) =>
    typeof value === "string" &&
    value.length >= 12 &&
    Buffer.byteLength(value, "utf8") <= 72;
  const emailOf = (value) =>
    String(value || "")
      .trim()
      .toLowerCase();
  async function action(account, purpose) {
    const token = randomToken();
    await store.query(
      "INSERT INTO account_actions(token_hash, account_id, purpose, expires_at) VALUES (?, ?, ?, ?)",
      [
        hashToken(token),
        account.id,
        purpose,
        new Date(
          Date.now() + (purpose === "verify" ? 86400000 : 3600000),
        ).toISOString(),
      ],
    );
    const url = `${publicUrl}/#/account/${purpose}?token=${token}`;
    return sendAccountMail(account.email, purpose, url, dataDir);
  }
  router.post("/register", limited, async (req, res) => {
    const email = emailOf(req.body.email);
    const name = String(req.body.name || "").trim();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      !name ||
      name.length > 80 ||
      !passwordValid(req.body.password)
    )
      throw fail(
        400,
        "Provide a name, valid email and a password of 12–72 bytes",
      );
    const account = { id: randomUUID(), email, name };
    const hash = await bcrypt.hash(req.body.password, 12);
    try {
      await store.query(
        "INSERT INTO accounts(id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
        [account.id, email, name, hash, now()],
      );
    } catch (error) {
      if (["23505", "SQLITE_CONSTRAINT_UNIQUE"].includes(error.code))
        throw fail(409, "An account with that email already exists");
      throw error;
    }
    res.status(201).json({
      message: "Check your email to verify your account.",
      ...(await action(account, "verify")),
    });
  });
  router.post("/verify", limited, async (req, res) => {
    await store.transaction(async (query) => {
      const [record] = await query(
        "DELETE FROM account_actions WHERE token_hash = ? AND purpose = 'verify' AND expires_at > ? RETURNING account_id",
        [hashToken(String(req.body.token || "")), now()],
      );
      if (!record)
        throw fail(400, "This verification link is invalid or expired");
      await query("UPDATE accounts SET verified = 1 WHERE id = ?", [
        record.account_id,
      ]);
    });
    res.json({ message: "Your account is verified. You can now sign in." });
  });
  router.post("/login", limited, async (req, res) => {
    const [account] = await store.query(
      "SELECT * FROM accounts WHERE email = ?",
      [emailOf(req.body.email)],
    );
    if (
      !account ||
      typeof req.body.password !== "string" ||
      !(await bcrypt.compare(req.body.password, account.password_hash))
    )
      throw fail(401, "Invalid email or password");
    if (!account.verified)
      throw fail(403, "Verify your email before signing in");
    const sid = randomUUID();
    await store.query(
      "INSERT INTO account_sessions(id, account_id, expires_at) VALUES (?, ?, ?)",
      [sid, account.id, new Date(Date.now() + 7 * 86400000).toISOString()],
    );
    res.json({
      token: jwt.sign({ sid }, env.jwtSecret, {
        algorithm: "HS256",
        audience: "cime-platform",
        expiresIn: "7d",
      }),
      user: publicAccount(account),
    });
  });
  router.get("/me", authenticate, (req, res) =>
    res.json({ user: publicAccount(req.account) }),
  );
  router.post("/logout", authenticate, async (req, res) => {
    await store.query("DELETE FROM account_sessions WHERE id = ?", [
      req.accountSession,
    ]);
    await onLogout?.(req.accountSession);
    res.json({ ok: true });
  });
  router.post("/forgot-password", limited, async (req, res) => {
    const [account] = await store.query(
      "SELECT * FROM accounts WHERE email = ?",
      [emailOf(req.body.email)],
    );
    const development = account ? await action(account, "reset") : {};
    res.json({
      message: "If the account exists, a password reset link has been sent.",
      ...development,
    });
  });
  router.post("/resend-verification", limited, async (req, res) => {
    const [account] = await store.query(
      "SELECT * FROM accounts WHERE email = ? AND verified = 0",
      [emailOf(req.body.email)],
    );
    res.json({
      message: "If verification is needed, a new link has been sent.",
      ...(account ? await action(account, "verify") : {}),
    });
  });
  router.post("/reset-password", limited, async (req, res) => {
    if (!passwordValid(req.body.password))
      throw fail(
        400,
        "Use a password of at least 12 characters and at most 72 bytes",
      );
    const hash = await bcrypt.hash(req.body.password, 12);
    const sessionIds = await store.transaction(async (query) => {
      const [record] = await query(
        "DELETE FROM account_actions WHERE token_hash = ? AND purpose = 'reset' AND expires_at > ? RETURNING account_id",
        [hashToken(String(req.body.token || "")), now()],
      );
      if (!record) throw fail(400, "This reset link is invalid or expired");
      await query("UPDATE accounts SET password_hash = ? WHERE id = ?", [
        hash,
        record.account_id,
      ]);
      await query(
        "DELETE FROM account_actions WHERE account_id = ? AND purpose = 'reset'",
        [record.account_id],
      );
      return query(
        "DELETE FROM account_sessions WHERE account_id = ? RETURNING id",
        [record.account_id],
      );
    });
    for (const session of sessionIds) await onLogout?.(session.id);
    res.json({ message: "Password changed. Please sign in again." });
  });
  return router;
}
