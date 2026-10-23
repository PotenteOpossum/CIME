export function parseNumericSurveyOption(option) {
  const match = /^(-?\d+)(?:\s*[—–:-]\s*(.*))?$/.exec(option);
  return match
    ? { option, value: Number(match[1]), label: match[2]?.trim() || "" }
    : null;
}

const knownAlternativeLabels = new Set([
  "dont know",
  "i dont know",
  "do not know",
  "i do not know",
  "prefer not to answer",
  "prefer not answer",
  "prefer not to say",
  "not applicable",
  "i do not use these categories to describe my views",
  "cannot assess",
  "cant assess",
]);

function normalizedOption(option) {
  return option
    .trim()
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/g, "");
}

export function surveyChoiceGroups(question) {
  if (question.type !== "single_choice" || !Array.isArray(question.options))
    return null;
  const explicit = Array.isArray(question.alternativeOptions)
    ? new Set(question.alternativeOptions)
    : null;
  const isAlternative = (option) =>
    explicit
      ? explicit.has(option)
      : knownAlternativeLabels.has(normalizedOption(option));
  return {
    options: question.options.filter((option) => !isAlternative(option)),
    alternatives: question.options.filter(isAlternative),
  };
}

export function surveyScale(question) {
  if (question.type === "scale") {
    return {
      values: Array.from(
        { length: question.max - question.min + 1 },
        (_, index) => ({
          value: question.min + index,
          option: question.min + index,
          label: "",
        }),
      ),
      alternatives: [],
    };
  }

  const groups = surveyChoiceGroups(question);
  if (!groups) return null;
  const parsed = groups.options.map(parseNumericSurveyOption);
  const values = parsed.filter(Boolean);
  if (
    values.length < 3 ||
    values.length !== groups.options.length ||
    values.some(
      (entry, index) =>
        index > 0 && entry.value !== values[index - 1].value + 1,
    )
  )
    return null;
  return {
    values,
    alternatives: groups.alternatives,
  };
}

export function isNumericSurveyScale(question) {
  return Boolean(surveyScale(question));
}
