// State-of-the-art persona model for the agent simulation.
//
// An agent has two layers:
//   (1) IDENTITY  — a free-text backstory, a Big Five / OCEAN vector, and a per-topic
//       initial stance (position + intensity). This is what makes agents *different*
//       and is injected into the language prompt (Argyle et al. 2023 "silicon sampling";
//       Park et al. 2023 generative agents).
//   (2) POLICY    — an explicit, auditable stochastic model that decides WHEN the agent
//       acts (Bernoulli participation gates) and HOW it votes (a random-utility / softmax
//       discrete-choice model, McFadden 1974), with explicit peer-support and argument-alignment
//       terms. This is a conformity/social-influence model, not a bounded-confidence model.
//
// The LLM still writes the words; the *decision* is computed here so every persona knob
// is a named coefficient we can log, plot, and reproduce.

import { db } from '../config/db.js';
import client from './llm.js';
import { env } from '../config/env.js';

// ---- small math helpers -------------------------------------------------------------

export function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

export function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0, y = Number(b[i]) || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Map a cosine similarity in [-1, 1] to a unit interval [0, 1].
export function toUnit(sim) {
  return clamp01((sim + 1) / 2);
}

// Numerically-stable softmax over utilities already scaled by lambda.
export function softmax(scaled) {
  if (!scaled.length) return [];
  const max = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - max));
  const sum = exps.reduce((s, v) => s + v, 0) || 1;
  return exps.map((v) => v / sum);
}

// Jaccard token overlap — the embedding-free fallback for text similarity.
function tokenSet(text) {
  return new Set(
    String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2)
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
  );
}
export function jaccard(a, b) {
  const sa = tokenSet(a), sb = tokenSet(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

// Global model coefficients (the fixed β scales in U = β_pref·s + β_soc·γ·m + β_arg·ω·q).
export const MODEL_DEFAULTS = {
  betaPref: 1.0, // weight on the agent's own initial stance
  betaSoc: 1.0,  // weight on the majority/peer term (further scaled by conformity γ)
  betaArg: 1.0,  // weight on the argument-quality term (further scaled by openness ω)
  lambdaMin: 2.0, // softmax inverse-temperature at Conscientiousness = 0 (noisy)
  lambdaMax: 8.0, // ... at Conscientiousness = 1 (near-deterministic argmax)
  pOtherMax: 0.6, // max propose-new-option rate at Openness = 1
  pAbstainMax: 0.3, // max abstention rate at Conscientiousness = 0
  speakSlope: 6.0, // logistic slope for p_speak vs Extraversion
  wordCapMin: 15,
  wordCapMax: 100
};

const EXCLUDED_OPTIONS = new Set(['other', 'keep discussing']);

// ---- persona profile resolution -----------------------------------------------------

// Derive an OCEAN vector from the legacy persona fields so existing saved configs still run.
function oceanFromLegacy(raw) {
  const type = Number(raw.type) || 1;
  const outgoingness = raw.outgoingness !== undefined ? Number(raw.outgoingness) : 3; // 1..5
  const conformity = raw.conformity !== undefined && raw.conformity !== null && raw.conformity !== ''
    ? clamp01(Number(raw.conformity)) : null;
  const otherness = raw.otherness !== undefined ? clamp01(Number(raw.otherness)) : 0.5;
  const agreeableByType = { 1: 0.75, 2: 0.5, 3: 0.25, 4: 0.0 };
  const conscByType = { 1: 0.3, 2: 0.5, 3: 0.7, 4: 0.9 };
  return {
    O: otherness,
    C: conscByType[type] ?? 0.5,
    E: clamp01((outgoingness - 1) / 4),
    A: conformity !== null ? conformity : (agreeableByType[type] ?? 0.5),
    N: 0.3
  };
}

// Normalize whatever the admin sent into a full profile with an OCEAN vector, the four
// vote-model coefficients, participation gates, and a per-topic stance lookup.
export function resolvePersonaProfile(raw = {}) {
  const provided = raw.ocean && typeof raw.ocean === 'object' ? raw.ocean : null;
  const legacy = oceanFromLegacy(raw);
  const ocean = {
    O: provided && provided.O !== undefined ? clamp01(provided.O) : legacy.O,
    C: provided && provided.C !== undefined ? clamp01(provided.C) : legacy.C,
    E: provided && provided.E !== undefined ? clamp01(provided.E) : legacy.E,
    A: provided && provided.A !== undefined ? clamp01(provided.A) : legacy.A,
    N: provided && provided.N !== undefined ? clamp01(provided.N) : legacy.N
  };

  const num = (v, fallback) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
  const coeffs = {
    betaPref: num(raw.betaPref, MODEL_DEFAULTS.betaPref),
    betaSoc: num(raw.betaSoc, MODEL_DEFAULTS.betaSoc),
    betaArg: num(raw.betaArg, MODEL_DEFAULTS.betaArg),
    // Conformity γ defaults to Agreeableness; openness ω to Openness. Choice precision λ
    // rises with Conscientiousness and falls with Neuroticism, which operationalizes the latter
    // as decision volatility rather than leaving it as an inert prompt-only trait.
    gamma: clamp01(num(raw.gamma ?? raw.conformity, ocean.A)),
    omega: clamp01(num(raw.omega, ocean.O)),
    lambda: num(
      raw.lambda,
      (MODEL_DEFAULTS.lambdaMin + (MODEL_DEFAULTS.lambdaMax - MODEL_DEFAULTS.lambdaMin) * ocean.C)
        * (1 - 0.5 * ocean.N)
    )
  };

  const gates = {
    pSpeak: clamp01(sigmoid(MODEL_DEFAULTS.speakSlope * (ocean.E - 0.5))),
    pOther: clamp01(num(raw.otherness, MODEL_DEFAULTS.pOtherMax * ocean.O)),
    pAbstain: clamp01(num(raw.noOpinionProbability, MODEL_DEFAULTS.pAbstainMax * (1 - ocean.C))),
    requiresDirectMention: ocean.E < 0.2,
    delayTicks: Math.round(3 * (1 - ocean.E)),
    wordCap: Math.round(MODEL_DEFAULTS.wordCapMin + (MODEL_DEFAULTS.wordCapMax - MODEL_DEFAULTS.wordCapMin) * ocean.E)
  };

  const stances = raw.stances && typeof raw.stances === 'object' ? raw.stances : {};

  return {
    backstory: typeof raw.backstory === 'string' ? raw.backstory.trim() : '',
    ocean,
    coeffs,
    gates,
    stances,
    stanceFor(topicKey) {
      const key = String(topicKey || '').trim().toLowerCase();
      for (const [t, v] of Object.entries(stances)) {
        if (String(t).trim().toLowerCase() === key) {
          return { position: String(v?.position || '').trim(), intensity: clamp01(v?.intensity ?? 0.5) };
        }
      }
      return { position: '', intensity: 0 };
    }
  };
}

// A compact identity string for the LLM system prompt.
export function personaPromptBlock(profile) {
  const { ocean } = profile;
  const lines = [];
  if (profile.backstory) lines.push(`Backstory: ${profile.backstory}`);
  lines.push(
    'Personality (Big Five, 0-1): ' +
    `Openness ${ocean.O.toFixed(2)}, Conscientiousness ${ocean.C.toFixed(2)}, ` +
    `Extraversion ${ocean.E.toFixed(2)}, Agreeableness ${ocean.A.toFixed(2)}, Neuroticism ${ocean.N.toFixed(2)}.`
  );
  return lines.join('\n');
}

// ---- current support (the majority term m_k) ----------------------------------------

// Share of current support for each option id, in [0, 1]. For continuous/plurality this is
// the vote share; for swipe it is the share of right-swipes.
function getSupportShares(pollId, pollType) {
  const shares = new Map();
  if (pollType === 'swipe') {
    const rows = db.prepare("SELECT option_id, COUNT(*) AS c FROM swipe_votes WHERE poll_id = ? AND swipe_direction = 'right' GROUP BY option_id").all(pollId);
    const total = rows.reduce((s, r) => s + Number(r.c || 0), 0) || 0;
    for (const r of rows) shares.set(Number(r.option_id), total ? Number(r.c) / total : 0);
  } else {
    const rows = db.prepare('SELECT option_id, COUNT(DISTINCT user_id) AS c FROM poll_votes WHERE poll_id = ? GROUP BY option_id').all(pollId);
    const total = rows.reduce((s, r) => s + Number(r.c || 0), 0) || 0;
    for (const r of rows) shares.set(Number(r.option_id), total ? Number(r.c) / total : 0);
  }
  return shares;
}

// Recent debate text that argues for a given option: messages whose tokens overlap the option
// label. Falls back to the option label itself when nothing in the transcript references it.
function argumentContextFor(roomId, optionText, recentMessages) {
  const optTokens = tokenSet(optionText);
  const hits = recentMessages.filter((m) => {
    const mt = tokenSet(m.text);
    for (const t of optTokens) if (mt.has(t)) return true;
    return false;
  }).map((m) => m.text);
  return hits.length ? `${optionText}. ${hits.join(' ')}` : optionText;
}

// ---- the vote-choice model ----------------------------------------------------------

async function embedAll(texts, roomId) {
  const unique = [...new Set(texts.map((t) => String(t || '')))];
  const map = new Map();
  if (!client?.embeddings?.create) {
    return { map, ok: false };
  }
  try {
    const response = await client.embeddings.create({
      model: env.embeddingModel,
      input: unique.map((t) => t.slice(0, 8000)),
      metadata: { caller: 'simulation_vote_model', roomId: roomId || null }
    });
    const vectors = Array.isArray(response.data) ? response.data : [];
    unique.forEach((t, i) => map.set(t, vectors[i]?.embedding || []));
    return { map, ok: true };
  } catch (err) {
    console.error('[SIMULATION] vote-model embedding failed, using token overlap:', err.message);
    return { map, ok: false };
  }
}

/**
 * Compute the utility and softmax choice probability for each option, then sample a vote.
 * Returns { probabilities: Map(optionId->p), utilities: Map, choiceId, ranked: [ids desc],
 *           swipeVotes: [{optionId, direction}] } — enough to build voteData for any poll type.
 */
export async function computeVoteDecision({ profile, poll, options, roomId, rng = Math.random }) {
  const votable = options.filter((o) => !EXCLUDED_OPTIONS.has(String(o.option_text || '').toLowerCase()));
  const pool = votable.length >= 1 ? votable : options;

  const stance = profile.stanceFor(poll.suggestion || poll.question);
  const valuesText = [profile.backstory, ...Object.values(profile.stances || {}).map((s) => s?.position)]
    .filter(Boolean).join('. ') || stance.position;

  const recentMessages = db.prepare(
    'SELECT text FROM messages WHERE room_id = ? AND text IS NOT NULL ORDER BY id DESC LIMIT 12'
  ).all(roomId);

  const needArg = profile.coeffs.betaArg * profile.coeffs.omega > 0 && recentMessages.length > 0;
  const argContexts = new Map();
  for (const o of pool) argContexts.set(o.id, needArg ? argumentContextFor(roomId, o.option_text, recentMessages) : o.option_text);

  // Batch every text we need to embed once.
  const toEmbed = [];
  if (stance.position) toEmbed.push(stance.position);
  if (valuesText) toEmbed.push(valuesText);
  for (const o of pool) toEmbed.push(o.option_text);
  if (needArg) for (const o of pool) toEmbed.push(argContexts.get(o.id));
  const { map: emb, ok: embOk } = await embedAll(toEmbed, roomId);

  const sim = (a, b) => {
    if (embOk) {
      const va = emb.get(String(a)) || [];
      const vb = emb.get(String(b)) || [];
      if (va.length && vb.length) return toUnit(cosineSimilarity(va, vb));
    }
    return jaccard(a, b); // already in [0,1]
  };

  const { betaPref, betaSoc, betaArg, gamma, omega, lambda } = profile.coeffs;
  const shares = getSupportShares(poll.id, poll.poll_type);

  const utilities = new Map();
  for (const o of pool) {
    const s_ik = stance.position ? stance.intensity * sim(stance.position, o.option_text) : 0;
    const m_k = shares.get(Number(o.id)) || 0;
    const q_ik = needArg && valuesText ? sim(valuesText, argContexts.get(o.id)) : 0;
    utilities.set(Number(o.id), betaPref * s_ik + betaSoc * gamma * m_k + betaArg * omega * q_ik);
  }

  const ids = pool.map((o) => Number(o.id));
  const scaled = ids.map((id) => lambda * utilities.get(id));
  const probs = softmax(scaled);
  const probabilities = new Map(ids.map((id, i) => [id, probs[i]]));

  // Sample one option from the softmax distribution.
  let r = rng();
  let choiceId = ids[ids.length - 1];
  for (let i = 0; i < ids.length; i++) {
    r -= probs[i];
    if (r <= 0) { choiceId = ids[i]; break; }
  }

  // Ranking: all pool options by descending utility, then any excluded options last.
  const ranked = [...ids].sort((a, b) => utilities.get(b) - utilities.get(a));
  for (const o of options) if (!ranked.includes(Number(o.id))) ranked.push(Number(o.id));

  // Swipe: approve (right) options at or above the uniform baseline 1/K, always including the
  // argmax; reject the rest and any excluded option.
  const baseline = 1 / ids.length;
  const argmaxId = ids.reduce((best, id) => (utilities.get(id) > utilities.get(best) ? id : best), ids[0]);
  const swipeVotes = options.map((o) => {
    const id = Number(o.id);
    const inPool = probabilities.has(id);
    const approve = inPool && (id === argmaxId || probabilities.get(id) >= baseline);
    return { optionId: id, direction: approve ? 'right' : 'left' };
  });

  return { probabilities, utilities, choiceId, ranked, swipeVotes };
}
