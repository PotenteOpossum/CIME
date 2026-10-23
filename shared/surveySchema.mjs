export const SURVEY_STAGES = ["pre", "post"];
const types = ["text", "single_choice", "multiple_choice", "scale"];
const operators = [
  "equals",
  "not_equals",
  "includes",
  "not_includes",
  "gte",
  "lte",
];
const fail = (status, message) => Object.assign(new Error(message), { status });
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

export function emptySurvey(stage) {
  return {
    enabled: false,
    title: stage === "pre" ? "Before the experiment" : "After the experiment",
    description: "",
    groups: [],
  };
}

function text(value, label, limit, optional = false) {
  if (
    typeof value !== "string" ||
    value.length > limit ||
    (!optional && !value.trim())
  ) {
    throw fail(
      400,
      `${label} must be ${optional ? "" : "non-empty "}text of at most ${limit} characters.`,
    );
  }
  return value.trim();
}

export function normalizeSurvey(input, stage) {
  if (!SURVEY_STAGES.includes(stage) || !object(input))
    throw fail(400, "Invalid survey.");
  if (typeof input.enabled !== "boolean")
    throw fail(400, "Survey enabled must be true or false.");
  // Keep old flat JSON files importable by treating their questions as one
  // default section. New surveys can organize questions into titled groups.
  if (input.groups !== undefined && input.questions !== undefined)
    throw fail(400, "Use either grouped questions or a flat questions array, not both.");
  const inputGroups = input.groups !== undefined
    ? Array.isArray(input.groups) ? input.groups : null
    : Array.isArray(input.questions)
      ? input.questions.length
        ? [{ id: "questions", title: "", description: "", questions: input.questions }]
        : []
      : null;
  if (!inputGroups || inputGroups.length > 100)
    throw fail(400, "Use up to 100 question groups.");
  const totalQuestions = inputGroups.reduce(
    (count, group) => count + (Array.isArray(group?.questions) ? group.questions.length : 0),
    0,
  );
  if (totalQuestions > 100) throw fail(400, "Use at most 100 questions.");
  if (input.enabled && !totalQuestions)
    throw fail(400, "An enabled survey needs at least one question.");
  const earlier = new Map();
  const groupIds = new Set();
  const groups = inputGroups.map((group, groupIndex) => {
    if (
      !object(group) ||
      typeof group.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(group.id) ||
      group.id in Object.prototype ||
      groupIds.has(group.id)
    )
      throw fail(400, `Question group ${groupIndex + 1} needs a unique ID.`);
    groupIds.add(group.id);
    if (!Array.isArray(group.questions))
      throw fail(400, `Question group ${groupIndex + 1} needs a questions array.`);
    const normalizedGroup = {
      id: group.id,
      title: text(group.title ?? "", "Group title", 200, true),
      description: text(group.description ?? "", "Group instructions", 5000, true),
      questions: group.questions.map((item, index) => {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
      item.id in Object.prototype ||
      earlier.has(item.id)
    ) {
      throw fail(400, `Question ${index + 1} needs a unique ID.`);
    }
    if (!types.includes(item.type) || typeof item.required !== "boolean")
      throw fail(400, "Invalid question type or required flag.");
    const q = {
      id: item.id,
      type: item.type,
      label: text(item.label, "Question", 2000),
      required: item.required,
    };
    if (["single_choice", "multiple_choice"].includes(q.type)) {
      if (
        !Array.isArray(item.options) ||
        item.options.length < 2 ||
        item.options.length > 30
      )
        throw fail(400, "Choice questions need 2–30 options.");
      q.options = item.options.map((option) => text(option, "Option", 300));
      if (new Set(q.options).size !== q.options.length)
        throw fail(400, "Choice options must be unique.");
      if (item.alternativeOptions != null) {
        const alternativeOptions = Array.isArray(item.alternativeOptions)
          ? item.alternativeOptions.map((option) =>
              text(option, "Alternative option", 300),
            )
          : item.alternativeOptions;
        if (
          q.type !== "single_choice" ||
          !Array.isArray(alternativeOptions) ||
          alternativeOptions.some((option) => !q.options.includes(option)) ||
          new Set(alternativeOptions).size !== alternativeOptions.length
        ) {
          throw fail(
            400,
            "Alternative answers must be unique options in a single-choice question.",
          );
        }
        q.alternativeOptions = alternativeOptions;
      }
    }
    if (q.type === "scale") {
      if (
        !Number.isInteger(item.min) ||
        !Number.isInteger(item.max) ||
        item.min < -100 ||
        item.max > 100 ||
        item.max <= item.min ||
        item.max - item.min > 20
      ) {
        throw fail(
          400,
          "Scales need integer bounds between -100 and 100, with 2–21 values.",
        );
      }
      Object.assign(q, {
        min: item.min,
        max: item.max,
        minLabel: text(item.minLabel ?? "", "Low-end label", 200, true),
        midLabel: text(item.midLabel ?? "", "Middle label", 200, true),
        maxLabel: text(item.maxLabel ?? "", "High-end label", 200, true),
      });
    }
    if (item.condition != null) {
      const c = item.condition;
      const source = earlier.get(c.questionId);
      if (!object(c) || !source || !operators.includes(c.operator))
        throw fail(400, "Conditions must refer to an earlier question.");
      const allowed =
        source.type === "multiple_choice"
          ? ["includes", "not_includes"]
          : source.type === "scale"
            ? ["equals", "not_equals", "gte", "lte"]
            : ["equals", "not_equals"];
      if (!allowed.includes(c.operator))
        throw fail(
          400,
          "Condition operator does not match the source question type.",
        );
      const value =
        source.type === "scale"
          ? c.value
          : text(c.value, "Condition value", 2000);
      if (
        source.type === "scale" &&
        (!Number.isInteger(value) || value < source.min || value > source.max)
      )
        throw fail(400, "Condition value is outside the source scale.");
      if (source.options && !source.options.includes(value))
        throw fail(400, "Condition value must be one of the source options.");
      q.condition = { questionId: c.questionId, operator: c.operator, value };
    }
    earlier.set(q.id, q);
    return q;
      }),
    };
    return normalizedGroup;
  });
  return {
    enabled: input.enabled,
    title: text(input.title, "Survey title", 200),
    description: text(input.description ?? "", "Description", 5000, true),
    groups,
  };
}

export { text as surveyText };
