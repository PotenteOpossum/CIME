import { createContext, useContext, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { useAuth } from "../contexts/AuthContext.jsx";
import { participantRunId, platformRequest, sessionKey } from "./client.js";
import { scheduleStoppedLogout } from "./stoppedLogout.js";
import { Shell } from "./PlatformPages.jsx";
import SurveyForm from '../components/SurveyForm.jsx';

const ParticipantRunContext = createContext(null);
export const useParticipantRun = () => useContext(ParticipantRunContext);

export default function ParticipantGate({ children }) {
  const { token, user, logout } = useAuth();
  const [state, setState] = useState(null);
  const stopped = useRef(false);
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  const [error, setError] = useState("");
  const [surveyRefresh, setSurveyRefresh] = useState(0);
  const recovery = sessionStorage.getItem(`recovery:${participantRunId}`);
  useEffect(() => {
    if (!token) return;
    let live = true;
    stopped.current = false;
    const update = () =>
      platformRequest(
        `/platform/participants/${participantRunId}`,
        { cache: "no-store" },
        token,
      )
        .then((next) => {
          if (live) {
            // Waiting participants initially cannot open an engine socket.
            // Retry after the organizer starts, so they also receive stop events.
            if (
              ["active", "completed", "interrupted"].includes(next.status) &&
              socket.disconnected
            )
              socket.connect();
            if (next.status === "interrupted") stopped.current = true;
            setState(
              stopped.current ? { ...next, status: "interrupted" } : next,
            );
            if (next.completion_url)
              sessionStorage.setItem(
                sessionKey("completion_url"),
                next.completion_url,
              );
            setError("");
          }
        })
        .catch((e) => {
          if (live && !stopped.current) setError(e.message);
        });
    update();
    const timer = setInterval(update, 2000);
    const socket = io(
      import.meta.env.VITE_SOCKET_URL || window.location.origin,
      {
        path: import.meta.env.VITE_SOCKET_PATH || "/socket.io/",
        auth: { token, runId: participantRunId },
        transports: ["websocket", "polling"],
      },
    );
    socket.on("process_interrupted", () => {
      stopped.current = true;
      setError("");
      setState((previous) => ({ ...previous, status: "interrupted" }));
    });
    socket.on("connect", update);
    window.addEventListener("focus", update);
    window.addEventListener('cime-surveys-refresh', update);
    return () => {
      live = false;
      clearInterval(timer);
      socket.disconnect();
      window.removeEventListener("focus", update);
      window.removeEventListener('cime-surveys-refresh', update);
    };
  }, [token, surveyRefresh]);
  useEffect(() => {
    if (!token || state?.status !== "interrupted") return;
    return scheduleStoppedLogout(
      sessionStorage,
      sessionKey("stop_logout_at"),
      () => {
        sessionStorage.setItem(sessionKey("participation_stopped"), "true");
        logoutRef.current();
      },
    );
  }, [token, state?.status]);
  if (
    !token &&
    (sessionStorage.getItem(sessionKey("participation_completed")) === "true" ||
      sessionStorage.getItem(sessionKey("participation_stopped")) === "true")
  )
    return (
      <Shell>
        <section className="platform-card">
          <h1>Thank you for joining the discussion</h1>
          <p>Your participation has ended. Thank you for sharing your views.</p>
          {sessionStorage.getItem(sessionKey("completion_url")) && (
            <a
              className="platform-button"
              href={sessionStorage.getItem(sessionKey("completion_url"))}
            >
              Return to Prolific to complete your submission
            </a>
          )}
          <a href="/">Go to homepage</a>
        </section>
      </Shell>
    );
  if (!token)
    return (
      <Shell>
        <section className="platform-card">
          <h1>Reconnect to your experiment</h1>
          <p>
            Open your invitation link and use your assigned credentials or
            recovery code to rejoin.
          </p>
          <a href="/">Go to homepage</a>
        </section>
      </Shell>
    );
  if (error)
    return (
      <Shell>
        <section className="platform-card">
          <h1>Unable to reconnect</h1>
          <p role="alert">{error}</p>
          <p>Keep your recovery code so you can rejoin using the invitation.</p>
          {recovery && <code>{recovery}</code>}
          <button onClick={logout}>Sign out</button>
        </section>
      </Shell>
    );
  if (!state)
    return (
      <Shell>
        <p>Connecting to your experiment…</p>
      </Shell>
    );
  if (state.status === "failed")
    return (
      <Shell>
        <section className="platform-card">
          <h1>This experiment is unavailable</h1>
          <p>Please contact the organiser. Keep your private recovery code.</p>
          {recovery && <code>{recovery}</code>}
          <button onClick={logout}>Sign out</button>
        </section>
      </Shell>
    );
  if (state.surveys?.pending)
    return <Shell><SurveyForm key={`${participantRunId}:${user?.id}:${state.surveys.pending.stage}`} survey={state.surveys.pending} token={token} userId={user?.id}
      onSubmitted={() => setSurveyRefresh((value) => value + 1)} /></Shell>;
  if (["draft", "recruiting", "starting"].includes(state.status))
    return (
      <Shell>
        <section className="platform-card platform-account">
          <span className="platform-eyebrow">You’re in, {user?.username}</span>
          <h1>Waiting for the organiser</h1>
          <p>
            This page will update automatically when the decision process
            starts.
          </p>
          {recovery && (
            <div className="platform-info">
              <p>
                Save your private recovery code to reconnect from another
                device:
              </p>
              <code style={{ overflowWrap: "anywhere" }}>{recovery}</code>
            </div>
          )}
          <button className="secondary" onClick={logout}>
            Sign out
          </button>
        </section>
      </Shell>
    );
  return (
    <ParticipantRunContext.Provider value={state}>
      {state.status === "interrupted" && (
        <p className="platform-info">
          The organiser has stopped this experiment. Its history remains
          available. You will be signed out automatically after 60 seconds.
        </p>
      )}
      {recovery && (
        <details className="platform" style={{ padding: "8px 16px" }}>
          <summary>Your private recovery code</summary>
          <code style={{ overflowWrap: "anywhere" }}>{recovery}</code>
          <p>
            Keep this code private. Use it with your invitation to reconnect
            from another device.
          </p>
        </details>
      )}
      {state.completion_url && (
        <div
          className="platform"
          style={{ padding: "16px", textAlign: "center" }}
        >
          <p>Your experiment is complete.</p>
          <a className="platform-button" href={state.completion_url}>
            Return to Prolific to complete your submission
          </a>
        </div>
      )}
      {children}
    </ParticipantRunContext.Provider>
  );
}
