import { createHash } from "node:crypto";
import client, { resolveLlmModel } from "./llm.js";
import { db } from "../config/db.js";
import { renderTemplate, getConfiguredModels } from "./agentConfigService.js";
import { shareAnalysis } from "./sharedAnalysisService.js";
import { throwIfWorkCancelled } from "./workContext.js";

function assessmentKey(caller, args, template) {
  const model = resolveLlmModel(caller, getConfiguredModels().primaryModel);
  const sortedArgs = Object.keys(args)
    .filter((key) => key !== "allowCompute")
    .sort()
    .map((key) => [key, args[key]]);
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify([caller, model, renderTemplate(template), sortedArgs]),
    )
    .digest("hex");
  return { cacheKey, modelName: model };
}

export function classifyCustomOption(args) {
  throwIfWorkCancelled();
  const identity = assessmentKey(
    "custom-option-analysis",
    args,
    "custom-option-analysis.md",
  );
  if (args.allowCompute === false)
    return Promise.resolve(readStoredAnalysis({ ...args, ...identity }));
  return shareAnalysis(identity.cacheKey, () =>
    classifyCustomOptionOnce({ ...args, ...identity }),
  );
}

export function classifyHumanMessageProactiveness(args) {
  throwIfWorkCancelled();
  const identity = assessmentKey(
    "message-proactiveness-analysis",
    args,
    "message-proactiveness-analysis.md",
  );
  if (args.allowCompute === false)
    return Promise.resolve(
      readStoredMessageProactivenessAnalysis({ ...args, ...identity }),
    );
  return shareAnalysis(identity.cacheKey, () =>
    classifyHumanMessageProactivenessOnce({ ...args, ...identity }),
  );
}

const ALLOWED_RECIPROCITY_TYPES = new Set([
  "extension",
  "contradiction",
  "combination",
  "unrelated",
]);
const ALLOWED_CONSTRUCTIVE_LABELS = new Set([
  "support",
  "opposition",
  "modification",
  "mitigation",
  "neutral",
]);
const ALLOWED_PROACTIVENESS_LABELS = new Set([
  "support",
  "opposition",
  "modification",
  "mitigation",
  "neutral",
]);

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function normalizeAnalysis(raw) {
  const parsed = raw && typeof raw === "object" ? raw : {};

  const rawReciprocity =
    parsed.reciprocity && typeof parsed.reciprocity === "object"
      ? parsed.reciprocity
      : parsed;
  const reciprocityType = ALLOWED_RECIPROCITY_TYPES.has(
    String(rawReciprocity.type || parsed.type || "").trim(),
  )
    ? String(rawReciprocity.type || parsed.type).trim()
    : "unrelated";
  const reciprocityConfidenceNumber = Number(
    rawReciprocity.confidence ?? parsed.confidence,
  );
  const reciprocityConfidence = Number.isFinite(reciprocityConfidenceNumber)
    ? Math.max(0, Math.min(1, reciprocityConfidenceNumber))
    : 0;
  const reciprocityReferencedMessages = Array.isArray(
    rawReciprocity.referenced_messages || parsed.referenced_messages,
  )
    ? (rawReciprocity.referenced_messages || parsed.referenced_messages)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .slice(0, 12)
    : [];

  const rawConstructive =
    parsed.constructive && typeof parsed.constructive === "object"
      ? parsed.constructive
      : null;
  const constructiveLabel = ALLOWED_CONSTRUCTIVE_LABELS.has(
    String(rawConstructive?.label || "").trim(),
  )
    ? String(rawConstructive.label).trim()
    : "neutral";
  const constructiveConfidenceNumber = Number(rawConstructive?.confidence);
  const constructiveConfidence = Number.isFinite(constructiveConfidenceNumber)
    ? Math.max(0, Math.min(1, constructiveConfidenceNumber))
    : 0;
  const constructiveReferencedMessages = Array.isArray(
    rawConstructive?.referenced_messages,
  )
    ? rawConstructive.referenced_messages
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .slice(0, 12)
    : [];

  return {
    reciprocity: {
      is_reciprocal:
        rawReciprocity.is_reciprocal === true ||
        reciprocityType !== "unrelated",
      type: reciprocityType,
      confidence: reciprocityConfidence,
      referenced_messages: reciprocityReferencedMessages,
    },
    constructive: {
      label: constructiveLabel,
      confidence: constructiveConfidence,
      referenced_messages: constructiveReferencedMessages,
    },
  };
}

function storeAnalysis({
  pollId,
  userId,
  optionId,
  customOptionText,
  analysis,
  cacheKey,
}) {
  db.prepare(
    `
    INSERT INTO custom_option_analyses (
      poll_id,
      user_id,
      option_id,
      custom_option_text,
      analysis_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(poll_id, user_id, option_id) DO UPDATE SET
      custom_option_text = excluded.custom_option_text,
      analysis_json = excluded.analysis_json,
      created_at = excluded.created_at
  `,
  ).run(
    pollId,
    userId,
    optionId,
    customOptionText,
    JSON.stringify({ ...analysis, cacheKey }),
    new Date().toISOString(),
  );
}

function readStoredAnalysis({
  pollId,
  userId,
  optionId,
  customOptionText,
  cacheKey,
}) {
  const row = db
    .prepare(
      `
    SELECT analysis_json
    FROM custom_option_analyses
    WHERE poll_id = ? AND user_id = ? AND option_id = ? AND custom_option_text = ?
  `,
    )
    .get(pollId, userId, optionId, customOptionText);
  if (!row) return null;
  const parsed = safeParseJson(row.analysis_json);
  if (parsed?.cacheKey !== cacheKey) return null;
  if (
    !parsed ||
    !parsed.reciprocity ||
    !parsed.constructive ||
    !(parsed.reciprocity.confidence > 0) ||
    !(parsed.constructive.confidence > 0)
  )
    return null;
  return normalizeAnalysis(parsed);
}

function normalizeProactivenessAnalysis(raw) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const label = ALLOWED_PROACTIVENESS_LABELS.has(
    String(parsed.label || "").trim(),
  )
    ? String(parsed.label).trim()
    : "neutral";
  const confidenceNumber = Number(parsed.confidence);
  const confidence = Number.isFinite(confidenceNumber)
    ? Math.max(0, Math.min(1, confidenceNumber))
    : 0;
  const referencedMessages = Array.isArray(parsed.referenced_messages)
    ? parsed.referenced_messages
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .slice(0, 12)
    : [];

  return {
    label,
    confidence,
    referenced_messages: referencedMessages,
  };
}

function storeMessageProactivenessAnalysis({
  messageId,
  userId,
  roomId,
  analysis,
  cacheKey,
}) {
  db.prepare(
    `
    INSERT INTO message_proactiveness_analyses (
      message_id,
      user_id,
      room_id,
      analysis_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      user_id = excluded.user_id,
      room_id = excluded.room_id,
      analysis_json = excluded.analysis_json,
      created_at = excluded.created_at
  `,
  ).run(
    messageId,
    userId,
    roomId,
    JSON.stringify({ ...analysis, cacheKey }),
    new Date().toISOString(),
  );
}

function readStoredMessageProactivenessAnalysis({ messageId, cacheKey }) {
  const row = db
    .prepare(
      `
    SELECT analysis_json
    FROM message_proactiveness_analyses
    WHERE message_id = ?
  `,
    )
    .get(messageId);
  if (!row) return null;
  const parsed = safeParseJson(row.analysis_json);
  if (parsed?.cacheKey !== cacheKey) return null;
  if (!parsed || typeof parsed.label !== "string" || !(parsed.confidence > 0))
    return null;
  return normalizeProactivenessAnalysis(parsed);
}

async function classifyCustomOptionOnce({
  cacheKey,
  modelName,
  pollId,
  userId,
  optionId,
  customOptionText,
  roomId,
  roomName,
  globalQuestion,
  decisionContext,
  generalDescription,
  pollQuestion,
  pollOptions,
  recentMessages,
  previousPollOptions,
}) {
  throwIfWorkCancelled();
  const cached = readStoredAnalysis({
    pollId,
    userId,
    optionId,
    customOptionText,
    cacheKey,
  });
  if (cached) return cached;

  const fallback = normalizeAnalysis({
    reciprocity: {
      is_reciprocal: false,
      type: "unrelated",
      confidence: 0,
      referenced_messages: [],
    },
    constructive: {
      label: "neutral",
      confidence: 0,
      referenced_messages: [],
    },
  });

  if (!client) {
    storeAnalysis({
      pollId,
      userId,
      optionId,
      customOptionText,
      analysis: fallback,
      cacheKey,
    });
    return fallback;
  }

  const previousPollBlock =
    Array.isArray(previousPollOptions) && previousPollOptions.length > 0
      ? `Previous poll options from the same topic:\n${previousPollOptions.map((opt) => `- ${opt}`).join("\n")}`
      : "";

  const prompt = renderTemplate("custom-option-analysis.md", {
    global_question: globalQuestion || "",
    decision_context: decisionContext || "",
    general_description: generalDescription || "",
    room_name: roomName || "",
    poll_question: pollQuestion || "",
    poll_options: Array.isArray(pollOptions)
      ? pollOptions.map((opt) => `- ${opt}`).join("\n")
      : "",
    custom_option_text: customOptionText || "",
    recent_messages: recentMessages || "",
    previous_poll_options_block: previousPollBlock,
  });

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      temperature: 0,
      response_format: { type: "json_object" },
      metadata: {
        caller: "custom-option-analysis",
        modelResolved: true,
        roomId: roomId || null,
      },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const rawText = response.choices?.[0]?.message?.content || "{}";
    const parsed = safeParseJson(rawText) || {};
    const normalized = normalizeAnalysis(parsed);
    storeAnalysis({
      pollId,
      userId,
      optionId,
      customOptionText,
      analysis: normalized,
      cacheKey,
    });
    return normalized;
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.error("Failed to classify custom option suggestion:", err);
    storeAnalysis({
      pollId,
      userId,
      optionId,
      customOptionText,
      analysis: fallback,
      cacheKey,
    });
    return fallback;
  }
}

async function classifyHumanMessageProactivenessOnce({
  cacheKey,
  modelName,
  messageId,
  userId,
  roomId,
  roomName,
  globalQuestion,
  decisionContext,
  generalDescription,
  messageText,
  recentMessages,
  currentPollQuestion,
  currentPollOptions,
  previousPollOptions,
}) {
  throwIfWorkCancelled();
  const cached = readStoredMessageProactivenessAnalysis({
    messageId,
    cacheKey,
  });
  if (cached) return cached;

  const fallback = normalizeProactivenessAnalysis({
    label: "neutral",
    confidence: 0,
    referenced_messages: [],
  });

  if (!client) {
    storeMessageProactivenessAnalysis({
      messageId,
      userId,
      roomId,
      analysis: fallback,
      cacheKey,
    });
    return fallback;
  }

  const previousPollBlock =
    Array.isArray(previousPollOptions) && previousPollOptions.length > 0
      ? `Previous poll options from the same topic:\n${previousPollOptions.map((opt) => `- ${opt}`).join("\n")}`
      : "";

  const prompt = renderTemplate("message-proactiveness-analysis.md", {
    global_question: globalQuestion || "",
    decision_context: decisionContext || "",
    general_description: generalDescription || "",
    room_name: roomName || "",
    poll_question: currentPollQuestion || "",
    poll_options: Array.isArray(currentPollOptions)
      ? currentPollOptions.map((opt) => `- ${opt}`).join("\n")
      : "",
    message_text: messageText || "",
    recent_messages: recentMessages || "",
    previous_poll_options_block: previousPollBlock,
  });

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      temperature: 0,
      response_format: { type: "json_object" },
      metadata: {
        caller: "message-proactiveness-analysis",
        modelResolved: true,
        roomId: roomId || null,
      },
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const rawText = response.choices?.[0]?.message?.content || "{}";
    const parsed = safeParseJson(rawText) || {};
    const normalized = normalizeProactivenessAnalysis(parsed);
    storeMessageProactivenessAnalysis({
      messageId,
      userId,
      roomId,
      analysis: normalized,
      cacheKey,
    });
    return normalized;
  } catch (err) {
    if (err.name === "AbortError") throw err;
    console.error("Failed to classify message proactiveness:", err);
    storeMessageProactivenessAnalysis({
      messageId,
      userId,
      roomId,
      analysis: fallback,
      cacheKey,
    });
    return fallback;
  }
}
