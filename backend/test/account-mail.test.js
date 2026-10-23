import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { accountMailConfigured, sendAccountMail } from "../src/platform/mail.js";

async function fixture(t, mode, nodeEnv = "production") {
  const keys = ["NODE_ENV", "SMTP_URL", "CIME_MAIL_MODE"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cime-mail-test-"));
  process.env.NODE_ENV = nodeEnv;
  delete process.env.SMTP_URL;
  if (mode === undefined) delete process.env.CIME_MAIL_MODE;
  else process.env.CIME_MAIL_MODE = mode;
  t.after(async () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("production without SMTP requires explicit outbox opt-in", async (t) => {
  const dir = await fixture(t);
  assert.equal(accountMailConfigured(), false);
  await assert.rejects(sendAccountMail("admin@example.test", "verify", "secret-link", dir), /CIME_MAIL_MODE=outbox/);
  await assert.rejects(fs.access(path.join(dir, "mail", "outbox.jsonl")));
  process.env.CIME_MAIL_MODE = "typo";
  assert.equal(accountMailConfigured(), false);
  process.env.SMTP_URL = "smtp://relay.example.test:587";
  assert.equal(accountMailConfigured(), true);
});

test("production outbox saves verification and reset links privately without returning tokens", async (t) => {
  const dir = await fixture(t, "outbox");
  assert.equal(accountMailConfigured(), true);
  // Explicit outbox mode overrides leftover SMTP settings without sending mail.
  process.env.SMTP_URL = "smtp://127.0.0.1:1";
  for (const purpose of ["verify", "reset"]) {
    assert.deepEqual(await sendAccountMail("admin@example.test", purpose, `https://example.test/${purpose}?token=secret`, dir), {});
  }
  const file = path.join(dir, "mail", "outbox.jsonl");
  const records = (await fs.readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.purpose), ["verify", "reset"]);
  assert.equal(records[0].url, "https://example.test/verify?token=secret");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
});

test("development retains the local verification link", async (t) => {
  const dir = await fixture(t, undefined, "development");
  assert.deepEqual(await sendAccountMail("admin@example.test", "verify", "local-link", dir), { developmentActionUrl: "local-link" });
});
