import { useEffect, useState } from "react";
import { platformRequest } from "./client.js";

export default function LiveRoomMonitoring({ runId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [confirmRoom, setConfirmRoom] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = () =>
      platformRequest(`/platform/runs/${runId}/engine/admin/monitoring`)
        .then((next) => {
          if (live) {
            setData(next);
            setError("");
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [runId]);
  async function showdown(room) {
    setBusy(true);
    try {
      await platformRequest(
        `/platform/runs/${runId}/engine/rooms/${room.id}/showdown`,
        { method: "POST" },
      );
      setConfirmRoom(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const personal = data?.personalSummary;
  return (
    <section className="platform-card">
      <h2>Live Room Monitoring</h2>
      <p>Room progress updates every four seconds.</p>
      {error && (
        <p role="alert" className="platform-error">
          {error}
        </p>
      )}
      {!data && !error && <p>Loading rooms…</p>}
      {data && (
        <div className="platform-grid">
          {personal && (
            <article className="platform-card">
              <h3>Personal rooms</h3>
              <p>A summary of all participant interviews.</p>
              <dl className="platform-monitor-stats">
                <dt>Total rooms</dt>
                <dd>{personal.total}</dd>
                <dt>In progress</dt>
                <dd>{personal.inProgress}</dd>
                <dt>Completed</dt>
                <dd>{personal.completed}</dd>
                <dt>Inactive / ended early</dt>
                <dd>{personal.inactive}</dd>
                <dt>Open ballots</dt>
                <dd>{personal.openPolls}</dd>
              </dl>
            </article>
          )}
          {(data.rooms || []).map((room) => (
            <article key={room.id} className="platform-card">
              <span className="platform-badge">
                {room.collection_complete
                  ? "Completed"
                  : room.is_active
                    ? "Open"
                    : "Closed"}
              </span>
              <h3>{room.name}</h3>
              <p>
                {room.room_type === "convergence"
                  ? "Convergence"
                  : "Discussion group"}{" "}
                · {room.membersCount} participants
              </p>
              <p>{room.membersNicknames.join(", ") || "No participants"}</p>
              <p>
                Time left:{" "}
                {room.is_active && room.timeLeftSeconds > 0
                  ? `${Math.floor(room.timeLeftSeconds / 60)}m ${room.timeLeftSeconds % 60}s`
                  : "No active countdown"}
              </p>
              <h4>Approved decisions</h4>
              {room.resolvedTopics.length ? (
                <ul>
                  {room.resolvedTopics.map((item, index) => (
                    <li key={index}>
                      <strong>{item.topic}:</strong> {item.decision}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>None yet</p>
              )}
              <h4>Voting attempts per topic</h4>
              {Object.entries(room.votingAttempts).length ? (
                <ul>
                  {Object.entries(room.votingAttempts).map(([topic, count]) => (
                    <li key={topic}>
                      {topic}: {count} {count === 1 ? "poll" : "polls"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No polls yet</p>
              )}
              <h4>Topics still to discuss</h4>
              {room.unresolvedTopics.length ? (
                <ul>
                  {room.unresolvedTopics.map((topic, index) => (
                    <li key={index}>{topic}</li>
                  ))}
                </ul>
              ) : (
                <p>All topics covered</p>
              )}
              {room.is_active &&
                !room.collection_complete &&
                (confirmRoom === room.id ? (
                  <div role="alertdialog" aria-label="Confirm showdown">
                    <p>Trigger a showdown for {room.name}?</p>
                    <div className="platform-actions">
                      <button disabled={busy} onClick={() => showdown(room)}>
                        Confirm showdown
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setConfirmRoom(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    className="secondary"
                    onClick={() => setConfirmRoom(room.id)}
                  >
                    Trigger Showdown
                  </button>
                ))}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
