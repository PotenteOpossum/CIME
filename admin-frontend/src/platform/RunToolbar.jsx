import { useEffect, useState } from "react";
import { runId, storage } from "./context.js";
import { useAdminAuth } from "../contexts/AdminAuthContext.jsx";
import { platformPath, platformRequest } from './platformApi.js';

export default function RunToolbar() {
  const { token } = useAdminAuth();
  const [run, setRun] = useState(null);
  const [message, setMessage] = useState("");
  async function request(options) {
    return platformRequest(`/platform/runs/${runId}`, token, options);
  }
  useEffect(() => {
    request()
      .then((data) => setRun(data.run))
      .catch((e) => setMessage(e.message));
  }, [token]);
  async function save() {
    try {
      const parse = (key) => {
        try {
          return JSON.parse(storage.getItem(key) || "[]");
        } catch {
          return [];
        }
      };
      const config = {
        ...run.config,
        globalQuestion: storage.getItem("cime_draft_global_question") || "",
        decisionContext: storage.getItem("cime_draft_decision_context") || "",
        generalDescription:
          storage.getItem("cime_draft_general_description") || "",
        deliberationQuestions: parse("cime_draft_deliberation_questions"),
        generalQuestionAnswers: parse("cime_draft_general_question_answers"),
      };
      const response = await platformRequest(`/platform/runs/${runId}/engine/admin/decision-process/settings`, token);
      config.settings = response.settings;
      const data = await request({
        method: "PATCH",
        body: JSON.stringify({ config }),
      });
      setRun(data.run);
      setMessage("Draft saved");
    } catch (error) {
      setMessage(error.message);
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-6 py-4 text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <a
        className="text-emerald-700 dark:text-emerald-400"
        href={platformPath(`/#/runs/${runId}`)}
      >
        ← Invitations and participants
      </a>
      <strong>{run?.title || "Decision workspace"} · Full CIME</strong>
      <div className="flex items-center gap-3">
        <span role="status" className="text-sm">
          {message}
        </span>
        {run && ["draft", "recruiting"].includes(run.status) && (
          <button
            className="rounded-lg bg-emerald-700 px-4 py-2 text-white"
            onClick={save}
          >
            Save draft
          </button>
        )}
      </div>
    </div>
  );
}
