import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomToken, engineSecret, fail } from "./security.js";
import { reserveModelCall } from "./modelBudget.js";
import { constants as fsConstants } from "node:fs";

const backendDir = fileURLToPath(new URL("../../", import.meta.url));

export class WorkerManager {
  constructor(store, dataDir) {
    this.store = store;
    this.dataDir = dataDir;
    this.workers = new Map();
    this.pending = new Map();
    this.deleting = new Set();
    this.closing = false;
    this.restarts = new Map();
    this.limit = Number(process.env.MAX_RUN_WORKERS || 16);
  }
  async ensure(run) {
    if (this.deleting.has(run.id)) throw fail(404, "Run not found");
    if (this.closing) throw fail(503, "The server is shutting down");
    if (this.workers.has(run.id)) {
      const worker = this.workers.get(run.id);
      worker.lastUsed = Date.now();
      return worker;
    }
    if (this.pending.has(run.id)) return this.pending.get(run.id);
    if (this.workers.size + this.pending.size >= this.limit) {
      // Idle drafts/completed runs may be evicted; active workflow timers stay alive.
      const idle = [...this.workers.values()]
        .filter((w) => !["active", "starting"].includes(w.run.status))
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle)
        throw fail(503, "The server is at capacity. Please try again later.");
      this.workers.delete(idle.run.id);
      idle.stopping = true;
      idle.child.kill("SIGTERM");
    }
    const promise = this.spawn(run);
    this.pending.set(run.id, promise);
    try {
      return await promise;
    } finally {
      this.pending.delete(run.id);
    }
  }
  async spawn(run) {
    if (!/^[a-f0-9-]{36}$/.test(run.id)) throw fail(400, "Invalid run");
    const directory = path.join(this.dataDir, "runs", run.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const config = path.join(directory, "agent-config");
    try {
      await fs.access(config);
    } catch {
      await fs.cp(path.join(backendDir, "agent-config"), config, {
        recursive: true,
      });
      // Never inherit another installation's live settings or credentials.
      await fs.rm(path.join(config, "settings.json"), { force: true });
      await fs.rm(path.join(config, "default-settings.json"), { force: true });
    }
    const prompts = path.join(directory, "prompts");
    await fs.mkdir(prompts, { recursive: true });
    try {
      await fs.copyFile(
        path.join(backendDir, "prompts/default.md"),
        path.join(prompts, "default.md"),
        fsConstants.COPYFILE_EXCL,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const key = randomToken();
    const child = fork(path.join(backendDir, "src/server.js"), [], {
      cwd: backendDir,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        HTTPS_ENABLED: "false",
        CIME_ENGINE: "true",
        CIME_RUN_ID: run.id,
        CIME_ENGINE_KEY: key,
        CIME_RUN_ACTIVE: ["active", "starting"].includes(run.status)
          ? "true"
          : "false",
        JWT_SECRET: engineSecret(run.id),
        CIME_DB_PATH: path.join(directory, "chat.db"),
        CIME_RUN_SCHEMA: `cime_run_${run.id.replaceAll("-", "")}`,
        CIME_CONFIG_DIR: config,
        CIME_PROMPTS_DIR: prompts,
        CIME_LOG_DIR: path.join(directory, "logs"),
      },
    });
    child.stdout.on("data", () => {});
    child.stderr.on("data", (data) =>
      console.error(`[run ${run.id}] ${String(data).trim()}`),
    );
    const worker = { child, key, run, lastUsed: Date.now(), stopping: false };
    child.once("exit", () => {
      if (this.workers.get(run.id) === worker) this.workers.delete(run.id);
      if (
        !worker.stopping &&
        !this.closing &&
        ["active", "starting"].includes(worker.run.status)
      ) {
        // Persisted deadlines are recovered by Agent 3 on restart.
        const previous = (this.restarts.get(run.id) || []).filter(
          (at) => at > Date.now() - 60000,
        );
        previous.push(Date.now());
        this.restarts.set(run.id, previous);
        if (previous.length > 3)
          this.store
            .query("UPDATE runs SET status = 'failed' WHERE id = ?", [run.id])
            .catch(() => {});
        else
          setTimeout(
            () =>
              this.ensure(worker.run).catch((error) =>
                console.error("Run recovery failed:", error.message),
              ),
            2000 * previous.length,
          ).unref();
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(fail(503, "Experiment worker did not start"));
      }, 60000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timeout);
        reject(fail(503, "Experiment worker stopped during startup"));
      });
      child.on("message", (message) => {
        if (message.type === "reserve-model-call") {
          reserveModelCall(this.store, run.id)
            .then(
              () =>
                child.connected &&
                child.send({ type: "model-budget", id: message.id, ok: true }),
            )
            .catch(
              (error) =>
                child.connected &&
                child.send({
                  type: "model-budget",
                  id: message.id,
                  ok: false,
                  error: error.message,
                }),
            );
        }
        if (message.type === "ready") {
          clearTimeout(timeout);
          worker.url = `http://127.0.0.1:${message.port}`;
          resolve();
        }
      });
    });
    this.workers.set(run.id, worker);
    const modelFile = path.join(directory, "initial-models.json");
    try {
      const models = JSON.parse(await fs.readFile(modelFile, "utf8"));
      await this.call(run, "/models", { method: "POST", body: { models } });
      await fs.rm(modelFile);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.call(run, "/admission", {
      method: "POST",
      body: {
        open: !!run.admission_open,
        mode: run.access_mode,
        limit: run.participant_limit,
      },
    });
    return worker;
  }
  async call(
    run,
    route,
    { method = "GET", body, owner = false, timeout = 60000 } = {},
  ) {
    const worker = await this.ensure(run);
    let token;
    if (owner)
      token = (await this.call(run, "/owner-session", { method: "POST" }))
        .token;
    const response = await fetch(
      `${worker.url}${owner ? "/api" : "/_platform"}${route}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "x-cime-engine-key": worker.key,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeout),
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw fail(
        response.status,
        result.error || "Experiment operation failed",
      );
    return result;
  }
  async recover() {
    const runs = await this.store.query(
      "SELECT * FROM runs WHERE status IN ('active', 'starting')",
    );
    for (const run of runs) {
      try {
        const state = await this.call(run, "/state");
        if (state.phase === "completed")
          await this.store.query(
            "UPDATE runs SET status = 'completed' WHERE id = ?",
            [run.id],
          );
        else if (run.status === "starting") {
          const status = state.phase === "idle" ? "failed" : "active";
          await this.store.query("UPDATE runs SET status = ? WHERE id = ?", [
            status,
            run.id,
          ]);
          const worker = this.workers.get(run.id);
          if (worker) worker.run.status = status;
        }
      } catch (error) {
        console.error("Unable to restore run:", run.id, error.message);
      }
    }
  }
  async remove(run) {
    this.deleting.add(run.id);
    await this.pending.get(run.id)?.catch(() => {});
    const worker = this.workers.get(run.id);
    if (worker) {
      worker.stopping = true;
      await new Promise((resolve) => {
        const timer = setTimeout(() => worker.child.kill("SIGKILL"), 5000);
        worker.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        worker.child.kill("SIGTERM");
      });
      this.workers.delete(run.id);
    }
    await this.store.dropRunSchema?.(run.id);
    await fs.rm(path.join(this.dataDir, "runs", run.id), {
      recursive: true,
      force: true,
    });
    this.restarts.delete(run.id);
  }
  async close() {
    this.closing = true;
    await Promise.all(
      [...this.workers.values()].map(
        (worker) =>
          new Promise((resolve) => {
            worker.child.once("exit", resolve);
            worker.child.kill("SIGTERM");
            const timer = setTimeout(() => {
              worker.child.kill("SIGKILL");
              resolve();
            }, 5000);
            timer.unref();
          }),
      ),
    );
  }
}
