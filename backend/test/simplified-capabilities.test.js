import test from "node:test";
import assert from "node:assert/strict";
import {
  SIMPLIFIED_TABS,
  simplifiedAdminRequestAllowed as allowed,
} from "../../shared/simplifiedCapabilities.mjs";
import {
  DEFAULT_SIMPLIFIED_PROMPT,
  normalizeSimplifiedSettings,
} from "../../shared/simplifiedSettingsSchema.mjs";

test("Simplified navigation and API capabilities exclude Full process mutations and direct legacy routes", () => {
  assert.deepEqual(
    SIMPLIFIED_TABS.map((tab) => tab.path),
    ["/", "/monitor", "/surveys", "/results", "/logs", "/help"],
  );
  for (const [method, path] of [
    ["GET", "/admin/simplified/settings"],
    ["PUT", "/admin/simplified/settings/"],
    ["GET", "/admin/surveys/export"],
    ["POST", "/admin/decision-process/start"],
    ["GET", "/admin/decision-process/export"],
    ["GET", "/rooms/3/recap"],
  ])
    assert.equal(allowed(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ["GET", "/admin/llm-models"],
    ["GET", "/admin/simulation"],
    ["POST", "/admin/simulation/start"],
    ["POST", "/admin/decision-process/settings"],
    ["POST", "/admin/decision-process/settings/reset-default"],
    ["POST", "/admin/rooms"],
    ["PUT", "/admin/rooms/3/members"],
    ["POST", "/admin/rooms/3/polls"],
    ["POST", "/rooms/3/showdown"],
    ["POST", "/admin/decision-process/agents/agent3/chat"],
    ["DELETE", "/admin/polls/1"],
  ])
    assert.equal(allowed(method, path), false, `${method} ${path}`);
});
test("Simplified settings accept only controls used by its facilitator and final ballot", () => {
  const input = {
    model: "study-model",
    facilitatorPrompt: DEFAULT_SIMPLIFIED_PROMPT,
    finalVoteMinutes: 2,
    quietMinutes: 0,
  };
  assert.deepEqual(normalizeSimplifiedSettings(input, ["study-model"]), {
    ...input,
    interventionEnabled: true,
    interventionCooldownSeconds: 90,
    interventionMaxPerTopic: 3,
  });
  for (const patch of [
    { consensus_sensitivity: 4 },
    { clustering_strategy: "random" },
    { finalVoteMinutes: 0 },
    { quietMinutes: -1 },
    { model: "unavailable" },
    { facilitatorPrompt: "" },
  ])
    assert.throws(
      () =>
        normalizeSimplifiedSettings({ ...input, ...patch }, ["study-model"]),
      { status: 400 },
    );
});
