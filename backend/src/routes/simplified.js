import { createRouter } from "../middleware/router.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { db } from "../config/db.js";
import {
  getSimplifiedSettings,
  saveSimplifiedSettings,
  simplifiedSettingsLocked,
  simplifiedAvailableModels,
} from "../services/simplifiedSettingsService.js";
import {
  getSimplifiedSession,
  advanceSimplifiedCime,
} from "../services/simplifiedCimeService.js";

export const simplifiedAdminRoutes = createRouter();
simplifiedAdminRoutes.use(authMiddleware, adminMiddleware);
simplifiedAdminRoutes.get("/settings", (_req, res) =>
  res.json({
    settings: getSimplifiedSettings(),
    availableModels: simplifiedAvailableModels(),
    locked: simplifiedSettingsLocked(),
  }),
);
simplifiedAdminRoutes.put("/settings", (req, res) =>
  res.json({
    settings: saveSimplifiedSettings(req.body),
    availableModels: simplifiedAvailableModels(),
    locked: false,
  }),
);
simplifiedAdminRoutes.get("/overview", (_req, res) => {
  advanceSimplifiedCime();
  const session = getSimplifiedSession();
  const participants = db
    .prepare(
      "SELECT u.id, u.username FROM users u JOIN run_participants p ON p.user_id = u.id WHERE u.is_admin = 0 ORDER BY p.joined_at",
    )
    .all();
  const topic = session?.config.deliberationQuestions[session.topic_index];
  const messages = session
    ? db
        .prepare(
          "SELECT m.id, m.text, m.timestamp, COALESCE(u.username, 'AI facilitator') AS sender FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 100",
        )
        .all(session.room_id)
        .reverse()
    : [];
  const results =
    session?.stage === "completed"
      ? db
          .prepare(
            "SELECT o.id, o.option_text, COUNT(v.user_id) AS votes FROM poll_options o LEFT JOIN poll_votes v ON v.poll_id = o.poll_id AND v.option_id = o.id WHERE o.poll_id = ? GROUP BY o.id, o.option_text ORDER BY o.id",
          )
          .all(session.final_poll_id)
      : [];
  res.json({
    participants,
    messages,
    results,
    stage: session?.stage || "waiting",
    topic: topic || null,
    topicNumber: session ? session.topic_index + 1 : 0,
    topicCount: session?.config.deliberationQuestions.length || 0,
    deadline: session?.deadline_at || null,
    roomId: session?.room_id || null,
  });
});
simplifiedAdminRoutes.get("/logs", (_req, res) =>
  res.json({
    logs: db
      .prepare(
        "SELECT id, created_at, model, caller, tokens_used, prompt, response FROM llm_logs ORDER BY id DESC LIMIT 100",
      )
      .all(),
  }),
);
