import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "simulation-test-secret-longer-than-32-characters";
process.env.OPENAI_API_KEY = "test-key-no-network";
process.env.CIME_API_KEY = "";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-simulation-"));
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb } = await import("../src/config/db.js");
initDb();
process.env.CIME_ENGINE_KEY = "simulation-test-engine-key";
process.env.CIME_RUN_ID = "simulation-test-run";
const { initEnginePlatform, engineRoutes } =
  await import("../src/platform/engineRoutes.js");
initEnginePlatform();
const { default: client } = await import("../src/services/llm.js");
client.chat.completions.create = async (params) => ({
  choices: [
    {
      message: {
        content:
          params.metadata?.caller === "agent3-personalTurn"
            ? JSON.stringify({
                intent: "answer",
                reply: "Thank you. Let us move to the next question.",
              })
            : params.response_format
              ? JSON.stringify({
                  valid: true,
                  relevant: true,
                  is_valid: true,
                  is_answer: true,
                  reply: "Thank you.",
                  option: "Residents",
                  preferences: {},
                })
              : "Choose eligibility rules and explain why.",
      },
    },
  ],
});
const flow = await import("../src/services/agent3Service.js");
const simulation = await import("../src/services/simulationService.js");
const { beginDecisionRun } =
  await import("../src/services/decisionWorkService.js");
const { updateDecisionSettings } =
  await import("../src/services/agentConfigService.js");
updateDecisionSettings({
  check_response_validity: false,
  clustering_strategy: "random",
  minimum_live_voting_duration_minutes: 10,
});
const app = express();
app.use(express.json());
app.set("io", {
  emit() {},
  to() {
    return { emit() {} };
  },
});
app.use("/admin", (await import("../src/routes/admin.js")).default);
app.use("/engine", engineRoutes());
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const admin = Number(
  db
    .prepare(
      "INSERT INTO users(username, password_hash, is_admin) VALUES ('owner', 'test', 1)",
    )
    .run().lastInsertRowid,
);
const token = jwt.sign({ id: admin }, process.env.JWT_SECRET);
async function request(route, body) {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/admin${route}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, data: await response.json() };
}
let users;
test("simulation participants, start, pause, resume and stop preserve setup and run identity", async () => {
  const added = await request("/simulation/users", {
    usernames: ["SimAlice", "SimBob"],
    password: "test-pass",
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  users = added.data.users;
  assert.equal((await request("/simulation/status")).data.hasStarted, false);
  const personas = Object.fromEntries(
    users.map((user) => [
      user.id,
      {
        ocean: { O: 0.5, C: 1, E: 0.2, A: 0.5, N: 0.2 },
        backstory: "Cares about affordable transport",
        stances: { eligibility: { position: "Residents", intensity: 0.8 } },
      },
    ]),
  );
  const result = await request("/simulation/start", {
    stopAt: "personal",
    model: "gpt-5.6-luna",
    seed: 4242,
    personas,
    preferences: { eligibility: ["Residents", "Workers"] },
    globalQuestion: "Approve a transport pass?",
    decisionContext: "A public transport trial",
    generalQuestionAnswers: ["Approve a trial", "Reject the proposal"],
    deliberationQuestions: [
      {
        topic: "eligibility",
        question_text: "Who should qualify?",
        predefined_answers: ["Residents", "Workers"],
      },
    ],
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  await simulation.stopSimulation(false);
  const state = db.prepare("SELECT * FROM system_state WHERE id = 1").get();
  const ids = db
    .prepare("SELECT id FROM gathering_questions ORDER BY id")
    .all();
  const finalQuestion = db
    .prepare(
      "SELECT predefined_answers_json FROM gathering_questions WHERE is_general_question = 1",
    )
    .get();
  assert.deepEqual(JSON.parse(finalQuestion.predefined_answers_json), [
    "Approve a trial",
    "Reject the proposal",
  ]);
  assert.equal((await request("/simulation/status")).data.canResume, true);
  process.env.CIME_ENGINE = "true";
  db.prepare("INSERT INTO run_simulation VALUES (1, ?, 0)").run(
    JSON.stringify({
      ...simulation.getSimulationStatus(),
      personas,
      seed: 4242,
      memories: [[String(users[0].id), [{ content: "Preserve this memory" }]]],
      skippedVotes: ["saved-vote"],
    }),
  );
  simulation.recoverSimulation(app.get("io"));
  assert.equal(simulation.getSimulationStatus().isRunning, false);
  assert.equal(simulation.getSimulationStatus().canResume, true);
  await simulation.stopSimulation(false);
  const persisted = JSON.parse(
    db.prepare("SELECT config_json FROM run_simulation WHERE id = 1").get()
      .config_json,
  );
  assert.deepEqual(persisted.memories, [
    [String(users[0].id), [{ content: "Preserve this memory" }]],
  ]);
  assert.deepEqual(persisted.skippedVotes, ["saved-vote"]);
  process.env.CIME_ENGINE = "false";

  assert.equal(
    (await request("/simulation/resume", { stopAt: "convergence", seed: 999 }))
      .status,
    409,
    "resume cannot silently change the seeded experiment",
  );
  const resumed = await request("/simulation/resume", {
    stopAt: "convergence",
    seed: 4242,
    personas,
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  await simulation.stopSimulation(false);
  assert.equal(
    db.prepare("SELECT decision_run_id FROM system_state WHERE id = 1").get()
      .decision_run_id,
    state.decision_run_id,
  );
  assert.deepEqual(
    db.prepare("SELECT id FROM gathering_questions ORDER BY id").all(),
    ids,
    "resume must not recreate questions or erase history",
  );
  const historyBefore = db
    .prepare("SELECT COUNT(*) AS n FROM messages")
    .get().n;
  const handedOff = await request("/simulation/handoff", {});
  assert.equal(handedOff.status, 200, JSON.stringify(handedOff.data));
  assert.equal(handedOff.data.status.isRunning, false);
  assert.equal(handedOff.data.status.canResume, true);
  assert.equal(handedOff.data.participants.length, 2);
  const codes = handedOff.data.participants;
  assert.notEqual(codes[0].recoveryCode, codes[1].recoveryCode);
  for (const participant of codes) {
    assert.notEqual(
      db
        .prepare("SELECT recovery_hash FROM run_participants WHERE user_id = ?")
        .get(participant.id).recovery_hash,
      participant.recoveryCode,
    );
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/engine/join`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-cime-engine-key": process.env.CIME_ENGINE_KEY,
        },
        body: JSON.stringify({ recoveryCode: participant.recoveryCode }),
      },
    );
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.user.id, participant.id);
    assert.equal(session.runId, process.env.CIME_RUN_ID);
    assert.equal(jwt.decode(session.token).aud, "cime-engine");
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM room_members WHERE user_id = ?")
        .get(participant.id).n > 0,
      true,
    );
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
    historyBefore,
  );
  const replaced = await request("/simulation/handoff", {});
  assert.equal(replaced.status, 200);
  const oldCode = await fetch(
    `http://127.0.0.1:${server.address().port}/engine/join`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cime-engine-key": process.env.CIME_ENGINE_KEY,
      },
      body: JSON.stringify({ recoveryCode: codes[0].recoveryCode }),
    },
  );
  assert.equal(oldCode.status, 401);
  const participantToken = jwt.sign(
    { id: users[0].id },
    process.env.JWT_SECRET,
  );
  const forbidden = await fetch(
    `http://127.0.0.1:${server.address().port}/admin/simulation/handoff`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${participantToken}` },
    },
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await request("/simulation/stop", {})).status, 200);
  const stopped = (await request("/simulation/status")).data;
  assert.equal(stopped.isRunning, false);
  assert.equal(stopped.canResume, false);
  assert.equal(stopped.hasStarted, true);
  assert.equal(stopped.phase, "idle");
  assert.equal((await request("/simulation/handoff", {})).status, 409);
  assert.equal((await request("/simulation/resume", {})).status, 409);
});

test("simulation ballots match human swipe and live write-in rules", async () => {
  beginDecisionRun({
    mode: "simulation",
    participantIds: users.map((user) => user.id),
    seed: 4242,
  });
  db.prepare(
    "UPDATE system_state SET current_phase = 'discussing' WHERE id = 1",
  ).run();
  const room = Number(
    db
      .prepare(
        "INSERT INTO rooms(name, room_type, is_active, topic_memory_json) VALUES ('sim-vote', 'group', 1, '[]')",
      )
      .run().lastInsertRowid,
  );
  for (const user of users)
    db.prepare("INSERT INTO room_members(user_id, room_id) VALUES (?, ?)").run(
      user.id,
      room,
    );
  const future = new Date(Date.now() + 600000).toISOString();
  const poll = Number(
    db
      .prepare(
        "INSERT INTO polls(room_id, question, poll_type, created_at, expires_at, minimum_live_until) VALUES (?, 'Eligibility?', 'continuous', ?, ?, ?)",
      )
      .run(room, new Date().toISOString(), future, future).lastInsertRowid,
  );
  const optionIds = ["Residents", "Workers", "Other"].map((text) =>
    Number(
      db
        .prepare("INSERT INTO poll_options(poll_id, option_text) VALUES (?, ?)")
        .run(poll, text).lastInsertRowid,
    ),
  );
  const options = db
    .prepare("SELECT * FROM poll_options WHERE poll_id = ?")
    .all(poll);
  assert.deepEqual(
    simulation.normalizeSimulationVoteData("continuous", options, { optionIds })
      .optionIds,
    [optionIds[0]],
    "live voting must remain single-choice",
  );
  const swipe = simulation.normalizeSimulationVoteData("swipe", options, {
    optionId: optionIds[2],
    customOptionText: "Low-income residents and workers",
  });
  assert.equal(swipe.swipeVotes.length, 2, "Other is not a swipe card");
  assert.ok(
    swipe.swipeVotes.every((vote) => vote.direction === "left"),
    "a write-in must not invent approval of the first predefined option",
  );
  await simulation.simulateAgentVote(null, poll, users[0].id, {
    optionId: optionIds[2],
    customOptionText: "Low-income residents and workers",
  });
  const recorded = db
    .prepare(
      "SELECT po.option_text FROM poll_votes pv JOIN poll_options po ON po.id = pv.option_id WHERE pv.poll_id = ? AND pv.user_id = ?",
    )
    .get(poll, users[0].id);
  assert.equal(recorded.option_text, "Low-income residents and workers");
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id = ? AND user_id = ?",
      )
      .get(poll, users[0].id).c,
    1,
  );
  const swipePoll = Number(
    db
      .prepare(
        "INSERT INTO polls(room_id, question, poll_type, created_at, expires_at) VALUES (?, 'Eligibility swipe?', 'swipe', ?, ?)",
      )
      .run(room, new Date().toISOString(), future).lastInsertRowid,
  );
  const swipeOption = Number(
    db
      .prepare(
        "INSERT INTO poll_options(poll_id, option_text) VALUES (?, 'Residents')",
      )
      .run(swipePoll).lastInsertRowid,
  );
  await simulation.simulateAgentVote(null, swipePoll, users[0].id, {
    swipeVotes: [{ optionId: swipeOption, direction: "left" }],
    customOptionText: "Low-income residents and workers",
  });
  assert.equal(
    db
      .prepare(
        "SELECT custom_option_text FROM poll_votes WHERE poll_id = ? AND user_id = ?",
      )
      .get(swipePoll, users[0].id).custom_option_text,
    "Low-income residents and workers",
  );
});

test.after(async () => {
  await simulation.stopSimulation(false);
  flow.cancelDecisionWork();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
});
