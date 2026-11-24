export const DISCUSSION_TYPES = ["full", "simplified"];
export const getDiscussionType = (config) => config?.discussionType || "full";
export const defaultFinalAnswers = () => [
  "No",
  "Probably no, but I can try",
  "I am hesitant",
  "Maybe",
  "Yes, I am open",
  "Yes, very open",
];
export function validateDiscussionType(value) {
  if (!DISCUSSION_TYPES.includes(value))
    throw Object.assign(new Error("Choose Full or Simplified CIME."), {
      status: 400,
    });
  return value;
}
export function validateSimplifiedTopics(config) {
  validateDiscussionType(getDiscussionType(config));
  if (getDiscussionType(config) !== "simplified") return;
  if (
    !Array.isArray(config.deliberationQuestions) ||
    !config.deliberationQuestions.length
  )
    throw Object.assign(new Error("Add at least one discussion topic."), {
      status: 400,
    });
  for (const [index, topic] of config.deliberationQuestions.entries()) {
    if (
      !topic ||
      typeof topic !== "object" ||
      typeof topic.topic !== "string" ||
      !topic.topic.trim() ||
      typeof (topic.question_text ?? topic.question) !== "string" ||
      !(topic.question_text ?? topic.question).trim()
    )
      throw Object.assign(
        new Error(`Give topic ${index + 1} a name and discussion question.`),
        { status: 400 },
      );
    if (
      typeof topic.durationMinutes !== "number" ||
      !Number.isFinite(topic.durationMinutes) ||
      topic.durationMinutes <= 0 ||
      topic.durationMinutes > 1440
    )
      throw Object.assign(
        new Error(
          `Set a discussion time greater than 0 and at most 1,440 minutes for topic ${index + 1}.`,
        ),
        { status: 400 },
      );
    if (
      !Array.isArray(topic.predefined_answers) ||
      topic.predefined_answers.some((value) => typeof value !== "string")
    )
      throw Object.assign(
        new Error(`Give topic ${index + 1} possible outcomes as text.`),
        { status: 400 },
      );
    const options = new Set(
      topic.predefined_answers
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (options.size < 2)
      throw Object.assign(
        new Error(
          `Give topic ${index + 1} at least two different possible outcomes to discuss.`,
        ),
        { status: 400 },
      );
  }
}
