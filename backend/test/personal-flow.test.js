import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-personal-"));
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "agent-config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb, ensurePersonalRoomsForAllUsers } =
  await import("../src/config/db.js");
initDb();
const { updateDecisionSettings, getDecisionSettings } =
  await import("../src/services/agentConfigService.js");
const { beginDecisionRun } =
  await import("../src/services/decisionWorkService.js");
const flow = await import("../src/services/agent3Service.js");
const { default: express } = await import("express");
const { default: jwt } = await import("jsonwebtoken");
const app = express();
app.use(express.json());
app.use("/api/rooms", (await import("../src/routes/rooms.js")).default);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
async function visiblePolls(user) {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/api/rooms/${user.roomId}/polls`,
    {
      headers: {
        Authorization: `Bearer ${jwt.sign({ id: user.id }, process.env.JWT_SECRET)}`,
      },
    },
  );
  assert.equal(response.status, 200);
  return (await response.json()).polls;
}

const past = "2000-01-01T00:00:00.000Z";
const open = (id) =>
  db
    .prepare(
      "SELECT * FROM polls WHERE room_id = ? AND is_closed = 0 ORDER BY id",
    )
    .all(id);
const onlyPoll = (id) => {
  const polls = open(id);
  assert.equal(polls.length, 1);
  return polls[0];
};
async function vote(user, poll, label) {
  const option = db
    .prepare(
      "SELECT id FROM poll_options WHERE poll_id = ? AND option_text = ?",
    )
    .get(poll.id, label);
  assert.ok(option, label);
  db.prepare(
    "INSERT INTO poll_votes(poll_id, option_id, user_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(poll.id, option.id, user.id, new Date().toISOString());
  await flow.resolvePoll(poll.id, poll.room_id);
}

test("personal interview, inactivity ballots, routing and recovery remain sequential", async (t) => {
  t.after(async () => {
    flow.cancelDecisionWork();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const defaults = getDecisionSettings();
  assert.equal(defaults.clustering_strategy, "topic_preference");
  assert.equal(defaults.clustering_min_users_per_room, 2);
  assert.equal(defaults.clustering_min_rooms, 2);
  updateDecisionSettings({
    clustering_strategy: "random",
    check_response_validity: false,
  });
  const addQuestion = db.prepare(
    "INSERT INTO gathering_questions(topic, question_text, question_order, predefined_answers_json, is_general_question, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  addQuestion.run(
    "exceptions",
    "Which roads are exempt?",
    1,
    '["Main roads","No exceptions"]',
    0,
    past,
  );
  addQuestion.run(
    "infrastructure",
    "How do we fund changes?",
    2,
    '["Existing budget","Municipal tax"]',
    0,
    past,
  );
  addQuestion.run(
    "general-question",
    "Accept the proposal?",
    3,
    '["Accept","Reject"]',
    1,
    past,
  );
  db.prepare(
    "UPDATE system_state SET global_question = 'Accept the proposal?', decision_context = 'Road safety', current_phase = 'gathering' WHERE id = 1",
  ).run();
  beginDecisionRun();
  for (const name of ["Chat", "Fallback", "Routing", "Recovery", "Blocker"])
    db.prepare(
      "INSERT INTO users(username,password_hash,is_admin) VALUES (?, 'test', 0)",
    ).run(name);
  ensurePersonalRoomsForAllUsers();
  const firstQuestion = db
    .prepare("SELECT id FROM gathering_questions WHERE topic = 'exceptions'")
    .get();
  db.prepare(
    "UPDATE rooms SET current_gathering_question_id = ? WHERE room_type = 'personal'",
  ).run(firstQuestion.id);
  const participant = (name) => ({
    ...db.prepare("SELECT id FROM users WHERE username = ?").get(name),
    roomId: db
      .prepare("SELECT id FROM rooms WHERE name = ?")
      .get(`${name}-personal`).id,
  });
  const chat = participant("Chat");
  const send = async (text) => {
    db.prepare(
      "INSERT INTO messages(room_id,sender_id,text,timestamp) VALUES (?, ?, ?, ?)",
    ).run(chat.roomId, chat.id, text, new Date().toISOString());
    await flow.checkPersonalRoom(chat.roomId, chat.id);
  };
  await send("Main roads");
  assert.equal(flow.getAnsweredQuestionIds(chat.id).size, 1);
  assert.equal(open(chat.roomId).length, 0);
  await flow.checkPersonalRoom(chat.roomId, chat.id);
  assert.equal(flow.getAnsweredQuestionIds(chat.id).size, 1);
  await send("Existing budget");
  await flow.checkPersonalRoom(chat.roomId, chat.id);
  assert.ok(
    onlyPoll(chat.roomId).question.startsWith("How open are you to debate"),
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT option_text FROM poll_options WHERE poll_id = ? ORDER BY id",
      )
      .all(onlyPoll(chat.roomId).id)
      .map((row) => row.option_text),
    [
      "No",
      "Probably no, but I can try",
      "I am hesitant",
      "Maybe",
      "Yes, I am open",
      "Yes, very open",
    ],
  );
  // A room deadline cannot close an existing ballot or evict its participant.
  const opennessId = onlyPoll(chat.roomId).id;
  db.prepare("UPDATE rooms SET timer_expires_at = ? WHERE id = ?").run(
    past,
    chat.roomId,
  );
  await flow.handleExpiredPersonalRoom({ id: chat.roomId });
  assert.equal(onlyPoll(chat.roomId).id, opennessId);
  assert.ok(
    db
      .prepare("SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?")
      .get(chat.roomId, chat.id),
  );

  const fallback = participant("Fallback");
  db.prepare("UPDATE rooms SET timer_expires_at = ? WHERE id = ?").run(
    past,
    fallback.roomId,
  );
  await flow.handleExpiredPersonalRoom({ id: fallback.roomId });
  assert.equal(onlyPoll(fallback.roomId).suggestion, "exceptions");
  const firstId = onlyPoll(fallback.roomId).id;
  await flow.handleExpiredPersonalRoom({ id: fallback.roomId });
  await flow.checkPersonalRoom(fallback.roomId, fallback.id);
  assert.equal(onlyPoll(fallback.roomId).id, firstId);
  assert.equal(
    flow.createMandatoryPoll(
      fallback.roomId,
      "Out-of-order poll",
      ["A", "B"],
      "duplicate",
    ),
    firstId,
  );
  await vote(fallback, onlyPoll(fallback.roomId), "Main roads");
  assert.equal(flow.getAnsweredQuestionIds(fallback.id).size, 1);
  assert.equal(onlyPoll(fallback.roomId).suggestion, "infrastructure");
  await vote(fallback, onlyPoll(fallback.roomId), "Existing budget");
  assert.equal(flow.getAnsweredQuestionIds(fallback.id).size, 2);
  assert.ok(
    onlyPoll(fallback.roomId).question.startsWith("How open are you to debate"),
  );
  assert.ok(
    db
      .prepare("SELECT extracted_preferences FROM users WHERE id = ?")
      .get(fallback.id)
      .extracted_preferences.includes("Main roads"),
  );
  await vote(fallback, onlyPoll(fallback.roomId), "Yes, very open");
  assert.equal(
    db
      .prepare("SELECT collection_complete FROM rooms WHERE id = ?")
      .get(fallback.roomId).collection_complete,
    1,
  );
  assert.equal(open(fallback.roomId).length, 0);

  updateDecisionSettings({ clustering_strategy: "topic_preference" });
  const routing = participant("Routing");
  db.prepare("UPDATE rooms SET timer_expires_at = ? WHERE id = ?").run(
    past,
    routing.roomId,
  );
  await flow.handleExpiredPersonalRoom({ id: routing.roomId });
  await vote(routing, onlyPoll(routing.roomId), "Main roads");
  await vote(routing, onlyPoll(routing.roomId), "Existing budget");
  assert.ok(
    onlyPoll(routing.roomId).question.includes("relevant or interesting"),
  );
  await vote(routing, onlyPoll(routing.roomId), "All topics");
  assert.ok(
    onlyPoll(routing.roomId).question.startsWith("How open are you to debate"),
  );
  await vote(routing, onlyPoll(routing.roomId), "Yes, very open");
  assert.equal(
    db
      .prepare("SELECT collection_complete FROM rooms WHERE id = ?")
      .get(routing.roomId).collection_complete,
    1,
  );

  updateDecisionSettings({ clustering_strategy: "random" });
  const recovery = participant("Recovery");
  const legacyInsert = db.prepare(
    "INSERT INTO polls(room_id,question,suggestion,mandatory,created_at,expires_at) VALUES (?, ?, ?, 1, ?, ?)",
  );
  const expiry = new Date(Date.now() + 120000).toISOString();
  const legacy = [];
  for (const question of db
    .prepare("SELECT * FROM gathering_questions ORDER BY question_order")
    .all()) {
    const id = Number(
      legacyInsert.run(
        recovery.roomId,
        question.question_text,
        question.topic,
        new Date().toISOString(),
        expiry,
      ).lastInsertRowid,
    );
    for (const label of JSON.parse(question.predefined_answers_json))
      db.prepare(
        "INSERT INTO poll_options(poll_id,option_text) VALUES (?, ?)",
      ).run(id, label);
    legacy.push(id);
  }
  // A prematurely opened openness ballot must not count as completed when
  // recovery queues it behind the unanswered interview topics.
  const prematureOpenness = Number(
    legacyInsert.run(
      recovery.roomId,
      'How open are you to debate and changing your mind on the following topic?\n\n"Accept the proposal?"',
      "general-question",
      new Date().toISOString(),
      expiry,
    ).lastInsertRowid,
  );
  const futureOption = db
    .prepare(
      "SELECT id FROM poll_options WHERE poll_id = ? AND option_text = 'Municipal tax'",
    )
    .get(legacy[1]);
  db.prepare(
    "INSERT INTO poll_votes(poll_id,option_id,user_id,created_at) VALUES (?, ?, ?, ?)",
  ).run(legacy[1], futureOption.id, recovery.id, new Date().toISOString());
  flow.repairPersonalPollSequence(recovery.roomId);
  assert.equal(onlyPoll(recovery.roomId).id, legacy[0]);
  assert.deepEqual(
    (await visiblePolls(recovery)).map((poll) => poll.id),
    [legacy[0]],
  );

  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM poll_votes WHERE poll_id = ?")
      .get(legacy[1]).n,
    1,
  );
  await vote(recovery, onlyPoll(recovery.roomId), "Main roads");
  assert.equal(onlyPoll(recovery.roomId).id, legacy[1]);
  assert.ok(
    !(await visiblePolls(recovery)).some((poll) => poll.id === legacy[2]),
  );

  await flow.resolvePoll(legacy[1], recovery.roomId);
  assert.ok(
    onlyPoll(recovery.roomId).question.startsWith("How open are you to debate"),
  );
  assert.notEqual(onlyPoll(recovery.roomId).id, prematureOpenness);
  assert.equal(
    db
      .prepare("SELECT collection_complete FROM rooms WHERE id = ?")
      .get(recovery.roomId).collection_complete,
    0,
  );
  assert.equal(
    db.prepare("SELECT is_closed FROM polls WHERE id = ?").get(legacy[2])
      .is_closed,
    1,
  );
  assert.equal(
    db
      .prepare(
        "SELECT answer_text FROM gathering_answers WHERE user_id = ? AND question_id = (SELECT id FROM gathering_questions WHERE topic = 'infrastructure')",
      )
      .get(recovery.id).answer_text,
    "Municipal tax",
  );
});
