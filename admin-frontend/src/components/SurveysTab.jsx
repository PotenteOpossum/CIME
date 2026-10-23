import { useEffect, useRef, useState } from "react";
import { surveyToJson, parseSurveyJson } from "../utils/surveyJson.js";
import { apiRequest, apiDownload } from "../api/client.js";
import SurveyScalePreview from "./SurveyScalePreview.jsx";
import {
  allSurveyQuestions,
  visibleSurveyGroups,
  pruneSurveyAnswers,
} from "../../../shared/surveyLogic.mjs";
import { emptySurvey, normalizeSurvey } from "../../../shared/surveySchema.mjs";

const TYPES = {
  text: "Free text",
  single_choice: "Choose one",
  multiple_choice: "Choose several",
  scale: "Numeric scale",
};
const OPS = {
  equals: "is",
  not_equals: "is not",
  includes: "includes",
  not_includes: "does not include",
  gte: "is at least",
  lte: "is at most",
};
const field = "survey-field";
const button = "survey-button";
function normalizeSurveyDefinitions(definitions) {
  return Object.fromEntries(
    ["pre", "post"].map((stage) => {
      const saved = definitions?.[stage];
      if (!saved) return [stage, emptySurvey(stage)];

      const hasQuestions = Array.isArray(saved.groups)
        ? saved.groups.some((group) => group?.questions?.length)
        : Array.isArray(saved.questions) && saved.questions.length > 0;
      let compatible = saved;
      if (saved.groups === undefined && saved.questions === undefined) {
        compatible = { ...saved, groups: [] };
      }
      if (!hasQuestions && compatible.enabled) {
        compatible = { ...compatible, enabled: false };
      }
      return [stage, normalizeSurvey(compatible, stage)];
    }),
  );
}
const operators = (q) =>
  q?.type === "multiple_choice"
    ? ["includes", "not_includes"]
    : q?.type === "scale"
      ? ["equals", "not_equals", "gte", "lte"]
      : ["equals", "not_equals"];

function Preview({ survey }) {
  const [answers, setAnswers] = useState({});
  const change = (id, value) =>
    setAnswers((previous) =>
      pruneSurveyAnswers(survey, { ...previous, [id]: value }),
    );
  return (
    <div className="survey-preview-print mt-5 rounded-2xl border border-slate-300 bg-white p-6 text-slate-900">
      <h3 className="text-xl font-semibold">
        Participant preview: {survey.title}
      </h3>
      <p className="whitespace-pre-wrap my-3">{survey.description}</p>
      <p className="text-sm text-slate-500">
        Try answers to test branching. Preview answers are not saved.
      </p>
      {visibleSurveyGroups(survey, answers).map((group) => (
        <section key={group.id} className="my-6 rounded-xl border border-slate-200 p-4">
          {group.title && <h4 className="text-lg font-semibold">{group.title}</h4>}
          {group.description && <p className="my-2 whitespace-pre-wrap text-slate-600">{group.description}</p>}
          {group.questions.map((q) => (
            <div
              key={q.id}
              className="survey-question my-5"
              role="group"
              aria-labelledby={`preview-question-${q.id}`}
            >
              <div id={`preview-question-${q.id}`} className="survey-question-label">
                {q.label || "Untitled question"}
                {q.required && " *"}
              </div>
              {q.type === "text" && (
                <textarea
                  className={field}
                  aria-label={q.label}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => change(q.id, e.target.value)}
                />
              )}
              {q.type === "multiple_choice" &&
                q.options.map((option, i) => (
                  <label key={i} className="flex items-center gap-2 py-2">
                    <input
                      type="checkbox"
                      name={`preview-${q.id}`}
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
                    {option || "(empty option)"}
                  </label>
                ))}
              {(q.type === "scale" || q.type === "single_choice") && (
                <SurveyScalePreview
                  question={q}
                  value={answers[q.id]}
                  onChange={(value) => change(q.id, value)}
                />
              )}
            </div>
          ))}
        </section>
      ))}
      <button type="button" className={button} onClick={() => setAnswers({})}>
        Reset preview
      </button>
    </div>
  );
}

export default function SurveysTab({ token }) {
  const [surveys, setSurveys] = useState(null);
  const [stage, setStage] = useState("pre");
  const [locked, setLocked] = useState(false);
  const [responses, setResponses] = useState([]);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState("form");
  const [jsonDrafts, setJsonDrafts] = useState({ pre: null, post: null });
  const [previewSurvey, setPreviewSurvey] = useState(null);
  const fileInput = useRef(null);
  const jsonInput = useRef(null);
  useEffect(() => {
    let live = true;
    const load = (initial = false) =>
      apiRequest("/admin/surveys", {}, token)
        .then((data) => {
          if (!live) return;
          if (initial) setSurveys(normalizeSurveyDefinitions(data.surveys));
          setLocked(Boolean(data.locked));
          setResponses(Array.isArray(data.responses) ? data.responses : []);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load(true);
    const timer = setInterval(() => load(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [token]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const survey = surveys?.[stage];
  const stageLabel = stage === "pre" ? "Before experiment" : "After experiment";
  const jsonValue =
    jsonDrafts[stage] ?? (survey ? surveyToJson(survey, stage) : "");
  function currentSurvey(value = stage) {
    return jsonDrafts[value] === null
      ? surveys[value]
      : parseSurveyJson(jsonDrafts[value], value);
  }
  function switchMode(next) {
    try {
      if (mode === "json" && next === "form") {
        const parsed = currentSurvey();
        setSurveys((previous) => ({ ...previous, [stage]: parsed }));
        setJsonDrafts((previous) => ({ ...previous, [stage]: null }));
      }
      setMode(next);
      setError("");
      setPreview(false);
    } catch (e) {
      setError(`${stageLabel}: ${e.message}`);
    }
  }
  function downloadJson(content, filename) {
    const url = URL.createObjectURL(
      new Blob([content], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importJson(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 200000)
        throw new Error("Survey JSON must be smaller than 200 KB.");
      const parsed = parseSurveyJson(await file.text(), stage);
      setSurveys((previous) => ({ ...previous, [stage]: parsed }));
      setJsonDrafts((previous) => ({
        ...previous,
        [stage]: surveyToJson(parsed, stage),
      }));
      setMode("json");
      setDirty(true);
      setPreview(false);
      setError("");
      setNotice(
        `Imported ${stageLabel.toLowerCase()} survey from ${file.name}. Save changes to publish it.`,
      );
    } catch (e) {
      setError(e.message);
    }
  }
  function exportJson() {
    try {
      downloadJson(
        surveyToJson(currentSurvey(), stage),
        `cime-${stage}-experiment-survey.json`,
      );
      setError("");
    } catch (e) {
      setError(e.message);
    }
  }
  async function copyJson() {
    try {
      await navigator.clipboard.writeText(surveyToJson(currentSurvey(), stage));
      setNotice(`${stageLabel} survey JSON copied.`);
      setError("");
    } catch (e) {
      setError(
        `Could not copy: ${e.message}. You can select and copy the JSON in the editor.`,
      );
      jsonInput.current?.focus();
      jsonInput.current?.select();
    }
  }
  function formatJson() {
    try {
      setJsonDrafts((previous) => ({
        ...previous,
        [stage]: surveyToJson(currentSurvey(), stage),
      }));
      setError("");
      setNotice(`${stageLabel} JSON is valid.`);
    } catch (e) {
      setError(`${stageLabel}: ${e.message}`);
    }
  }
  function togglePreview() {
    try {
      setPreviewSurvey(currentSurvey());
      setPreview((value) => !value);
      setError("");
    } catch (e) {
      setError(`${stageLabel}: ${e.message}`);
    }
  }
  function update(patch) {
    setSurveys((previous) => ({
      ...previous,
      [stage]: { ...previous[stage], ...patch },
    }));
    setDirty(true);
    setJsonDrafts((previous) => ({ ...previous, [stage]: null }));
    setPreview(false);
    setNotice("");
    setError("");
  }
  function updateQuestion(id, patch) {
    update({
      groups: survey.groups.map((group) => ({
        ...group,
        questions: group.questions.map((q) =>
          q.id === id ? { ...q, ...patch } : q,
        ),
      })),
    });
  }
  function addGroup() {
    update({
      groups: [
        ...survey.groups,
        {
          id: `section_${crypto.randomUUID()}`,
          title: "New section",
          description: "",
          questions: [],
        },
      ],
    });
  }
  function updateGroup(id, patch) {
    update({ groups: survey.groups.map((group) => group.id === id ? { ...group, ...patch } : group) });
  }
  function removeGroup(id) {
    const group = survey.groups.find((item) => item.id === id);
    if (group?.questions.length) {
      setError("Remove this section's questions before removing the section.");
      return;
    }
    update({ groups: survey.groups.filter((item) => item.id !== id) });
  }
  function addQuestion(groupId) {
    update({
      groups: survey.groups.map((group) => group.id === groupId ? {
        ...group,
        questions: [...group.questions, {
          id: `q_${crypto.randomUUID()}`,
          label: "",
          type: "text",
          required: true,
        }],
      } : group),
    });
  }
  function removeQuestion(id) {
    const questions = allSurveyQuestions(survey);
    if (questions.some((q) => q.condition?.questionId === id)) {
      setError(
        "Another question depends on this answer. Remove that condition first.",
      );
      return;
    }
    update({ groups: survey.groups.map((group) => ({ ...group, questions: group.questions.filter((q) => q.id !== id) })) });
  }
  function moveQuestion(groupId, index, offset) {
    const group = survey.groups.find((item) => item.id === groupId);
    const nextGroupQuestions = [...group.questions];
    const target = index + offset;
    if (target < 0 || target >= nextGroupQuestions.length) return;
    [nextGroupQuestions[index], nextGroupQuestions[target]] = [nextGroupQuestions[target], nextGroupQuestions[index]];
    const nextGroups = survey.groups.map((item) => item.id === groupId ? { ...item, questions: nextGroupQuestions } : item);
    const next = nextGroups.flatMap((item) => item.questions);
    const seen = new Set();
    for (const q of next) {
      if (q.condition && !seen.has(q.condition.questionId)) {
        setError(
          "A conditional question must stay below the question it depends on.",
        );
        return;
      }
      seen.add(q.id);
    }
    update({ groups: nextGroups });
  }
  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const payload = Object.fromEntries(
        ["pre", "post"].map((value) => {
          try {
            return [value, currentSurvey(value)];
          } catch (e) {
            throw new Error(
              `${value === "pre" ? "Before" : "After"} experiment: ${e.message}`,
            );
          }
        }),
      );
      const data = await apiRequest(
        "/admin/surveys",
        { method: "PUT", body: JSON.stringify(payload) },
        token,
      );
      setSurveys(normalizeSurveyDefinitions(data.surveys));
      setJsonDrafts({ pre: null, post: null });
      setDirty(false);
      setNotice("Both survey configurations saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    try {
      const { blob, filename } = await apiDownload(
        "/admin/surveys/export",
        token,
      );
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e.message);
    }
  }
  if (!surveys)
    return (
      <section className="p-6">
        <h1 className="text-2xl">Experiment surveys</h1>
        <p role={error ? "alert" : undefined}>{error || "Loading surveys…"}</p>
      </section>
    );
  return (
    <section className="survey-page">
      <header className="survey-page-header">
        <div>
          <p className="survey-eyebrow">Experiment setup</p>
          <h1>Experiment surveys</h1>
          <p>
            Create two independent questionnaires. Choose when participants will
            answer, then use the form or JSON editor.
          </p>
        </div>
        <button type="button" className={button} onClick={download}>
          Download responses
        </button>
      </header>
      <div
        className="survey-stage-tabs"
        role="tablist"
        aria-label="Survey timing"
      >
        {["pre", "post"].map((value) => (
          <button
            type="button"
            className="survey-stage-tab"
            role="tab"
            id={`survey-tab-${value}`}
            aria-selected={stage === value}
            aria-controls="survey-editor-panel"
            key={value}
            onClick={() => {
              setStage(value);
              setPreview(false);
              setError("");
              setNotice("");
            }}
          >
            <span className="survey-stage-name">
              <span className="survey-stage-number">
                {value === "pre" ? "1" : "2"}
              </span>
              {value === "pre" ? "Before experiment" : "After experiment"}
              <span className="survey-stage-selection">
                {stage === value ? "Editing" : "Select"}
              </span>
            </span>
            <span className="survey-stage-description">
              {value === "pre"
                ? "Pre-survey · in the waiting room, before discussion starts"
                : "Post-survey · after the decision, before completion"}
            </span>
            <span className="survey-stage-status">
              {jsonDrafts[value] !== null
                ? "JSON draft"
                : surveys[value].enabled
                  ? "Enabled"
                  : "Not enabled"}{" "}
              · {responses.filter((r) => r.stage === value).length} submitted
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="my-3 text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="my-3 text-emerald-700">
          {notice}
        </p>
      )}
      {locked && (
        <p className="rounded-xl bg-amber-50 p-4">
          Questions are locked after the first response or experiment start.
          Repeat this run to reuse and edit its surveys.
        </p>
      )}
      <section
        id="survey-editor-panel"
        role="tabpanel"
        aria-labelledby={`survey-tab-${stage}`}
        className="survey-editor-panel"
      >
        <header className="survey-editor-heading">
          <p className="survey-eyebrow">
            {stage === "pre"
              ? "Pre-experiment questionnaire"
              : "Post-experiment questionnaire"}
          </p>
          <h2>Editing: {stageLabel.toLowerCase()}</h2>
          <p>
            {stage === "pre"
              ? "Participants answer this survey while waiting. Everyone must submit it before you can start the experiment."
              : "Participants answer this survey after the decision completes and before receiving the Prolific return link."}
          </p>
        </header>
        <div className="survey-editor-toolbar">
          <div
            className="survey-mode-switch"
            role="group"
            aria-label="Editor mode"
          >
            <button
              type="button"
              className={button}
              aria-pressed={mode === "form"}
              onClick={() => switchMode("form")}
            >
              Form editor
            </button>
            <button
              type="button"
              className={button}
              aria-pressed={mode === "json"}
              onClick={() => switchMode("json")}
            >
              JSON editor
            </button>
          </div>
          <div className="survey-file-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              aria-label={`Import ${stageLabel.toLowerCase()} survey JSON`}
              onChange={importJson}
            />
            <button
              type="button"
              className={button}
              disabled={locked || busy}
              onClick={() => fileInput.current?.click()}
            >
              Import JSON file
            </button>
            <button type="button" className={button} onClick={exportJson}>
              Download survey JSON
            </button>
          </div>
        </div>
        <fieldset disabled={locked || busy} className="survey-editor-fields">
          {mode === "json" ? (
            <div className="survey-json-panel">
              <div className="survey-json-label">
                <label htmlFor="survey-json-editor">
                  {stageLabel} survey JSON
                </label>
                <span>
                  {stage === "pre" ? '"stage": "pre"' : '"stage": "post"'}
                </span>
              </div>
              <p>
                Edit or paste this questionnaire. Changes stay in this survey;
                the other survey is kept separately.
              </p>
              <textarea
                ref={jsonInput}
                id="survey-json-editor"
                className="survey-json-editor"
                value={jsonValue}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => {
                  setJsonDrafts((previous) => ({
                    ...previous,
                    [stage]: e.target.value,
                  }));
                  setDirty(true);
                  setError("");
                  setNotice("");
                  setPreview(false);
                }}
              />
              <div className="survey-actions">
                <button type="button" className={button} onClick={formatJson}>
                  Validate & format
                </button>
                <button type="button" className={button} onClick={copyJson}>
                  Copy JSON
                </button>
              </div>
              <details className="survey-json-help">
                <summary>JSON format & conditional questions</summary>
                <p>
                  Use <code>enabled</code>, <code>title</code>,{" "}
                  <code>description</code>, and a <code>groups</code> array.
                  Each group has an <code>id</code>, <code>title</code>, optional{" "}
                  shared <code>description</code>, and nested{" "}
                  <code>questions</code>. Questions need a unique{" "}
                  <code>id</code>, <code>label</code>, <code>type</code>, and{" "}
                  <code>required</code> flag. Existing flat question files can
                  still be imported.
                </p>
                <p>
                  Types: <code>text</code>, <code>single_choice</code>,{" "}
                  <code>multiple_choice</code>, <code>scale</code>. Choices need{" "}
                  <code>options</code>; single-choice questions may mark special
                  responses with an <code>alternativeOptions</code> array whose
                  entries match the option text exactly. Common nonresponse labels
                  are detected automatically when this is omitted. Scales need <code>min</code> and{" "}
                  <code>max</code>, with optional <code>minLabel</code>,{" "}
                  <code>midLabel</code>, and <code>maxLabel</code>.
                </p>
                <p>
                  A condition references an earlier question. For an “otherwise”
                  branch use <code>not_equals</code> instead of{" "}
                  <code>equals</code>:
                </p>
                <pre>
                  {JSON.stringify(
                    {
                      condition: {
                        questionId: "previous_question_id",
                        operator: "equals",
                        value: "Yes",
                      },
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>A section keeps a repeated prompt above its nested questions:</p>
                <pre>
                  {JSON.stringify(
                    {
                      groups: [
                        {
                          id: "discussion",
                          title: "Your subgroup discussion",
                          description: "Think only about the discussion after your personal interaction with CIME.",
                          questions: [
                            { id: "balanced", type: "scale", label: "Contributions were reasonably balanced across participants.", required: false, min: 1, max: 7, minLabel: "Strongly disagree", midLabel: "Neither", maxLabel: "Strongly agree" },
                          ],
                        },
                      ],
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  Operators: <code>equals</code>, <code>not_equals</code>;{" "}
                  <code>includes</code>, <code>not_includes</code> for multiple
                  choices; <code>gte</code>, <code>lte</code> for scales.
                  Neither branch appears until the source is answered.
                </p>
              </details>
            </div>
          ) : (
            <>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={survey.enabled}
                  onChange={(e) => update({ enabled: e.target.checked })}
                />
                Enable {stage === "pre" ? "pre" : "post"}-experiment survey
              </label>
              <label className="block">
                Survey title
                <input
                  className={field}
                  maxLength={200}
                  value={survey.title}
                  onChange={(e) => update({ title: e.target.value })}
                />
              </label>
              <label className="block">
                Instructions (optional)
                <textarea
                  className={field}
                  maxLength={5000}
                  value={survey.description}
                  onChange={(e) => update({ description: e.target.value })}
                />
              </label>
              <div>
                <h2 className="mb-1 text-lg font-semibold">Question sections</h2>
                <p className="mb-4 text-sm text-slate-600">
                  Put related questions together and write a shared instruction once for the whole section.
                </p>
              </div>
              {survey.groups.map((group) => (
                <section key={group.id} className="rounded-2xl border border-emerald-200 bg-emerald-50/40 p-5 space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      Section heading (optional)
                      <input className={field} maxLength={200} value={group.title} onChange={(e) => updateGroup(group.id, { title: e.target.value })} />
                    </label>
                    <label className="block">
                      Shared instruction (shown once above this section)
                      <textarea className={field} maxLength={5000} value={group.description} onChange={(e) => updateGroup(group.id, { description: e.target.value })} />
                    </label>
                  </div>
                  {group.questions.map((q, index) => {
                    const allQuestions = allSurveyQuestions(survey);
                    const globalIndex = allQuestions.findIndex((item) => item.id === q.id);
                    const earlier = allQuestions.slice(0, globalIndex);
                    const source = earlier.find(
                      (item) => item.id === q.condition?.questionId,
                    );
                    return (
                  <div
                    key={q.id}
                    className="rounded-2xl border border-slate-300 bg-white p-5 space-y-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold mr-auto">
                        Question {globalIndex + 1}
                      </h2>
                      <button
                        type="button"
                        className={button}
                        disabled={index === 0}
                        onClick={() => moveQuestion(group.id, index, -1)}
                        aria-label={`Move question ${globalIndex + 1} up`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className={button}
                        disabled={index === group.questions.length - 1}
                        onClick={() => moveQuestion(group.id, index, 1)}
                        aria-label={`Move question ${globalIndex + 1} down`}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className={button}
                        onClick={() => removeQuestion(q.id)}
                      >
                        Remove
                      </button>
                    </div>
                    <label className="block">
                      Question text
                      <textarea
                        className={field}
                        maxLength={2000}
                        value={q.label}
                        onChange={(e) =>
                          updateQuestion(q.id, { label: e.target.value })
                        }
                      />
                    </label>
                    <div className="flex flex-wrap items-center gap-4">
                      <label>
                        Answer type
                        <select
                          className={field}
                          value={q.type}
                          onChange={(e) =>
                            updateQuestion(q.id, {
                              type: e.target.value,
                              ...(e.target.value.includes("choice")
                                ? { options: ["Yes", "No"] }
                                : {}),
                              ...(e.target.value !== "single_choice"
                                ? { alternativeOptions: undefined }
                                : {}),
                              ...(e.target.value === "scale"
                                ? { min: 1, max: 5, minLabel: "", midLabel: "", maxLabel: "" }
                                : {}),
                            })
                          }
                        >
                          {Object.entries(TYPES).map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={q.required}
                          onChange={(e) =>
                            updateQuestion(q.id, { required: e.target.checked })
                          }
                        />
                        Required
                      </label>
                    </div>
                    {q.type.includes("choice") && (
                      <label className="block">
                        Options (one per line, 2–30)
                        <textarea
                          className={field}
                          rows={4}
                          value={q.options.join("\n")}
                          onChange={(e) =>
                            updateQuestion(q.id, {
                              options: e.target.value.split("\n"),
                            })
                          }
                        />
                      </label>
                    )}
                    {q.type === "single_choice" && (
                      <label className="block">
                        Alternative answers (exact option text, one per line)
                        <textarea
                          className={field}
                          rows={2}
                          placeholder={"Don't know\nPrefer not to answer"}
                          value={(q.alternativeOptions || []).join("\n")}
                          onChange={(e) =>
                            updateQuestion(q.id, {
                              alternativeOptions: e.target.value.trim()
                                ? e.target.value
                                    .split("\n")
                                    .map((option) => option.trim())
                                    .filter(Boolean)
                                : undefined,
                            })
                          }
                        />
                        <span className="mt-1 block text-xs text-slate-500">
                          Common “don’t know”, “prefer not”, and “not applicable”
                          answers are detected automatically when this is blank.
                        </span>
                      </label>
                    )}
                    {q.type === "scale" && (
                      <div className="grid sm:grid-cols-2 gap-4">
                        <label>
                          Minimum
                          <input
                            className={field}
                            type="number"
                            min={-100}
                            max={99}
                            value={q.min}
                            onChange={(e) =>
                              updateQuestion(q.id, {
                                min: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          Maximum
                          <input
                            className={field}
                            type="number"
                            min={-99}
                            max={100}
                            value={q.max}
                            onChange={(e) =>
                              updateQuestion(q.id, {
                                max: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          Minimum label
                          <input
                            className={field}
                            maxLength={200}
                            value={q.minLabel}
                            onChange={(e) =>
                              updateQuestion(q.id, { minLabel: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Middle label
                          <input
                            className={field}
                            maxLength={200}
                            value={q.midLabel || ""}
                            onChange={(e) =>
                              updateQuestion(q.id, { midLabel: e.target.value })
                            }
                          />
                        </label>
                        <label>
                          Maximum label
                          <input
                            className={field}
                            maxLength={200}
                            value={q.maxLabel}
                            onChange={(e) =>
                              updateQuestion(q.id, { maxLabel: e.target.value })
                            }
                          />
                        </label>
                      </div>
                    )}
                    <div className="rounded-xl bg-slate-50 p-4 space-y-3">
                      <label className="block">
                        Show this question
                        <select
                          className={field}
                          value={q.condition?.questionId || ""}
                          onChange={(e) => {
                            const previous = earlier.find(
                              (item) => item.id === e.target.value,
                            );
                            updateQuestion(q.id, {
                              condition: previous
                                ? {
                                    questionId: previous.id,
                                    operator: operators(previous)[0],
                                    value:
                                      previous.type === "scale"
                                        ? previous.min
                                        : previous.options?.[0] || "",
                                  }
                                : null,
                            });
                          }}
                        >
                          <option value="">Always</option>
                          {earlier.map((item, i) => (
                            <option key={item.id} value={item.id}>
                              When answering {i + 1}.{" "}
                              {item.label || "Untitled question"}
                            </option>
                          ))}
                        </select>
                      </label>
                      {source && (
                        <div className="flex flex-wrap gap-3">
                          <label>
                            Answer
                            <select
                              className={field}
                              value={q.condition.operator}
                              onChange={(e) =>
                                updateQuestion(q.id, {
                                  condition: {
                                    ...q.condition,
                                    operator: e.target.value,
                                  },
                                })
                              }
                            >
                              {operators(source).map((value) => (
                                <option key={value} value={value}>
                                  {OPS[value]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            Value
                            {source.options &&
                            source.type.includes("choice") ? (
                              <select
                                className={field}
                                value={q.condition.value}
                                onChange={(e) =>
                                  updateQuestion(q.id, {
                                    condition: {
                                      ...q.condition,
                                      value: e.target.value,
                                    },
                                  })
                                }
                              >
                                {source.options.map((value, i) => (
                                  <option key={i} value={value}>
                                    {value}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                className={field}
                                type={
                                  source.type === "scale" ? "number" : "text"
                                }
                                value={q.condition.value}
                                onChange={(e) =>
                                  updateQuestion(q.id, {
                                    condition: {
                                      ...q.condition,
                                      value:
                                        source.type === "scale"
                                          ? Number(e.target.value)
                                          : e.target.value,
                                    },
                                  })
                                }
                              />
                            )}
                          </label>
                        </div>
                      )}
                      <p className="text-sm text-slate-500">
                        For an if/otherwise branch, add two questions with the
                        same source: use “is” for A and “is not” for B. Neither
                        appears until the source is answered. Text comparisons
                        match the complete answer after trimming spaces.
                      </p>
                    </div>
                  </div>
                );
                  })}
                  <div className="survey-actions">
                    <button type="button" className={button} onClick={() => addQuestion(group.id)} disabled={allSurveyQuestions(survey).length >= 100}>
                      Add question to section
                    </button>
                    <button type="button" className={button} onClick={() => removeGroup(group.id)} disabled={group.questions.length > 0}>
                      Remove empty section
                    </button>
                  </div>
                </section>
              ))}
              <div className="survey-actions">
                <button
                  type="button"
                  className={button}
                  onClick={addGroup}
                  disabled={survey.groups.length >= 100}
                >
                  Add question section
                </button>
              </div>
            </>
          )}
        </fieldset>
        <footer className="survey-editor-footer">
          <p role="status">
            {dirty
              ? "Unsaved changes. Save before leaving or inviting participants."
              : "Both surveys are saved."}
          </p>
          <div className="survey-actions">
            <button type="button" className={button} onClick={togglePreview}>
              {preview ? "Hide preview" : "Preview branching"}
            </button>
            <button
              type="button"
              className={button}
              disabled={!preview || !previewSurvey}
              onClick={() => window.print()}
            >
              Download preview as PDF
            </button>
            <button
              type="button"
              className="survey-button survey-button-primary"
              disabled={locked || busy || !dirty}
              onClick={save}
            >
              {busy ? "Saving…" : "Save survey changes"}
            </button>
          </div>
        </footer>
        {preview && previewSurvey && (
          <Preview key={stage} survey={previewSurvey} />
        )}
      </section>
      <details className="my-6">
        <summary className="cursor-pointer font-semibold">
          Submitted responses ({responses.length})
        </summary>
        <div className="overflow-x-auto">
          <table className="w-full text-sm my-3">
            <thead>
              <tr>
                <th className="text-left p-2">Participant</th>
                <th className="text-left p-2">Survey</th>
                <th className="text-left p-2">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {responses.map((r) => (
                <tr key={`${r.stage}:${r.user_id}`}>
                  <td className="p-2">{r.username}</td>
                  <td className="p-2">
                    {r.stage === "pre" ? "Before" : "After"}
                  </td>
                  <td className="p-2">
                    {new Date(r.submitted_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-sm text-slate-500">
          The JSON download includes question definitions and individual
          answers, linked by participant and run. Treat it as participant
          research data.
        </p>
      </details>
    </section>
  );
}
