// Settings for the mid-discussion intervention check. Full CIME and Simplified
// CIME store them separately but share these defaults and limits, so both
// conditions can use the same rule for when the facilitator steps in.
export const INTERVENTION_DEFAULTS = Object.freeze({
  enabled: true,
  cooldownSeconds: 90,
  maxPerTopic: 3,
});

export const INTERVENTION_LIMITS = Object.freeze({
  cooldownSeconds: { min: 30, max: 600 },
  maxPerTopic: { min: 0, max: 20 },
});

function clampInteger(value, fallback, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeInterventionSettings(input = {}) {
  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : INTERVENTION_DEFAULTS.enabled,
    cooldownSeconds: clampInteger(
      input.cooldownSeconds,
      INTERVENTION_DEFAULTS.cooldownSeconds,
      INTERVENTION_LIMITS.cooldownSeconds,
    ),
    maxPerTopic: clampInteger(
      input.maxPerTopic,
      INTERVENTION_DEFAULTS.maxPerTopic,
      INTERVENTION_LIMITS.maxPerTopic,
    ),
  };
}
