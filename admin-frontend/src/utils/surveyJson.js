import { normalizeSurvey } from "../../../shared/surveySchema.mjs";

export function surveyToJson(survey, stage) {
  return JSON.stringify({ stage, ...survey }, null, 2);
}

export function parseSurveyJson(source, stage) {
  if (source.length > 200000)
    throw new Error("Survey JSON must be smaller than 200 KB.");
  let input;
  try {
    input = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON: ${error.message}`);
  }
  if (input?.stage !== undefined && input.stage !== stage) {
    throw new Error(
      `This file is for the ${input.stage === "post" ? "after" : input.stage === "pre" ? "before" : "unknown"}-experiment survey. Select the matching survey before importing it.`,
    );
  }
  return normalizeSurvey(input, stage);
}
