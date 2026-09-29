function readArray(storage, key) {
  try {
    const value = JSON.parse(storage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

export function hasDecisionDraft(storage) {
  return ['global_question', 'decision_context', 'general_description']
    .some(field => hasText(storage.getItem(`cime_draft_${field}`)))
    || readArray(storage, 'cime_draft_deliberation_questions').some(question =>
      hasText(question?.topic) || hasText(question?.question_text)
      || (Array.isArray(question?.predefined_answers) && question.predefined_answers.some(hasText)))
    || readArray(storage, 'cime_draft_general_question_answers').some(hasText);
}

export function decisionDraftFromServer(decision) {
  const questions = Array.isArray(decision.deliberation_questions) ? decision.deliberation_questions : [];
  const generalQuestion = questions.find(question => question.is_general_question);
  return {
    globalQuestion: decision.global_question || '',
    decisionContext: decision.decision_context || '',
    generalDescription: decision.general_description || '',
    deliberationQuestions: questions.filter(question => !question.is_general_question),
    generalQuestionAnswers: Array.isArray(generalQuestion?.predefined_answers)
      ? generalQuestion.predefined_answers : ['', '']
  };
}
