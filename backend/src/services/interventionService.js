import { db } from "../config/db.js";
import client from "./llm.js";
import { getConfiguredModels, getDecisionSettings } from "./agentConfigService.js";
import { getSimplifiedSession } from "./simplifiedCimeService.js";
import { getSimplifiedSettings } from "./simplifiedSettingsService.js";
import {
  getUnresolvedRoomMemoryTopics,
  isPollLifecycleMessage,
} from "./agent3Service.js";
import { generateAgent1Reply } from "./agent1Service.js";
import { createDecisionWorkContext } from "./decisionWorkService.js";
import { runWithWorkContext } from "./workContext.js";
import { logAgentEvent } from "./agent2Service.js";
import { normalizeInterventionSettings } from "../../../shared/interventionSettings.mjs";

// Mid-discussion intervention check, shared by Full CIME group rooms and the
// Simplified CIME shared room. After participants pause, a cheap model reads the
// current topic's messages and decides whether the facilitator should step in.
// The hard limits below are enforced in code and cannot be overridden by the model.
// Silence is still handled by each version's quiet nudge.

export const INTERVENTION_DEBOUNCE_MS = 20_000;
export const INTERVENTION_MAX_WAIT_MS = 60_000;
const MIN_HUMAN_MESSAGES_SINCE_AI = 2;
const END_OF_TOPIC_QUIET_MS = 30_000;
const MAX_TRANSCRIPT_MESSAGES = 40;

export const INTERVENTION_MOVES = Object.freeze({
  bridge_option:
    "The discussion seems stuck between positions. Propose ONE compromise option that combines concerns participants have actually raised. Present it clearly as a suggestion for discussion, not a decision, and ask what people think of it.",
  summarize_positions:
    "Briefly summarize where participants agree and where they still disagree on the current topic, using only points that were actually made. End with one question about the main remaining difference.",
  invite_quiet_participants:
    "A few participants are doing most of the talking. Warmly invite those who have not spoken on this topic yet to share their view, without naming or pressuring anyone.",
  refocus:
    "The discussion has drifted from the current topic. Gently bring it back by connecting the recent point to the current topic and asking one focused question about it.",
  answer_question:
    "A participant's question has not been answered. Answer it briefly and neutrally using only the available context, then return to the current topic.",
});

const DECISION_PROMPT = `You decide whether a neutral discussion facilitator should post a message now. Most of the time the answer is no: participants should lead their own discussion.

Intervene only when one of these is clearly happening on the current topic:
- "bridge_option": participants repeat the same opposing positions without progress.
- "summarize_positions": many points were raised and the group would benefit from seeing where it agrees and disagrees.
- "invite_quiet_participants": the counts show that a few participants wrote most messages while several others have not written on this topic.
- "refocus": the recent messages are about something unrelated to the current topic.
- "answer_question": a participant asked a question about the topic or process that nobody has answered.

Never intervene to ask anyone how they will vote. If the discussion is progressing, do not intervene.

Return strict JSON: {"intervene": boolean, "move": one of the moves above or null, "reason": short explanation}.`;

const timers = new Map();

function iso(time = Date.now()) {
  return new Date(time).toISOString();
}

export function interventionSettingsFor(roomType) {
  if (roomType === "plenary") {
    const saved =
      getSimplifiedSession()?.config.simplifiedSettings || getSimplifiedSettings();
    return normalizeInterventionSettings({
      enabled: saved.interventionEnabled,
      cooldownSeconds: saved.interventionCooldownSeconds,
      maxPerTopic: saved.interventionMaxPerTopic,
    });
  }
  const settings = getDecisionSettings();
  return normalizeInterventionSettings({
    enabled: settings.intervention_enabled,
    cooldownSeconds: settings.intervention_cooldown_seconds,
    maxPerTopic: settings.intervention_max_per_topic,
  });
}

// The current topic and when it started, for either room type.
function currentTopic(room) {
  if (room.room_type === "plenary") {
    const session = getSimplifiedSession(room.id);
    if (!session || session.stage !== "discussing") return null;
    const topic = session.config.deliberationQuestions[session.topic_index];
    return {
      key: topic.topic,
      question: topic.question_text || topic.question,
      options: topic.predefined_answers.filter((item) => item.trim()),
      startedAt: session.topic_started_at,
      deadline: session.deadline_at,
    };
  }
  const topic = getUnresolvedRoomMemoryTopics(room.id)[0];
  if (!topic) return null;
  const lastClosed = db
    .prepare(
      "SELECT MAX(closed_at) AS t FROM polls WHERE room_id = ? AND is_closed = 1",
    )
    .get(room.id)?.t;
  return {
    key: topic.suggestion || topic.key || topic.topic,
    question: topic.question || topic.topic,
    options: Array.isArray(topic.options) ? topic.options : [],
    startedAt: lastClosed || room.opened_at,
    deadline: room.timer_expires_at,
  };
}

// The facilitator's latest conversational message: a reply, nudge or earlier
// intervention. Automatic announcements (topic transitions, results, voting
// notices) do not count. Full CIME posts them every minute or two, so counting
// them would leave far fewer chances to intervene than in Simplified CIME.
function lastFacilitatorMessage(roomId) {
  return db
    .prepare(
      "SELECT id, timestamp FROM messages WHERE room_id = ? AND sender_id IS NULL AND is_facilitation = 1 ORDER BY id DESC LIMIT 1",
    )
    .get(roomId);
}

// Reasons the hard rules block a check, or null when a check may run.
function blockedReason(room, topic, settings, now) {
  if (!settings.enabled) return "disabled";
  if (!room || room.is_active !== 1 || room.collection_complete === 1)
    return "room_inactive";
  if (!topic) return "no_active_topic";
  // Open votes, swipe rounds included, do not block a check: in Full CIME a vote
  // is open for most of each topic, and Simplified CIME has no topic votes.
  if (
    topic.deadline &&
    new Date(topic.deadline).getTime() - now < END_OF_TOPIC_QUIET_MS
  )
    return "topic_ending";
  const lastAi = lastFacilitatorMessage(room.id);
  if (
    lastAi &&
    now - new Date(lastAi.timestamp).getTime() < settings.cooldownSeconds * 1000
  )
    return "cooldown";
  const humanSinceAi = db
    .prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE room_id = ? AND sender_id IS NOT NULL AND id > ? AND timestamp >= ?",
    )
    .get(room.id, lastAi?.id || 0, topic.startedAt || "").n;
  if (humanSinceAi < MIN_HUMAN_MESSAGES_SINCE_AI) return "too_few_new_messages";
  const used = db
    .prepare(
      "SELECT COUNT(*) AS n FROM intervention_decisions WHERE room_id = ? AND topic = ? AND outcome = 'posted'",
    )
    .get(room.id, topic.key).n;
  if (used >= settings.maxPerTopic) return "topic_limit_reached";
  return null;
}

// Participants are labelled P1, P2, ... in order of first message, so the
// decision can see who dominates without receiving usernames.
function topicTranscript(room, topic) {
  const messages = db
    .prepare(
      "SELECT id, sender_id, text, timestamp FROM messages WHERE room_id = ? AND timestamp >= ? ORDER BY id DESC LIMIT ?",
    )
    .all(room.id, topic.startedAt || "", MAX_TRANSCRIPT_MESSAGES)
    .reverse();
  const labels = new Map();
  const counts = new Map();
  const lines = messages.map((message) => {
    if (message.sender_id === null) return `Facilitator: ${message.text}`;
    if (!labels.has(message.sender_id))
      labels.set(message.sender_id, `P${labels.size + 1}`);
    counts.set(message.sender_id, (counts.get(message.sender_id) || 0) + 1);
    return `${labels.get(message.sender_id)}: ${message.text}`;
  });
  const members = db
    .prepare(
      "SELECT COUNT(*) AS n FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0",
    )
    .get(room.id).n;
  const humanMessages = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const topThree = [...counts.values()]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, n) => sum + n, 0);
  return {
    lines,
    signals: {
      participants_in_room: members,
      participants_who_wrote_on_topic: counts.size,
      participant_messages_on_topic: humanMessages,
      share_of_messages_by_top_three: humanMessages
        ? Math.round((topThree / humanMessages) * 100) / 100
        : 0,
      minutes_left_on_topic: topic.deadline
        ? Math.max(
            0,
            Math.round((new Date(topic.deadline).getTime() - Date.now()) / 6000) /
              10,
          )
        : null,
    },
  };
}

function parseDecision(text) {
  try {
    const parsed = JSON.parse(String(text || "").replace(/^```(?:json)?|```$/g, "").trim());
    const move = parsed.move ? String(parsed.move) : null;
    if (parsed.intervene === true && move && INTERVENTION_MOVES[move])
      return { intervene: true, move, reason: String(parsed.reason || "") };
    if (parsed.intervene === false)
      return { intervene: false, move: null, reason: String(parsed.reason || "") };
  } catch {
    // Unreadable output is treated as "do not intervene".
  }
  return { intervene: false, move: null, reason: "unreadable_decision" };
}

function record(room, topic, decision, outcome, signals, messageId = null) {
  db.prepare(
    "INSERT INTO intervention_decisions(room_id, discussion_type, topic, decided_at, intervene, move, reason, outcome, signals_json, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    room.id,
    room.room_type === "plenary" ? "simplified" : "full",
    topic.key,
    iso(),
    decision.intervene ? 1 : 0,
    decision.move,
    decision.reason,
    outcome,
    JSON.stringify(signals),
    messageId,
  );
}

export async function evaluateIntervention(roomId, { io, provider = client, generate = generateAgent1Reply, now = Date.now() } = {}) {
  const room = db.prepare("SELECT * FROM rooms WHERE id = ?").get(roomId);
  if (!room || !["group", "plenary"].includes(room.room_type)) return null;
  const settings = interventionSettingsFor(room.room_type);
  const topic = currentTopic(room);
  const blocked = blockedReason(room, topic, settings, now);
  if (blocked) {
    // Recorded so a pilot can show how often each rule kept the facilitator
    // silent. A disabled check or a finished room is not worth a row.
    if (topic && !["disabled", "room_inactive"].includes(blocked))
      record(room, topic, { intervene: false, move: null, reason: null }, `blocked_${blocked}`, {});
    return null;
  }
  if (!provider) return null;

  const { lines, signals } = topicTranscript(room, topic);
  const response = await provider.chat.completions.create({
    model: getConfiguredModels().cheapModel,
    max_completion_tokens: 400,
    messages: [
      { role: "system", content: DECISION_PROMPT },
      {
        role: "user",
        content: `Current topic: ${topic.key}\nQuestion: ${topic.question}\nOptions so far: ${topic.options.join(" | ") || "none"}\n\nCounts: ${JSON.stringify(signals)}\n\nMessages on this topic:\n${lines.join("\n")}`,
      },
    ],
    metadata: { roomId, caller: "intervention_decision" },
  });
  const decision = parseDecision(response.choices?.[0]?.message?.content);
  if (!decision.intervene) {
    record(room, topic, decision, "no_intervention", signals);
    return { decision, message: null };
  }

  const checkedAt = Date.now();
  const reply = await generate({
    roomId,
    allowDuringPoll: room.room_type === "group",
    triggerText: `${INTERVENTION_MOVES[decision.move]} Keep it to at most 3 short sentences. Never ask how anyone will vote.`,
  });
  if (!reply) {
    record(room, topic, decision, "no_reply", signals);
    return { decision, message: null };
  }
  // Another facilitator message (a quiet nudge, an @mention reply or a topic
  // transition) may have been posted while this one was generated.
  const otherAi = db
    .prepare(
      "SELECT text FROM messages WHERE room_id = ? AND sender_id IS NULL AND id <> ? AND timestamp >= ?",
    )
    .all(roomId, reply.id, iso(checkedAt))
    .filter((message) => !isPollLifecycleMessage(message.text)).length;
  if (otherAi > 0) {
    db.prepare("DELETE FROM messages WHERE id = ?").run(reply.id);
    record(room, topic, decision, "dropped_other_ai_message", signals);
    return { decision, message: null };
  }
  record(room, topic, decision, "posted", signals, reply.id);
  logAgentEvent(
    "agent1",
    "Mid-discussion intervention",
    `${decision.move}: ${decision.reason}`,
  );
  io?.to(`room:${roomId}`).emit("receive_message", reply);
  return { decision, message: reply };
}

// Called after every participant message. The check runs once participants
// pause, so a burst of messages leads to one decision. A room that never
// pauses is still checked once the first unchecked message is a minute old.
export function scheduleInterventionCheck(roomId, io) {
  const room = db.prepare("SELECT room_type FROM rooms WHERE id = ?").get(roomId);
  if (!room || !["group", "plenary"].includes(room.room_type)) return;
  if (!interventionSettingsFor(room.room_type).enabled) return;
  const pending = timers.get(roomId);
  const firstPendingAt = pending?.firstPendingAt ?? Date.now();
  clearTimeout(pending?.timer);
  const delay = Math.max(
    0,
    Math.min(
      INTERVENTION_DEBOUNCE_MS,
      firstPendingAt + INTERVENTION_MAX_WAIT_MS - Date.now(),
    ),
  );
  const timer = setTimeout(() => {
    timers.delete(roomId);
    const work = createDecisionWorkContext({ roomId });
    runWithWorkContext(work, () => evaluateIntervention(roomId, { io })).catch(
      (error) => console.error("Intervention check failed:", error.message),
    );
  }, delay);
  timer.unref?.();
  timers.set(roomId, { timer, firstPendingAt });
}

export function cancelInterventionChecks() {
  for (const pending of timers.values()) clearTimeout(pending.timer);
  timers.clear();
}
