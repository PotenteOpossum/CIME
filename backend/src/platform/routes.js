import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import fs from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { createRouter } from "../middleware/router.js";
import {
  accountAuth,
  engineSecret,
  fail,
  now,
  randomToken,
  encrypt,
  decrypt,
  rateLimit,
} from "./security.js";
import {
  parseConfig,
  runView,
  runService,
  validateDraft,
} from "./runService.js";
import { verifyProlific } from "./prolific.js";

export function platformRoutes(
  store,
  manager,
  { publicUrl, onParticipantRevoke },
) {
  const router = createRouter();
  const authenticate = accountAuth(store);
  const limited = rateLimit({ limit: 30 });
  const service = runService(store, manager);
  const serialize = (run) => runView(run, publicUrl);
  const getOwned = (req) => service.owned(req.params.id, req.account.id);
  const fresh = (run) => ["draft", "recruiting"].includes(run.status);

  router.get("/decisions", authenticate, async (req, res) => {
    const runs = await store.query(
      "SELECT r.*, COALESCE(r.title_override, d.title) AS title, COALESCE(r.description_override, d.description) AS description FROM runs r JOIN decisions d ON d.id = r.decision_id WHERE d.owner_id = ? ORDER BY r.created_at DESC",
      [req.account.id],
    );
    res.json({ runs: runs.map(serialize) });
  });
  router.post("/decisions", authenticate, limited, async (req, res) => {
    const title = String(req.body.title || "").trim();
    if (!title || title.length > 160)
      throw fail(400, "Provide a title of 1–160 characters");
    const decisionId = randomUUID();
    const id = randomUUID();
    await store.transaction(async (query) => {
      const [count] = await query(
        "SELECT COUNT(*) AS n FROM decisions WHERE owner_id = ?",
        [req.account.id],
      );
      if (Number(count.n) >= Number(process.env.MAX_DECISIONS_PER_ADMIN || 100))
        throw fail(409, "Your decision limit has been reached");
      await query(
        "INSERT INTO decisions(id, owner_id, title, description, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          decisionId,
          req.account.id,
          title,
          String(req.body.description || "").slice(0, 2000),
          now(),
        ],
      );
      await query(
        "INSERT INTO runs(id, decision_id, invite_token, created_at) VALUES (?, ?, ?, ?)",
        [id, decisionId, randomToken(), now()],
      );
    });
    await service.audit(req.account.id, id, "decision_created");
    res
      .status(201)
      .json({ run: serialize(await service.owned(id, req.account.id)) });
  });
  router.get("/runs/:id", authenticate, async (req, res) => {
    let run = await getOwned(req);
    const state = await manager.call(run, "/state");
    if (run.status === "active" && state.phase === "completed") {
      await store.query("UPDATE runs SET status = 'completed' WHERE id = ?", [
        run.id,
      ]);
      run.status = "completed";
      manager.workers.get(run.id).run.status = "completed";
    }
    res.json({ run: serialize(run), ...state });
  });
  router.patch("/runs/:id", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const run = await getOwned(req);
      if (!fresh(run))
        throw fail(
          409,
          "Started runs retain their configuration. Create a new run to change it.",
        );
      const editsMetadata =
        req.body.title !== undefined || req.body.description !== undefined;
      if (editsMetadata && (run.status !== "draft" || run.archived))
        throw fail(
          409,
          "Only unarchived drafts can change their title and invitation description",
        );
      const title = req.body.title === undefined ? run.title : req.body.title;
      const description =
        req.body.description === undefined
          ? run.description
          : req.body.description;
      if (
        typeof title !== "string" ||
        !title.trim() ||
        title.trim().length > 160
      )
        throw fail(400, "Provide a title of 1–160 characters");
      if (typeof description !== "string" || description.length > 2000)
        throw fail(
          400,
          "Invitation description must be text of at most 2,000 characters",
        );
      const state = await manager.call(run, "/state");
      const mode = req.body.access_mode ?? run.access_mode;
      if (!["open", "credentials", "prolific"].includes(mode))
        throw fail(400, "Invalid access mode");
      if (
        state.participants.length &&
        (mode !== run.access_mode ||
          [
            "prolific_study_id",
            "prolific_verification",
            "prolific_audience",
            "prolific_workspace_id",
            "prolific_organisation_id",
          ].some(
            (key) =>
              req.body.config?.[key] !== undefined &&
              req.body.config[key] !== parseConfig(run)[key],
          ) ||
          req.body.prolific_api_token !== undefined)
      )
        throw fail(409, "Access settings are locked after participants join");
      const limit = req.body.participant_limit ?? run.participant_limit;
      if (
        !Number.isInteger(limit) ||
        limit < Math.max(1, state.participants.length) ||
        limit > Number(process.env.MAX_PARTICIPANTS_PER_RUN || 500)
      )
        throw fail(400, "Invalid participant limit");
      const config = { ...parseConfig(run), ...(req.body.config || {}) };
      if (JSON.stringify(config).length > 100000)
        throw fail(400, "Configuration is too large");
      validateDraft(config);
      delete config.prolific_api_token;
      if (config.prolific_completion_url) {
        let target;
        try {
          target = new URL(config.prolific_completion_url);
        } catch {
          throw fail(400, "Invalid completion URL");
        }
        if (
          target.protocol !== "https:" ||
          target.hostname !== "app.prolific.com" ||
          target.pathname !== "/submissions/complete"
        )
          throw fail(
            400,
            "Use the Prolific completion URL supplied for your study",
          );
      }
      if (mode === "prolific") {
        if (
          !/^[a-f0-9]{24}$/i.test(config.prolific_study_id || "") ||
          !["api", "signed"].includes(config.prolific_verification)
        )
          throw fail(
            400,
            "Configure a Prolific study ID and verification method",
          );
        if (
          config.prolific_verification === "signed" &&
          (!config.prolific_audience ||
            !/^[a-f0-9]{24}$/i.test(config.prolific_workspace_id || ""))
        )
          throw fail(
            400,
            "Signed links require the exact study URL audience and workspace ID",
          );
      }
      const secret =
        req.body.prolific_api_token === undefined
          ? run.prolific_secret
          : encrypt(String(req.body.prolific_api_token));
      await store.query(
        "UPDATE runs SET access_mode = ?, participant_limit = ?, config_json = ?, prolific_secret = ?, title_override = ?, description_override = ? WHERE id = ?",
        [
          mode,
          limit,
          JSON.stringify(config),
          secret,
          title.trim(),
          description,
          run.id,
        ],
      );
      if (config.settings)
        await manager.call(run, "/settings", {
          method: "POST",
          body: config.settings,
        });
      await manager.call(run, "/admission", {
        method: "POST",
        body: { open: !!run.admission_open, mode, limit },
      });
      await service.audit(req.account.id, run.id, "draft_saved");
      res.json({ run: serialize(await getOwned(req)) });
    }),
  );
  router.post("/runs/:id/admission", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const run = await getOwned(req);
      if (!fresh(run)) throw fail(409, "Registration is locked after starting");
      const config = parseConfig(run);
      if (
        req.body.open &&
        run.access_mode === "prolific" &&
        config.prolific_verification === "api" &&
        !run.prolific_secret
      )
        throw fail(
          400,
          "Configure the Prolific API token before opening recruitment",
        );
      await manager.call(run, "/admission", {
        method: "POST",
        body: {
          open: !!req.body.open,
          mode: run.access_mode,
          limit: run.participant_limit,
        },
      });
      await store.query(
        "UPDATE runs SET admission_open = ?, status = ? WHERE id = ?",
        [req.body.open ? 1 : 0, req.body.open ? "recruiting" : "draft", run.id],
      );
      await service.audit(
        req.account.id,
        run.id,
        req.body.open ? "admission_opened" : "admission_closed",
      );
      res.json({ run: serialize(await getOwned(req)) });
    }),
  );
  router.post("/runs/:id/rotate-invitation", authenticate, async (req, res) => {
    const run = await getOwned(req);
    if (!fresh(run)) throw fail(409, "Invitations are locked after starting");
    await store.query("UPDATE runs SET invite_token = ? WHERE id = ?", [
      randomToken(),
      run.id,
    ]);
    res.json({ run: serialize(await getOwned(req)) });
  });
  router.get("/runs/:id/qr", authenticate, async (req, res) => {
    const run = await getOwned(req);
    res
      .type("svg")
      .set("Content-Disposition", 'attachment; filename="cime-invitation.svg"')
      .send(
        await QRCode.toString(serialize(run).invite_url, {
          type: "svg",
          margin: 2,
          errorCorrectionLevel: "M",
        }),
      );
  });
  router.post("/runs/:id/credentials", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const run = await getOwned(req);
      if (!fresh(run) || run.access_mode !== "credentials")
        throw fail(
          409,
          "Choose assigned credentials before creating participant accounts",
        );
      res.json(
        await manager.call(run, "/credentials", {
          method: "POST",
          body: req.body,
        }),
      );
    }),
  );
  router.post("/runs/:id/start", authenticate, async (req, res) =>
    res.json(
      await service.start(
        await getOwned(req),
        req.account.id,
        req.body.config || parseConfig(await getOwned(req)),
      ),
    ),
  );
  router.post("/runs/:id/repeat", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const old = await getOwned(req);
      const reusable = await manager.call(old, "/configuration");
      const id = randomUUID();
      await store.transaction(async (query) => {
        const [count] = await query(
          "SELECT COUNT(*) AS n FROM runs WHERE decision_id = ?",
          [old.decision_id],
        );
        if (Number(count.n) >= Number(process.env.MAX_RUNS_PER_DECISION || 50))
          throw fail(409, "The run limit for this decision has been reached");
        await query(
          "INSERT INTO runs(id, decision_id, access_mode, invite_token, participant_limit, config_json, prolific_secret, created_at, title_override, description_override) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            old.decision_id,
            old.access_mode,
            randomToken(),
            old.participant_limit,
            old.config_json,
            old.prolific_secret,
            now(),
            old.title,
            old.description,
          ],
        );
      });
      // Copy reusable configuration, never participants, sessions, ballots or logs.
      for (const folder of ["agent-config", "prompts"]) {
        const source = path.join(manager.dataDir, "runs", old.id, folder);
        try {
          await fs.cp(source, path.join(manager.dataDir, "runs", id, folder), {
            recursive: true,
          });
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await fs.writeFile(
        path.join(manager.dataDir, "runs", id, "initial-models.json"),
        JSON.stringify(reusable.models),
      );
      if (reusable.surveys) {
        const repeated = await service.owned(id, req.account.id);
        await manager.call(repeated, '/admin/surveys', { method: 'PUT', owner: true, body: reusable.surveys });
      }
      await service.audit(req.account.id, id, "run_repeated");
      res
        .status(201)
        .json({ run: serialize(await service.owned(id, req.account.id)) });
    }),
  );
  router.post("/runs/:id/stop", authenticate, async (req, res) => {
    const run = await service.stop(
      req.params.id,
      req.account.id,
      req.body.archived === true,
    );
    res.json({ run: serialize(run) });
  });
  router.delete("/runs/:id", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const run = await getOwned(req);
      if (
        !run.archived ||
        ["active", "starting", "recruiting"].includes(run.status)
      )
        throw fail(409, "Only archived, stopped runs can be deleted");
      await manager.remove(run);
      await store.transaction(async (query) => {
        await query("DELETE FROM runs WHERE id = ?", [run.id]);
        await query(
          "DELETE FROM decisions WHERE id = ? AND NOT EXISTS (SELECT 1 FROM runs WHERE decision_id = ?)",
          [run.decision_id, run.decision_id],
        );
      });
      await service.audit(req.account.id, run.id, "run_deleted");
      res.json({ deleted: true });
    }),
  );
  router.post("/runs/:id/archive", authenticate, async (req, res) =>
    service.exclusive(req.params.id, async () => {
      const run = await getOwned(req);
      if (["active", "starting", "recruiting"].includes(run.status))
        throw fail(409, "Stop the run or close recruitment before archiving");
      const archived = req.body.archived !== false;
      await store.query("UPDATE runs SET archived = ? WHERE id = ?", [
        archived ? 1 : 0,
        run.id,
      ]);
      await service.audit(
        req.account.id,
        run.id,
        archived ? "run_archived" : "run_restored",
      );
      res.json({ run: serialize(await getOwned(req)) });
    }),
  );
  router.post(
    "/runs/:id/participants/:userId/revoke",
    authenticate,
    async (req, res) => {
      const run = await getOwned(req);
      await manager.call(run, "/revoke-user", {
        method: "POST",
        body: { userId: Number(req.params.userId) },
      });
      onParticipantRevoke?.(run.id, { userId: Number(req.params.userId) });
      res.json({ ok: true });
    },
  );
  router.get("/invitations/:invite", async (req, res) => {
    const [run] = await store.query(
      "SELECT r.*, COALESCE(r.title_override, d.title) AS title, COALESCE(r.description_override, d.description) AS description FROM runs r JOIN decisions d ON d.id = r.decision_id WHERE r.invite_token = ? AND r.archived = 0",
      [req.params.invite],
    );
    if (!run) throw fail(404, "Invitation not found or revoked");
    res.json({
      id: run.id,
      title: run.title,
      description: run.description,
      access_mode: run.access_mode,
      admission_open: !!run.admission_open,
      status: run.status,
    });
  });
  router.post("/invitations/:invite/join", limited, async (req, res) => {
    const [run] = await store.query(
      "SELECT * FROM runs WHERE invite_token = ? AND archived = 0",
      [req.params.invite],
    );
    if (!run) throw fail(404, "Invitation not found or revoked");
    return service.exclusive(run.id, async () => {
      const [current] = await store.query("SELECT * FROM runs WHERE id = ?", [
        run.id,
      ]);
      // Never accept caller-supplied verification results.
      const body = {
        username: req.body.username,
        password: req.body.password,
        recoveryCode: req.body.recoveryCode,
      };
      if (current.access_mode === "prolific" && !body.recoveryCode)
        body.prolific = await verifyProlific(
          req.body,
          parseConfig(current),
          decrypt(current.prolific_secret),
        );
      res.json(await manager.call(current, "/join", { method: "POST", body }));
    });
  });

  async function participant(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    try {
      const payload = jwt.verify(token, engineSecret(req.params.id), {
        algorithms: ["HS256"],
        audience: "cime-engine",
      });
      if (payload.run !== req.params.id) throw new Error();
      const [run] = await store.query("SELECT * FROM runs WHERE id = ?", [
        req.params.id,
      ]);
      if (!run) throw new Error();
      const session = await manager.call(run, "/session", {
        method: "POST",
        body: { token },
      });
      if (session.user.is_admin) throw new Error();
      return { run, session, token, payload };
    } catch (error) {
      if (error.status === 503) throw error;
      throw fail(
        401,
        "Please rejoin using your recovery code or assigned credentials",
      );
    }
  }
  router.get("/participants/:id", async (req, res) => {
    const { run, session } = await participant(req);
    const state = await manager.call(run, "/state");
    const surveys = ['interrupted', 'failed'].includes(run.status)
      ? { pending: null }
      : await manager.call(run, '/survey-status', { method: 'POST', body: { userId: session.user.id } });
    res.json({
      user: session.user,
      phase: state.phase,
      status: run.status,
      surveys,
      completion_url:
        state.phase === "completed" && !surveys.pending
          ? parseConfig(run).prolific_completion_url || null
          : null,
    });
  });
  router.post("/participants/:id/logout", async (req, res) => {
    const { run, payload } = await participant(req);
    await manager.call(run, "/revoke", {
      method: "POST",
      body: { sid: payload.sid },
    });
    onParticipantRevoke?.(run.id, { sid: payload.sid });
    res.json({ ok: true });
  });

  // Existing participant/admin APIs are kept behind the run-scoped gateway.
  router.use("/runs/:id/engine", async (req, res, next) => {
    try {
      const route = req.url.split("?")[0];
      if (!/^\/(admin|rooms|decision|surveys)(\/|$)/.test(route))
        throw fail(404, "Endpoint not found");
      let run, token;
      if (
        route.startsWith("/admin") ||
        jwt.decode(req.headers.authorization?.replace(/^Bearer /, "") || "")
          ?.aud === "cime-platform"
      ) {
        await new Promise((resolve, reject) =>
          authenticate(req, res, (error) =>
            error ? reject(error) : resolve(),
          ),
        );
        run = await getOwned(req);
        if (route === '/admin/surveys' && req.method === 'PUT') {
          return res.json(await service.exclusive(run.id, async () => {
            const latest = await getOwned(req);
            if (!fresh(latest) || latest.archived) throw fail(409, 'Surveys are locked after the experiment starts. Repeat the run to edit them.');
            return manager.call(latest, '/admin/surveys', { method: 'PUT', owner: true, body: req.body });
          }));
        }
        if (/^\/admin\/(db|users)(\/|$)/.test(route) && req.method !== "GET")
          throw fail(
            403,
            "Use the experiment access controls to manage participants",
          );
        if (/^\/admin\/db(\/|$)/.test(route))
          throw fail(
            403,
            "Database maintenance is restricted to the server operator",
          );
        if (req.method === "POST" && route === "/admin/decision-process/start")
          return res.json(await service.start(run, req.account.id, req.body));
        if (req.method === "POST" && route === "/admin/simulation/start")
          return res.json(
            await service.start(run, req.account.id, req.body, true),
          );
        if (route === "/admin/decision-process/fast-simulation")
          throw fail(403, "Create a separate run and use the Simulation tab");
        if (/^\/admin\/simulation\/users/.test(route) && !fresh(run))
          throw fail(409, "Participants are locked after the run starts");
        const worker = await manager.ensure(run);
        if (
          !worker.ownerToken ||
          (jwt.decode(worker.ownerToken)?.exp || 0) < Date.now() / 1000 + 60
        )
          worker.ownerToken = (
            await manager.call(run, "/owner-session", { method: "POST" })
          ).token;
        token = worker.ownerToken;
      } else {
        const entry = await participant(req);
        run = entry.run;
        token = entry.token;
        const surveyRequest = /^\/surveys(?:\/(pre|post)\/responses)?\/?$/.test(route);
        if (surveyRequest && ['starting', 'interrupted', 'failed'].includes(run.status)) throw fail(409, 'Surveys are not available for this experiment right now.');
        if (!surveyRequest && run.status !== "active" && !["GET", "HEAD"].includes(req.method))
          throw fail(409, "This run is closed. You can review its history.");
        if (!surveyRequest && ["draft", "recruiting", "starting", "failed"].includes(run.status))
          throw fail(409, "Please wait for the administrator to start");
      }
      const worker = await manager.ensure(run);
      const response = await fetch(`${worker.url}/api${req.url}`, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-cime-engine-key": worker.key,
        },
        ...(req.method === "GET" || req.method === "HEAD"
          ? {}
          : { body: JSON.stringify(req.body || {}) }),
        signal: AbortSignal.timeout(180000),
      });
      if (
        response.ok &&
        req.method === "POST" &&
        [
          "/admin/decision-process/interrupt",
          "/admin/simulation/stop",
        ].includes(route)
      ) {
        await store.query(
          "UPDATE runs SET status = 'interrupted', admission_open = 0 WHERE id = ?",
          [run.id],
        );
        worker.run.status = "interrupted";
      }
      if (
        response.ok &&
        route === "/admin/decision-process" &&
        req.method === "GET" &&
        fresh(run)
      ) {
        const status = await response.json();
        const draft = parseConfig(run);
        return res.json({
          ...status,
          global_question: draft.globalQuestion || status.global_question,
          decision_context: draft.decisionContext || status.decision_context,
          general_description:
            draft.generalDescription || status.general_description,
          deliberation_questions: [
            ...(draft.deliberationQuestions || []).map((q) => ({
              ...q,
              is_general_question: false,
            })),
            {
              question_text: draft.globalQuestion,
              is_general_question: true,
              predefined_answers: draft.generalQuestionAnswers || [],
            },
          ],
        });
      }
      res.status(response.status);
      for (const name of ["content-type", "content-disposition"])
        if (response.headers.has(name))
          res.set(name, response.headers.get(name));
      res.send(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      next(error);
    }
  });
  return { router, service, participant };
}
