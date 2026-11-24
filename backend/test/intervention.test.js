import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cime-intervention-"));
process.env.JWT_SECRET = "intervention-test-secret-at-least-32-characters";
process.env.DATABASE_URL = "";
process.env.OPENAI_API_KEY = "";
process.env.CIME_API_KEY = "";
process.env.CIME_DB_PATH = path.join(directory, "chat.db");
process.env.CIME_CONFIG_DIR = path.join(directory, "agent-config");
await fs.cp(new URL("../agent-config", import.meta.url), process.env.CIME_CONFIG_DIR, {
  recursive: true,
});
const { db, initDb } = await import("../src/config/db.js");
initDb();
const simple = await import("../src/services/simplifiedCimeService.js");
const simpleSettings = await import("../src/services/simplifiedSettingsService.js");
const { getDecisionSettings, updateDecisionSettings } = await import(
  "../src/services/agentConfigService.js"
);
const { cancelDecisionWork } = await import("../src/services/agent3Service.js");
const { evaluateIntervention, INTERVENTION_MOVES } = await import(
  "../src/services/interventionService.js"
);
const { normalizeSimplifiedSettings } = await import(
  "../../shared/simplifiedSettingsSchema.mjs"
);

const config = {
  discussionType: "simplified",
  globalQuestion: "Renovate the square?",
  decisionContext: "A fictional proposal.",
  generalDescription: "",
  deliberationQuestions: [
    {
      topic: "Trees",
      question_text: "Where should trees go?",
      predefined_answers: ["Edges", "Seating"],
      durationMinutes: 10,
    },
  ],
};

function provider(content) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          return { choices: [{ message: { content } }] };
        },
      },
    },
  };
}

function say(roomId, userId, text) {
  db.prepare(
    "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)",
  ).run(roomId, userId, text, new Date().toISOString());
}

test("the intervention check follows its hard limits and logs every model decision", async (t) => {
  t.after(async () => {
    cancelDecisionWork();
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  // Both versions share the same defaults, and older saved settings still load.
  assert.equal(getDecisionSettings().intervention_enabled, true);
  assert.equal(getDecisionSettings().intervention_cooldown_seconds, 90);
  assert.equal(
    updateDecisionSettings({ intervention_cooldown_seconds: 5 }).intervention_cooldown_seconds,
    30,
  );
  const models = simpleSettings.simplifiedAvailableModels();
  const legacy = normalizeSimplifiedSettings(
    { model: models[0], facilitatorPrompt: "Be neutral.", finalVoteMinutes: 2, quietMinutes: 0 },
    models,
  );
  assert.equal(legacy.interventionEnabled, true);
  assert.equal(legacy.interventionMaxPerTopic, 3);
  assert.throws(
    () => normalizeSimplifiedSettings({ ...legacy, interventionMaxPerTopic: 50 }, models),
    { status: 400 },
  );

  for (const name of ["Alice", "Bob", "Cleo"])
    db.prepare("INSERT INTO users(username,password_hash,is_admin) VALUES (?,'test',0)").run(name);
  const [alice, bob] = db.prepare("SELECT id FROM users WHERE is_admin = 0 ORDER BY id").all();
  simpleSettings.saveSimplifiedSettings({ ...legacy, interventionMaxPerTopic: 1 });
  const { roomId } = simple.startSimplifiedCime(config);
  const later = Date.now() + 200_000;

  // A facilitator reply starts the gap; the automatic topic announcement does not.
  db.prepare(
    "INSERT INTO messages(room_id, sender_id, text, timestamp, is_facilitation) VALUES (?, NULL, ?, ?, 1)",
  ).run(roomId, "Which trade-off matters most to you?", new Date().toISOString());
  const idle = provider('{"intervene": true, "move": "bridge_option", "reason": "x"}');
  say(roomId, alice.id, "Trees at the edges.");
  say(roomId, bob.id, "No, around the seating.");
  assert.equal(
    await evaluateIntervention(roomId, { provider: idle }),
    null,
    "the facilitator just replied, so the gap applies",
  );
  assert.equal(idle.calls.length, 0);

  // Automatic voting announcements do not restart the gap.
  db.prepare(
    "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)",
  ).run(roomId, "A mandatory poll has been created. Voting closes in 2 minute(s).", new Date(later).toISOString());
  const quiet = provider('{"intervene": false, "move": null, "reason": "progressing"}');
  const declined = await evaluateIntervention(roomId, { provider: quiet, now: later });
  assert.equal(declined.decision.intervene, false);
  const prompt = quiet.calls[0].messages[1].content;
  assert.match(prompt, /P1: Trees at the edges\./);
  assert.doesNotMatch(prompt, /Alice|Bob/, "usernames are not sent to the model");

  const garbled = await evaluateIntervention(roomId, { provider: provider("not json"), now: later });
  assert.equal(garbled.decision.reason, "unreadable_decision");

  let trigger;
  const posted = await evaluateIntervention(roomId, {
    provider: provider('{"intervene": true, "move": "bridge_option", "reason": "stuck"}'),
    now: later,
    generate: async ({ triggerText }) => {
      trigger = triggerText;
      const id = Number(
        db
          .prepare("INSERT INTO messages(room_id, sender_id, text, timestamp, is_facilitation) VALUES (?, NULL, ?, ?, 1)")
          .run(roomId, "What about trees near the seating at the edges?", new Date().toISOString())
          .lastInsertRowid,
      );
      return { id, room_id: roomId, sender_id: null, text: "x", is_bot: true };
    },
  });
  assert.equal(posted.decision.move, "bridge_option");
  assert.ok(trigger.startsWith(INTERVENTION_MOVES.bridge_option));

  say(roomId, alice.id, "Maybe.");
  say(roomId, bob.id, "Still prefer seating.");
  const limited = provider('{"intervene": true, "move": "summarize_positions", "reason": "x"}');
  assert.equal(
    await evaluateIntervention(roomId, { provider: limited, now: later + 200_000 }),
    null,
    "the per-topic maximum has been reached",
  );
  assert.equal(limited.calls.length, 0);

  const rows = db.prepare("SELECT outcome, move FROM intervention_decisions ORDER BY id").all();
  assert.deepEqual(
    rows.map((row) => row.outcome),
    ["blocked_cooldown", "no_intervention", "no_intervention", "posted", "blocked_topic_limit_reached"],
  );
});
