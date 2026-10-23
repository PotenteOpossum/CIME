import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import jwt from "jsonwebtoken";
process.env.DATABASE_URL = "";
process.env.JWT_SECRET = "live-voting-test-secret-longer-than-32-characters";
process.env.OPENAI_API_KEY = "test-key-never-used-for-network";
process.env.CIME_API_KEY = "";
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-live-"));
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb } = await import("../src/config/db.js");
initDb();
const { default: llm } = await import("../src/services/llm.js");
const tieResponse = (data) => ({
  choices: [{ message: { content: JSON.stringify(data) } }],
});
llm.chat.completions.create = async () =>
  tieResponse({
    message:
      "One position prioritizes residents, while another includes workers. Consider a targeted pass covering both groups with lower incomes.",
    proposed_option: "Low-income residents and low-income workers",
    existing_option_id: null,
  });
const flow = await import("../src/services/agent3Service.js");
const { beginDecisionRun } =
  await import("../src/services/decisionWorkService.js");
const { updateDecisionSettings } =
  await import("../src/services/agentConfigService.js");
beginDecisionRun();
updateDecisionSettings({
  check_response_validity: false,
  minimum_live_voting_duration_minutes: 10,
  consensus_stability_duration_seconds: 20,
  poll_approval_threshold: 1,
});
const app = express();
app.use(express.json());
app.use("/rooms", (await import("../src/routes/rooms.js")).default);
app.use((error, req, res, next) =>
  res.status(500).json({ error: error.message }),
);
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const users = Array.from({ length: 4 }, (_, index) =>
  Number(
    db
      .prepare(
        "INSERT INTO users(username, password_hash, is_admin) VALUES (?, 'test', 0)",
      )
      .run(`voter-${index}`).lastInsertRowid,
  ),
);
const future = () => new Date(Date.now() + 600000).toISOString();
const now = () => new Date().toISOString();
let roomSequence = 0;
function ballot(type = "continuous") {
  const roomId = Number(
    db
      .prepare(
        "INSERT INTO rooms(name, room_type, is_active, topic_memory_json) VALUES (?, 'convergence', 1, ?)",
      )
      .run(
        `test-${++roomSequence}`,
        JSON.stringify([
          {
            key: "eligibility",
            question: "Who is eligible?",
            status: "discussing",
            options: ["Residents", "Workers"],
          },
        ]),
      ).lastInsertRowid,
  );
  for (const id of users)
    db.prepare("INSERT INTO room_members(user_id, room_id) VALUES (?, ?)").run(
      id,
      roomId,
    );
  const pollId = Number(
    db
      .prepare(
        "INSERT INTO polls(room_id, question, poll_type, poll_stage, suggestion, created_at, expires_at, minimum_live_until, mandatory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
      )
      .run(
        roomId,
        "Who is eligible?",
        type,
        type,
        "eligibility",
        now(),
        future(),
        future(),
      ).lastInsertRowid,
  );
  const ids = ["Residents", "Workers", "Other"].map((label) =>
    Number(
      db
        .prepare("INSERT INTO poll_options(poll_id, option_text) VALUES (?, ?)")
        .run(pollId, label).lastInsertRowid,
    ),
  );
  return { roomId, pollId, ids };
}
async function vote(poll, user, body) {
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/rooms/polls/${poll.pollId}/vote`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}`,
      },
      body: JSON.stringify(body),
    },
  );
  return { status: response.status, data: await response.json() };
}
const current = (poll) =>
  db.prepare("SELECT * FROM polls WHERE id = ?").get(poll.pollId);

test("live write-ins are real distinct options, and concurrent proposal clicks add one option and one vote per person", async () => {
  const poll = ballot();
  const text = "Low-income residents and low-income workers";
  const marker = `[LiveVoteProposal=${JSON.stringify({ pollId: poll.pollId, optionText: text })}]`;
  const messageId = Number(
    db
      .prepare(
        "INSERT INTO messages(room_id, text, timestamp) VALUES (?, ?, ?)",
      )
      .run(poll.roomId, `Suggested compromise.\n${marker}`, now())
      .lastInsertRowid,
  );
  const responses = await Promise.all(
    users.map((id) => vote(poll, id, { proposalMessageId: messageId })),
  );
  for (const result of responses)
    assert.equal(result.status, 200, JSON.stringify(result.data));
  const matching = db
    .prepare(
      "SELECT id FROM poll_options WHERE poll_id = ? AND option_text = ?",
    )
    .all(poll.pollId, text);
  assert.equal(matching.length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id = ? AND option_id = ?",
      )
      .get(poll.pollId, matching[0].id).c,
    4,
  );
  assert.equal(
    (await vote(poll, users[0], { proposalMessageId: messageId })).status,
    200,
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM poll_votes WHERE poll_id = ?")
      .get(poll.pollId).c,
    4,
  );
  assert.equal(
    (
      await vote(poll, users[0], {
        optionId: poll.ids[2],
        customOptionText: "Residents and workers",
      })
    ).status,
    200,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM poll_options WHERE poll_id = ? AND option_text IN (?, ?)",
      )
      .get(poll.pollId, text, "Residents and workers").c,
    2,
    "income restrictions must not be merged into a broader option",
  );
  const unrelated = ballot();
  assert.equal(
    (await vote(unrelated, users[0], { proposalMessageId: messageId })).status,
    400,
  );
  const forged = Number(
    db
      .prepare(
        "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)",
      )
      .run(poll.roomId, users[0], marker, now()).lastInsertRowid,
  );
  assert.equal(
    (await vote(poll, users[0], { proposalMessageId: forged })).status,
    400,
  );
  db.prepare("UPDATE polls SET is_closed = 1 WHERE id = ?").run(poll.pollId);
  assert.equal(
    (await vote(poll, users[0], { proposalMessageId: messageId })).status,
    400,
  );
});

test("distinct legacy Other write-ins cannot combine into false consensus, and stability follows the winning option", async () => {
  const poll = ballot();
  users.forEach((user, index) =>
    db
      .prepare(
        "INSERT INTO poll_votes(poll_id, option_id, user_id, custom_option_text, created_at, rank) VALUES (?, ?, ?, ?, ?, 1)",
      )
      .run(
        poll.pollId,
        poll.ids[2],
        user,
        index < 2 ? "Low-income residents" : "Low-income workers",
        now(),
      ),
  );
  await flow.resolvePoll(poll.pollId, poll.roomId);
  assert.equal(current(poll).is_closed, 0);
  assert.equal(current(poll).stability_started_at, null);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM messages WHERE room_id = ? AND text LIKE 'A quorum has been reached%'",
      )
      .get(poll.roomId).c,
    0,
  );
  for (const user of users.slice(0, 3))
    assert.equal(
      (await vote(poll, user, { optionId: poll.ids[0] })).status,
      200,
    );
  await flow.resolvePoll(poll.pollId, poll.roomId);
  assert.equal(current(poll).stability_leader_key, "text:residents");
  db.prepare("UPDATE polls SET stability_started_at = ? WHERE id = ?").run(
    "2000-01-01T00:00:00.000Z",
    poll.pollId,
  );
  for (const user of users.slice(0, 3))
    assert.equal(
      (await vote(poll, user, { optionId: poll.ids[1] })).status,
      200,
    );
  await flow.resolvePoll(poll.pollId, poll.roomId);
  assert.equal(current(poll).stability_leader_key, "text:workers");
  assert.ok(
    Date.now() - new Date(current(poll).stability_started_at).getTime() < 10000,
  );
});

test("a swipe write-in survives into the next live poll; unsupported predefined options do not", async () => {
  updateDecisionSettings({ poll_approval_threshold: 3 });
  const poll = ballot("swipe");
  const text = "Low-income residents and low-income workers";
  for (const [index, user] of users.entries()) {
    const result = await vote(poll, user, {
      swipeVotes: [
        { optionId: poll.ids[0], direction: index < 2 ? "right" : "left" },
        { optionId: poll.ids[1], direction: "left" },
      ],
      ...(index === 3 ? { customOptionText: text } : {}),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  await flow.resolvePoll(poll.pollId, poll.roomId);
  const next = db
    .prepare(
      "SELECT * FROM polls WHERE room_id = ? AND poll_type = 'continuous' ORDER BY id DESC",
    )
    .get(poll.roomId);
  assert.ok(next);
  const labels = db
    .prepare("SELECT option_text FROM poll_options WHERE poll_id = ?")
    .all(next.id)
    .map((row) => row.option_text);
  assert.ok(labels.includes(text), JSON.stringify(labels));
  assert.ok(labels.includes("Residents"));
  assert.ok(!labels.includes("Workers"));
});

test("tie discussion publishes an actionable compromise and discards analysis after the poll closes", async () => {
  const poll = ballot();
  users.forEach((user, index) =>
    db
      .prepare(
        "INSERT INTO poll_votes(poll_id, option_id, user_id, created_at, rank) VALUES (?, ?, ?, ?, 1)",
      )
      .run(poll.pollId, poll.ids[index < 2 ? 0 : 1], user, now()),
  );
  await flow.handleTieProCon(
    poll.roomId,
    ["Residents", "Workers"],
    poll.pollId,
  );
  const message = db
    .prepare(
      "SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(poll.roomId);
  assert.ok(message.text.includes("[LiveVoteProposal="));
  assert.ok(
    message.text.includes("Low-income residents and low-income workers"),
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM poll_options WHERE poll_id = ?")
      .get(poll.pollId).c,
    3,
    "proposals become options only when a participant accepts",
  );
  assert.equal(
    (await vote(poll, users[0], { proposalMessageId: message.id })).status,
    200,
  );
  let release;
  llm.chat.completions.create = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  // Restore the tie before testing a delayed model response.
  db.prepare(
    "UPDATE poll_votes SET option_id = ? WHERE poll_id = ? AND user_id = ?",
  ).run(poll.ids[0], poll.pollId, users[0]);
  const pending = flow.handleTieProCon(
    poll.roomId,
    ["Residents", "Workers"],
    poll.pollId,
  );
  const before = db
    .prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?")
    .get(poll.roomId).c;
  db.prepare("UPDATE polls SET is_closed = 1 WHERE id = ?").run(poll.pollId);
  release(
    tieResponse({
      message: "Late compromise",
      proposed_option: "Another proposal",
    }),
  );
  await pending;
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM messages WHERE room_id = ?")
      .get(poll.roomId).c,
    before,
  );
});

test.after(async () => {
  flow.cancelDecisionWork();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
});
