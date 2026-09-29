import crypto from 'crypto';
import client, { resolveLlmModel } from './llm.js';
import { env } from '../config/env.js';
import { db } from '../config/db.js';
import { getConfiguredModels } from './agentConfigService.js';
import { shareAnalysis } from './sharedAnalysisService.js';
import { throwIfWorkCancelled } from './workContext.js';

const RUBRIC_VERSION = 'aqua_llm_embedding_v1';

const DIMENSION_WEIGHTS = {
  participationEquality: 0.18,
  justification: 0.18,
  reciprocity: 0.16,
  respect: 0.16,
  constructiveness: 0.17,
  epistemicOrientation: 0.15
};

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function round4(value) {
  return Number(clamp01(value).toFixed(4));
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function calculateGini(values) {
  const arr = values.map((v) => Number(v) || 0).sort((a, b) => a - b);
  const n = arr.length;
  if (n === 0) return 0;
  const sum = arr.reduce((a, b) => a + b, 0);
  if (sum === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * arr[i];
  return (2 * weighted) / (n * sum) - (n + 1) / n;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function similarityToUnit(similarity) {
  return clamp01((similarity + 1) / 2);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp01(n / 3);
}

function normalizeRubric(raw) {
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const indices = parsed.indices && typeof parsed.indices === 'object' ? parsed.indices : parsed;
  const read = (key) => normalizeScore(indices[key]);

  const normalized = {
    relevance: read('relevance'),
    factClaim: read('fact_claim'),
    opinion: read('opinion'),
    justification: read('justification'),
    solutionProposal: read('solution_proposal'),
    additionalKnowledge: read('additional_knowledge'),
    genuineQuestion: read('genuine_question'),
    referencingUsers: read('referencing_users'),
    referencingContent: read('referencing_content'),
    respect: read('respect'),
    screaming: read('screaming'),
    vulgarity: read('vulgarity'),
    insult: read('insult'),
    sarcasm: read('sarcasm'),
    discrimination: read('discrimination'),
    storytelling: read('storytelling'),
    listening: read('listening'),
    constructiveness: read('constructiveness'),
    epistemicCare: read('epistemic_care')
  };

  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? clamp01(rawConfidence) : 0.5;

  return {
    indices: normalized,
    source: 'llm+embeddings',
    confidence,
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 600) : ''
  };
}

function fallbackRuleAnalysis(messageText) {
  const text = String(messageText || '');
  const lower = text.toLowerCase();
  const words = countWords(text);
  const hasReason = /\b(because|since|therefore|due to|for example|for instance|reason|risk|cost|benefit|impact|trade[- ]?off)\b/i.test(text);
  const hasReference = /\b(i agree|i disagree|you said|your point|building on|in response|what .* said|we|our)\b/i.test(text) || /@\w+/.test(text);
  const hasConstructive = /\b(proposal|suggest|solution|compromise|combine|modify|mitigat|alternative|we could|let'?s|plan|option)\b/i.test(text);
  const hasEvidence = /\b(data|evidence|research|study|fact|according to|example|case|percent|\d+([.,]\d+)?)\b/i.test(text);
  const hasIncivility = /\b(stupid|idiot|dumb|shut up|trash|fuck|shit|asshole|bullshit)\b/i.test(text);
  const allCaps = text.trim().length >= 12 && /[A-Z]/.test(text) && text.trim() === text.trim().toUpperCase();
  const repeatedPunctuation = /[!?]{3,}/.test(text);

  return {
    source: 'fallback-rules',
    indices: {
      relevance: words > 4 ? 0.6 : 0.25,
      factClaim: hasEvidence ? 0.75 : 0.2,
      opinion: words > 0 ? 0.6 : 0,
      justification: clamp01((hasReason ? 0.75 : 0) + (words >= 18 ? 0.2 : words >= 10 ? 0.1 : 0)),
      solutionProposal: hasConstructive ? 0.75 : 0.15,
      additionalKnowledge: hasEvidence ? 0.65 : 0.15,
      genuineQuestion: /\?/.test(text) ? 0.65 : 0,
      referencingUsers: hasReference ? 0.7 : 0.1,
      referencingContent: hasReference ? 0.65 : 0.1,
      respect: hasIncivility ? 0.05 : 0.85,
      screaming: allCaps || repeatedPunctuation ? 0.7 : 0,
      vulgarity: /\b(fuck|shit|bullshit)\b/i.test(text) ? 0.85 : 0,
      insult: /\b(stupid|idiot|dumb|asshole)\b/i.test(text) ? 0.85 : 0,
      sarcasm: 0,
      discrimination: 0,
      storytelling: /\b(i|my|we|our)\b/i.test(lower) && words >= 18 ? 0.35 : 0,
      listening: hasReference ? 0.7 : 0.1,
      constructiveness: hasConstructive ? 0.75 : 0.15,
      epistemicCare: hasEvidence || hasReason ? 0.65 : 0.25
    },
    confidence: 0,
    rationale: 'Deterministic fallback used because LLM analysis was unavailable.'
  };
}

function dimensionsFromRubric(rubric, embeddingMetrics) {
  const i = rubric.indices;
  const topical = embeddingMetrics.topicalRelevance;
  const responsiveness = embeddingMetrics.semanticResponsiveness;
  const novelty = embeddingMetrics.semanticNovelty;
  const civilityPenalty = clamp01(
    i.screaming * 0.18 +
    i.vulgarity * 0.24 +
    i.insult * 0.28 +
    i.sarcasm * 0.14 +
    i.discrimination * 0.26
  );

  const llmJustification = clamp01(
    i.justification * 0.62 +
    i.factClaim * 0.14 +
    i.additionalKnowledge * 0.14 +
    i.relevance * 0.1
  );
  const llmReciprocity = clamp01(
    i.listening * 0.38 +
    i.referencingUsers * 0.24 +
    i.referencingContent * 0.24 +
    i.genuineQuestion * 0.06 +
    i.relevance * 0.08
  );
  const llmRespect = clamp01(i.respect * 0.72 + (1 - civilityPenalty) * 0.28);
  const llmConstructiveness = clamp01(
    i.constructiveness * 0.38 +
    i.solutionProposal * 0.28 +
    i.additionalKnowledge * 0.12 +
    i.storytelling * 0.06 +
    i.justification * 0.08 +
    i.relevance * 0.08
  );
  const llmEpistemic = clamp01(
    i.epistemicCare * 0.34 +
    i.factClaim * 0.22 +
    i.justification * 0.2 +
    i.additionalKnowledge * 0.16 +
    i.relevance * 0.08
  );

  return {
    justification: round4(llmJustification * 0.85 + topical * 0.15),
    reciprocity: round4(llmReciprocity * 0.72 + responsiveness * 0.28),
    respect: round4(llmRespect),
    constructiveness: round4(llmConstructiveness * 0.78 + topical * 0.12 + novelty * 0.1),
    epistemicOrientation: round4(llmEpistemic * 0.82 + topical * 0.18)
  };
}

function readStoredAnalysis(messageId, contextHash, modelName, embeddingModelName) {
  const row = db.prepare(`
    SELECT analysis_json, embedding_json, context_hash, model_name, embedding_model_name
    FROM message_deliberative_quality_analyses
    WHERE message_id = ?
  `).get(messageId);
  if (!row || row.context_hash !== contextHash) return null;
  if (row.model_name !== modelName || row.embedding_model_name !== embeddingModelName) return null;
  const analysis = safeParseJson(row.analysis_json);
  const embedding = safeParseJson(row.embedding_json);
  if (!analysis || !analysis.dimensions || !Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite) || !embedding.some(value => value !== 0)) return null;
  if (analysis.source !== 'llm+embeddings' || analysis.embeddingStatus === 'unavailable') return null;
  return { ...analysis, embedding };
}

function storeAnalysis({ messageId, userId, roomId, analysis, embedding, contextHash, modelName, embeddingModelName }) {
  db.prepare(`
    INSERT INTO message_deliberative_quality_analyses (
      message_id,
      user_id,
      room_id,
      analysis_json,
      embedding_json,
      context_hash,
      model_name,
      embedding_model_name,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      user_id = excluded.user_id,
      room_id = excluded.room_id,
      analysis_json = excluded.analysis_json,
      embedding_json = excluded.embedding_json,
      context_hash = excluded.context_hash,
      model_name = excluded.model_name,
      embedding_model_name = excluded.embedding_model_name,
      created_at = excluded.created_at
  `).run(
    messageId,
    userId,
    roomId,
    JSON.stringify(analysis),
    JSON.stringify(embedding || []),
    contextHash,
    modelName || '',
    embeddingModelName || '',
    new Date().toISOString()
  );
}

async function embedTexts(texts, roomId, modelName) {
  if (!client?.embeddings?.create) return texts.map(() => []);
  try {
    const response = await client.embeddings.create({
      model: modelName,
      input: texts.map((text) => String(text || '').slice(0, 8000)),
      metadata: {
        caller: 'deliberative_quality_embedding',
        modelResolved: true,
        roomId: roomId || null
      }
    });
    const vectors = Array.isArray(response.data) ? response.data : [];
    return texts.map((_, index) => vectors[index]?.embedding || []);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Failed to compute deliberative quality embeddings:', err);
    return texts.map(() => []);
  }
}

async function callRubricLlm({ row, context, modelName }) {
  if (!client?.chat?.completions?.create) return fallbackRuleAnalysis(row.text);

  const prompt = `You are assessing deliberative quality in an online political discussion.

Use an AQuA-inspired rubric: score each deliberative index from 0 to 3.
0 = absent or harmful, 1 = weak, 2 = present, 3 = clearly strong.

Return strict JSON only:
{
  "indices": {
    "relevance": 0-3,
    "fact_claim": 0-3,
    "opinion": 0-3,
    "justification": 0-3,
    "solution_proposal": 0-3,
    "additional_knowledge": 0-3,
    "genuine_question": 0-3,
    "referencing_users": 0-3,
    "referencing_content": 0-3,
    "respect": 0-3,
    "screaming": 0-3,
    "vulgarity": 0-3,
    "insult": 0-3,
    "sarcasm": 0-3,
    "discrimination": 0-3,
    "storytelling": 0-3,
    "listening": 0-3,
    "constructiveness": 0-3,
    "epistemic_care": 0-3
  },
  "confidence": 0-1,
  "rationale": "one short sentence"
}

Context:
Global question: ${context.globalQuestion || ''}
Room: ${context.roomName || ''}
Current poll/question: ${context.currentPollQuestion || ''}
Current poll options:
${Array.isArray(context.currentPollOptions) ? context.currentPollOptions.map((opt) => `- ${opt}`).join('\n') : ''}

Recent previous messages:
${context.recentMessages || ''}

Message to assess:
${row.text || ''}`;

  try {
    const response = await client.chat.completions.create({
      model: modelName,
      temperature: 0,
      response_format: { type: 'json_object' },
      metadata: {
        caller: 'deliberative_quality',
        modelResolved: true,
        roomId: row.room_id || null
      },
      messages: [
        {
          role: 'system',
          content: prompt
        }
      ]
    });
    const rawText = response.choices?.[0]?.message?.content || '{}';
    return normalizeRubric(safeParseJson(rawText) || {});
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error('Failed to analyze deliberative quality with LLM:', err);
    return fallbackRuleAnalysis(row.text);
  }
}

async function analyzeOneMessage(row, context, previousAnalyses) {
  throwIfWorkCancelled();
  const contextText = [
    RUBRIC_VERSION,
    row.text || '',
    context.globalQuestion || '',
    context.roomName || '',
    context.currentPollQuestion || '',
    Array.isArray(context.currentPollOptions) ? context.currentPollOptions.join('|') : '',
    context.recentMessages || ''
  ].join('\n');
  const contextHash = hashText(contextText);
  const modelName = resolveLlmModel('deliberative_quality', getConfiguredModels().primaryModel);
  const embeddingModelName = resolveLlmModel('deliberative_quality_embedding', env.embeddingModel);
  const key = JSON.stringify(['quality', row.id, contextHash, modelName, embeddingModelName]);
  return shareAnalysis(key, async () => {
    throwIfWorkCancelled();
    const cached = readStoredAnalysis(row.id, contextHash, modelName, embeddingModelName);
    if (cached) return cached;

    const contextEmbeddingText = [
      context.globalQuestion || '',
      context.roomName || '',
      context.currentPollQuestion || '',
      Array.isArray(context.currentPollOptions) ? context.currentPollOptions.join(' ') : ''
    ].filter(Boolean).join('\n');
    const [messageEmbedding, contextEmbedding] = await embedTexts(
      [row.text || '', contextEmbeddingText || contextText],
      row.room_id,
      embeddingModelName
    );

    const previousEmbeddings = previousAnalyses
      .map((analysis) => analysis.embedding)
      .filter((embedding) => Array.isArray(embedding) && embedding.length > 0);
    const previousSimilarities = previousEmbeddings
      .map((embedding) => cosineSimilarity(messageEmbedding, embedding))
      .filter((value) => Number.isFinite(value));
    const maxPreviousSimilarity = previousSimilarities.length > 0
      ? Math.max(...previousSimilarities)
      : 0;
    const avgPreviousSimilarity = previousSimilarities.length > 0
      ? previousSimilarities.reduce((sum, value) => sum + value, 0) / previousSimilarities.length
      : 0;

    const embeddingMetrics = {
      topicalRelevance: round4(similarityToUnit(cosineSimilarity(messageEmbedding, contextEmbedding))),
      semanticResponsiveness: previousSimilarities.length > 0 ? round4(similarityToUnit(maxPreviousSimilarity)) : 0.5,
      semanticNovelty: previousSimilarities.length > 0 ? round4(1 - similarityToUnit(avgPreviousSimilarity)) : 0.5
    };

    throwIfWorkCancelled();
    const rubric = await callRubricLlm({ row, context, modelName });
    const dimensions = dimensionsFromRubric(rubric, embeddingMetrics);
    const validVector = (vector) => Array.isArray(vector) && vector.length > 0 && vector.every(Number.isFinite) && vector.some(value => value !== 0);
    const embeddingsAvailable = validVector(messageEmbedding) && validVector(contextEmbedding) && messageEmbedding.length === contextEmbedding.length;
    const analysis = {
      rubricVersion: RUBRIC_VERSION,
      source: rubric.source === 'llm+embeddings' && !embeddingsAvailable ? 'llm-without-embeddings' : (rubric.source || 'unknown'),
      embeddingStatus: embeddingsAvailable ? 'complete' : 'unavailable',
      indices: rubric.indices,
      confidence: rubric.confidence,
      rationale: rubric.rationale,
      embeddingMetrics,
      dimensions
    };

    storeAnalysis({
      messageId: row.id,
      userId: row.sender_id,
      roomId: row.room_id,
      analysis,
      embedding: messageEmbedding,
      contextHash,
      modelName,
      embeddingModelName
    });

    return { ...analysis, embedding: messageEmbedding };
  });
}

export async function analyzeDeliberativeMessagesWithLLM({
  messageRows,
  userIds,
  getContextForMessage = () => ({})
}) {
  const rows = Array.isArray(messageRows) ? messageRows : [];
  const participantIds = Array.isArray(userIds) ? userIds : [];
  const messageCount = rows.length;
  if (messageCount === 0) {
    return {
      score: 0,
      messageCount: 0,
      dimensions: {
        participationEquality: 0,
        justification: 0,
        reciprocity: 0,
        respect: 0,
        constructiveness: 0,
        epistemicOrientation: 0
      },
      weights: DIMENSION_WEIGHTS,
      method: 'aqua-inspired-llm-embeddings',
      analyzedMessages: 0
    };
  }

  const countsByUser = {};
  for (const uid of participantIds) countsByUser[uid] = 0;
  for (const row of rows) {
    if (countsByUser[row.sender_id] !== undefined) countsByUser[row.sender_id]++;
  }

  const sortedRows = [...rows].sort((a, b) => {
    const timeDiff = new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime();
    return timeDiff || Number(a.id || 0) - Number(b.id || 0);
  });

  const analyses = [];
  const previousAnalysesByRoom = new Map();
  for (const row of sortedRows) {
    throwIfWorkCancelled();
    const roomPrevious = previousAnalysesByRoom.get(row.room_id) || [];
    const recentPrevious = roomPrevious.slice(-8);
    const context = getContextForMessage(row) || {};
    const analysis = await analyzeOneMessage(row, context, recentPrevious);
    analyses.push(analysis);
    previousAnalysesByRoom.set(row.room_id, [...roomPrevious, analysis]);
  }

  const participationEquality = participantIds.length > 0
    ? 1 - calculateGini(participantIds.map((uid) => countsByUser[uid] || 0))
    : 0;

  const average = (key) => {
    if (analyses.length === 0) return 0;
    return analyses.reduce((sum, item) => sum + (Number(item.dimensions?.[key]) || 0), 0) / analyses.length;
  };

  const dimensions = {
    participationEquality: round4(participationEquality),
    justification: round4(average('justification')),
    reciprocity: round4(average('reciprocity')),
    respect: round4(average('respect')),
    constructiveness: round4(average('constructiveness')),
    epistemicOrientation: round4(average('epistemicOrientation'))
  };
  const score = Object.entries(DIMENSION_WEIGHTS).reduce(
    (sum, [key, weight]) => sum + dimensions[key] * weight,
    0
  );

  return {
    score: round4(score),
    messageCount,
    dimensions,
    weights: DIMENSION_WEIGHTS,
    method: 'aqua-inspired-llm-embeddings',
    analyzedMessages: analyses.length,
    sourceBreakdown: analyses.reduce((acc, item) => {
      const source = item.source || 'unknown';
      acc[source] = (acc[source] || 0) + 1;
      return acc;
    }, {})
  };
}
