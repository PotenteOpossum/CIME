import nodemailer from "nodemailer";
import fs from "node:fs/promises";
import path from "node:path";

export function useMailOutbox() {
  return process.env.CIME_MAIL_MODE === "outbox";
}

export function accountMailConfigured() {
  return Boolean(process.env.SMTP_URL) || useMailOutbox();
}

export async function sendAccountMail(email, purpose, url, dataDir) {
  const subject =
    purpose === "verify"
      ? "Verify your CIME account"
      : "Reset your CIME password";
  const text = `${subject}\n\n${url}\n\nIf you did not request this, you can ignore this email.`;
  if (process.env.SMTP_URL && !useMailOutbox()) {
    const transport = nodemailer.createTransport(process.env.SMTP_URL);
    await transport.sendMail({
      from: process.env.MAIL_FROM || "CIME <noreply@example.com>",
      to: email,
      subject,
      text,
    });
    return {};
  }
  if (process.env.NODE_ENV === "production" && !useMailOutbox())
    throw new Error("Production requires SMTP_URL or CIME_MAIL_MODE=outbox");
  await fs.mkdir(path.join(dataDir, "mail"), { recursive: true, mode: 0o700 });
  await fs.appendFile(
    path.join(dataDir, "mail", "outbox.jsonl"),
    `${JSON.stringify({ email, purpose, url })}\n`,
    { mode: 0o600 },
  );
  // Production links stay in the private server outbox, never in API responses.
  return process.env.NODE_ENV === "production"
    ? {}
    : { developmentActionUrl: url };
}
