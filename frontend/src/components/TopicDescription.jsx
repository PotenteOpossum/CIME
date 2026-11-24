import { useEffect, useState } from "react";
import { apiRequest } from "../api/client.js";
import "./topicDescription.css";

export function TopicDescriptionContent({ document }) {
  return (
    <article className="topic-description-content">
      <h1>{document.title}</h1>
      {document.blocks.map((block) => {
        if (block.type === "heading") {
          const Heading = block.level === 3 ? "h3" : "h2";
          return <Heading key={block.id}>{block.text}</Heading>;
        }
        if (block.type === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={block.id}>
              {block.text
                .split("\n")
                .filter((line) => line.trim())
                .map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
            </List>
          );
        }
        if (block.type === "image")
          return (
            <figure key={block.id} style={{ width: `${block.width || 100}%` }}>
              <img src={block.src} alt={block.alt} />
              {block.caption && <figcaption>{block.caption}</figcaption>}
            </figure>
          );
        return (
          <p key={block.id} className="topic-description-paragraph">
            {block.text}
          </p>
        );
      })}
    </article>
  );
}

export default function TopicDescription({ document, token, onContinued }) {
  const [page, setPage] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    apiRequest("/introduction", {}, token)
      .then((result) => {
        if (live) setPage(result.pending);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [document.version, token]);
  async function continueToSurvey() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        "/introduction/continue",
        { method: "POST", body: JSON.stringify({ version: page.version }) },
        token,
      );
      onContinued();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <section className="platform-card topic-description-page">
      <span className="platform-eyebrow">Before you begin</span>
      <p className="topic-description-flow">
        Topic description <span aria-hidden="true">→</span> Pre-survey{" "}
        <span aria-hidden="true">→</span> CIME <span aria-hidden="true">→</span>{" "}
        Post-survey
      </p>
      {page ? (
        <TopicDescriptionContent document={page} />
      ) : (
        <p role="status">Loading topic description…</p>
      )}
      <div className="topic-description-continue">
        <p>Read the topic information above, then continue to the next step.</p>
        {error && (
          <p role="alert" className="platform-error">
            {error}
          </p>
        )}
        <button disabled={busy || !page} onClick={continueToSurvey}>
          {busy ? "Continuing…" : "Continue"}
        </button>
      </div>
    </section>
  );
}
