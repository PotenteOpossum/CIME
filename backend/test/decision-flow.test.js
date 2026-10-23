import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "test-secret-which-is-longer-than-32-characters";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-flow-"));
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "agent-config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb } = await import("../src/config/db.js");
initDb();
const { updateDecisionSettings } =
  await import("../src/services/agentConfigService.js");
const { beginDecisionRun } =
  await import("../src/services/decisionWorkService.js");
const { createClusteredDiscussionRooms, createConvergenceDiscussionRoom } =
  await import("../src/services/agent2Service.js");
const flow = await import("../src/services/agent3Service.js");
const past = "2000-01-01T00:00:00.000Z";
const memory = (id) =>
  JSON.parse(
    db.prepare("SELECT topic_memory_json FROM rooms WHERE id = ?").get(id)
      .topic_memory_json,
  );
const openPoll = (id) =>
  db.prepare("SELECT * FROM polls WHERE room_id = ? AND is_closed = 0").get(id);
const expire = async (poll) => {
  db.prepare("UPDATE polls SET expires_at = ? WHERE id = ?").run(past, poll.id);
  await flow.resolvePoll(poll.id, poll.room_id);
};

test("all topics finish their voting chain despite the group deadline, then converge", async (t) => {
  t.after(async () => {
    flow.cancelDecisionWork();
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  updateDecisionSettings({
    clustering_strategy: "random",
    clustering_min_rooms: 1,
    clustering_min_users_per_room: 2,
  });
  const insertQ = db.prepare(
    "INSERT INTO gathering_questions(topic, question_text, question_order, predefined_answers_json, is_general_question, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertQ.run(
    "exceptions",
    "Which roads are exempt?",
    1,
    '["Main roads","No exceptions","Bus routes"]',
    0,
    past,
  );
  insertQ.run(
    "infrastructure",
    "How do we fund changes?",
    2,
    '["Existing budget","Municipal tax"]',
    0,
    past,
  );
  insertQ.run(
    "general-question",
    "Accept the proposal?",
    3,
    '["Accept","Reject"]',
    1,
    past,
  );
  db.prepare(
    "UPDATE system_state SET global_question = 'Accept the proposal?', decision_context = 'Road safety', current_phase = 'discussing', discussion_round = 1 WHERE id = 1",
  ).run();
  beginDecisionRun();
  for (const name of ["Alice", "Bob"])
    db.prepare(
      "INSERT INTO users(username, password_hash, is_admin) VALUES (?, 'test', 0)",
    ).run(name);
  const users = db
    .prepare("SELECT id, username FROM users WHERE is_admin = 0")
    .all();
  const [group] = await createClusteredDiscussionRooms({
    globalQuestion: "Accept the proposal?",
    preferences: users,
  });
  assert.deepEqual(
    memory(group.roomId).map((entry) => entry.key),
    ["exceptions", "infrastructure", "general-question"],
  );
  flow.createTopicPoll(
    group.roomId,
    flow.getUnresolvedRoomMemoryTopics(group.roomId)[0],
  );
  assert.equal(openPoll(group.roomId).suggestion, "exceptions");
  await expire(openPoll(group.roomId)); // No swipe submissions -> continuous, still the first topic.
  assert.equal(openPoll(group.roomId).poll_type, "continuous");
  const liveId = openPoll(group.roomId).id;
  db.prepare("UPDATE rooms SET timer_expires_at = ? WHERE id = ?").run(
    past,
    group.roomId,
  );
  assert.equal(
    (await flow.handleExpiredGroupRoom({ id: group.roomId })).handled,
    true,
  );
  assert.equal(openPoll(group.roomId).id, liveId);
  assert.ok(
    memory(group.roomId).every((entry) => entry.status !== "timed_out"),
  );
  assert.equal(
    (await flow.handleExpiredGroupRoom({ id: group.roomId })).handled,
    false,
  );
  assert.equal(
    flow.createMandatoryPoll(
      group.roomId,
      "Accept the proposal?",
      ["Accept", "Reject"],
      "Premature final",
      "general-question",
    ),
    liveId,
  );
  await expire(openPoll(group.roomId));
  // Since the room deadline expired first, the live-vote failure must hand off
  // to ranking immediately instead of retaining the normal one-minute review.
  const rankingId = openPoll(group.roomId)?.id;
  assert.ok(rankingId);
  assert.equal(openPoll(group.roomId).poll_type, "ranking");
  assert.ok(
    new Date(db.prepare("SELECT review_until FROM polls WHERE id = ?").get(liveId).review_until).getTime() <= Date.now(),
  );
  const options = db
    .prepare("SELECT option_text FROM poll_options WHERE poll_id = ?")
    .all(rankingId)
    .map((row) => row.option_text);
  assert.ok(options.length >= 2);
  assert.ok(!options.includes("Other"));
  // Simulate losing the ranking handoff across a restart. Recovery must stay
  // in ranking instead of starting a new swipe/live cycle.
  db.prepare("UPDATE polls SET is_closed = 1, closed_at = ? WHERE id = ?").run(
    past,
    rankingId,
  );
  flow.recoverStuckTopicPolls();
  assert.equal(openPoll(group.roomId).poll_type, "ranking");
  await expire(openPoll(group.roomId));
  assert.equal(memory(group.roomId)[0].status, "resolved");
  assert.equal(
    flow.getUnresolvedRoomMemoryTopics(group.roomId)[0].key,
    "infrastructure",
  );
  assert.equal(
    flow.createMandatoryPoll(
      group.roomId,
      "Accept the proposal?",
      ["Accept", "Reject"],
      "Premature final",
      "general-question",
    ),
    null,
  );
  flow.createTopicPoll(
    group.roomId,
    flow.getUnresolvedRoomMemoryTopics(group.roomId)[0],
  );
  assert.equal(openPoll(group.roomId).suggestion, "infrastructure");
  // Unanimous swipe approval exercises the successful branch and the next-topic handoff.
  const swipe = openPoll(group.roomId);
  const swipeOptions = db
    .prepare("SELECT id FROM poll_options WHERE poll_id = ?")
    .all(swipe.id);
  for (const user of users)
    for (const option of swipeOptions)
      db.prepare(
        "INSERT INTO swipe_votes(poll_id, option_id, user_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(
        swipe.id,
        option.id,
        user.id,
        option.id === swipeOptions[0].id ? "right" : "left",
        past,
      );
  updateDecisionSettings({ time_before_final_vote_seconds: 300 });
  await expire(swipe);
  assert.equal(memory(group.roomId)[1].status, "resolved");
  assert.equal(
    flow.getUnresolvedRoomMemoryTopics(group.roomId)[0].key,
    "general-question",
  );
  flow.createTopicPoll(
    group.roomId,
    flow.getUnresolvedRoomMemoryTopics(group.roomId)[0],
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM polls WHERE room_id = ? AND is_closed = 0",
      )
      .get(group.roomId).n,
    0,
  );
  flow.recoverStuckTopicPolls();
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM polls WHERE room_id = ? AND is_closed = 0",
      )
      .get(group.roomId).n,
    0,
  );
  db.prepare("UPDATE rooms SET final_vote_not_before = ? WHERE id = ?").run(
    past,
    group.roomId,
  );
  flow.recoverStuckTopicPolls();
  updateDecisionSettings({ time_before_final_vote_seconds: 0 });
  const final = openPoll(group.roomId);
  assert.equal(final.poll_type, "plurality");
  assert.equal(final.suggestion, "general-question");
  await expire(final);
  await flow.reconcileClosedDiscussionRooms();
  const convergence = db
    .prepare("SELECT * FROM rooms WHERE room_type = 'convergence'")
    .get();
  assert.ok(convergence);
  assert.equal(convergence.decision_round, 2);
  const summary = flow.getConvergenceSummaryData(1);
  assert.deepEqual(
    summary.topics.map((entry) => entry.key),
    ["exceptions", "infrastructure"],
  );
  assert.ok(summary.topics.every((entry) => entry.status === "agreed"));
  assert.equal(flow.isConvergenceReviewLocked(convergence.id), true);
  flow.finalizeConvergenceReviewWindow(convergence.id);
  flow.createTopicPoll(
    convergence.id,
    flow.getUnresolvedRoomMemoryTopics(convergence.id)[0],
  );
  assert.equal(openPoll(convergence.id).suggestion, "general-question");

  // Historical timed-out topics must remain visible; one resolved group is
  // insufficient to pre-resolve a topic if another assigned group timed out.
  const historical = memory(group.roomId).map((entry) => ({
    ...entry,
    status: entry.is_general_question ? "resolved" : "timed_out",
    decision: entry.is_general_question ? "Accept" : null,
    summary: null,
  }));
  db.prepare(
    "INSERT INTO rooms(name, room_type, decision_round, topic_memory_json) VALUES ('Timed-out group', 'group', 1, ?)",
  ).run(JSON.stringify(historical));
  // Repair cards saved by the old code, including when no room resolved a topic.
  const saved = memory(group.roomId);
  db.prepare("UPDATE rooms SET topic_memory_json = ? WHERE id = ?").run(
    JSON.stringify(historical),
    group.roomId,
  );
  assert.deepEqual(
    flow.getConvergenceSummaryData(1).topics.map((entry) => entry.key),
    ["exceptions", "infrastructure"],
  );
  flow.refreshConvergenceSummaries();
  const card = db
    .prepare(
      "SELECT text FROM messages WHERE room_id = ? AND text LIKE '[ConvergenceSummary=%'",
    )
    .get(convergence.id);
  const repaired = JSON.parse(
    card.text.slice("[ConvergenceSummary=".length, -1),
  );
  assert.ok(repaired.topics.every((entry) => entry.status === "open"));
  db.prepare("UPDATE rooms SET topic_memory_json = ? WHERE id = ?").run(
    JSON.stringify(saved),
    group.roomId,
  );
  const incomplete = flow.getConvergenceSummaryData(1);
  assert.ok(incomplete.topics.every((entry) => entry.status === "open"));
  const reopened = await createConvergenceDiscussionRoom({
    globalQuestion: "Accept the proposal?",
    decisions: [],
  });
  assert.ok(
    memory(reopened.roomId)
      .filter((entry) => !entry.is_general_question)
      .every((entry) => entry.status === "open"),
  );
  const report = await flow.generateRoomAnalysisReport(reopened.roomId);
  assert.ok(report);
  const finalizedRoom = db
    .prepare("SELECT collection_complete, recap_report FROM rooms WHERE id = ?")
    .get(reopened.roomId);
  assert.equal(finalizedRoom.collection_complete, 1);
  assert.equal(finalizedRoom.recap_report, report);
});
