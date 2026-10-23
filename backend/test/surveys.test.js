import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneSurveyAnswers } from "../../shared/surveyLogic.mjs";
import { visibleSurveyGroups } from "../../shared/surveyLogic.mjs";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-surveys-"));
process.env.DATABASE_URL = "";
process.env.CIME_RUN_SCHEMA = "";
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.JWT_SECRET = "test-surveys-secret-at-least-32-characters";
process.env.CIME_RUN_ID = "survey-run-a";
process.env.CIME_CONFIG_DIR = path.join(directory, "config");
const { db, initDb } = await import("../src/config/db.js");
const { initEnginePlatform } = await import("../src/platform/engineRoutes.js");
const service = await import("../src/services/surveyService.js");
initDb();
initEnginePlatform();
process.env.CIME_ENGINE = "true";

const survey = () => ({
  enabled: true,
  title: "Before",
  description: "",
  questions: [
    {
      id: "familiar",
      type: "single_choice",
      label: "Familiar with this topic?",
      required: true,
      options: ["Yes", "No"],
    },
    {
      id: "experience",
      type: "text",
      label: "Describe your experience",
      required: true,
      condition: { questionId: "familiar", operator: "equals", value: "Yes" },
    },
    {
      id: "expectations",
      type: "text",
      label: "What do you expect?",
      required: true,
      condition: {
        questionId: "familiar",
        operator: "not_equals",
        value: "Yes",
      },
    },
    {
      id: "interests",
      type: "multiple_choice",
      label: "Interests",
      required: false,
      options: ["Roads", "Parks"],
    },
    {
      id: "park",
      type: "scale",
      label: "Rate park knowledge",
      required: true,
      min: 0,
      max: 5,
      condition: {
        questionId: "interests",
        operator: "includes",
        value: "Parks",
      },
    },
    {
      id: "explain",
      type: "text",
      label: "Why?",
      required: true,
      condition: { questionId: "park", operator: "gte", value: 4 },
    },
  ],
});
let alice, admin;
test.beforeEach(() => {
  db.prepare("DELETE FROM survey_responses").run();
  db.prepare("DELETE FROM survey_definitions").run();
  db.prepare("DELETE FROM users").run();
  db.prepare(
    "UPDATE system_state SET current_phase = 'idle', decision_run_mode = 'human' WHERE id = 1",
  ).run();
  const insert = db.prepare(
    "INSERT INTO users(username, password_hash, is_admin) VALUES (?, ?, ?)",
  );
  alice = Number(insert.run("Alice", "test-hash", 0).lastInsertRowid);
  admin = Number(insert.run("Owner", "test-hash", 1).lastInsertRowid);
  db.prepare(
    "INSERT INTO run_participants(user_id, joined_at, recovery_hash) VALUES (?, ?, ?)",
  ).run(alice, "now", "hash");
});
test.after(async () => {
  db.close();
  await fs.rm(directory, { recursive: true, force: true });
});

test("if/otherwise and nested conditions match on client and server; hidden stale answers are dropped", () => {
  const s = service.normalizeSurvey(survey(), "pre");
  assert.deepEqual(
    service.visibleQuestions(s, {}).map((q) => q.id),
    ["familiar", "interests"],
  );
  const input = {
    familiar: "No",
    experience: "stale",
    expectations: "Learn",
    interests: ["Roads"],
    park: 5,
    explain: "stale nested",
  };
  assert.deepEqual(service.validateAnswers(s, input), {
    familiar: "No",
    expectations: "Learn",
    interests: ["Roads"],
  });
  assert.deepEqual(pruneSurveyAnswers(s, input), {
    familiar: "No",
    expectations: "Learn",
    interests: ["Roads"],
  });
  assert.throws(
    () => service.validateAnswers(s, { familiar: "Yes" }),
    /Describe your experience/,
  );
  assert.throws(
    () =>
      service.validateAnswers(s, {
        familiar: "No",
        expectations: "Learn",
        interests: ["Parks"],
        park: 5,
      }),
    /Why/,
  );
  assert.equal(
    service.validateAnswers(s, {
      familiar: "No",
      expectations: "Learn",
      interests: ["Parks"],
      park: 0,
    }).park,
    0,
  );
});

test("invalid types, options, scales, duplicate IDs, forward references and cycles are rejected", () => {
  const s = service.normalizeSurvey(survey(), "pre");
  for (const patch of [
    { familiar: "Maybe" },
    { familiar: "Yes", experience: "ok", interests: "Parks" },
    { familiar: "Yes", experience: "ok", interests: ["Parks", "Parks"] },
    { familiar: "Yes", experience: "ok", interests: ["Parks"], park: "3" },
    { familiar: "Yes", experience: "ok", interests: ["Parks"], park: 6 },
    { familiar: "Yes", experience: "ok", unknown: 1 },
  ]) {
    assert.throws(() => service.validateAnswers(s, patch));
  }
  for (const mutation of [
    (s) => (s.questions[1].condition.questionId = "explain"),
    (s) => (s.questions[1].condition.questionId = "experience"),
    (s) => (s.questions[1].id = "familiar"),
    (s) => (s.questions[0].id = "__proto__"),
    (s) => (s.questions[0].options = ["Yes", "Yes"]),
    (s) => (s.questions[4].max = 1000),
    (s) => (s.questions[1].condition.value = "Unknown"),
  ]) {
    const invalid = survey();
    mutation(invalid);
    assert.throws(() => service.normalizeSurvey(invalid, "pre"));
  }
});

test("pre/post submissions persist by participant and run, lock definitions, reject duplicates and export safely", () => {
  service.saveSurveyDefinitions({
    pre: survey(),
    post: { ...survey(), title: "After" },
  });
  assert.equal(service.getParticipantSurveyStatus(alice).pending.stage, "pre");
  assert.equal(service.pendingPreSurveyParticipants().length, 1);
  assert.throws(() => service.submitSurvey("post", alice, {}), /unavailable/);
  assert.throws(
    () => service.submitSurvey("pre", admin, {}),
    /Only participants/,
  );
  service.submitSurvey("pre", alice, { familiar: "No", expectations: "Learn" });
  assert.equal(service.getParticipantSurveyStatus(alice).pending, null);
  assert.equal(service.pendingPreSurveyParticipants().length, 0);
  assert.throws(
    () => service.submitSurvey("pre", alice, {}),
    /already submitted/,
  );
  assert.throws(
    () =>
      service.saveSurveyDefinitions({
        pre: survey(),
        post: service.emptySurvey("post"),
      }),
    /locked/,
  );
  db.prepare(
    "UPDATE system_state SET current_phase = 'discussing' WHERE id = 1",
  ).run();
  assert.equal(service.getParticipantSurveyStatus(alice).pending, null);
  assert.throws(() => service.submitSurvey("post", alice, {}), /unavailable/);
  db.prepare(
    "UPDATE system_state SET current_phase = 'completed' WHERE id = 1",
  ).run();
  assert.equal(service.getParticipantSurveyStatus(alice).pending.stage, "post");
  service.submitSurvey("post", alice, {
    familiar: "Yes",
    experience: "Useful",
  });
  assert.equal(service.getParticipantSurveyStatus(alice).pending, null);
  const data = service.surveyExport();
  assert.equal(data.responses.length, 2);
  assert.equal(data.responses[0].user_id, alice);
  assert.equal(JSON.stringify(data).includes("test-hash"), false);
  process.env.CIME_RUN_ID = "survey-run-b";
  assert.equal(service.surveyExport().responses.length, 0);
  process.env.CIME_RUN_ID = "survey-run-a";
});

test("disabled surveys and simulations do not block or prompt participants", () => {
  service.saveSurveyDefinitions({
    pre: service.emptySurvey("pre"),
    post: service.emptySurvey("post"),
  });
  assert.equal(service.getParticipantSurveyStatus(alice).pending, null);
  assert.deepEqual(service.pendingPreSurveyParticipants(), []);
  service.saveSurveyDefinitions({ pre: survey(), post: survey() });
  db.prepare(
    "UPDATE system_state SET current_phase = 'completed', decision_run_mode = 'simulation' WHERE id = 1",
  ).run();
  assert.equal(service.getParticipantSurveyStatus(alice).pending, null);
});

test("otherwise choices and text conditions agree between browser and server", () => {
  const s = service.normalizeSurvey(
    {
      enabled: true,
      title: "Branches",
      questions: [
        {
          id: "topics",
          type: "multiple_choice",
          label: "Topics",
          required: true,
          options: ["Parks", "Roads"],
        },
        {
          id: "other",
          type: "text",
          label: "Other topic?",
          required: true,
          condition: {
            questionId: "topics",
            operator: "not_includes",
            value: "Parks",
          },
        },
        {
          id: "detail",
          type: "text",
          label: "Tell us more",
          required: true,
          condition: {
            questionId: "other",
            operator: "equals",
            value: "Trees",
          },
        },
      ],
    },
    "pre",
  );
  const input = { topics: ["Roads"], other: " Trees ", detail: "Shade" };
  assert.deepEqual(
    service.visibleQuestions(s, input).map((q) => q.id),
    ["topics", "other", "detail"],
  );
  assert.equal(service.validateAnswers(s, input).detail, "Shade");
  assert.deepEqual(
    service.validateAnswers(s, {
      topics: ["Parks"],
      other: "Trees",
      detail: "Hidden",
    }),
    { topics: ["Parks"] },
  );
});

test("grouped surveys show shared instructions once and resolve branches across groups", () => {
  const grouped = service.normalizeSurvey({
    enabled: true,
    title: "Grouped",
    groups: [
      {
        id: "context",
        title: "Discussion experience",
        description: "Think only about your subgroup discussion.",
        questions: [
          { id: "attended", type: "single_choice", label: "Did you attend?", required: true, options: ["Yes", "No"] },
        ],
      },
      {
        id: "follow-up",
        title: "Follow-up",
        description: "Tell us more.",
        questions: [
          { id: "details", type: "text", label: "What stood out?", required: true, condition: { questionId: "attended", operator: "equals", value: "Yes" } },
        ],
      },
    ],
  }, "pre");
  assert.deepEqual(visibleSurveyGroups(grouped, {}).map((group) => group.id), ["context"]);
  assert.deepEqual(service.validateAnswers(grouped, { attended: "No" }), { attended: "No" });
  assert.deepEqual(visibleSurveyGroups(grouped, { attended: "Yes" }).map((group) => group.id), ["context", "follow-up"]);
  assert.deepEqual(service.validateAnswers(grouped, { attended: "Yes", details: "Listening" }), { attended: "Yes", details: "Listening" });
});
