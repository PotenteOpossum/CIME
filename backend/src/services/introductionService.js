import { createHash } from "node:crypto";
import { db } from "../config/db.js";
import {
  emptyIntroduction,
  normalizeIntroduction,
} from "../../../shared/introductionSchema.mjs";

const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
let cachedIntroduction;
const versions = new WeakMap();
export function getIntroduction() {
  if (cachedIntroduction) return cachedIntroduction;
  const row = db
    .prepare("SELECT definition_json FROM topic_introduction WHERE id = 1")
    .get();
  cachedIntroduction = row
    ? JSON.parse(row.definition_json)
    : emptyIntroduction();
  return cachedIntroduction;
}
export function introductionVersion(document = getIntroduction()) {
  if (!versions.has(document))
    versions.set(
      document,
      createHash("sha256").update(JSON.stringify(document)).digest("hex"),
    );
  return versions.get(document);
}
export function introductionLocked() {
  return (
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      ?.current_phase !== "idle" ||
    !!db.prepare("SELECT user_id FROM introduction_reads LIMIT 1").get() ||
    !!db.prepare("SELECT user_id FROM survey_responses LIMIT 1").get()
  );
}
export function saveIntroduction(input) {
  const document = normalizeIntroduction(input);
  const saved = db.transaction(() => {
    if (introductionLocked())
      fail(
        409,
        "The topic description is locked after the first participant continues, a survey is submitted, or the experiment starts. Repeat the run to edit it.",
      );
    db.prepare(
      "INSERT INTO topic_introduction(id, definition_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET definition_json = excluded.definition_json",
    ).run(JSON.stringify(document));
    return document;
  })();
  cachedIntroduction = saved;
  return saved;
}
export function participantIntroduction(userId, includeContent = false) {
  const document = getIntroduction();
  const state = db
    .prepare(
      "SELECT current_phase, decision_run_mode FROM system_state WHERE id = 1",
    )
    .get();
  if (
    !document.enabled ||
    state.current_phase !== "idle" ||
    state.decision_run_mode === "simulation"
  )
    return { pending: null };
  if (
    db
      .prepare("SELECT user_id FROM introduction_reads WHERE user_id = ?")
      .get(userId)
  )
    return { pending: null };
  const version = introductionVersion(document);
  return {
    pending: includeContent
      ? { ...document, version }
      : { title: document.title, version },
  };
}
export function acknowledgeIntroduction(userId, version) {
  return db.transaction(() => {
    const user = db
      .prepare("SELECT id, is_admin FROM users WHERE id = ?")
      .get(userId);
    if (!user || user.is_admin)
      fail(403, "Only participants can continue past the topic description.");
    const pending = participantIntroduction(userId).pending;
    if (!pending) return { acknowledged: true };
    if (pending.version !== version)
      fail(
        409,
        "The topic description has changed. Read the updated page before continuing.",
      );
    db.prepare(
      "INSERT INTO introduction_reads(user_id, version, acknowledged_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING",
    ).run(userId, version, new Date().toISOString());
    return { acknowledged: true };
  })();
}
export function pendingIntroductionParticipants() {
  if (!getIntroduction().enabled) return [];
  return db
    .prepare(
      "SELECT u.id, u.username FROM users u JOIN run_participants p ON p.user_id = u.id WHERE u.is_admin = 0 AND NOT EXISTS (SELECT 1 FROM introduction_reads r WHERE r.user_id = u.id)",
    )
    .all();
}
export function introductionExport() {
  return {
    definition: getIntroduction(),
    acknowledgements: db
      .prepare(
        "SELECT user_id, version, acknowledged_at FROM introduction_reads ORDER BY acknowledged_at, user_id",
      )
      .all(),
  };
}
