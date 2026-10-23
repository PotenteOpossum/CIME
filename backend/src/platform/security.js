import {
  createHash,
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token) =>
  createHash("sha256").update(token).digest("hex");
export const engineSecret = (id) =>
  createHmac("sha256", env.jwtSecret).update(`engine:${id}`).digest("hex");
export const now = () => new Date().toISOString();
export const fail = (status, message) =>
  Object.assign(new Error(message), { status });
export const publicAccount = (a) => ({
  id: a.id,
  email: a.email,
  name: a.name,
  verified: !!a.verified,
});

const encryptionKey = createHash("sha256")
  .update(`secrets:${env.jwtSecret}`)
  .digest();
export function encrypt(value) {
  if (!value) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decrypt(value) {
  if (!value) return "";
  const bytes = Buffer.from(value, "base64");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    bytes.subarray(0, 12),
  );
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([
    cipher.update(bytes.subarray(28)),
    cipher.final(),
  ]).toString("utf8");
}

export function accountAuth(store) {
  return async (req, _res, next) => {
    try {
      const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
      const payload = jwt.verify(token, env.jwtSecret, {
        algorithms: ["HS256"],
        audience: "cime-platform",
      });
      const [account] = await store.query(
        `SELECT a.* FROM accounts a JOIN account_sessions s ON s.account_id = a.id WHERE s.id = ? AND s.expires_at > ?`,
        [payload.sid, now()],
      );
      if (!account) throw fail(401, "Please sign in again");
      req.account = account;
      req.accountSession = payload.sid;
      next();
    } catch {
      next(fail(401, "Please sign in again"));
    }
  };
}

export function rateLimit({ limit = 30, windowMs = 60000 } = {}) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    for (const [key, bucket] of buckets)
      if (bucket.until <= Date.now()) buckets.delete(key);
  }, windowMs);
  cleanup.unref();
  return (req, res, next) => {
    const key = req.ip;
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= Date.now()) {
      bucket = { count: 0, until: Date.now() + windowMs };
      buckets.set(key, bucket);
    }
    if (++bucket.count > limit) {
      res.set(
        "Retry-After",
        String(Math.ceil((bucket.until - Date.now()) / 1000)),
      );
      return res
        .status(429)
        .json({ error: "Too many attempts. Please try again shortly." });
    }
    next();
  };
}
