import { randomUUID } from "node:crypto";
import { fail, now, randomToken } from "./security.js";

export function parseConfig(run) {
  return JSON.parse(run.config_json || "{}");
}
export function validateDraft(config) {
  for (const key of [
    "globalQuestion",
    "decisionContext",
    "generalDescription",
  ]) {
    if (
      config[key] !== undefined &&
      (typeof config[key] !== "string" || config[key].length > 20000)
    )
      throw fail(
        400,
        "Question, context and description must be text of at most 20,000 characters",
      );
  }
  if (config.deliberationQuestions !== undefined) {
    if (
      !Array.isArray(config.deliberationQuestions) ||
      config.deliberationQuestions.length > 10
    )
      throw fail(400, "Use at most 10 discussion questions");
    for (const question of config.deliberationQuestions) {
      if (
        !question ||
        typeof question !== "object" ||
        [question.topic, question.question_text ?? question.question].some(
          (value) =>
            value !== undefined &&
            (typeof value !== "string" || value.length > 10000),
        )
      )
        throw fail(400, "Topics and discussion questions must be text");
      if (
        question.predefined_answers !== undefined &&
        (!Array.isArray(question.predefined_answers) ||
          question.predefined_answers.some(
            (value) => typeof value !== "string" || value.length > 2000,
          ) ||
          question.predefined_answers.filter((value) => value.trim()).length >
            6)
      )
        throw fail(
          400,
          "Use at most six initial voting options per discussion question",
        );
    }
  }
  if (
    config.generalQuestionAnswers !== undefined &&
    (!Array.isArray(config.generalQuestionAnswers) ||
      config.generalQuestionAnswers.some(
        (value) => typeof value !== "string" || value.length > 2000,
      ) ||
      config.generalQuestionAnswers.filter((value) => value.trim()).length > 6)
  )
    throw fail(400, "Use at most six final voting options");
}
export function runView(run, publicUrl) {
  return {
    id: run.id,
    decision_id: run.decision_id,
    title: run.title,
    description: run.description,
    status: run.status,
    access_mode: run.access_mode,
    admission_open: !!run.admission_open,
    participant_limit: run.participant_limit,
    created_at: run.created_at,
    started_at: run.started_at,
    archived: !!run.archived,
    config: parseConfig(run),
    prolific_api_configured: !!run.prolific_secret,
    invite_url: `${publicUrl}/join/${run.invite_token}`,
  };
}
export function runService(store, manager) {
  const locks = new Map();
  const exclusive = (id, task) => {
    const result = (locks.get(id) || Promise.resolve()).then(task);
    locks.set(id, result);
    result
      .finally(() => {
        if (locks.get(id) === result) locks.delete(id);
      })
      .catch(() => {});
    return result;
  };
  async function owned(id, accountId) {
    const [run] = await store.query(
      "SELECT r.*, COALESCE(r.title_override, d.title) AS title, COALESCE(r.description_override, d.description) AS description, d.owner_id FROM runs r JOIN decisions d ON d.id = r.decision_id WHERE r.id = ? AND d.owner_id = ?",
      [id, accountId],
    );
    if (!run) throw fail(404, "Experiment not found");
    return run;
  }
  async function audit(accountId, runId, event) {
    await store.query(
      "INSERT INTO audit_events(id, account_id, run_id, event, created_at) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), accountId, runId, event, now()],
    );
  }
  async function start(run, accountId, body, simulation = false) {
    return exclusive(run.id, async () => {
      run = await owned(run.id, accountId);
      if (run.archived) throw fail(409, "Restore this run before starting it");
      if (!["draft", "recruiting"].includes(run.status))
        throw fail(
          409,
          "This run has already started. Create a new run to repeat it.",
        );
      const config = { ...parseConfig(run), ...body };
      if (
        !String(config.globalQuestion || "").trim() ||
        !String(config.decisionContext || "").trim() ||
        !Array.isArray(config.deliberationQuestions) ||
        !config.deliberationQuestions.some((q) =>
          String(q.question_text || q.question || "").trim(),
        )
      )
        throw fail(
          400,
          "Provide the main question, context and at least one discussion question",
        );
      validateDraft(config);
      const state = await manager.call(run, "/state");
      if (simulation && state.participants.length)
        throw fail(
          409,
          "Use a fresh run for simulations so human participants are kept separate",
        );
      if (!simulation && !state.participants.length)
        throw fail(400, "At least one participant must join before starting");
      config.configuration_snapshot = await manager.call(run, "/configuration");
      config.settings = config.configuration_snapshot.settings;
      await exclusive("__start_capacity", async () => {
        const ownedActive = await store.query(
          "SELECT COUNT(*) AS n FROM runs r JOIN decisions d ON d.id = r.decision_id WHERE d.owner_id = ? AND r.status IN ('active', 'starting')",
          [accountId],
        );
        if (
          Number(ownedActive[0].n) >=
          Number(process.env.MAX_ACTIVE_RUNS_PER_ADMIN || 4)
        )
          throw fail(409, "Your active experiment limit has been reached");
        const active = await store.query(
          "SELECT COUNT(*) AS n FROM runs WHERE status IN ('starting', 'active')",
        );
        if (Number(active[0].n) >= manager.limit)
          throw fail(503, "The server has reached its active experiment limit");
        await manager.call(run, "/admission", {
          method: "POST",
          body: {
            open: false,
            mode: run.access_mode,
            limit: run.participant_limit,
          },
        });
        if (!simulation) {
          const { pending } = await manager.call(run, '/surveys/preflight');
          if (pending.length) {
            await manager.call(run, '/admission', { method: 'POST', body: { open: !!run.admission_open, mode: run.access_mode, limit: run.participant_limit } });
            throw fail(409, `${pending.length} participant(s) still need to submit the pre-experiment survey. Check the Surveys tab.`);
          }
        }
        await store.query(
          "UPDATE runs SET status = 'starting', admission_open = 0, config_json = ?, started_at = ? WHERE id = ?",
          [JSON.stringify(config), now(), run.id],
        );
      });
      const worker = manager.workers.get(run.id);
      worker.run.status = "starting";
      try {
        await manager.call(run, "/snapshot", { method: "POST", body: config });
        if (!simulation)
          await manager.call(run, "/discard-simulation-participants", {
            method: "POST",
          });
        const result = await manager.call(
          run,
          simulation
            ? "/admin/simulation/start"
            : "/admin/decision-process/start",
          { method: "POST", body: config, owner: true, timeout: 180000 },
        );
        await store.query("UPDATE runs SET status = 'active' WHERE id = ?", [
          run.id,
        ]);
        worker.run.status = "active";
        await audit(
          accountId,
          run.id,
          simulation ? "simulation_started" : "run_started",
        );
        return result;
      } catch (error) {
        const actual = await manager.call(run, "/state").catch(() => null);
        // Never reopen admission if setup has already created live engine state.
        const status = actual && actual.phase !== "idle" ? "active" : "failed";
        await store.query("UPDATE runs SET status = ? WHERE id = ?", [
          status,
          run.id,
        ]);
        worker.run.status = status;
        throw error;
      }
    });
  }
  async function stop(id, accountId, archive = false) {
    return exclusive(id, async () => {
      const run = await owned(id, accountId);
      if (["active", "starting", "recruiting", "draft"].includes(run.status)) {
        await manager.call(run, "/admission", {
          method: "POST",
          body: {
            open: false,
            mode: run.access_mode,
            limit: run.participant_limit,
          },
        });
        await manager.call(run, "/admin/decision-process/interrupt", {
          method: "POST",
          body: {},
          owner: true,
        });
        await store.query(
          "UPDATE runs SET status = 'interrupted', admission_open = 0 WHERE id = ?",
          [id],
        );
        const worker = manager.workers.get(id);
        if (worker) worker.run.status = "interrupted";
        await audit(accountId, id, "run_stopped");
      }
      if (archive) {
        await store.query("UPDATE runs SET archived = 1 WHERE id = ?", [id]);
        await audit(accountId, id, "run_archived");
      }
      return owned(id, accountId);
    });
  }
  return { owned, audit, start, stop, exclusive, randomToken };
}
