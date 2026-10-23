import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useLocation } from "react-router-dom";
import {
  platformRequest,
  accountToken,
  saveAccount,
  saveParticipant,
} from "./client.js";
import { createPortal } from "react-dom";
import LiveRoomMonitoring from "./LiveRoomMonitoring.jsx";
import RecapModal from "../components/RecapModal.jsx";
import logo from "../img/CIME_LOGO.png";
import "./platform.css";

const iconPaths = {
  plus: "M12 5v14M5 12h14",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  archive: "M4 4h16v4H4zM6 8v12h12V8M10 12h4",
  restore: "M4 10a8 8 0 1 1 2 8M4 4v6h6",
  trash: "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7",
  stop: "M6 6h12v12H6z",
  play: "m8 5 11 7-11 7z",
  settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  check: "m5 12 4 4L19 6",
  spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z",
};
const Icon = ({ name }) => (
  <svg
    className="platform-icon"
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={iconPaths[name] || iconPaths.arrow} />
  </svg>
);
const RunStatus = ({ run }) => (
  <span
    className={`platform-badge status-${run.status} ${run.archived ? "status-archived" : ""}`}
  >
    <Icon
      name={
        run.archived
          ? "archive"
          : run.status === "completed"
            ? "check"
            : "spark"
      }
    />
    {run.archived
      ? `Archived · ${run.status === "completed" ? "Completed" : run.status}`
      : run.status}
  </span>
);

export function Shell({ children }) {
  return (
    <div className="platform platform-page">
      <header className="platform-nav">
        <a href="/">
          <img src={logo} alt="CIME" />
        </a>
        <nav>
          <a href="/#/decisions">My decisions</a>
          <a href="/#/account/login">Admin account</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer>Collective Intelligence Made Easy</footer>
    </div>
  );
}
const Message = ({ error, info }) => (
  <>
    {error && (
      <p role="alert" className="platform-error">
        {error}
      </p>
    )}
    {info && (
      <p role="status" className="platform-info">
        {info}
      </p>
    )}
  </>
);
const Field = ({ label, children }) => (
  <label className="platform-field">
    <span>{label}</span>
    {children}
  </label>
);

export function HomePage() {
  return (
    <Shell>
      <section className="platform-hero">
        <span className="platform-eyebrow">A space to decide together</span>
        <h1>Turn different perspectives into a shared decision.</h1>
        <p>
          Bring people together for private interviews, facilitated discussions,
          voting and collective review.
        </p>
        <div className="platform-actions">
          <Link
            className="platform-button"
            to={accountToken() ? "/decisions" : "/account/register"}
          >
            Create a decision
          </Link>
          <Link className="platform-button secondary" to="/account/login">
            Admin sign in
          </Link>
        </div>
      </section>
      <section className="platform-grid">
        <article>
          <h2>Prepare your question</h2>
          <p>
            Choose topics, initial options and the settings for your decision.
          </p>
        </article>
        <article>
          <h2>Invite your participants</h2>
          <p>
            Share a link or QR code. Choose open access, assigned credentials or
            verified Prolific access.
          </p>
        </article>
        <article>
          <h2>Decide together</h2>
          <p>
            Follow the discussion and voting process, then review the results
            and export your experiment.
          </p>
        </article>
      </section>
      <section className="platform-card">
        <h2>Here to participate?</h2>
        <p>
          Open the invitation link provided by your organiser, or scan their QR
          code. You can join without an administrator account.
        </p>
      </section>
    </Shell>
  );
}

export function AccountPage() {
  const { action = "login" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [developmentUrl, setDevelopmentUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const token = new URLSearchParams(location.search).get("token");
  useEffect(() => {
    setError("");
    setInfo("");
    setDevelopmentUrl("");
    setPassword("");
  }, [action]);
  const title =
    {
      login: "Welcome back",
      register: "Create your admin account",
      verify: "Verify your email",
      reset: "Choose a new password",
      forgot: "Reset your password",
      resend: "Resend verification",
    }[action] || "Sign in";
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const route =
        {
          forgot: "forgot-password",
          reset: "reset-password",
          resend: "resend-verification",
        }[action] || action;
      const result = await platformRequest(
        `/accounts/${route}`,
        {
          method: "POST",
          body: JSON.stringify({ email, name, password, token }),
        },
        "",
      );
      if (action === "login") {
        saveAccount(result);
        navigate("/decisions");
      } else {
        setInfo(result.message);
        setDevelopmentUrl(result.developmentActionUrl || "");
      }
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <form onSubmit={submit} className="platform-card platform-account">
        <h1>{title}</h1>
        <Message error={error} info={info} />
        {action === "register" && (
          <Field label="Your name">
            <input
              required
              maxLength={80}
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
        )}
        {!["verify", "reset"].includes(action) && (
          <Field label="Email">
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}
        {["login", "register", "reset"].includes(action) && (
          <Field label="Password">
            <input
              required
              type="password"
              minLength={action === "login" ? 1 : 12}
              autoComplete={
                action === "login" ? "current-password" : "new-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
        )}
        {action === "verify" && (
          <p>Confirm your email to start creating decisions.</p>
        )}
        <button
          disabled={busy || (["verify", "reset"].includes(action) && !token)}
        >
          {busy
            ? "Please wait…"
            : {
                login: "Sign in",
                register: "Create account",
                verify: "Verify email",
                reset: "Update password",
                forgot: "Send reset link",
                resend: "Send verification link",
              }[action]}
        </button>
        {developmentUrl && (
          <p className="platform-info">
            Local development: <a href={developmentUrl}>open the email link</a>
          </p>
        )}
        <div className="platform-links">
          <Link to="/account/login">Sign in</Link>
          <Link to="/account/register">Create account</Link>
          <Link to="/account/forgot">Forgot password?</Link>
          <Link to="/account/resend">Resend verification</Link>
        </div>
      </form>
    </Shell>
  );
}

export function DecisionsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState([]);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [info, setInfo] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const load = () =>
    platformRequest("/platform/decisions").then((data) => setRuns(data.runs));
  useEffect(() => {
    if (!accountToken()) {
      navigate("/account/login");
      return;
    }
    load().catch((e) => setError(e.message));
  }, []);
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await platformRequest("/platform/decisions", {
        method: "POST",
        body: JSON.stringify({ title, description }),
      });
      navigate(`/runs/${data.run.id}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function changeRun(run, action) {
    const stopping = action === "stop" || action === "stopArchive";
    setPendingAction(null);
    setActionBusy(run.id);
    setError("");
    setInfo("");
    try {
      await platformRequest(
        `/platform/runs/${run.id}${action === "delete" ? "" : stopping ? "/stop" : "/archive"}`,
        {
          method: action === "delete" ? "DELETE" : "POST",
          body: JSON.stringify({
            archived: action === "stopArchive" || action === "archive",
          }),
        },
      );
      await load();
      setInfo(
        action === "delete"
          ? "Run deleted"
          : action === "stop"
            ? "Decision stopped"
            : action === "restore"
              ? "Decision restored"
              : "Decision archived",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setActionBusy("");
    }
  }
  async function logout() {
    await platformRequest("/accounts/logout", { method: "POST" }).catch(
      () => {},
    );
    sessionStorage.removeItem("cime_account_token");
    sessionStorage.removeItem("cime_account_user");
    navigate("/");
  }
  return (
    <Shell>
      <div className="platform-heading">
        <div>
          <span className="platform-eyebrow">Your workspace</span>
          <h1>My decisions</h1>
        </div>
        <button className="secondary" onClick={logout}>
          Sign out
        </button>
      </div>
      <Message error={error} info={info} />
      <form className="platform-card" onSubmit={create}>
        <h2>Create a decision</h2>
        <Field label="Title">
          <input
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What should we decide together?"
          />
        </Field>
        <Field label="Invitation description">
          <textarea
            value={description}
            maxLength={2000}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What should participants know before joining?"
          />
        </Field>
        <button disabled={busy}>
          <Icon name="plus" /> {busy ? "Creating…" : "Create decision"}
        </button>
      </form>
      <label className="platform-check">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />{" "}
        Show archived runs
      </label>
      <section className="platform-grid">
        {runs
          .filter((run) => showArchived || !run.archived)
          .map((run) => (
            <article className="platform-card platform-run-card" key={run.id}>
              <div className="platform-run-heading">
                <h2>
                  <Link to={`/runs/${run.id}`}>{run.title}</Link>
                </h2>
                <RunStatus run={run} />
              </div>
              <p>
                {run.description ||
                  "Configure your decision and invite participants."}
              </p>
              <small>
                {run.access_mode} access ·{" "}
                {new Date(run.created_at).toLocaleDateString()}
              </small>
              {pendingAction?.run.id === run.id && (
                <div
                  role="alertdialog"
                  aria-label={
                    pendingAction.action === "delete"
                      ? "Confirm deleting run"
                      : "Confirm stopping decision"
                  }
                >
                  <p>
                    {pendingAction.action === "delete"
                      ? `Permanently delete “${run.title}”? This removes this run’s participants, messages, votes, reports, and files. This cannot be undone.`
                      : `Stop “${run.title}”? Participation will end. Its history and votes will be kept.`}
                  </p>
                  <div className="platform-actions">
                    <button
                      onClick={() => changeRun(run, pendingAction.action)}
                      autoFocus
                    >
                      {pendingAction.action === "delete"
                        ? "Confirm delete"
                        : pendingAction.action === "stopArchive"
                          ? "Confirm stop and archive"
                          : "Confirm stop"}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setPendingAction(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {pendingAction?.run.id !== run.id && (
                <div className="platform-actions">
                  <Link
                    className="platform-button secondary"
                    to={`/runs/${run.id}`}
                  >
                    <Icon name="arrow" /> Open decision
                  </Link>
                  {(run.archived ||
                    !["active", "starting", "recruiting"].includes(
                      run.status,
                    )) && (
                    <button
                      className="secondary"
                      disabled={!!actionBusy}
                      onClick={() =>
                        changeRun(run, run.archived ? "restore" : "archive")
                      }
                    >
                      <Icon name={run.archived ? "restore" : "archive"} />
                      {actionBusy === run.id
                        ? "Updating…"
                        : run.archived
                          ? "Restore decision"
                          : "Archive decision"}
                    </button>
                  )}
                  {run.archived && (
                    <button
                      className="secondary"
                      disabled={!!actionBusy}
                      onClick={() =>
                        setPendingAction({ run, action: "delete" })
                      }
                    >
                      <Icon name="trash" /> Delete run
                    </button>
                  )}
                </div>
              )}
            </article>
          ))}
      </section>
      {!runs.length && (
        <p>Your decisions will appear here. Start by creating one above.</p>
      )}
    </Shell>
  );
}

export function RunPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [config, setConfig] = useState({
    globalQuestion: "",
    decisionContext: "",
    generalDescription: "",
    deliberationQuestions: [],
    generalQuestionAnswers: [],
  });
  const [genCount, setGenCount] = useState(5);
  const [generating, setGenerating] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("open");
  const [limit, setLimit] = useState(100);
  const [report, setReport] = useState(null);
  useEffect(() => setReport(null), [id]);
  const [loadingReport, setLoadingReport] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [apiToken, setApiToken] = useState("");
  const [names, setNames] = useState("");
  const [credentials, setCredentials] = useState([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    platformRequest(`/platform/runs/${id}`).then((next) => {
      setData(next);
      return next;
    });
  useEffect(() => {
    if (!accountToken()) {
      navigate("/account/login");
      return;
    }
    load()
      .then((next) => {
        setConfig({
          globalQuestion: "",
          decisionContext: "",
          generalDescription: "",
          deliberationQuestions: [],
          generalQuestionAnswers: [],
          ...next.run.config,
        });
        setTitle(next.run.title);
        setDescription(next.run.description);
        setMode(next.run.access_mode);
        setLimit(next.run.participant_limit);
      })
      .catch((e) => setError(e.message));
    const timer = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [id]);
  const frozen = data && !["draft", "recruiting"].includes(data.run.status);
  const accessLocked = frozen || !!data?.participants.length;
  const patch = (field, value) =>
    setConfig((previous) => ({ ...previous, [field]: value }));
  async function execute(task, message) {
    setBusy(true);
    setError("");
    setInfo("");
    try {
      await task();
      await load();
      if (message) setInfo(message);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    await platformRequest(`/platform/runs/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        access_mode: mode,
        participant_limit: limit,
        config,
        ...(apiToken ? { prolific_api_token: apiToken } : {}),
      }),
    });
    setApiToken("");
  }
  const download = (content, filename, type) => {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };
  async function generate(kind) {
    setGenerating(kind);
    setError("");
    try {
      const result = await platformRequest(
        `/platform/runs/${id}/engine/admin/decision-process/generate-${kind}`,
        {
          method: "POST",
          body: JSON.stringify({
            globalQuestion: config.globalQuestion,
            generalDescription: config.generalDescription,
            count: genCount,
          }),
        },
      );
      if (kind === "description")
        patch("generalDescription", result.description);
      else patch("deliberationQuestions", result.questions);
    } catch (e) {
      setError(e.message);
    } finally {
      setGenerating("");
    }
  }
  async function viewReport() {
    setLoadingReport(true);
    setError("");
    try {
      const { rooms } = await platformRequest(
        `/platform/runs/${id}/engine/admin/rooms`,
      );
      const completedRoom = [...rooms]
        .reverse()
        .find(
          (room) =>
            room.room_type === "convergence" && room.collection_complete,
        );
      if (!completedRoom)
        throw new Error(
          "No completed convergence report is available for this run.",
        );
      const result = await platformRequest(
        `/platform/runs/${id}/engine/rooms/${completedRoom.id}/recap`,
      );
      if (!result.report)
        throw new Error(
          result.error ||
            "The final report is still being generated. Please try again shortly.",
        );
      setReport(result.report);
    } catch (error) {
      setError(error.message);
    } finally {
      setLoadingReport(false);
    }
  }
  async function qr() {
    const response = await fetch(`/api/platform/runs/${id}/qr`, {
      headers: { Authorization: `Bearer ${accountToken()}` },
    });
    if (!response.ok) throw new Error("Unable to download QR code");
    download(await response.text(), "cime-invitation.svg", "image/svg+xml");
  }
  if (!data)
    return (
      <Shell>
        <Message error={error} />
        <p>Loading your decision…</p>
      </Shell>
    );
  const { run } = data;
  return (
    <Shell>
      <Link to="/decisions">← My decisions</Link>
      <div className="platform-heading">
        <div>
          <RunStatus run={run} />
          <h1>{run.title}</h1>
          <p>{run.description}</p>
        </div>
        <div className="platform-actions">
          <a className="platform-button secondary" href={`/admin/?run=${id}`}>
            <Icon name="settings" /> Advanced settings
          </a>
        </div>
      </div>
      <Message error={error} info={info} />
      {["active", "starting", "recruiting"].includes(run.status) &&
        !run.archived && (
          <div className="platform-control-bar">
            <div>
              <strong>Process controls</strong>
              <p>Manage participation and the decision process here.</p>
            </div>
            {!confirmStop ? (
              <button
                className="secondary platform-danger"
                disabled={busy}
                onClick={() => setConfirmStop(true)}
              >
                <Icon name="stop" />
                Stop decision
              </button>
            ) : (
              <div role="alertdialog" aria-label="Confirm stopping decision">
                <p>
                  Stop this process? Participation will end; votes and history
                  will be kept.
                </p>
                <div className="platform-actions">
                  <button
                    disabled={busy}
                    onClick={() =>
                      execute(async () => {
                        await platformRequest(`/platform/runs/${id}/stop`, {
                          method: "POST",
                          body: JSON.stringify({ archived: false }),
                        });
                        setConfirmStop(false);
                      }, "Decision stopped")
                    }
                  >
                    <Icon name="stop" />
                    Confirm stop
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setConfirmStop(false)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      {report &&
        createPortal(
          <RecapModal
            report={report}
            title={run.title}
            onClose={() => setReport(null)}
          />,
          document.body,
        )}
      {run.status === "draft" && !run.archived && (
        <form
          className="platform-card"
          onSubmit={(event) => {
            event.preventDefault();
            execute(
              () =>
                platformRequest(`/platform/runs/${id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ title, description }),
                }),
              "Title and invitation description saved",
            );
          }}
        >
          <h2>Decision details</h2>
          <fieldset disabled={busy}>
            <Field label="Title">
              <input
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="Invitation description">
              <textarea
                maxLength={2000}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <button disabled={busy}>Save decision details</button>
          </fieldset>
        </form>
      )}
      {run.status === "completed" && (
        <section className="platform-card platform-results">
          <span className="platform-eyebrow">Explore your results</span>
          <h2>
            <span className="platform-section-icon">
              <Icon name="check" />
            </span>
            Decision results
          </h2>
          <p>
            Read the final report and explore participation, voting patterns,
            and discussion quality.
          </p>
          <div className="platform-actions">
            <button disabled={loadingReport} onClick={viewReport}>
              {loadingReport ? "Loading report…" : "📄 View & Download Report"}
            </button>
            <a
              className="platform-button secondary"
              href={`/admin/?run=${id}#/quality`}
            >
              <Icon name="spark" />
              Explore quality
            </a>
          </div>
        </section>
      )}
      <section className="platform-card platform-survey-card">
        <div>
          <span className="platform-eyebrow">Participant questionnaires</span>
          <h2>Before & after experiment surveys</h2>
          <p>Set up a pre-survey for the waiting room, a post-survey after the decision, or both. Build questions with the form or JSON editor.</p>
        </div>
        <a className="platform-button secondary" href={`/admin/?run=${id}#/surveys`}>Configure surveys & view responses</a>
      </section>
      <section className="platform-card platform-setup">
        <div className="setup-section-title">
          <span className="platform-eyebrow">Design your discussion</span>
          <h2>
            <span className="platform-section-icon">
              <Icon name="settings" />
            </span>
            Decision setup
          </h2>
          <p>
            Set the question, introduce the context, and shape the choices
            participants will discuss.
          </p>
        </div>
        <fieldset disabled={frozen || busy || !!generating}>
          <Field label="Main question">
            <input
              value={config.globalQuestion || ""}
              onChange={(e) => patch("globalQuestion", e.target.value)}
            />
          </Field>
          <Field label="Background context">
            <textarea
              rows={4}
              value={config.decisionContext || ""}
              onChange={(e) => patch("decisionContext", e.target.value)}
            />
          </Field>
          <Field label="Participant introduction">
            <textarea
              value={config.generalDescription || ""}
              onChange={(e) => patch("generalDescription", e.target.value)}
            />
          </Field>
          <button
            className="secondary"
            disabled={!config.globalQuestion?.trim()}
            onClick={() => generate("description")}
          >
            {generating === "description"
              ? "Generating…"
              : "⚡ AI Generate introduction"}
          </button>
          <section className="setup-topics-section">
            <div className="setup-section-header">
              <div>
                <h3>Discussion topics</h3>
                <p>Focused questions for the participant interviews.</p>
              </div>
              <button
                className="secondary setup-small-button"
                disabled={(config.deliberationQuestions || []).length >= 10}
                onClick={() =>
                  patch("deliberationQuestions", [
                    ...(config.deliberationQuestions || []),
                    { topic: "", question_text: "", predefined_answers: [] },
                  ])
                }
              >
                + Add topic
              </button>
            </div>
            <div className="setup-generation">
              <label htmlFor="setup-topic-count">
                Number of topics to generate
              </label>
              <input
                id="setup-topic-count"
                type="number"
                min={1}
                max={10}
                value={genCount}
                onChange={(event) =>
                  setGenCount(
                    Math.max(1, Math.min(10, Number(event.target.value) || 1)),
                  )
                }
              />
              <button
                className="secondary setup-small-button"
                disabled={!config.globalQuestion?.trim()}
                onClick={() => generate("questions")}
              >
                {generating === "questions" ? "Generating…" : "⚡ AI Generate"}
              </button>
            </div>
            <p className="setup-hint">
              AI generation replaces the current topics. Review the suggestions
              before saving.
            </p>
            <div className="setup-topic-list">
              {(config.deliberationQuestions || []).map((question, i) => (
                <article className="setup-topic-card" key={i}>
                  <div className="setup-topic-header">
                    <input
                      aria-label={`Topic ${i + 1}`}
                      placeholder={`Topic ${i + 1}`}
                      value={question.topic || ""}
                      onChange={(event) =>
                        patch(
                          "deliberationQuestions",
                          config.deliberationQuestions.map((q, j) =>
                            j === i ? { ...q, topic: event.target.value } : q,
                          ),
                        )
                      }
                    />
                    <button
                      className="secondary setup-remove"
                      aria-label={`Remove topic ${i + 1}`}
                      onClick={() =>
                        patch(
                          "deliberationQuestions",
                          config.deliberationQuestions.filter(
                            (_, j) => j !== i,
                          ),
                        )
                      }
                    >
                      Remove
                    </button>
                  </div>
                  <input
                    aria-label={`Discussion question ${i + 1}`}
                    placeholder="What should participants discuss?"
                    value={question.question_text || question.question || ""}
                    onChange={(event) =>
                      patch(
                        "deliberationQuestions",
                        config.deliberationQuestions.map((q, j) =>
                          j === i
                            ? { ...q, question_text: event.target.value }
                            : q,
                        ),
                      )
                    }
                  />
                  <div className="setup-options-grid">
                    {Array.from({ length: 6 }, (_, optionIndex) => (
                      <input
                        key={optionIndex}
                        aria-label={`Topic ${i + 1} option ${optionIndex + 1}`}
                        placeholder={`Option ${optionIndex + 1}`}
                        value={question.predefined_answers?.[optionIndex] || ""}
                        onChange={(event) =>
                          patch(
                            "deliberationQuestions",
                            config.deliberationQuestions.map((q, j) => {
                              if (j !== i) return q;
                              const options = [...(q.predefined_answers || [])];
                              while (options.length <= optionIndex)
                                options.push("");
                              options[optionIndex] = event.target.value;
                              return { ...q, predefined_answers: options };
                            }),
                          )
                        }
                      />
                    ))}
                  </div>
                </article>
              ))}
              {!config.deliberationQuestions?.length && (
                <div className="setup-empty">
                  Add a topic or generate suggestions to start building the
                  discussion.
                </div>
              )}
            </div>
          </section>
          <section className="setup-final-options">
            <h3>Final voting options</h3>
            <p>
              The choices for the final vote on your main question. Leave blank
              to use the defaults.
            </p>
            <div className="setup-options-grid">
              {Array.from({ length: 6 }, (_, index) => (
                <input
                  key={index}
                  aria-label={`Final voting option ${index + 1}`}
                  placeholder={`Option ${index + 1}`}
                  value={config.generalQuestionAnswers?.[index] || ""}
                  onChange={(event) => {
                    const options = [...(config.generalQuestionAnswers || [])];
                    while (options.length <= index) options.push("");
                    options[index] = event.target.value;
                    patch("generalQuestionAnswers", options);
                  }}
                />
              ))}
            </div>
          </section>
          <div className="setup-save-row">
            <p>Review your setup, then save before inviting participants.</p>
            <button onClick={() => execute(save, "Draft saved")}>
              Save draft
            </button>
          </div>
        </fieldset>
        <p>
          Grouping, prompts, timing, quorum and advanced settings are available
          in the process workspace.
        </p>
      </section>
      <div className="platform-columns platform-participant-columns">
        <section className="platform-card">
          <h2>
            <span className="platform-section-icon">
              <Icon name="users" />
            </span>
            Participant access
          </h2>
          <fieldset disabled={busy || frozen}>
            <Field label="Who can join?">
              <select
                disabled={accessLocked}
                value={mode}
                onChange={(e) => setMode(e.target.value)}
              >
                <option value="open">Anyone with the link</option>
                <option value="credentials">
                  Assigned username and password
                </option>
                <option value="prolific">Verified Prolific participants</option>
              </select>
            </Field>
            <Field label="Participant limit">
              <input
                type="number"
                min={1}
                max={500}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </Field>
            {mode === "prolific" && (
              <fieldset disabled={accessLocked}>
                <Field label="Prolific study ID">
                  <input
                    value={config.prolific_study_id || ""}
                    onChange={(e) => patch("prolific_study_id", e.target.value)}
                  />
                </Field>
                <Field label="Verification">
                  <select
                    value={config.prolific_verification || ""}
                    onChange={(e) =>
                      patch("prolific_verification", e.target.value)
                    }
                  >
                    <option value="">Choose verification</option>
                    <option value="api">
                      Verify active submission through API
                    </option>
                    <option value="signed">
                      Verify a secure signed study link
                    </option>
                  </select>
                </Field>
                {config.prolific_verification === "api" ? (
                  <Field
                    label={`Prolific API token ${run.prolific_api_configured ? "(already configured)" : ""}`}
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      value={apiToken}
                      onChange={(e) => setApiToken(e.target.value)}
                    />
                  </Field>
                ) : (
                  <>
                    <Field label="Exact JWT audience (external study URL)">
                      <input
                        value={config.prolific_audience || ""}
                        onChange={(e) =>
                          patch("prolific_audience", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="Prolific workspace ID">
                      <input
                        value={config.prolific_workspace_id || ""}
                        onChange={(e) =>
                          patch("prolific_workspace_id", e.target.value)
                        }
                      />
                    </Field>
                    <Field label="Organisation ID (if applicable)">
                      <input
                        value={config.prolific_organisation_id || ""}
                        onChange={(e) =>
                          patch("prolific_organisation_id", e.target.value)
                        }
                      />
                    </Field>
                  </>
                )}
                <Field label="Prolific completion URL">
                  <input
                    value={config.prolific_completion_url || ""}
                    onChange={(e) =>
                      patch("prolific_completion_url", e.target.value)
                    }
                  />
                </Field>
                <p>
                  Set the invitation URL as the external study URL in Prolific
                  and enable URL parameters.
                </p>
              </fieldset>
            )}
            <button onClick={() => execute(save, "Access settings saved")}>
              Save access settings
            </button>
            {mode === "credentials" && (
              <>
                <Field label="Participant usernames (one per line)">
                  <textarea
                    disabled={accessLocked}
                    rows={4}
                    value={names}
                    onChange={(e) => setNames(e.target.value)}
                  />
                </Field>
                <button
                  disabled={accessLocked}
                  onClick={() =>
                    execute(async () => {
                      await save();
                      const result = await platformRequest(
                        `/platform/runs/${id}/credentials`,
                        {
                          method: "POST",
                          body: JSON.stringify({
                            entries: names
                              .split("\n")
                              .map((username) => username.trim())
                              .filter(Boolean)
                              .map((username) => ({ username })),
                          }),
                        },
                      );
                      setCredentials(result.credentials);
                    }, "Credentials generated. Download and distribute them privately.")
                  }
                >
                  Generate participant credentials
                </button>
              </>
            )}
            <hr />
            <Field label="Invitation link">
              <input readOnly value={run.invite_url} />
            </Field>
            <div className="platform-actions">
              <button
                className="secondary"
                onClick={() =>
                  execute(
                    () => navigator.clipboard.writeText(run.invite_url),
                    "Invitation copied",
                  )
                }
              >
                Copy link
              </button>
              <button className="secondary" onClick={() => execute(qr)}>
                Download QR
              </button>
              <button
                className="secondary"
                onClick={() =>
                  execute(
                    () =>
                      platformRequest(
                        `/platform/runs/${id}/rotate-invitation`,
                        { method: "POST" },
                      ),
                    "Previous invitation revoked",
                  )
                }
              >
                Replace link
              </button>
            </div>
            <button
              onClick={() =>
                execute(
                  async () => {
                    await save();
                    await platformRequest(`/platform/runs/${id}/admission`, {
                      method: "POST",
                      body: JSON.stringify({ open: !run.admission_open }),
                    });
                  },
                  run.admission_open
                    ? "Registration closed"
                    : "Registration opened",
                )
              }
            >
              {run.admission_open ? "Close registration" : "Open registration"}
            </button>
          </fieldset>
          {accessLocked && (
            <p>Access mode is locked after the first participant joins.</p>
          )}
          {credentials.length > 0 && (
            <div className="platform-info">
              <p>
                Passwords are shown only now. Download them before leaving this
                page.
              </p>
              <button
                onClick={() =>
                  download(
                    [
                      "username,password",
                      ...credentials.map(
                        (c) =>
                          `"${c.username.replaceAll('"', '""')}",${c.password}`,
                      ),
                    ].join("\n"),
                    "cime-credentials.csv",
                    "text/csv",
                  )
                }
              >
                Download credentials
              </button>
            </div>
          )}
        </section>
        <section className="platform-card">
          <div className="platform-heading">
            <h2>
              <span className="platform-section-icon">
                <Icon name="users" />
              </span>
              Participants{" "}
              <span className="platform-count">{data.participants.length}</span>
            </h2>
            <span>
              {data.usage.calls} model calls · {data.usage.tokens} tokens
            </span>
          </div>
          <ul className="platform-participants">
            {data.participants.map((p) => (
              <li key={p.id}>
                <span>{p.username}</span>
                {p.prolific_pid && <small>PID: {p.prolific_pid}</small>}
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    execute(
                      () =>
                        platformRequest(
                          `/platform/runs/${id}/participants/${p.id}/revoke`,
                          { method: "POST" },
                        ),
                      "Participant sessions revoked",
                    )
                  }
                >
                  Revoke sessions
                </button>
              </li>
            ))}
          </ul>
          {!data.participants.length && (
            <p>Participants will appear here when they join.</p>
          )}
          <div className="platform-actions">
            {!frozen && (
              <button
                disabled={busy || !data.participants.length}
                onClick={() =>
                  execute(async () => {
                    await save();
                    await platformRequest(`/platform/runs/${id}/start`, {
                      method: "POST",
                    });
                  }, "The decision process has started")
                }
              >
                <Icon name="play" /> Start decision process
              </button>
            )}
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                execute(async () => {
                  const result = await platformRequest(
                    `/platform/runs/${id}/repeat`,
                    { method: "POST" },
                  );
                  navigate(`/runs/${result.run.id}`);
                }, "A fresh run has been created")
              }
            >
              <Icon name="plus" /> Create another run
            </button>
            {!["active", "starting", "recruiting"].includes(run.status) && (
              <button
                className="secondary"
                onClick={() =>
                  execute(
                    () =>
                      platformRequest(`/platform/runs/${id}/archive`, {
                        method: "POST",
                        body: JSON.stringify({ archived: !run.archived }),
                      }),
                    run.archived ? "Run restored" : "Run archived",
                  )
                }
              >
                {run.archived ? "Restore run" : "Archive run"}
              </button>
            )}
          </div>
          <p className="platform-muted">
            Create another run copies the saved setup into a fresh draft with a
            new invitation link. Participants, votes, messages, and results stay
            in this run. The new run starts only when you start it.
          </p>
        </section>
      </div>
      {run.status === "active" && <LiveRoomMonitoring runId={id} />}
    </Shell>
  );
}

export function JoinPage({ invite }) {
  const [data, setData] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recover, setRecover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [existing, setExisting] = useState(false);
  const [identifiers] = useState(() => {
    const query = new URLSearchParams(window.location.search);
    return Object.fromEntries(
      ["PROLIFIC_PID", "STUDY_ID", "SESSION_ID", "prolific_token"].map(
        (key) => [key, query.get(key) || ""],
      ),
    );
  });
  useEffect(() => {
    let live = true;
    const update = () =>
      platformRequest(
        `/platform/invitations/${invite}`,
        { cache: "no-store" },
        "",
      )
        .then((result) => {
          if (!live) return;
          setData(result);
          setExisting(!!sessionStorage.getItem(`chat_jwt_token:${result.id}`));
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    update();
    const timer = setInterval(update, 2000);
    window.addEventListener("focus", update);
    // Remove research identifiers from the address bar/history after capture.
    if (window.location.search)
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.hash,
      );
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", update);
    };
  }, [invite]);
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await platformRequest(
        `/platform/invitations/${invite}/join`,
        {
          method: "POST",
          body: JSON.stringify(
            recover ? { recoveryCode } : { username, password, ...identifiers },
          ),
        },
        "",
      );
      saveParticipant(result);
      window.location.assign(`/participate/${result.runId}/#/dashboard`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <form className="platform-card platform-account" onSubmit={submit}>
        <span className="platform-eyebrow">You’re invited</span>
        <h1>{data?.title || "Join a decision"}</h1>
        <p>{data?.description}</p>
        <Message error={error} />
        {data && (
          <>
            {!data.admission_open && (
              <p className="platform-info">
                Registration is closed. Existing participants can reconnect.
              </p>
            )}
            {existing && (
              <a
                className="platform-button"
                href={`/participate/${data.id}/#/dashboard`}
              >
                Resume participation
              </a>
            )}
            {recover ? (
              <Field label="Your private recovery code">
                <input
                  required
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                />
              </Field>
            ) : (
              <>
                <Field label="Your display username">
                  <input
                    required
                    maxLength={40}
                    autoComplete={
                      data.access_mode === "credentials" ? "username" : "off"
                    }
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </Field>
                {data.access_mode === "credentials" && (
                  <Field label="Assigned password">
                    <input
                      required
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </Field>
                )}
                {data.access_mode === "prolific" && (
                  <p>
                    Your study identifiers will be verified with Prolific.
                    Choose a display name for the discussion.
                  </p>
                )}
              </>
            )}
            <button
              disabled={
                busy ||
                (!recover &&
                  !data.admission_open &&
                  !["credentials", "prolific"].includes(data.access_mode))
              }
            >
              {busy
                ? "Joining…"
                : recover
                  ? "Recover participation"
                  : "Join experiment"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setRecover(!recover)}
            >
              {recover ? "Back to joining" : "I have a recovery code"}
            </button>
          </>
        )}
      </form>
    </Shell>
  );
}
