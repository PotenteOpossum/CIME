import { db } from "../config/db.js";
import {
  hasSurveyAnswer as present,
  matchesSurveyCondition as matches,
  allSurveyQuestions,
} from "../../../shared/surveyLogic.mjs";
export { visibleSurveyQuestions as visibleQuestions } from "../../../shared/surveyLogic.mjs";

import {
  SURVEY_STAGES,
  emptySurvey,
  normalizeSurvey,
  surveyText as text,
} from "../../../shared/surveySchema.mjs";
export { SURVEY_STAGES, emptySurvey, normalizeSurvey };
const fail = (status, message) => Object.assign(new Error(message), { status });
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function validateAnswers(survey, input) {
  if (!object(input)) throw fail(400, "Answers must be an object.");
  if (JSON.stringify(input).length > 200000)
    throw fail(400, "Survey answers are too large.");
  if (
    Object.keys(input).some((id) => !allSurveyQuestions(survey).some((q) => q.id === id))
  )
    throw fail(400, "Unknown survey question.");
  const answers = {};
  for (const q of allSurveyQuestions(survey)) {
    // Only validated, visible upstream answers may select a branch.
    if (q.condition && !matches(q.condition, answers[q.condition.questionId]))
      continue;
    const value = input[q.id];
    if (!present(value)) {
      if (q.required) throw fail(400, `Please answer: ${q.label}`);
      continue;
    }
    if (q.type === "text") answers[q.id] = text(value, q.label, 10000);
    else if (q.type === "single_choice") {
      if (!q.options.includes(value))
        throw fail(400, `Invalid option for: ${q.label}`);
      answers[q.id] = value;
    } else if (q.type === "multiple_choice") {
      if (
        !Array.isArray(value) ||
        new Set(value).size !== value.length ||
        value.some((v) => !q.options.includes(v))
      )
        throw fail(400, `Invalid choices for: ${q.label}`);
      answers[q.id] = value;
    } else {
      if (!Number.isInteger(value) || value < q.min || value > q.max)
        throw fail(400, `Invalid scale answer for: ${q.label}`);
      answers[q.id] = value;
    }
  }
  return answers;
}

export function getSurveyDefinitions() {
  return Object.fromEntries(
    SURVEY_STAGES.map((stage) => {
      const row = db
        .prepare(
          "SELECT definition_json FROM survey_definitions WHERE stage = ?",
        )
        .get(stage);
      return [stage, row ? normalizeSurvey(JSON.parse(row.definition_json), stage) : emptySurvey(stage)];
    }),
  );
}

export function surveysLocked() {
  return (
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      ?.current_phase !== "idle" ||
    !!db.prepare("SELECT user_id FROM survey_responses LIMIT 1").get()
  );
}

export function saveSurveyDefinitions(input) {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !SURVEY_STAGES.includes(key))
  )
    throw fail(400, "Provide pre and post survey definitions.");
  const surveys = Object.fromEntries(
    SURVEY_STAGES.map((stage) => [stage, normalizeSurvey(input[stage], stage)]),
  );
  if (JSON.stringify(surveys).length > 200000)
    throw fail(400, "Survey definitions are too large.");
  return db.transaction(() => {
    if (surveysLocked())
      throw fail(
        409,
        "Surveys are locked after the first response or experiment start. Repeat the run to edit them.",
      );
    const save = db.prepare(
      "INSERT INTO survey_definitions(stage, definition_json) VALUES (?, ?) ON CONFLICT(stage) DO UPDATE SET definition_json = excluded.definition_json",
    );
    for (const stage of SURVEY_STAGES)
      save.run(stage, JSON.stringify(surveys[stage]));
    return surveys;
  })();
}

function runId() {
  return (
    process.env.CIME_RUN_ID ||
    db.prepare("SELECT decision_run_id FROM system_state WHERE id = 1").get()
      ?.decision_run_id
  );
}

export function getParticipantSurveyStatus(userId) {
  const state = db
    .prepare(
      "SELECT current_phase, decision_run_mode FROM system_state WHERE id = 1",
    )
    .get();
  if (
    state.decision_run_mode === "simulation" &&
    state.current_phase !== "idle"
  )
    return { pending: null };
  const stage =
    state.current_phase === "idle"
      ? "pre"
      : state.current_phase === "completed"
        ? "post"
        : null;
  if (!stage) return { pending: null };
  const survey = getSurveyDefinitions()[stage];
  if (
    !survey.enabled ||
    db
      .prepare(
        "SELECT user_id FROM survey_responses WHERE stage = ? AND user_id = ? AND run_id = ?",
      )
      .get(stage, userId, runId())
  )
    return { pending: null };
  return { pending: { stage, ...survey } };
}

export function submitSurvey(stage, userId, input) {
  if (!SURVEY_STAGES.includes(stage)) throw fail(404, "Survey not found.");
  return db.transaction(() => {
    const user = db
      .prepare("SELECT id, is_admin FROM users WHERE id = ?")
      .get(userId);
    if (!user || user.is_admin)
      throw fail(403, "Only participants can answer surveys.");
    if (
      process.env.CIME_ENGINE === "true" &&
      !db
        .prepare("SELECT user_id FROM run_participants WHERE user_id = ?")
        .get(userId)
    )
      throw fail(403, "Join this experiment first.");
    const pending = getParticipantSurveyStatus(userId).pending;
    if (!pending || pending.stage !== stage)
      throw fail(409, "This survey is unavailable or already submitted.");
    const answers = validateAnswers(pending, input);
    db.prepare(
      "INSERT INTO survey_responses(stage, user_id, run_id, answers_json, submitted_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      stage,
      userId,
      runId(),
      JSON.stringify(answers),
      new Date().toISOString(),
    );
    return { submitted: true };
  })();
}

export function surveyExport() {
  return {
    definitions: getSurveyDefinitions(),
    responses: db
      .prepare(
        "SELECT r.stage, r.run_id, r.user_id, u.username, r.answers_json, r.submitted_at FROM survey_responses r JOIN users u ON u.id = r.user_id WHERE r.run_id = ? ORDER BY r.submitted_at, r.user_id",
      )
      .all(runId())
      .map(({ answers_json, ...row }) => ({
        ...row,
        answers: JSON.parse(answers_json),
      })),
  };
}

export function surveyResponseSummaries() {
  return db
    .prepare(
      "SELECT r.stage, r.run_id, r.user_id, u.username, r.submitted_at FROM survey_responses r JOIN users u ON u.id = r.user_id WHERE r.run_id = ? ORDER BY r.submitted_at, r.user_id",
    )
    .all(runId());
}

export function pendingPreSurveyParticipants() {
  if (!getSurveyDefinitions().pre.enabled) return [];
  return db
    .prepare(
      `SELECT u.id, u.username FROM users u JOIN run_participants p ON p.user_id = u.id
    WHERE u.is_admin = 0 AND NOT EXISTS (SELECT 1 FROM survey_responses r WHERE r.stage = 'pre' AND r.user_id = u.id AND r.run_id = ?)`,
    )
    .all(runId());
}
