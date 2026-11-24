import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAdminAuth } from "../contexts/AdminAuthContext.jsx";
import { apiRequest, apiDownload } from "../api/client.js";
import { useOwnedRun } from "./OwnedRunContext.jsx";
import { platformPath, platformRequest } from "./platformApi.js";
import SurveysTab from "../components/SurveysTab.jsx";
import { SIMPLIFIED_TABS } from "../../../shared/simplifiedCapabilities.mjs";
import "./simplifiedWorkspace.css";

const titles = Object.fromEntries(
  SIMPLIFIED_TABS.map((tab) => [tab.path, tab.label]),
);
function countdown(deadline, now) {
  if (!deadline) return "—";
  const seconds = Math.max(
    0,
    Math.ceil((new Date(deadline).getTime() - now) / 1000),
  );
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export default function SimplifiedWorkspace() {
  const { token } = useAdminAuth();
  const { run, refresh } = useOwnedRun();
  const location = useLocation();
  const active =
    location.pathname === "/quality"
      ? "/results"
      : titles[location.pathname]
        ? location.pathname
        : "/";
  const [settings, setSettings] = useState(null);
  const [models, setModels] = useState([]);
  const [settingsLocked, setSettingsLocked] = useState(false);
  const [overview, setOverview] = useState(null);
  const [logs, setLogs] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const [now, setNow] = useState(Date.now());
  const setupUrl = platformPath(`/#/runs/${run.id}`);
  const frozen =
    run.archived ||
    !["draft", "recruiting"].includes(run.status) ||
    settingsLocked;
  useEffect(() => {
    let live = true;
    apiRequest("/admin/simplified/settings", {}, token)
      .then((data) => {
        if (live) {
          setSettings(data.settings);
          setModels(data.availableModels);
          setSettingsLocked(data.locked);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [run.id, token]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const data = await apiRequest("/admin/simplified/overview", {}, token);
        if (live) setOverview(data);
        await refresh();
      } catch (e) {
        if (live) setError(e.message);
      }
    };
    load();
    const interval = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(interval);
    };
  }, [run.id, token, refresh]);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    if (active !== "/logs") return;
    let live = true;
    apiRequest("/admin/simplified/logs", {}, token)
      .then((data) => {
        if (live) setLogs(data.logs);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [active, token]);
  function change(key, value) {
    setSettings((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
    setInfo("");
  }
  async function perform(task, message) {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await task();
      await refresh();
      if (message) setInfo(message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    await perform(async () => {
      const data = await apiRequest(
        "/admin/simplified/settings",
        { method: "PUT", body: JSON.stringify(settings) },
        token,
      );
      setSettings(data.settings);
      setSettingsLocked(data.locked);
      setDirty(false);
    }, "Simplified settings saved.");
  }
  async function download() {
    await perform(async () => {
      const result = await apiDownload("/admin/decision-process/export", token);
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  }
  return (
    <div className="simple-workspace">
      <header className="simple-workspace-header">
        <a href={setupUrl}>← Discussion setup & participants</a>
        <span className="simple-workspace-badge">Simplified CIME</span>
        <span className="simple-workspace-status">
          {run.archived ? "Archived" : run.status}
        </span>
      </header>
      <div className="simple-workspace-heading">
        <p>Advanced workspace</p>
        <h1>{run.title}</h1>
        <p>One shared discussion · Timed topics · Final main-question ballot</p>
      </div>
      <nav
        className="simple-workspace-nav"
        aria-label="Simplified workspace navigation"
      >
        {SIMPLIFIED_TABS.map((tab) => (
          <Link
            key={tab.path}
            to={tab.path}
            aria-current={active === tab.path ? "page" : undefined}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <main>
        {error && (
          <p role="alert" className="simple-error">
            {error}
          </p>
        )}
        {info && (
          <p role="status" className="simple-info">
            {info}
          </p>
        )}
        {active === "/" && (
          <>
            <section className="simple-card">
              <h2>Topic schedule</h2>
              <p>
                Configure the question, background, opening message, discussion
                options, and minutes per topic on the discussion setup page.
              </p>
              {run.config.deliberationQuestions?.length ? (
                <ol className="simple-schedule">
                  {run.config.deliberationQuestions.map((topic, index) => (
                    <li key={index}>
                      <div>
                        <strong>{topic.topic}</strong>
                        <span>{topic.question_text || topic.question}</span>
                      </div>
                      <span>
                        {topic.durationMinutes
                          ? `${topic.durationMinutes} min`
                          : "Time not set"}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No discussion topics configured yet.</p>
              )}
              <a className="simple-button secondary" href={setupUrl}>
                Edit discussion setup
              </a>
            </section>
            <form className="simple-card" onSubmit={save}>
              <h2>Facilitator & timing</h2>
              <p>
                These settings apply to the shared chat and the final ballot.
                Individual topic times are configured above.
              </p>
              {frozen && (
                <p className="simple-info">
                  Settings are locked for this run. Repeat it to change its
                  configuration.
                </p>
              )}
              {!settings ? (
                <p role="status">Loading settings…</p>
              ) : (
                <fieldset disabled={frozen || busy}>
                  <div className="simple-settings-grid">
                    <label>
                      <span>Final vote duration (minutes)</span>
                      <input
                        type="number"
                        required
                        min="0.1"
                        max="120"
                        step="any"
                        value={settings.finalVoteMinutes}
                        onChange={(e) =>
                          change(
                            "finalVoteMinutes",
                            e.target.value === "" ? "" : Number(e.target.value),
                          )
                        }
                      />
                      <small>
                        The ballot opens automatically after the last topic and
                        closes at this deadline, or when everyone has voted.
                      </small>
                    </label>
                    <label>
                      <span>Quiet discussion reminder (minutes)</span>
                      <input
                        type="number"
                        required
                        min="0"
                        max="60"
                        step="any"
                        value={settings.quietMinutes}
                        onChange={(e) =>
                          change(
                            "quietMinutes",
                            e.target.value === "" ? "" : Number(e.target.value),
                          )
                        }
                      />
                      <small>
                        Minutes of silence before the facilitator invites
                        contributions. Set 0 to turn reminders off.
                      </small>
                    </label>
                    <label>
                      <span>Mid-discussion interventions</span>
                      <select
                        value={settings.interventionEnabled ? "on" : "off"}
                        onChange={(e) =>
                          change("interventionEnabled", e.target.value === "on")
                        }
                      >
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                      <small>
                        After participants pause, the facilitator checks
                        whether to step in: suggest a compromise, summarize,
                        invite quieter participants, refocus, or answer a
                        question. Full CIME uses the same check.
                      </small>
                    </label>
                    <label>
                      <span>Minimum gap between interventions (seconds)</span>
                      <input
                        type="number"
                        required
                        min="30"
                        max="600"
                        step="1"
                        value={settings.interventionCooldownSeconds}
                        onChange={(e) =>
                          change(
                            "interventionCooldownSeconds",
                            e.target.value === "" ? "" : Number(e.target.value),
                          )
                        }
                      />
                      <small>
                        Counted from the facilitator's last reply, reminder or
                        intervention. Topic announcements do not count.
                      </small>
                    </label>
                    <label>
                      <span>Maximum interventions per topic</span>
                      <input
                        type="number"
                        required
                        min="0"
                        max="20"
                        step="1"
                        value={settings.interventionMaxPerTopic}
                        onChange={(e) =>
                          change(
                            "interventionMaxPerTopic",
                            e.target.value === "" ? "" : Number(e.target.value),
                          )
                        }
                      />
                      <small>
                        Quiet reminders and replies to @mentions do not count
                        toward this limit.
                      </small>
                    </label>
                  </div>
                  <label>
                    <span>Facilitator model</span>
                    <select
                      value={settings.model}
                      onChange={(e) => change("model", e.target.value)}
                    >
                      {[...new Set([settings.model, ...models])].map(
                        (model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label>
                    <span>Facilitator instructions</span>
                    <textarea
                      required
                      maxLength={12000}
                      rows={7}
                      value={settings.facilitatorPrompt}
                      onChange={(e) =>
                        change("facilitatorPrompt", e.target.value)
                      }
                    />
                    <small>
                      Guide tone and facilitation. The application always keeps
                      the current topic, its deadline, and the final-only voting
                      flow.
                    </small>
                  </label>
                  <div className="simple-save">
                    <button disabled={busy || !dirty} type="submit">
                      {busy ? "Saving…" : "Save Simplified settings"}
                    </button>
                    <span>
                      {dirty
                        ? "Unsaved settings"
                        : "Settings are saved for this discussion."}
                    </span>
                  </div>
                </fieldset>
              )}
            </form>
          </>
        )}
        {active === "/monitor" && (
          <>
            <section className="simple-card">
              <h2>Shared discussion</h2>
              <div className="simple-stats">
                <div>
                  <span>Status</span>
                  <strong>
                    {overview?.stage.replace("_", " ") || "Loading…"}
                  </strong>
                </div>
                <div>
                  <span>Current topic</span>
                  <strong>
                    {overview?.stage === "discussing"
                      ? `${overview.topicNumber} / ${overview.topicCount}`
                      : "—"}
                  </strong>
                </div>
                <div>
                  <span>Time remaining</span>
                  <strong>{countdown(overview?.deadline, now)}</strong>
                </div>
              </div>
              {overview?.stage === "discussing" && (
                <>
                  <h3>{overview.topic?.topic}</h3>
                  <p>
                    {overview.topic?.question_text || overview.topic?.question}
                  </p>
                  <ul>
                    {overview.topic?.predefined_answers
                      .filter(Boolean)
                      .map((option) => (
                        <li key={option}>{option}</li>
                      ))}
                  </ul>
                </>
              )}
              <p>
                {overview?.participants.length || 0} participants:{" "}
                {overview?.participants
                  .map((participant) => participant.username)
                  .join(", ") || "No participants have joined yet."}
              </p>
              {["draft", "recruiting"].includes(run.status) && (
                <a className="simple-button" href={setupUrl}>
                  Open setup to start the discussion
                </a>
              )}
              {["active", "recruiting", "starting"].includes(run.status) &&
                !run.archived && (
                  <button
                    className="secondary"
                    onClick={() => setConfirmStop(true)}
                  >
                    Stop discussion
                  </button>
                )}
              {confirmStop && (
                <div role="alertdialog" aria-label="Stop this discussion">
                  <p>
                    Stop this run and close its discussion? Its messages and
                    votes will remain available.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      perform(async () => {
                        await platformRequest(
                          `/platform/runs/${run.id}/stop`,
                          token,
                          { method: "POST", body: "{}" },
                        );
                        setConfirmStop(false);
                      }, "Discussion stopped.")
                    }
                  >
                    Confirm stop
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setConfirmStop(false)}
                  >
                    Keep running
                  </button>
                </div>
              )}
            </section>
            <section className="simple-card">
              <h2>Recent messages</h2>
              <p>
                The organiser observes the shared discussion without posting as
                a participant.
              </p>
              <div className="simple-transcript">
                {overview?.messages.map((entry) => (
                  <article key={entry.id}>
                    <strong>{entry.sender}</strong>
                    <time>
                      {new Date(entry.timestamp).toLocaleTimeString()}
                    </time>
                    <p>{entry.text}</p>
                  </article>
                ))}
                {!overview?.messages.length && (
                  <p>Messages appear when the discussion starts.</p>
                )}
              </div>
            </section>
          </>
        )}
        {active === "/surveys" && (
          <>
            <section className="simple-card">
              <h2>Participant flow</h2>
              <p>
                Topic description → Pre-survey → Simplified CIME → Post-survey
              </p>
              <a href={setupUrl}>
                Edit the topic description on the setup page →
              </a>
            </section>
            <SurveysTab token={token} />
          </>
        )}
        {active === "/results" && (
          <section className="simple-card">
            <h2>Final vote & research export</h2>
            {overview?.stage === "completed" ? (
              <>
                <h3>{run.config.globalQuestion}</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Answer</th>
                      <th>Votes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.results.map((item) => (
                      <tr key={item.id}>
                        <td>{item.option_text}</td>
                        <td>{item.votes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p>
                The final result appears after the main-question ballot closes.
              </p>
            )}
            <p>
              The export includes the topic description, questionnaires,
              responses, shared chat, topic schedule, facilitator settings, and
              final votes.
            </p>
            <button disabled={busy} onClick={download}>
              Download run data
            </button>
          </section>
        )}
        {active === "/logs" && (
          <section className="simple-card">
            <h2>AI call logs</h2>
            <p>
              Requests and responses for this discussion, including the
              facilitator and any setup suggestions.
            </p>
            {!logs.length && <p>No AI calls have been recorded.</p>}
            {logs.map((entry) => (
              <details key={entry.id} className="simple-log">
                <summary>
                  {new Date(entry.created_at).toLocaleString()} · {entry.model}{" "}
                  ·{" "}
                  {entry.caller === "simplified_facilitator"
                    ? "Facilitator"
                    : "Setup or analysis"}
                  {entry.tokens_used ? ` · ${entry.tokens_used} tokens` : ""}
                </summary>
                <h3>Request</h3>
                <pre>{entry.prompt}</pre>
                <h3>Response</h3>
                <pre>{entry.response}</pre>
              </details>
            ))}
          </section>
        )}
        {active === "/help" && (
          <section className="simple-card">
            <h2>How Simplified CIME works</h2>
            <ol>
              <li>
                Participants read the topic description and complete the
                pre-survey, when enabled.
              </li>
              <li>
                Everyone joins the same shared chat. The facilitator presents
                each topic and possible outcomes.
              </li>
              <li>
                Each topic runs for the minutes chosen in setup. Its deadline
                controls the transition to the next topic.
              </li>
              <li>
                The main-question ballot opens after the last topic and closes
                when everyone votes or its deadline ends.
              </li>
              <li>Participants complete the post-survey, when enabled.</li>
            </ol>
            <p>
              Full CIME’s interviews, group assignment, implementation ballots,
              consensus thresholds, and collective review are not part of this
              flow.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
