import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { platformRequest, saveAccount, accountToken } from "../platform/client.js";
import { FAST_FULL_SETTINGS, NAMES, SCENARIOS } from "./scenarios.js";
import "./testlab.css";

// Development-only page for testing Full and Simplified CIME with several
// participants on one screen. Each participant runs in an iframe served from
// its own *.localhost origin, so browser storage (and therefore the login)
// stays separate per participant.

const STORE_KEY = "cime_test_lab_v1";
const loadLab = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  } catch {
    return null;
  }
};
const saveLab = (lab) => {
  try {
    if (lab) localStorage.setItem(STORE_KEY, JSON.stringify(lab));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    /* storage unavailable: the lab still works until reload */
  }
};

const tileUrl = (index, session) => {
  const { protocol, port } = window.location;
  const payload = btoa(unescape(encodeURIComponent(JSON.stringify(session))));
  return `${protocol}//p${index + 1}.localhost${port ? `:${port}` : ""}/test-lab/tile#${encodeURIComponent(payload)}`;
};

const engine = (runId, path) => `/platform/runs/${runId}/engine${path}`;
const clock = (iso) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

function Login({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const session = await platformRequest("/accounts/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }, "");
      saveAccount(session);
      onDone();
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <form className="tl-card tl-login" onSubmit={submit}>
      <h1>CIME Test Lab</h1>
      <p>Sign in with your local administrator account.</p>
      {error && <p className="tl-error">{error}</p>}
      <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
      <button className="tl-primary">Sign in</button>
      <p className="tl-muted">No account yet? Register at <a href="/#/account/register">the registration page</a>, then come back to /test-lab.</p>
    </form>
  );
}

function Setup({ initial, busy, onCreate }) {
  const [type, setType] = useState(initial?.type || "simplified");
  const [scenario, setScenario] = useState(initial?.scenario || "heimplatz");
  const [count, setCount] = useState(initial?.count || 6);
  const [topics, setTopics] = useState(initial?.topics || 3);
  const [minutes, setMinutes] = useState(initial?.minutes || 1.5);
  return (
    <form
      className="tl-card tl-setup"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate({ type, scenario, count: Number(count), topics: Number(topics), minutes: Number(minutes) });
      }}
    >
      <h2>New test</h2>
      <div className="tl-segment">
        {["full", "simplified"].map((value) => (
          <button type="button" key={value} className={type === value ? "on" : ""} onClick={() => setType(value)}>
            {value === "full" ? "Full CIME" : "Simplified CIME"}
          </button>
        ))}
      </div>
      <label>Scenario
        <select value={scenario} onChange={(e) => setScenario(e.target.value)}>
          {Object.entries(SCENARIOS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
        </select>
      </label>
      <label>Participants
        <input type="number" min={2} max={15} value={count} onChange={(e) => setCount(e.target.value)} />
      </label>
      <label>Topics
        <input type="number" min={1} max={5} value={topics} onChange={(e) => setTopics(e.target.value)} />
      </label>
      {type === "simplified" && (
        <label>Minutes per topic
          <input type="number" min={0.25} max={30} step={0.25} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        </label>
      )}
      <p className="tl-muted">
        {type === "full"
          ? "Uses short timers and rooms of at least 2 people, so a few tabs are enough."
          : "Topics move on when their time runs out. You can also skip ahead."}
        {" "}No topic description or surveys.
      </p>
      <button className="tl-primary" disabled={busy}>{busy ? "Setting up…" : "Create test"}</button>
    </form>
  );
}

function Tile({ index, participant, size, expanded, onExpand, reloadKey }) {
  const src = tileUrl(index, participant.session);
  return (
    <div className={`tl-tile ${expanded ? "expanded" : ""}`} style={{ "--tile-h": `${size}px` }}>
      <div className="tl-tile-head">
        <strong>P{index + 1} · {participant.name}</strong>
        <span>
          <button type="button" onClick={onExpand}>{expanded ? "Shrink" : "Expand"}</button>
          <a href={src} target="_blank" rel="noreferrer">Open in tab</a>
        </span>
      </div>
      <iframe key={reloadKey} title={participant.name} src={src} />
    </div>
  );
}

export default function TestLab() {
  const [signedIn, setSignedIn] = useState(!!accountToken());
  const [lab, setLab] = useState(loadLab);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(null);
  const [rooms, setRooms] = useState([]);
  const [overview, setOverview] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [size, setSize] = useState(520);
  const [expanded, setExpanded] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [showSetup, setShowSetup] = useState(!loadLab());
  const [sender, setSender] = useState(0);
  const [text, setText] = useState("");
  const [repeat, setRepeat] = useState(1);
  const [voteMode, setVoteMode] = useState("random");
  const sockets = useRef(new Map());
  const note = useCallback((line) => setLog((prev) => [`${time(new Date().toISOString())}  ${line}`, ...prev].slice(0, 60)), []);

  useEffect(() => () => {
    for (const socket of sockets.current.values()) socket.disconnect();
  }, []);

  // Poll run state, rooms and the AI's intervention decisions.
  useEffect(() => {
    if (!lab?.runId || !signedIn) return undefined;
    let live = true;
    const tick = async () => {
      try {
        const run = await platformRequest(`/platform/runs/${lab.runId}`);
        if (!live) return;
        setStatus(run);
        if (!["draft", "recruiting"].includes(run.run.status)) {
          const [mon, ivs, ov] = await Promise.all([
            platformRequest(engine(lab.runId, "/admin/monitoring")).catch(() => null),
            platformRequest(engine(lab.runId, "/admin/interventions?limit=40")).catch(() => null),
            lab.type === "simplified"
              ? platformRequest(engine(lab.runId, "/admin/simplified/overview")).catch(() => null)
              : Promise.resolve(null),
          ]);
          if (!live) return;
          setRooms(mon?.rooms || []);
          setDecisions(ivs?.decisions || []);
          setOverview(ov);
        }
      } catch (e) {
        if (live && /sign|401|session/i.test(e.message)) setSignedIn(false);
      }
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [lab?.runId, lab?.type, signedIn]);

  async function act(label, task) {
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (e) {
      setError(`${label}: ${e.message}`);
      note(`✗ ${label}: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const stopRun = (runId) =>
    platformRequest(`/platform/runs/${runId}/stop`, { method: "POST", body: "{}" }).catch(() => {});

  const create = (options) =>
    act("Create test", async () => {
      for (const socket of sockets.current.values()) socket.disconnect();
      sockets.current.clear();
      if (lab?.runId) {
        note("Stopping the previous test run");
        await stopRun(lab.runId);
      }
      const scenario = SCENARIOS[options.scenario];
      const label = options.type === "full" ? "Full" : "Simplified";
      const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      note(`Creating ${label} CIME test (${scenario.label}, ${options.count} participants)`);
      const { run } = await platformRequest("/platform/decisions", {
        method: "POST",
        body: JSON.stringify({ title: `Test Lab · ${label} · ${scenario.label} · ${stamp}`, discussion_type: options.type }),
      });
      const topics = scenario.topics.slice(0, options.topics).map((t) =>
        options.type === "simplified" ? { ...t, durationMinutes: options.minutes } : t,
      );
      const config = {
        discussionType: options.type,
        globalQuestion: scenario.globalQuestion,
        decisionContext: scenario.decisionContext,
        generalDescription: "",
        deliberationQuestions: topics,
        generalQuestionAnswers: [],
        ...(options.type === "full" ? { settings: FAST_FULL_SETTINGS } : {}),
      };
      await platformRequest(`/platform/runs/${run.id}`, {
        method: "PATCH",
        body: JSON.stringify({ access_mode: "open", participant_limit: options.count, config }),
      });
      await platformRequest(`/platform/runs/${run.id}/admission`, { method: "POST", body: JSON.stringify({ open: true }) });
      const invite = run.invite_url.split("/join/")[1];
      const participants = [];
      for (let i = 0; i < options.count; i += 1) {
        const session = await platformRequest(`/platform/invitations/${invite}/join`, {
          method: "POST",
          body: JSON.stringify({ username: NAMES[i] }),
        }, "");
        participants.push({ name: NAMES[i], session });
      }
      note(`${participants.length} participants joined. Press “Start discussion” when ready.`);
      const next = { ...options, runId: run.id, invite, participants };
      saveLab(next);
      setLab(next);
      setRooms([]);
      setDecisions([]);
      setOverview(null);
      setExpanded(null);
      setShowSetup(false);
      setReloadKey((k) => k + 1);
    });

  const start = () =>
    act("Start", async () => {
      note("Starting the discussion");
      await platformRequest(`/platform/runs/${lab.runId}/start`, { method: "POST", body: "{}" });
      note("Discussion started");
    });

  // Rooms the participant can currently see, newest first.
  async function participantRooms(p) {
    const { rooms: list } = await platformRequest(engine(lab.runId, "/rooms"), {}, p.session.token);
    return list.filter((r) => r.is_active || r.collection_complete).sort((a, b) => b.id - a.id);
  }
  async function openPolls(p) {
    const found = [];
    for (const room of await participantRooms(p)) {
      const { polls } = await platformRequest(engine(lab.runId, `/rooms/${room.id}/polls`), {}, p.session.token);
      for (const poll of polls || [])
        if (!poll.is_closed && (!poll.expires_at || new Date(poll.expires_at) > new Date())) found.push(poll);
    }
    return found;
  }

  function socketFor(p) {
    let socket = sockets.current.get(p.name);
    if (!socket) {
      socket = io(window.location.origin, {
        path: "/socket.io/",
        auth: { token: p.session.token, runId: lab.runId },
        transports: ["websocket", "polling"],
      });
      sockets.current.set(p.name, socket);
    }
    return socket;
  }

  const sendAs = () =>
    act("Send", async () => {
      const p = lab.participants[sender];
      const visible = await participantRooms(p);
      const target = visible.find((r) => r.room_type !== "personal" && r.is_active) || visible.find((r) => r.is_active) || visible[0];
      if (!target) throw new Error(`${p.name} is not in a room yet`);
      const socket = socketFor(p);
      if (!socket.connected) await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("connect_error", reject);
      });
      socket.emit("join_room", { roomId: target.id });
      const lines = text.trim() ? [text.trim()] : [];
      if (!lines.length) throw new Error("Type a message first");
      for (let i = 0; i < repeat; i += 1) {
        socket.emit("send_message", { roomId: target.id, text: repeat > 1 ? `${lines[0]} (${i + 1})` : lines[0] });
        await new Promise((r) => setTimeout(r, 400));
      }
      note(`${p.name} → ${target.name}: “${lines[0]}”${repeat > 1 ? ` ×${repeat}` : ""}`);
      setText("");
    });

  const pick = (options, i, n) => {
    const real = options.filter((o) => String(o.option_text).trim().toLowerCase() !== "other");
    if (!real.length) return null;
    if (voteMode === "first") return real[0];
    if (voteMode === "last") return real[real.length - 1];
    if (voteMode === "split") return real[i % Math.min(2, real.length)];
    return real[Math.floor(Math.random() * real.length)];
  };

  const voteAll = () =>
    act("Vote", async () => {
      let cast = 0;
      for (const [i, p] of lab.participants.entries()) {
        for (const poll of await openPolls(p)) {
          const options = poll.options || [];
          const choice = pick(options, i, lab.participants.length);
          if (!choice) continue;
          let body;
          if (poll.poll_type === "swipe")
            body = { swipeVotes: options.filter((o) => String(o.option_text).toLowerCase() !== "other").map((o) => ({ optionId: o.id, direction: o.id === choice.id || (voteMode === "random" && Math.random() < 0.4) ? "right" : "left" })) };
          else if (poll.poll_type === "ranking")
            body = { rankedOptions: [choice, ...options.filter((o) => o.id !== choice.id && String(o.option_text).toLowerCase() !== "other")].map((o) => o.id) };
          else body = { optionId: choice.id };
          try {
            await platformRequest(engine(lab.runId, `/rooms/polls/${poll.id}/vote`), { method: "POST", body: JSON.stringify(body) }, p.session.token);
            cast += 1;
          } catch (e) {
            note(`✗ ${p.name} could not vote on poll ${poll.id}: ${e.message}`);
          }
        }
      }
      note(cast ? `Cast ${cast} vote(s) (${voteMode})` : "No open votes found");
    });

  const closeVotes = () =>
    act("Close votes", async () => {
      const ids = new Set();
      for (const p of lab.participants) for (const poll of await openPolls(p)) ids.add(poll.id);
      for (const id of ids)
        await platformRequest(engine(lab.runId, `/admin/polls/${id}`), { method: "PATCH", body: JSON.stringify({ is_closed: true }) });
      note(ids.size ? `Closed ${ids.size} open vote(s)` : "No open votes found");
    });

  const skip = () =>
    act("Skip", async () => {
      const result = await platformRequest(engine(lab.runId, "/admin/simplified/skip"), { method: "POST", body: "{}" });
      note(result.skipped ? `Skipped ahead (now: ${result.stage})` : "Nothing to skip");
    });

  if (!signedIn) return <div className="tl-page"><Login onDone={() => setSignedIn(true)} /></div>;

  const runStatus = status?.run?.status;
  const phase = status?.phase;
  const notStarted = ["draft", "recruiting"].includes(runStatus);

  return (
    <div className="tl-page">
      <header className="tl-bar">
        <strong>CIME Test Lab</strong>
        {lab && (
          <span className="tl-chip">
            {lab.type === "full" ? "Full" : "Simplified"} · {SCENARIOS[lab.scenario]?.label} · {lab.participants.length} participants
          </span>
        )}
        {runStatus && <span className="tl-chip">run: {runStatus}{phase ? ` · phase: ${phase}` : ""}</span>}
        <span className="tl-spacer" />
        <label className="tl-inline">Tile height
          <input type="range" min={320} max={900} step={20} value={size} onChange={(e) => setSize(Number(e.target.value))} />
        </label>
        {lab && <button type="button" onClick={() => setReloadKey((k) => k + 1)}>Reload tiles</button>}
        {lab && (
          // window.open keeps this tab's sign-in (sessionStorage) in the new tab.
          <button type="button" onClick={() => window.open(`/#/runs/${lab.runId}`, "_blank")}>Admin page</button>
        )}
        <button type="button" onClick={() => setShowSetup((v) => !v)}>{showSetup ? "Hide setup" : "New test"}</button>
      </header>

      {error && <p className="tl-error tl-banner">{error}</p>}

      <div className="tl-main">
        <section className="tl-grid">
          {showSetup && <Setup initial={lab} busy={busy} onCreate={create} />}
          {lab?.participants.map((p, i) => (
            <Tile
              key={`${lab.runId}-${p.name}`}
              index={i}
              participant={p}
              size={size}
              expanded={expanded === i}
              onExpand={() => setExpanded(expanded === i ? null : i)}
              reloadKey={reloadKey}
            />
          ))}
          {!lab && !showSetup && <p className="tl-muted">Create a test to begin.</p>}
        </section>

        {lab && (
          <aside className="tl-side">
            <div className="tl-card">
              <h3>Controls</h3>
              {notStarted && <button className="tl-primary" disabled={busy} onClick={start}>Start discussion</button>}
              {runStatus === "active" && (
                <>
                  <div className="tl-row">
                    <select value={voteMode} onChange={(e) => setVoteMode(e.target.value)}>
                      <option value="random">Random choices</option>
                      <option value="first">Everyone: first option</option>
                      <option value="last">Everyone: last option</option>
                      <option value="split">Split between two options</option>
                    </select>
                    <button disabled={busy} onClick={voteAll}>Everyone votes</button>
                  </div>
                  {lab.type === "full"
                    ? <button disabled={busy} onClick={closeVotes}>Close open votes now</button>
                    : <button disabled={busy} onClick={skip}>Next topic now</button>}
                </>
              )}
              <button disabled={busy} onClick={() => create(lab)}>Restart with same settings</button>
              {["active", "starting"].includes(runStatus) && (
                <button className="tl-danger" disabled={busy} onClick={() => act("Stop", async () => { await stopRun(lab.runId); note("Run stopped"); })}>Stop run</button>
              )}
            </div>

            {runStatus === "active" && (
              <div className="tl-card">
                <h3>Send as participant</h3>
                <div className="tl-row">
                  <select value={sender} onChange={(e) => setSender(Number(e.target.value))}>
                    {lab.participants.map((p, i) => <option key={p.name} value={i}>P{i + 1} · {p.name}</option>)}
                  </select>
                  <label className="tl-inline">×<input type="number" min={1} max={10} value={repeat} onChange={(e) => setRepeat(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} /></label>
                </div>
                <textarea rows={2} value={text} placeholder="Message…" onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendAs(); } }} />
                <button disabled={busy} onClick={sendAs}>Send</button>
                <p className="tl-muted">Sends to the participant's newest room. Use ×3 to test a dominant speaker.</p>
              </div>
            )}

            {lab.type === "simplified" && overview && (
              <div className="tl-card">
                <h3>Simplified progress</h3>
                <p><b>Stage:</b> {overview.stage}</p>
                {overview.topic && <p><b>Topic {overview.topicNumber}/{overview.topicCount}:</b> {overview.topic.topic}</p>}
                {overview.deadline && <p><b>Time left:</b> {clock(overview.deadline)}</p>}
                {!!overview.results?.length && (
                  <ul>{overview.results.map((r) => <li key={r.id}>{r.option_text}: {r.votes}</li>)}</ul>
                )}
              </div>
            )}

            {!!rooms.length && (
              <div className="tl-card">
                <h3>Rooms</h3>
                <ul className="tl-list">
                  {rooms.map((r) => (
                    <li key={r.id}>
                      <b>{r.name}</b> <span className="tl-muted">({r.room_type}{r.is_active ? "" : ", closed"})</span>
                      {r.timeLeftSeconds > 0 && <span className="tl-muted"> · {Math.floor(r.timeLeftSeconds / 60)}:{String(r.timeLeftSeconds % 60).padStart(2, "0")}</span>}
                      <div className="tl-muted">{(r.membersNicknames || []).join(", ")}</div>
                      {!!r.unresolvedTopics?.length && <div className="tl-muted">Open: {r.unresolvedTopics.join(", ")}</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="tl-card">
              <h3>AI intervention checks</h3>
              {!decisions.length && <p className="tl-muted">None yet. A check runs after participants pause.</p>}
              <ul className="tl-list">
                {decisions.map((d) => (
                  <li key={d.id} className={`tl-decision ${d.outcome === "posted" ? "posted" : ""}`}>
                    <span className="tl-muted">{time(d.decided_at)} · {d.room_name || `room ${d.room_id}`}</span>
                    <div><b>{d.outcome}</b>{d.move ? ` · ${d.move}` : ""}</div>
                    {d.reason && <div className="tl-muted">{d.reason}</div>}
                  </li>
                ))}
              </ul>
            </div>

            <div className="tl-card">
              <h3>Log</h3>
              <ul className="tl-list tl-log">{log.map((line, i) => <li key={i}>{line}</li>)}</ul>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
