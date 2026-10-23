import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  parseSurveyJson,
  surveyToJson,
} from "../../admin-frontend/src/utils/surveyJson.js";
import { normalizeSurvey } from "../../shared/surveySchema.mjs";

test("survey JSON examples round-trip between files, editor, and server schema", async () => {
  for (const stage of ["pre", "post"]) {
    const source = await fs.readFile(
      new URL(`../../examples/surveys/${stage}-survey.json`, import.meta.url),
      "utf8",
    );
    const survey = parseSurveyJson(source, stage);
    assert.deepEqual(
      parseSurveyJson(surveyToJson(survey, stage), stage),
      normalizeSurvey(survey, stage),
    );
    assert.equal(JSON.parse(surveyToJson(survey, stage)).stage, stage);
    assert.ok(survey.groups.flatMap((group) => group.questions).some((q) => q.condition));
  }
});

test("wrong-stage files, invalid JSON and invalid schema fail without replacing a survey", () => {
  const current = {
    enabled: false,
    title: "Current",
    description: "",
    questions: [],
  };
  const original = structuredClone(current);
  assert.throws(
    () => parseSurveyJson(surveyToJson(current, "post"), "pre"),
    /matching survey/,
  );
  assert.throws(() => parseSurveyJson("{broken", "pre"), /Invalid JSON/);
  assert.throws(() => parseSurveyJson("null", "pre"), /Invalid survey/);
  assert.throws(
    () => parseSurveyJson(JSON.stringify({ ...current, enabled: true }), "pre"),
    /at least one question/,
  );
  assert.throws(
    () => parseSurveyJson(JSON.stringify({ enabled: false, title: "Invalid groups", groups: "not-an-array" }), "pre"),
    /question groups/,
  );
  assert.throws(() => parseSurveyJson(" ".repeat(200001), "pre"), /200 KB/);
  assert.deepEqual(current, original);
});

test("existing JSON without stage metadata remains importable into the selected survey", () => {
  const survey = {
    enabled: true,
    title: "Scale",
    questions: [
      {
        id: "rating",
        type: "scale",
        label: "Rate",
        required: false,
        min: 0,
        max: 5,
      },
    ],
  };
  assert.equal(
    parseSurveyJson(JSON.stringify(survey), "post").groups[0].questions[0].min,
    0,
  );
});

test("nested question groups preserve shared instructions and allow conditions across sections", () => {
  const grouped = {
    enabled: true,
    title: "Workshop survey",
    groups: [
      {
        id: "context",
        title: "Your context",
        description: "Think about your experience before the workshop.",
        questions: [
          { id: "attended", type: "single_choice", label: "Did you attend?", required: true, options: ["Yes", "No"] },
        ],
      },
      {
        id: "follow-up",
        title: "Follow-up",
        description: "Answer if you attended.",
        questions: [
          { id: "why", type: "text", label: "What stood out?", required: false, condition: { questionId: "attended", operator: "equals", value: "Yes" } },
        ],
      },
    ],
  };
  const normalized = parseSurveyJson(JSON.stringify(grouped), "pre");
  assert.equal(normalized.groups[0].description, "Think about your experience before the workshop.");
  assert.deepEqual(normalized.groups.map((group) => group.questions.length), [1, 1]);
  assert.equal(normalized.groups[1].questions[0].condition.questionId, "attended");
  assert.deepEqual(parseSurveyJson(surveyToJson(normalized, "pre"), "pre"), normalized);
});
