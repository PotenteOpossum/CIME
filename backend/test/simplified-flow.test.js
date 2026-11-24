import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateSimplifiedTopics,
  defaultFinalAnswers,
} from "../../shared/discussionSchema.mjs";

const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "cime-simplified-flow-"),
);
process.env.JWT_SECRET = "simplified-flow-test-secret-at-least-32-characters";
process.env.DATABASE_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "agent-config");
await fs.cp(
  new URL("../agent-config", import.meta.url),
  process.env.CIME_CONFIG_DIR,
  { recursive: true },
);
const { db, initDb } = await import("../src/config/db.js");
initDb();
const simple = await import("../src/services/simplifiedCimeService.js");
const simpleSettings =
  await import("../src/services/simplifiedSettingsService.js");
const { resolvePoll, processAgent3AfterMessage, cancelDecisionWork } =
  await import("../src/services/agent3Service.js");
const { getParticipantSurveyStatus, saveSurveyDefinitions } =
  await import("../src/services/surveyService.js");
const config = {
  discussionType: "simplified",
  globalQuestion: "Renovate the square?",
  decisionContext: "A fictional proposal.",
  generalDescription: "Welcome to the discussion.",
  deliberationQuestions: [
    {
      topic: "Trees",
      question_text: "Where should trees go?",
      predefined_answers: ["Edges", "Seating"],
      durationMinutes: 2,
    },
    {
      topic: "Access",
      question_text: "How should deliveries work?",
      predefined_answers: ["Current access", "Timed access"],
      durationMinutes: 3,
    },
  ],
};
test("Simplified CIME uses timed topics, no implementation polls, one final vote, and post-survey completion", async (t) => {
  t.after(async () => {
    cancelDecisionWork();
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const invalid of [0, -1, null, "5", Infinity])
    assert.throws(
      () =>
        validateSimplifiedTopics({
          ...config,
          deliberationQuestions: [
            { ...config.deliberationQuestions[0], durationMinutes: invalid },
          ],
        }),
      { status: 400 },
    );
  assert.throws(
    () =>
      validateSimplifiedTopics({
        ...config,
        deliberationQuestions: [
          {
            ...config.deliberationQuestions[0],
            predefined_answers: ["Only one"],
          },
        ],
      }),
    /two different/,
  );
  validateSimplifiedTopics(config);
  for (const name of ["Alice", "Bob"])
    db.prepare(
      "INSERT INTO users(username,password_hash,is_admin) VALUES (?,'test',0)",
    ).run(name);
  const users = db.prepare("SELECT id FROM users WHERE is_admin = 0").all();
  const disabled = {
    enabled: false,
    title: "Before",
    description: "",
    questions: [],
  };
  saveSurveyDefinitions({
    pre: disabled,
    post: {
      enabled: true,
      title: "After",
      description: "",
      questions: [
        {
          id: "experience",
          type: "text",
          label: "Your experience",
          required: false,
        },
      ],
    },
  });
  const configured = {
    ...simpleSettings.getSimplifiedSettings(),
    model: simpleSettings.simplifiedAvailableModels().at(-1),
    finalVoteMinutes: 1.5,
    quietMinutes: 0,
    facilitatorPrompt:
      "Invite concise reasons and ask participants to consider another perspective.",
  };
  simpleSettings.saveSimplifiedSettings(configured);
  const { roomId } = simple.startSimplifiedCime(config);
  let call;
  const reply = await simple.generateSimplifiedReply(
    { roomId, triggerText: "A participant asked for clarification." },
    {
      chat: {
        completions: {
          create: async (params) => {
            call = params;
            return {
              choices: [
                {
                  message: { content: "Which trade-off matters most to you?" },
                },
              ],
            };
          },
        },
      },
    },
  );
  assert.equal(call.model, configured.model);
  assert.equal(call.messages[0].content, configured.facilitatorPrompt);
  assert.equal(call.metadata.caller, "simplified_facilitator");
  assert.equal(reply.text, "Which trade-off matters most to you?");
  assert.throws(() => simpleSettings.saveSimplifiedSettings(configured), {
    status: 409,
  });
  let resolveLate;
  const lateReply = simple.generateSimplifiedReply(
    { roomId },
    {
      chat: {
        completions: {
          create: () =>
            new Promise((resolve) => {
              resolveLate = resolve;
            }),
        },
      },
    },
  );
  const messagesBeforeTransition = db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?")
    .get(roomId).n;
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE is_active = 1").get().n,
    1,
  );
  assert.equal(
    db.prepare("SELECT room_type FROM rooms WHERE id = ?").get(roomId)
      .room_type,
    "plenary",
  );
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?")
      .get(roomId).n,
    2,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM gathering_answers").get().n,
    0,
  );
  const initial = simple.getSimplifiedSession();
  assert.match(simple.simplifiedRuntimeInstruction(roomId), /no topic votes/);
  await processAgent3AfterMessage({ roomId, userId: users[0].id });
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM polls").get().n,
    0,
    "Full CIME hooks cannot start topic votes",
  );
  const firstDeadline = new Date(initial.deadline_at).getTime();
  simple.advanceSimplifiedCime(firstDeadline - 1);
  assert.equal(simple.getSimplifiedSession().topic_index, 0);
  simple.advanceSimplifiedCime(firstDeadline);
  resolveLate({
    choices: [
      { message: { content: "Stale reply about the previous topic." } },
    ],
  });
  assert.equal(
    await lateReply,
    null,
    "late responses cannot post after the topic changes",
  );
  assert.equal(simple.getSimplifiedSession().topic_index, 1);
  const second = simple.getSimplifiedSession();
  assert.equal(
    new Date(second.deadline_at).getTime() - firstDeadline,
    3 * 60000,
  );
  simple.advanceSimplifiedCime(firstDeadline);
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id = ?")
      .get(roomId).n,
    messagesBeforeTransition + 1,
    "repeated ticks do not repeat topic announcements",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM polls").get().n, 0);
  simple.advanceSimplifiedCime(new Date(second.deadline_at).getTime());
  const voting = simple.getSimplifiedSession();
  assert.equal(
    new Date(voting.deadline_at).getTime() -
      new Date(second.deadline_at).getTime(),
    1.5 * 60000,
    "the advanced final-vote duration is actually used",
  );
  assert.equal(voting.stage, "final_vote");
  const poll = db.prepare("SELECT * FROM polls").get();
  assert.equal(poll.poll_type, "plurality");
  assert.equal(poll.suggestion, "general-question");
  assert.deepEqual(
    db
      .prepare(
        "SELECT option_text FROM poll_options WHERE poll_id = ? ORDER BY id",
      )
      .all(poll.id)
      .map((row) => row.option_text),
    defaultFinalAnswers(),
  );
  await resolvePoll(poll.id, roomId);
  assert.equal(
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      .current_phase,
    "discussing",
    "a ballot stays open before its deadline while participants have not voted",
  );
  simple.advanceSimplifiedCime(new Date(voting.deadline_at).getTime());
  assert.equal(
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      .current_phase,
    "completed",
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM rooms WHERE room_type IN ('group','convergence')",
      )
      .get().n,
    0,
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM polls").get().n, 1);
  assert.equal(getParticipantSurveyStatus(users[0].id).pending.stage, "post");
  assert.match(
    db.prepare("SELECT recap_report FROM rooms WHERE id = ?").get(roomId)
      .recap_report,
    /No collective implementation decisions/,
  );
  assert.match(
    db.prepare("SELECT recap_report FROM rooms WHERE id = ?").get(roomId)
      .recap_report,
    /0 of 2 participants voted/,
  );
  assert.match(
    db.prepare("SELECT recap_report FROM rooms WHERE id = ?").get(roomId)
      .recap_report,
    /## Outcome\nNo votes were cast\./,
  );
  const timeline = JSON.parse(
    db.prepare("SELECT topic_timeline_json FROM rooms WHERE id = ?").get(roomId)
      .topic_timeline_json,
  );
  assert.deepEqual(
    timeline.map((entry) => entry.topic),
    ["Trees", "Access", "general-question"],
    "each topic's start is recorded for per-topic analysis",
  );
  assert.equal(
    new Date(timeline[1].started_at).getTime(),
    firstDeadline,
  );
  simple.advanceSimplifiedCime(Date.now() + 86400000);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM polls").get().n,
    1,
    "completed discussions never reopen a ballot",
  );
});
