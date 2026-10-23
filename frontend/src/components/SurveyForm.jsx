import { useState } from "react";
import { apiRequest } from "../api/client.js";
import { sessionKey } from "../platform/client.js";
import {
  visibleSurveyGroups,
  pruneSurveyAnswers,
  hasSurveyAnswer,
} from "../../../shared/surveyLogic.mjs";
import SurveyScale from "./SurveyScale.jsx";
import "../../../shared/surveyScale.css";

export default function SurveyForm({ survey, token, userId, onSubmitted }) {
  const draftKey = sessionKey(`survey:${survey.stage}:${userId}`);
  const [answers, setAnswers] = useState(() => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(draftKey));
      return draft?.definition === JSON.stringify(survey) ? draft.answers : {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const visibleGroups = visibleSurveyGroups(survey, answers);
  const visible = visibleGroups.flatMap((group) => group.questions);
  function change(id, value) {
    const next = pruneSurveyAnswers(survey, { ...answers, [id]: value });
    setAnswers(next);
    try {
      sessionStorage.setItem(
        draftKey,
        JSON.stringify({ definition: JSON.stringify(survey), answers: next }),
      );
    } catch {
      /* Draft persistence is optional. */
    }
    setError("");
  }
  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const missing = visible.find(
      (q) => q.required && !hasSurveyAnswer(answers[q.id]),
    );
    if (missing) {
      setError(`Please answer: ${missing.label}`);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        `/surveys/${survey.stage}/responses`,
        {
          method: "POST",
          body: JSON.stringify({
            answers: pruneSurveyAnswers(survey, answers),
          }),
        },
        token,
      );
      sessionStorage.removeItem(draftKey);
      onSubmitted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="platform-card platform-account"
      style={{ maxWidth: 780, margin: "24px auto" }}
    >
      <span className="platform-eyebrow">
        {survey.stage === "pre"
          ? "Pre-experiment survey"
          : "Post-experiment survey"}
      </span>
      <h1>{survey.title}</h1>
      {survey.description && (
        <p style={{ whiteSpace: "pre-wrap" }}>{survey.description}</p>
      )}
      <p>
        Questions marked * are required. Your answers are saved when you submit
        and are visible to the organiser.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy} style={{ border: 0, padding: 0 }}>
          {(() => {
            let questionNumber = 0;
            return visibleGroups.map((group) => (
              <section key={group.id} className="survey-question-group">
                {group.title && <h2 className="survey-group-title">{group.title}</h2>}
                {group.description && (
                  <p className="survey-group-description">{group.description}</p>
                )}
                {group.questions.map((q) => {
                  questionNumber += 1;
                  return (
                    <div
                      key={q.id}
                      className="survey-question"
                      role="group"
                      aria-labelledby={`survey-question-${q.id}`}
                    >
                      <div id={`survey-question-${q.id}`} className="survey-question-label">
                        {questionNumber}. {q.label}
                        {q.required ? " *" : " (optional)"}
                      </div>
                      {q.type === "text" && (
                        <textarea
                          aria-label={q.label}
                          rows={4}
                          maxLength={10000}
                          required={q.required}
                          value={answers[q.id] ?? ""}
                          onChange={(e) => change(q.id, e.target.value)}
                        />
                      )}
                      {q.type === "multiple_choice" &&
                        q.options.map((option) => (
                          <label
                            key={option}
                            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}
                          >
                            <input
                              style={{ width: "auto", margin: 0 }}
                              type="checkbox"
                              name={q.id}
                              value={option}
                              checked={(answers[q.id] || []).includes(option)}
                              onChange={(e) =>
                                change(
                                  q.id,
                                  e.target.checked
                                    ? [...(answers[q.id] || []), option]
                                    : (answers[q.id] || []).filter((v) => v !== option),
                                )
                              }
                            />
                            {option}
                          </label>
                        ))}
                      {(q.type === "scale" || q.type === "single_choice") && (
                        <SurveyScale
                          question={q}
                          value={answers[q.id]}
                          onChange={(value) => change(q.id, value)}
                        />
                      )}
                      {!q.required && hasSurveyAnswer(answers[q.id]) && (
                        <button type="button" className="secondary" onClick={() => change(q.id, undefined)}>
                          Clear answer
                        </button>
                      )}
                    </div>
                  );
                })}
              </section>
            ));
          })()}
          {error && <p role="alert">{error}</p>}
          <button type="submit" className="platform-button">
            {busy ? "Submitting…" : "Submit survey"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
