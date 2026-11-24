import { normalizeInterventionSettings } from "./interventionSettings.mjs";

export const DEFAULT_SIMPLIFIED_PROMPT =
  "You are a neutral facilitator for a shared discussion about a public-policy proposal. Help participants explain their reasons, understand different perspectives, and respond respectfully to one another. Be concise, distinguish proposals from facts, and do not favour an outcome. Follow the current topic and the application schedule.";

// Intervention fields are optional so settings saved before they existed, and
// repeated runs that copy those settings, still load with the shared defaults.
export function withInterventionDefaults(settings) {
  const intervention = normalizeInterventionSettings({
    enabled: settings.interventionEnabled,
    cooldownSeconds: settings.interventionCooldownSeconds,
    maxPerTopic: settings.interventionMaxPerTopic,
  });
  return {
    ...settings,
    interventionEnabled: intervention.enabled,
    interventionCooldownSeconds: intervention.cooldownSeconds,
    interventionMaxPerTopic: intervention.maxPerTopic,
  };
}

export function normalizeSimplifiedSettings(input, availableModels) {
  const fail = (message) => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("Provide Simplified CIME settings.");
  if (
    Object.keys(input).some(
      (key) =>
        ![
          "model",
          "facilitatorPrompt",
          "finalVoteMinutes",
          "quietMinutes",
          "interventionEnabled",
          "interventionCooldownSeconds",
          "interventionMaxPerTopic",
        ].includes(key),
    )
  )
    fail("These settings do not apply to Simplified CIME.");
  if (typeof input.model !== "string" || !availableModels.includes(input.model))
    fail("Choose an available facilitator model.");
  if (
    typeof input.facilitatorPrompt !== "string" ||
    !input.facilitatorPrompt.trim() ||
    input.facilitatorPrompt.length > 12000
  )
    fail("Facilitator instructions must contain 1–12,000 characters.");
  if (
    typeof input.finalVoteMinutes !== "number" ||
    !Number.isFinite(input.finalVoteMinutes) ||
    input.finalVoteMinutes < 0.1 ||
    input.finalVoteMinutes > 120
  )
    fail("Final vote duration must be between 0.1 and 120 minutes.");
  if (
    typeof input.quietMinutes !== "number" ||
    !Number.isFinite(input.quietMinutes) ||
    input.quietMinutes < 0 ||
    input.quietMinutes > 60
  )
    fail(
      "Quiet discussion reminders must be between 0 and 60 minutes; 0 turns them off.",
    );
  if (
    input.interventionEnabled !== undefined &&
    typeof input.interventionEnabled !== "boolean"
  )
    fail("Mid-discussion interventions must be on or off.");
  for (const [key, label, min, max] of [
    ["interventionCooldownSeconds", "The minimum gap between interventions", 30, 600],
    ["interventionMaxPerTopic", "The maximum number of interventions per topic", 0, 20],
  ])
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "number" ||
        !Number.isFinite(input[key]) ||
        input[key] < min ||
        input[key] > max)
    )
      fail(`${label} must be between ${min} and ${max}.`);
  return withInterventionDefaults({
    model: input.model,
    facilitatorPrompt: input.facilitatorPrompt.trim(),
    finalVoteMinutes: input.finalVoteMinutes,
    quietMinutes: input.quietMinutes,
    interventionEnabled: input.interventionEnabled,
    interventionCooldownSeconds: input.interventionCooldownSeconds,
    interventionMaxPerTopic: input.interventionMaxPerTopic,
  });
}
