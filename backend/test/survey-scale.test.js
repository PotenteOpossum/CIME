import test from "node:test";
import assert from "node:assert/strict";
import {
  surveyChoiceGroups,
  surveyScale,
} from "../../shared/surveyScale.mjs";
import { normalizeSurvey } from "../src/services/surveyService.js";

test("known alternative labels are separated wherever they appear, preserving option order", () => {
  const question = {
    type: "single_choice",
    options: [
      "Don't know",
      "0 days",
      "Prefer not to answer",
      "1 day",
      "2–3 days",
      "4–5 days",
    ],
  };
  assert.deepEqual(surveyChoiceGroups(question), {
    options: ["0 days", "1 day", "2–3 days", "4–5 days"],
    alternatives: ["Don't know", "Prefer not to answer"],
  });
});

test("explicit alternative metadata overrides label inference and preserves stored values", () => {
  const question = {
    type: "single_choice",
    options: ["Prefer not to answer", "I am undecided", "Yes"],
    alternativeOptions: ["I am undecided"],
  };
  assert.deepEqual(surveyChoiceGroups(question), {
    options: ["Prefer not to answer", "Yes"],
    alternatives: ["I am undecided"],
  });
  assert.deepEqual(
    surveyChoiceGroups({ ...question, alternativeOptions: [] }),
    { options: question.options, alternatives: [] },
  );
});

test("numeric choice scales retain their configured order and separate only declared alternatives", () => {
  const question = {
    type: "single_choice",
    options: ["0 — Oppose", "1", "2", "3 — Neutral", "4", "5 — Support", "Don't know"],
  };
  assert.deepEqual(
    surveyScale(question).values.map((entry) => entry.option),
    ["0 — Oppose", "1", "2", "3 — Neutral", "4", "5 — Support"],
  );
  assert.deepEqual(surveyScale(question).alternatives, ["Don't know"]);
  assert.equal(
    surveyScale({
      ...question,
      options: [...question.options.slice(0, 6), "Another option"],
    }),
    null,
  );
});

test("survey schema validates alternativeOptions without changing response options", () => {
  const source = {
    enabled: true,
    title: "Before",
    questions: [
      {
        id: "travel",
        type: "single_choice",
        label: "Travel days",
        required: false,
        options: ["0 days", "1 day", "Don't know"],
        alternativeOptions: ["Don't know"],
      },
    ],
  };
  assert.deepEqual(
    normalizeSurvey(source, "pre").groups[0].questions[0].options,
    source.questions[0].options,
  );
  assert.deepEqual(
    normalizeSurvey(source, "pre").groups[0].questions[0].alternativeOptions,
    ["Don't know"],
  );
  assert.deepEqual(
    normalizeSurvey(
      {
        ...source,
        questions: [
          { ...source.questions[0], alternativeOptions: [" Don't know "] },
        ],
      },
      "pre",
    ).groups[0].questions[0].alternativeOptions,
    ["Don't know"],
  );
  assert.throws(
    () =>
      normalizeSurvey(
        {
          ...source,
          questions: [
            { ...source.questions[0], alternativeOptions: ["Missing"] },
          ],
        },
        "pre",
      ),
    /Alternative answers must be unique options/,
  );
});
