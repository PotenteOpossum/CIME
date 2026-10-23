import { randomUUID } from "node:crypto";
import { fail } from "./security.js";

export async function reserveModelCall(store, runId) {
  return store.transaction(async (query) => {
    const [run] = await query(
      "SELECT r.model_calls_used, d.owner_id FROM runs r JOIN decisions d ON d.id = r.decision_id WHERE r.id = ?",
      [runId],
    );
    if (
      !run ||
      run.model_calls_used >= Number(process.env.MAX_LLM_CALLS_PER_RUN || 5000)
    )
      throw fail(429, "This experiment has reached its model-call limit");
    const day = new Date().toISOString().slice(0, 10);
    const [usage] = await query(
      `INSERT INTO account_model_usage(account_id, day, calls) VALUES (?, ?, 1)
      ON CONFLICT(account_id, day) DO UPDATE SET calls = account_model_usage.calls + 1
      WHERE account_model_usage.calls < ? RETURNING calls`,
      [
        run.owner_id,
        day,
        Number(process.env.MAX_LLM_CALLS_PER_ADMIN_DAY || 10000),
      ],
    );
    if (!usage)
      throw fail(
        429,
        "This administrator has reached the daily model-call limit",
      );
    const [reserved] = await query(
      "UPDATE runs SET model_calls_used = model_calls_used + 1 WHERE id = ? AND model_calls_used < ? RETURNING model_calls_used",
      [runId, Number(process.env.MAX_LLM_CALLS_PER_RUN || 5000)],
    );
    if (!reserved)
      throw fail(429, "This experiment has reached its model-call limit");
    return reserved.model_calls_used;
  });
}

let active = 0;
const pending = [];
export async function withModelBudget(callback) {
  if (process.env.CIME_ENGINE !== "true") return callback();
  if (!process.send)
    throw new Error("A platform supervisor is required for model calls");
  if (active >= Number(process.env.MAX_LLM_CONCURRENCY_PER_RUN || 4))
    await new Promise((resolve) => pending.push(resolve));
  active++;
  try {
    await new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => {
        clearTimeout(timeout);
        process.off("message", listener);
      };
      const listener = (message) => {
        if (message.type !== "model-budget" || message.id !== id) return;
        cleanup();
        message.ok
          ? resolve()
          : reject(new Error(message.error || "Model-call limit reached"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Unable to reserve model-call capacity"));
      }, 15000);
      process.on("message", listener);
      process.send({ type: "reserve-model-call", id });
    });
    return await callback();
  } finally {
    active--;
    pending.shift()?.();
  }
}
