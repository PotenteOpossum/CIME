import { db, ensureAdminsInRoom } from "../config/db.js";
import {
  beginDecisionRun,
  createDecisionWorkContext,
} from "./decisionWorkService.js";
import { runWithWorkContext } from "./workContext.js";
import { emitDecisionStatus, logAgentEvent } from "./agent2Service.js";
import { getSimplifiedSettings } from './simplifiedSettingsService.js';
import client from './llm.js';
import { throwIfWorkCancelled } from './workContext.js';
import {
  defaultFinalAnswers,
  validateSimplifiedTopics,
} from "../../../shared/discussionSchema.mjs";

let ioRef;
let watchdog;
let nudging = false;
const iso = (time = Date.now()) => new Date(time).toISOString();
function liveSession(session) {
  const state = db
    .prepare(
      "SELECT current_phase, decision_run_id FROM system_state WHERE id = 1",
    )
    .get();
  return (
    !!session &&
    state?.current_phase === "discussing" &&
    state.decision_run_id === session.decision_run_id &&
    db.prepare("SELECT is_active FROM rooms WHERE id = ?").get(session.room_id)
      ?.is_active === 1
  );
}
export function getSimplifiedSession(roomId) {
  const row = db.prepare("SELECT * FROM simplified_cime WHERE id = 1").get();
  return row && (roomId === undefined || row.room_id === roomId)
    ? { ...row, config: JSON.parse(row.config_json) }
    : null;
}
export function simplifiedSignature(roomId) {
  const session = getSimplifiedSession(roomId);
  return session
    ? `${session.decision_run_id}:${session.stage}:${session.topic_index}`
    : null;
}
function message(roomId, text, now = Date.now()) {
  const inserted = db
    .prepare(
      "INSERT INTO messages(room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)",
    )
    .run(roomId, text, iso(now));
  const result = {
    id: Number(inserted.lastInsertRowid),
    room_id: roomId,
    sender_id: null,
    sender_name: "Bot",
    text,
    timestamp: iso(now),
    is_bot: true,
  };
  ioRef?.to(`room:${roomId}`).emit("receive_message", result);
  return result;
}
function updated(roomId) {
  ioRef?.emit("rooms_updated");
  ioRef?.to(`room:${roomId}`).emit("room_updated", { roomId });
  ioRef?.to(`room:${roomId}`).emit("polls_updated", { roomId });
  emitDecisionStatus(ioRef);
}
function topicMemory(config, active, stage) {
  return config.deliberationQuestions.map((topic, index) => ({
    key: `simplified-topic-${index + 1}`,
    topic: topic.topic,
    question: topic.question_text || topic.question,
    options: [
      ...new Set(
        topic.predefined_answers.map((item) => item.trim()).filter(Boolean),
      ),
    ],
    status:
      index < active || stage !== "discussing"
        ? "discussed"
        : index === active
          ? "discussing"
          : "upcoming",
    duration_minutes: topic.durationMinutes,
    is_general_question: false,
  }));
}
function recordTopicStart(roomId, topic, now) {
  const row = db
    .prepare("SELECT topic_timeline_json FROM rooms WHERE id = ?")
    .get(roomId);
  const timeline = JSON.parse(row?.topic_timeline_json || "[]");
  timeline.push({ topic, started_at: iso(now) });
  db.prepare("UPDATE rooms SET topic_timeline_json = ? WHERE id = ?").run(
    JSON.stringify(timeline),
    roomId,
  );
}
function announceTopic(session, now) {
  const topic = session.config.deliberationQuestions[session.topic_index];
  const options = [
    ...new Set(
      topic.predefined_answers.map((item) => item.trim()).filter(Boolean),
    ),
  ];
  message(
    session.room_id,
    `**Topic ${session.topic_index + 1} of ${session.config.deliberationQuestions.length}: ${topic.topic}**\n\n${topic.question_text || topic.question}\n\nPossible outcomes to discuss:\n${options.map((option) => `- ${option}`).join("\n")}\n\nWe have ${topic.durationMinutes} minute${topic.durationMinutes === 1 ? "" : "s"} for this topic. These are discussion options, not a ballot; you may suggest alternatives. The final vote on the main question comes after all topics.`,
    now,
  );
}
export function startSimplifiedCime(config, io) {
  validateSimplifiedTopics(config);
  if (!config.globalQuestion?.trim() || !config.decisionContext?.trim())
    throw Object.assign(
      new Error("Provide the main question and background context."),
      { status: 400 },
    );
  if (
    db.prepare("SELECT current_phase FROM system_state WHERE id = 1").get()
      ?.current_phase !== "idle"
  )
    throw Object.assign(new Error("This discussion has already started."), {
      status: 409,
    });
  ioRef = io;
  const time = Date.now();
  const finalOptions = [
    ...new Set(
      (config.generalQuestionAnswers || [])
        .map((item) => item.trim())
        .filter(
          (item) =>
            item && !["other", "keep discussing"].includes(item.toLowerCase()),
        ),
    ),
  ];
  const saved = {
    ...config,
    simplifiedSettings: getSimplifiedSettings(),
    generalQuestionAnswers:
      finalOptions.length >= 2 ? finalOptions : defaultFinalAnswers(),
  };
  const roomId = db.transaction(() => {
    const runId = beginDecisionRun({ mode: "human" });
    db.prepare("UPDATE rooms SET is_active = 0").run();
    db.prepare(
      "UPDATE system_state SET global_question = ?, decision_context = ?, general_description = ?, current_phase = 'discussing', discussion_round = 1, active_topic_index = 0, deliberation_config_json = ?, showdown_initiated = 0 WHERE id = 1",
    ).run(
      saved.globalQuestion.trim(),
      saved.decisionContext.trim(),
      saved.generalDescription || "",
      JSON.stringify(saved.deliberationQuestions),
    );
    const deadline = iso(
      time + saved.deliberationQuestions[0].durationMinutes * 60000,
    );
    const id = Number(
      db
        .prepare(
          "INSERT INTO rooms(name, prompt_file, system_prompt, room_type, is_active, decision_round, opened_at, timer_expires_at, topic_memory_json) VALUES (?, 'default.md', ?, 'plenary', 1, 1, ?, ?, ?)",
        )
        .run(
          "Shared discussion",
          saved.simplifiedSettings.facilitatorPrompt,
          iso(time),
          deadline,
          JSON.stringify(topicMemory(saved, 0, "discussing")),
        ).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO room_members(user_id, room_id) SELECT id, ? FROM users WHERE is_admin = 0",
    ).run(id);
    ensureAdminsInRoom(id);
    recordTopicStart(id, saved.deliberationQuestions[0].topic, time);
    db.prepare(
      "INSERT INTO simplified_cime(id, room_id, decision_run_id, config_json, topic_index, stage, topic_started_at, deadline_at) VALUES (1, ?, ?, ?, 0, 'discussing', ?, ?) ON CONFLICT(id) DO UPDATE SET room_id = excluded.room_id, decision_run_id = excluded.decision_run_id, config_json = excluded.config_json, topic_index = 0, stage = 'discussing', topic_started_at = excluded.topic_started_at, deadline_at = excluded.deadline_at, final_poll_id = NULL",
    ).run(id, runId, JSON.stringify(saved), iso(time), deadline);
    const insertQuestion = db.prepare(
      "INSERT INTO gathering_questions(topic, question_text, question_order, predefined_answers_json, is_general_question, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    saved.deliberationQuestions.forEach((topic, index) =>
      insertQuestion.run(
        topic.topic,
        topic.question_text || topic.question,
        index + 1,
        JSON.stringify(topic.predefined_answers.filter((item) => item.trim())),
        0,
        iso(time),
      ),
    );
    insertQuestion.run(
      "general-question",
      saved.globalQuestion,
      saved.deliberationQuestions.length + 1,
      JSON.stringify(saved.generalQuestionAnswers),
      1,
      iso(time),
    );
    return id;
  })();
  if (saved.generalDescription?.trim())
    message(roomId, saved.generalDescription.trim(), time);
  announceTopic(getSimplifiedSession(roomId), time);
  logAgentEvent(
    "agent2",
    "Started Simplified CIME",
    "One shared discussion; timed topics; final vote only.",
  );
  ioRef?.emit("process_started", {
    globalQuestion: saved.globalQuestion,
    generalDescription: saved.generalDescription || "",
    process_started_at: iso(time),
    discussionType: "simplified",
  });
  updated(roomId);
  return { ok: true, roomId, discussionType: "simplified" };
}
function openFinalVote(session, now) {
  const minutes = (session.config.simplifiedSettings || getSimplifiedSettings()).finalVoteMinutes;
  const deadline = iso(now + minutes * 60000);
  const pollId = Number(
    db
      .prepare(
        "INSERT INTO polls(room_id, question, show_results, is_closed, mandatory, expires_at, created_at, suggestion, poll_type, poll_stage) VALUES (?, ?, 0, 0, 1, ?, ?, 'general-question', 'plurality', 'standard')",
      )
      .run(session.room_id, session.config.globalQuestion, deadline, iso(now))
      .lastInsertRowid,
  );
  for (const option of session.config.generalQuestionAnswers)
    db.prepare(
      "INSERT INTO poll_options(poll_id, option_text) VALUES (?, ?)",
    ).run(pollId, option);
  db.prepare(
    "UPDATE simplified_cime SET stage = 'final_vote', final_poll_id = ?, deadline_at = ? WHERE id = 1",
  ).run(pollId, deadline);
  recordTopicStart(session.room_id, "general-question", now);
  db.prepare(
    "UPDATE rooms SET timer_expires_at = ?, topic_memory_json = ? WHERE id = ?",
  ).run(
    deadline,
    JSON.stringify(
      topicMemory(session.config, session.topic_index, "final_vote"),
    ),
    session.room_id,
  );
  message(
    session.room_id,
    `All discussion topics have finished. The final vote on **${session.config.globalQuestion}** is now open for ${minutes} minutes. Choose your answer in the poll.`,
    now,
  );
}
export function resolveSimplifiedFinalVote(pollId, roomId, now = Date.now()) {
  const session = getSimplifiedSession(roomId);
  if (
    !session ||
    session.stage !== "final_vote" ||
    session.final_poll_id !== pollId
  )
    return;
  if (!liveSession(session)) return;
  const poll = db
    .prepare("SELECT * FROM polls WHERE id = ? AND is_closed = 0")
    .get(pollId);
  if (!poll) return;
  const eligible = db
    .prepare(
      "SELECT COUNT(*) AS n FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0",
    )
    .get(roomId).n;
  const voters = db
    .prepare(
      "SELECT COUNT(DISTINCT v.user_id) AS n FROM poll_votes v JOIN room_members rm ON rm.user_id = v.user_id AND rm.room_id = ? JOIN users u ON u.id = v.user_id WHERE v.poll_id = ? AND u.is_admin = 0",
    )
    .get(roomId, pollId).n;
  if (new Date(poll.expires_at).getTime() > now && voters < eligible) return;
  const counts = db
    .prepare(
      "SELECT o.id, o.option_text, COUNT(v.user_id) AS votes FROM poll_options o LEFT JOIN poll_votes v ON v.option_id = o.id AND v.poll_id = o.poll_id WHERE o.poll_id = ? GROUP BY o.id, o.option_text ORDER BY o.id",
    )
    .all(pollId);
  const topVotes = Math.max(0, ...counts.map((item) => item.votes));
  const leaders = counts.filter((item) => item.votes === topVotes);
  const outcome =
    topVotes === 0
      ? "No votes were cast."
      : leaders.length > 1
        ? `Tie between ${leaders.map((item) => `"${item.option_text}"`).join(" and ")} with ${topVotes} vote${topVotes === 1 ? "" : "s"} each. No option won.`
        : `"${leaders[0].option_text}" received the most votes (${topVotes}).`;
  const report = `# Final discussion report\n\n## Main question\n${session.config.globalQuestion}\n\n## Outcome\n${outcome}\n\n## Final vote\n${counts.map((item) => `- ${item.option_text}: ${item.votes}`).join("\n")}\n\n${voters} of ${eligible} participants voted.\n\n## Topics discussed\n${session.config.deliberationQuestions.map((topic, index) => `${index + 1}. ${topic.topic} (${topic.durationMinutes} minutes)`).join("\n")}\n\nImplementation options were discussed without topic votes. No collective implementation decisions were taken.`;
  db.transaction(() => {
    db.prepare(
      "UPDATE polls SET is_closed = 1, show_results = 1, closed_at = ? WHERE id = ?",
    ).run(iso(now), pollId);
    db.prepare(
      "UPDATE simplified_cime SET stage = 'completed', deadline_at = NULL WHERE id = 1",
    ).run();
    db.prepare(
      "UPDATE rooms SET is_active = 0, collection_complete = 1, timer_expires_at = NULL, recap_report = ? WHERE id = ?",
    ).run(report, roomId);
    db.prepare(
      "UPDATE system_state SET current_phase = 'completed' WHERE id = 1",
    ).run();
  })();
  message(
    roomId,
    "The final vote is complete. Thank you for taking part. Please continue to the post-experiment survey if one is available.",
    now,
  );
  updated(roomId);
  ioRef?.emit("convergence_completed", { roomId, report });
}
export function advanceSimplifiedCime(now = Date.now()) {
  const session = getSimplifiedSession();
  if (!session || session.stage === "completed" || !liveSession(session))
    return;
  if (session.stage === "final_vote")
    return resolveSimplifiedFinalVote(
      session.final_poll_id,
      session.room_id,
      now,
    );
  if (new Date(session.deadline_at).getTime() > now) return;
  db.transaction(() => {
    const index = session.topic_index + 1;
    if (index === session.config.deliberationQuestions.length)
      openFinalVote(session, now);
    else {
      const deadline = iso(
        now +
          session.config.deliberationQuestions[index].durationMinutes * 60000,
      );
      db.prepare(
        "UPDATE simplified_cime SET topic_index = ?, topic_started_at = ?, deadline_at = ? WHERE id = 1",
      ).run(index, iso(now), deadline);
      db.prepare(
        "UPDATE system_state SET active_topic_index = ? WHERE id = 1",
      ).run(index);
      recordTopicStart(
        session.room_id,
        session.config.deliberationQuestions[index].topic,
        now,
      );
      db.prepare(
        "UPDATE rooms SET timer_expires_at = ?, topic_memory_json = ? WHERE id = ?",
      ).run(
        deadline,
        JSON.stringify(topicMemory(session.config, index, "discussing")),
        session.room_id,
      );
      announceTopic({ ...session, topic_index: index }, now);
    }
  })();
  updated(session.room_id);
}
export function simplifiedRuntimeInstruction(roomId) {
  const session = getSimplifiedSession(roomId);
  if (!session) return "";
  if (session.stage !== "discussing")
    return "The final main-question ballot is open or finished. Answer clarification questions neutrally; do not discuss new topics or tell anyone how to vote.";
  const topic = session.config.deliberationQuestions[session.topic_index];
  return `You facilitate Simplified CIME: everyone shares one chat. Stay on the current topic: ${topic.topic}. Discussion question: ${topic.question_text || topic.question}. Possible outcomes for discussion: ${topic.predefined_answers.filter(Boolean).join(" | ")}. Use the admin background context, ask for reasons and differing views, and remain neutral. Options are suggestions to discuss, not a ballot or an agreed decision. There are no topic votes, private interviews, subgroups, or collective review. Never open or promise a topic vote, seek consensus as a condition for moving on, or advance to another topic yourself. The application moves topics automatically at the configured deadlines. Only the main question is voted on after every topic. Participants may suggest other possible outcomes.`;
}
export async function generateSimplifiedReply({ roomId, triggerText, allowDuringPoll = false }, provider = client) {
  throwIfWorkCancelled();
  advanceSimplifiedCime();
  const session = getSimplifiedSession(roomId);
  if (!provider || !liveSession(session) || (session.stage !== 'discussing' && !allowDuringPoll)) return null;
  const signature = simplifiedSignature(roomId);
  const settings = session.config.simplifiedSettings || getSimplifiedSettings();
  const history = db.prepare('SELECT m.sender_id, m.text, u.username FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 40').all(roomId).reverse();
  const response = await provider.chat.completions.create({
    model: settings.model, max_completion_tokens: 350,
    messages: [
      { role: 'system', content: settings.facilitatorPrompt },
      { role: 'system', content: `Main question: ${session.config.globalQuestion}\nBackground context: ${session.config.decisionContext}\nOpening message: ${session.config.generalDescription || ''}\n${simplifiedRuntimeInstruction(roomId)}` },
      ...history.map((entry) => ({ role: entry.sender_id === null ? 'assistant' : 'user', content: entry.text })),
      ...(triggerText ? [{ role: 'system', content: triggerText }] : []),
    ],
    metadata: { roomId, caller: 'simplified_facilitator', modelResolved: true },
  });
  throwIfWorkCancelled();
  advanceSimplifiedCime();
  if (!liveSession(getSimplifiedSession(roomId)) || signature !== simplifiedSignature(roomId)) return null;
  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  const timestamp = iso();
  const result = db.prepare('INSERT INTO messages(room_id, sender_id, text, timestamp, is_facilitation) VALUES (?, NULL, ?, ?, 1)').run(roomId, text, timestamp);
  return { id: Number(result.lastInsertRowid), room_id: roomId, sender_id: null, sender_name: 'Bot', is_bot: true, text, timestamp };
}
export function initSimplifiedCime(io) {
  ioRef = io;
  if (watchdog) return;
  const tick = async () => {
    advanceSimplifiedCime();
    const session = getSimplifiedSession();
    if (!session || session.stage !== "discussing" || nudging) return;
    if (!liveSession(session)) return;
    const quietMinutes = (session.config.simplifiedSettings || getSimplifiedSettings()).quietMinutes;
    if (quietMinutes === 0) return;
    const latest = db
      .prepare(
        "SELECT timestamp FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(session.room_id);
    if (
      !latest ||
      Date.now() - new Date(latest.timestamp).getTime() <
        quietMinutes * 60000
    )
      return;
    nudging = true;
    try {
      const work = createDecisionWorkContext({ roomId: session.room_id });
      await runWithWorkContext(work, async () => {
        const { maybeGenerateBotReply } = await import("./openaiService.js");
        const reply = await maybeGenerateBotReply({
          roomId: session.room_id,
          triggerText:
            "The shared discussion has been quiet. Briefly invite participants to discuss the current topic, respond to a different view, or explain a reason. Do not ask for a vote.",
        });
        if (reply)
          ioRef?.to(`room:${session.room_id}`).emit("receive_message", reply);
      });
    } finally {
      nudging = false;
    }
  };
  watchdog = setInterval(
    () =>
      tick().catch((error) =>
        console.error("Simplified CIME timer:", error.message),
      ),
    1000,
  );
  watchdog.unref();
  // Persisted deadlines also work after an engine restart.
  advanceSimplifiedCime();
}
