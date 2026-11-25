import { useEffect, useState } from "react";
import { platformPath, saveParticipant } from "../platform/client.js";

// Development-only handoff page loaded inside a Test Lab tile. The tile runs on
// its own pN.localhost origin; this page stores the participant session the
// Test Lab created and then opens the normal participant view.
export default function TestLabTile() {
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const raw = decodeURIComponent(window.location.hash.slice(1));
      const session = JSON.parse(decodeURIComponent(escape(atob(raw))));
      if (!session?.runId || !session?.token) throw new Error("Missing session");
      saveParticipant(session);
      window.location.replace(platformPath(`/participate/${session.runId}/#/dashboard`));
    } catch {
      setError("This tile has no participant session. Create a test in the Test Lab.");
    }
  }, []);
  return <p style={{ padding: 16, fontFamily: "system-ui" }}>{error || "Opening participant view…"}</p>;
}
