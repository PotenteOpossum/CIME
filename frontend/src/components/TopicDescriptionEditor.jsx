import { useEffect, useRef, useState } from "react";
import { platformRequest } from "../platform/client.js";
import {
  emptyIntroduction,
  normalizeIntroduction,
  MAX_IMAGE_BYTES,
} from "../../../shared/introductionSchema.mjs";
import { TopicDescriptionContent } from "./TopicDescription.jsx";
import "./topicDescription.css";

const labels = {
  heading: "Heading",
  paragraph: "Text",
  list: "List",
  image: "Image",
};
const uid = () => crypto.randomUUID();

async function prepareImage(file) {
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)
  )
    throw new Error("Choose a PNG, JPEG, WebP, or GIF image.");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("Choose an image smaller than 20 MB.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(
      1,
      1600 / Math.max(image.naturalWidth, image.naturalHeight),
    );
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const src = canvas.toDataURL("image/webp", 0.85);
    if ((src.length * 3) / 4 > MAX_IMAGE_BYTES)
      throw new Error("This image is still too large. Choose a smaller image.");
    return src;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function TopicDescriptionEditor({ runId, frozen }) {
  const [document, setDocument] = useState(emptyIntroduction);
  const [locked, setLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const fileInput = useRef(null);
  const endpoint = `/platform/runs/${runId}/engine/admin/introduction`;
  const disabled = frozen || locked || busy || uploading || loading;
  useEffect(() => {
    let live = true;
    platformRequest(endpoint)
      .then((result) => {
        if (!live) return;
        setDocument(result.introduction);
        setLocked(result.locked);
        setLoading(false);
      })
      .catch((e) => {
        if (live) {
          setError(e.message);
          setLoading(false);
        }
      });
    return () => {
      live = false;
    };
  }, [endpoint]);
  function change(next) {
    setDocument(next);
    setDirty(true);
    setInfo("");
    setError("");
  }
  function update(id, patch) {
    change({
      ...document,
      blocks: document.blocks.map((block) =>
        block.id === id ? { ...block, ...patch } : block,
      ),
    });
  }
  function add(type) {
    if (document.blocks.length >= 50) {
      setError("Use at most 50 content blocks.");
      return;
    }
    change({
      ...document,
      blocks: [
        ...document.blocks,
        {
          id: uid(),
          type,
          text: "",
          ...(type === "heading" ? { level: 2 } : {}),
          ...(type === "list" ? { ordered: false } : {}),
        },
      ],
    });
  }
  function move(index, offset) {
    const blocks = [...document.blocks];
    [blocks[index], blocks[index + offset]] = [
      blocks[index + offset],
      blocks[index],
    ];
    change({ ...document, blocks });
  }
  async function upload(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || disabled) return;
    if (
      document.blocks.length >= 50 ||
      document.blocks.filter((block) => block.type === "image").length >= 8
    ) {
      setError("Use at most 50 blocks and eight images.");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const src = await prepareImage(file);
      const image = {
        id: uid(),
        type: "image",
        src,
        alt: file.name.replace(/\.[^.]+$/, "").replace(/[_-]/g, " "),
        caption: "",
        width: 100,
      };
      setDocument((previous) => ({
        ...previous,
        blocks: [...previous.blocks, image],
      }));
      setDirty(true);
      setInfo("");
    } catch (e) {
      setError(e.message || "Unable to read this image.");
    } finally {
      setUploading(false);
    }
  }
  async function save() {
    setError("");
    setInfo("");
    try {
      const normalized = normalizeIntroduction(document);
      setBusy(true);
      const result = await platformRequest(endpoint, {
        method: "PUT",
        body: JSON.stringify(normalized),
      });
      setDocument(result.introduction);
      setLocked(result.locked);
      setDirty(false);
      setInfo("Topic description saved.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="platform-card topic-editor"
      aria-labelledby="topic-editor-title"
    >
      <div className="topic-editor-header">
        <div>
          <span className="platform-eyebrow">
            Step 1 · Before the pre-survey
          </span>
          <h2 id="topic-editor-title">Topic description</h2>
          <p>
            Build a short introduction so participants understand the proposal
            before answering the pre-survey.
          </p>
        </div>
        <div
          className="topic-editor-tabs"
          role="group"
          aria-label="Description view"
        >
          <button
            type="button"
            className={preview ? "secondary" : ""}
            aria-pressed={!preview}
            onClick={() => setPreview(false)}
          >
            Edit page
          </button>
          <button
            type="button"
            className={preview ? "" : "secondary"}
            aria-pressed={preview}
            onClick={() => setPreview(true)}
          >
            Participant preview
          </button>
        </div>
      </div>
      <p className="topic-description-flow">
        Description → Pre-survey → CIME → Post-survey
      </p>
      {(locked || frozen) && (
        <p className="platform-info">
          This page is locked after a participant continues, a survey is
          submitted, or the experiment starts. Repeat the run to edit it.
        </p>
      )}
      {loading ? (
        <p>Loading topic description…</p>
      ) : preview ? (
        <div className="topic-editor-preview">
          {!document.enabled && (
            <p className="platform-info">
              Preview only. Enable and save this page to show it to
              participants.
            </p>
          )}
          <TopicDescriptionContent document={document} />
        </div>
      ) : (
        <fieldset disabled={disabled} className="topic-editor-fields">
          <label className="topic-editor-toggle">
            <input
              type="checkbox"
              checked={document.enabled}
              onChange={(e) =>
                change({ ...document, enabled: e.target.checked })
              }
            />{" "}
            Show this description before the pre-survey
          </label>
          <label className="platform-field">
            <span>Page title</span>
            <input
              value={document.title}
              maxLength={200}
              onChange={(e) => change({ ...document, title: e.target.value })}
            />
          </label>
          <div
            className="topic-editor-toolbar"
            role="group"
            aria-label="Add page content"
          >
            <span>Add content</span>
            {["heading", "paragraph", "list"].map((type) => (
              <button
                type="button"
                className="secondary"
                key={type}
                onClick={() => add(type)}
              >
                + {labels[type]}
              </button>
            ))}
            <button
              type="button"
              className="secondary"
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? "Preparing image…" : "+ Image"}
            </button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={upload}
            />
          </div>
          {!document.blocks.length && (
            <div className="topic-editor-empty">
              <h3>Give your topic a little context</h3>
              <p>
                Add text and images, arrange them in order, then preview the
                page participants will read.
              </p>
              <button
                type="button"
                className="secondary"
                onClick={() => add("paragraph")}
              >
                Add your first text block
              </button>
            </div>
          )}
          <div className="topic-editor-blocks">
            {document.blocks.map((block, index) => (
              <section
                className="topic-editor-block"
                key={block.id}
                aria-label={`${labels[block.type]} block ${index + 1}`}
              >
                <div className="topic-editor-block-header">
                  <strong>
                    {index + 1}. {labels[block.type]}
                  </strong>
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled || index === 0}
                      onClick={() => move(index, -1)}
                      aria-label={`Move block ${index + 1} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={
                        disabled || index === document.blocks.length - 1
                      }
                      onClick={() => move(index, 1)}
                      aria-label={`Move block ${index + 1} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() =>
                        change({
                          ...document,
                          blocks: document.blocks.filter(
                            (item) => item.id !== block.id,
                          ),
                        })
                      }
                      aria-label={`Remove block ${index + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                </div>
                {block.type === "image" ? (
                  <>
                    <img
                      className="topic-editor-image"
                      src={block.src}
                      alt={block.alt}
                    />
                    <label className="platform-field">
                      <span>Image description (for screen readers)</span>
                      <input
                        maxLength={500}
                        value={block.alt}
                        onChange={(e) =>
                          update(block.id, { alt: e.target.value })
                        }
                      />
                    </label>
                    <label className="platform-field">
                      <span>Caption (optional)</span>
                      <input
                        maxLength={1000}
                        value={block.caption}
                        onChange={(e) =>
                          update(block.id, { caption: e.target.value })
                        }
                      />
                    </label>
                    <label className="platform-field">
                      <span>Image width</span>
                      <select
                        value={block.width}
                        onChange={(e) =>
                          update(block.id, { width: Number(e.target.value) })
                        }
                      >
                        <option value={100}>Full width</option>
                        <option value={75}>Three-quarter width</option>
                        <option value={50}>Half width</option>
                      </select>
                    </label>
                  </>
                ) : (
                  <>
                    {block.type === "heading" && (
                      <label className="platform-field">
                        <span>Heading style</span>
                        <select
                          value={block.level}
                          onChange={(e) =>
                            update(block.id, { level: Number(e.target.value) })
                          }
                        >
                          <option value={2}>Section heading</option>
                          <option value={3}>Subheading</option>
                        </select>
                      </label>
                    )}
                    {block.type === "list" && (
                      <label className="platform-field">
                        <span>List style</span>
                        <select
                          value={String(block.ordered)}
                          onChange={(e) =>
                            update(block.id, {
                              ordered: e.target.value === "true",
                            })
                          }
                        >
                          <option value="false">Bullet points</option>
                          <option value="true">Numbered list</option>
                        </select>
                      </label>
                    )}
                    <label className="platform-field">
                      <span>
                        {block.type === "list"
                          ? "List items (one per line)"
                          : labels[block.type]}
                      </span>
                      <textarea
                        rows={block.type === "heading" ? 2 : 5}
                        maxLength={10000}
                        value={block.text}
                        placeholder={
                          block.type === "paragraph"
                            ? "Explain the proposal in your own words…"
                            : ""
                        }
                        onChange={(e) =>
                          update(block.id, { text: e.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </section>
            ))}
          </div>
          <p className="topic-editor-hint">
            Uploaded images stay with this experiment and are resized
            automatically. Animated images use their first frame.
          </p>
        </fieldset>
      )}
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
      <div className="topic-editor-save">
        <button type="button" disabled={disabled || !dirty} onClick={save}>
          {busy ? "Saving…" : "Save topic description"}
        </button>
        <span>
          {dirty
            ? "You have unsaved changes."
            : document.enabled
              ? "Enabled for participants."
              : "Optional · Currently hidden from participants."}
        </span>
      </div>
    </section>
  );
}
