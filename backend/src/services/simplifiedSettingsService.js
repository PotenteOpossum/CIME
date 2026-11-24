import { db } from "../config/db.js";
import { SUPPORTED_CHAT_MODELS } from "../config/env.js";
import {
  getConfiguredModels,
  getDecisionSettings,
} from "./agentConfigService.js";
import {
  DEFAULT_SIMPLIFIED_PROMPT,
  normalizeSimplifiedSettings,
  withInterventionDefaults,
} from "../../../shared/simplifiedSettingsSchema.mjs";

export function simplifiedAvailableModels() {
  const configured = getConfiguredModels();
  return [
    ...new Set([
      configured.primaryModel,
      configured.cheapModel,
      ...SUPPORTED_CHAT_MODELS,
    ]),
  ].filter(Boolean);
}
export function getSimplifiedSettings() {
  const row = db
    .prepare("SELECT settings_json FROM simplified_settings WHERE id = 1")
    .get();
  if (row) return withInterventionDefaults(JSON.parse(row.settings_json));
  const legacy = getDecisionSettings();
  return withInterventionDefaults({
    model: getConfiguredModels().primaryModel,
    facilitatorPrompt: DEFAULT_SIMPLIFIED_PROMPT,
    finalVoteMinutes: legacy.live_voting_duration_minutes || 5,
    quietMinutes: legacy.group_proactivity || 4,
  });
}
export function simplifiedSettingsLocked() {
  return (
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      ?.current_phase !== "idle"
  );
}
export function saveSimplifiedSettings(input) {
  const settings = normalizeSimplifiedSettings(
    input,
    simplifiedAvailableModels(),
  );
  return db.transaction(() => {
    if (simplifiedSettingsLocked())
      throw Object.assign(
        new Error(
          "Simplified settings are locked after the discussion starts. Repeat the run to change them.",
        ),
        { status: 409 },
      );
    db.prepare(
      "INSERT INTO simplified_settings(id, settings_json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json",
    ).run(JSON.stringify(settings));
    return settings;
  })();
}
