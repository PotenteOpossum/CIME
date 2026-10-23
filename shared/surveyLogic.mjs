export const hasSurveyAnswer = (value) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  (!Array.isArray(value) || value.length > 0);

export function matchesSurveyCondition(condition, answer) {
  if (!hasSurveyAnswer(answer)) return false;
  if (typeof answer === "string") answer = answer.trim();
  switch (condition.operator) {
    case "equals":
      return answer === condition.value;
    case "not_equals":
      return answer !== condition.value;
    case "includes":
      return Array.isArray(answer) && answer.includes(condition.value);
    case "not_includes":
      return Array.isArray(answer) && !answer.includes(condition.value);
    case "gte":
      return answer >= condition.value;
    case "lte":
      return answer <= condition.value;
    default:
      return false;
  }
}

export function allSurveyQuestions(survey) {
  if (Array.isArray(survey.groups))
    return survey.groups.flatMap((group) => group.questions || []);
  return survey.questions || [];
}

export function visibleSurveyGroups(survey, answers) {
  const groups = Array.isArray(survey.groups)
    ? survey.groups
    : survey.questions?.length
      ? [{ id: "questions", title: "Questions", description: "", questions: survey.questions }]
      : [];
  const visible = new Set();
  const visibleByGroup = new Map();
  for (const group of groups) {
    const questions = [];
    for (const q of group.questions || []) {
      if (
        q.condition &&
        (!visible.has(q.condition.questionId) ||
          !matchesSurveyCondition(q.condition, answers[q.condition.questionId]))
      )
        continue;
      visible.add(q.id);
      questions.push(q);
    }
    visibleByGroup.set(group.id, questions);
  }
  return groups
    .map((group) => ({ ...group, questions: visibleByGroup.get(group.id) }))
    .filter((group) => group.questions.length);
}

export function visibleSurveyQuestions(survey, answers) {
  return visibleSurveyGroups(survey, answers).flatMap((group) => group.questions);
}

export function pruneSurveyAnswers(survey, answers) {
  const visible = new Set(
    visibleSurveyQuestions(survey, answers).map((q) => q.id),
  );
  return Object.fromEntries(
    Object.entries(answers).filter(([id]) => visible.has(id)),
  );
}
