import { db } from '../config/db.js';
import client from './llm.js';
import { runWithWorkContext, throwIfWorkCancelled } from './workContext.js';
import { createDecisionWorkContext } from './decisionWorkService.js';
import {
  processAgent3AfterMessage,
  maybeResolvePollEarlyForVote,
  consumePersonalRoomReplyAction,
  isConvergenceReviewLocked,
  recordConvergenceReopen,
  recordConvergenceAgreement,
  recordContinuousVoteAudit
} from './agent3Service.js';
import { resolvePersonaProfile, personaPromptBlock, computeVoteDecision } from './simulationAgentModel.js';

// Resolved persona profiles (OCEAN + coefficients + gates + stances), cached per user for the
// duration of a run. Cleared on startSimulation. See simulationAgentModel.js for the model.
const personaProfiles = new Map();
function getProfile(userId) {
  const key = String(userId);
  if (!personaProfiles.has(key)) {
    personaProfiles.set(key, resolvePersonaProfile(simulationState.personas[userId] || {}));
  }
  return personaProfiles.get(key);
}

// The persona behavior model (OCEAN identity + random-utility vote model + participation
// gates) lives in simulationAgentModel.js. simulationState.personas holds the raw admin config;
// getProfile() resolves each into a full profile on first use.
let simulationState = {
  isRunning: false,
  stopAt: 'personal', // 'personal' | 'discussing' | 'convergence'
  model: 'gpt-5.6-luna',
  seed: 20260720,
  personas: {}, // { [userId]: { backstory, ocean:{O,C,E,A,N}, stances, gamma?, omega?, lambda?, noOpinionProbability?, ...legacy } }
  preferences: {} // { [topic]: [option1, option2, ...] }
};

let simulationInterval = null;
let simulationTimeout = null;
let simulationGeneration = 0;
const skippedVotes = new Set();
const simulationMemories = new Map();
const convergenceReviewProcessing = new Set();

const maxConcurrency = 5;
let activeRequests = 0;
const requestQueue = [];

async function queueLlmCall(fn) {
  throwIfWorkCancelled();
  if (activeRequests >= maxConcurrency) {
    await new Promise((resolve) => {
      requestQueue.push(resolve);
    });
  }
  activeRequests++;
  try {
    throwIfWorkCancelled();
    return await fn();
  } finally {
    activeRequests--;
    if (requestQueue.length > 0) {
      const next = requestQueue.shift();
      next();
    }
  }
}

async function callLlmCompletions(args) {
  if (!client?.chat?.completions?.create) {
    return {
      choices: [{
        message: {
          content: 'I support a practical compromise because it should improve safety while keeping access, cost, and implementation constraints visible.'
        }
      }]
    };
  }
  return queueLlmCall(() => client.chat.completions.create(args));
}

function nowIso() {
  return new Date().toISOString();
}

// Keyed random draws make behavioral decisions independent of async execution order. LLM text
// can still vary between API calls, but a fixed seed reproduces routing, participation gates,
// abstention/write-in gates, and discrete vote sampling for the same persisted state.
function simulationRandom(...parts) {
  const input = [simulationState.seed, ...parts].join('|');
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  hash += hash << 13;
  hash ^= hash >>> 7;
  hash += hash << 3;
  hash ^= hash >>> 17;
  hash += hash << 5;
  return (hash >>> 0) / 4294967296;
}

function normalizeOptionIds(rawIds, validIds) {
  const normalized = [];
  const seen = new Set();
  const source = Array.isArray(rawIds) ? rawIds : [rawIds];
  for (const rawId of source) {
    const id = Number(rawId);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    normalized.push(id);
    seen.add(id);
  }
  return normalized;
}

function normalizeDirection(rawDirection) {
  const direction = String(rawDirection || '').trim().toLowerCase();
  return direction === 'left' ? 'left' : 'right';
}

function rememberAgentEvent(userId, eventText) {
  if (!userId || !eventText) return;
  const key = String(userId);
  const existing = simulationMemories.get(key) || [];
  const next = [...existing, String(eventText).replace(/\s+/g, ' ').trim()].slice(-12);
  simulationMemories.set(key, next);
}

function getAgentMemoryContext(userId) {
  const memories = simulationMemories.get(String(userId)) || [];
  if (!memories.length) return 'No prior simulation memories yet.';
  return memories.map((memory, index) => `${index + 1}. ${memory}`).join('\n');
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return {};
    try { return JSON.parse(match[0]); } catch { return {}; }
  }
}

function normalizedReviewKey(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

async function simulateConvergenceReview(io, room, members) {
  if (room.room_type !== 'convergence' || !isConvergenceReviewLocked(room.id)) return;
  if (convergenceReviewProcessing.has(room.id)) return;
  convergenceReviewProcessing.add(room.id);

  try {
    const roomState = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(room.id);
    let memory = [];
    try { memory = JSON.parse(roomState?.topic_memory_json || '[]'); } catch { memory = []; }
    const reviewTopics = memory
      .filter((entry) => !entry.is_general_question && String(entry.status || '').toLowerCase() === 'resolved')
      .map((entry) => ({
        key: entry.key || entry.topic || entry.question,
        question: entry.question || entry.key,
        decision: entry.decision || entry.summary || 'No decision recorded'
      }));
    const report = reviewTopics.length
      ? reviewTopics.map((topic, index) => `${index + 1}. Topic key: ${topic.key}\nQuestion: ${topic.question}\nReported decision: ${topic.decision}`).join('\n\n')
      : 'No resolved sub-topic decisions were recorded in the report.';

    for (const member of members) {
      if (!simulationState.personas[member.id]) continue;
      if (db.prepare('SELECT 1 FROM convergence_review_actions WHERE room_id = ? AND user_id = ? LIMIT 1').get(room.id, member.id)) continue;

      const profile = getProfile(member.id);
      const stance = profile.stanceFor(room.name);
      const response = await callLlmCompletions({
        model: simulationState.model,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              `You are ${member.username}, reviewing the opening report in a convergence room.`,
              personaPromptBlock(profile),
              stance.position ? `Your relevant stance is: ${stance.position}` : '',
              'Choose exactly one action. Use "agree" if the report is acceptable overall. Use "reopen" only when one reported topic conflicts with your position or needs another decision.',
              'Return JSON only: {"action":"agree"} or {"action":"reopen","topic_key":"EXACT TOPIC KEY"}.',
              'Do not invent topic keys and do not reopen the final general question.'
            ].filter(Boolean).join('\n')
          },
          {
            role: 'user',
            content: `Opening report to review:\n${report}\n\nYour prior context:\n${getAgentMemoryContext(member.id)}`
          }
        ]
      });
      throwIfWorkCancelled();
      const choice = parseJsonObject(response.choices?.[0]?.message?.content);
      const requestedAction = String(choice.action || '').toLowerCase();
      const requestedKey = normalizedReviewKey(choice.topic_key);
      const topic = reviewTopics.find((candidate) => normalizedReviewKey(candidate.key) === requestedKey);

      if (requestedAction === 'reopen' && topic) {
        const result = recordConvergenceReopen(room.id, member.id, topic.key);
        if (result.success) {
          await simulateAgentMessage(io, room.id, member.id, `I reviewed the opening report. I think the decision on "${topic.question}" should be reopened for another discussion.`);
          continue;
        }
      }

      const result = recordConvergenceAgreement(room.id, member.id);
      if (result.success) {
        await simulateAgentMessage(io, room.id, member.id, 'I reviewed the opening report and agree with the reported decisions.');
      }
    }
  } catch (error) {
    console.error('[SIMULATION] convergence review failed:', error);
  } finally {
    convergenceReviewProcessing.delete(room.id);
  }
}

export function normalizeSimulationVoteData(pollType, options, voteData = {}) {
  const input = voteData && typeof voteData === 'object' ? voteData : {};
  const validOptions = Array.isArray(options) ? options : [];
  const validIds = new Set(validOptions.map((option) => Number(option.id)).filter(Number.isInteger));
  const fallbackId = validOptions.length > 0 ? Number(validOptions[0].id) : null;
  const customOptionText = typeof input.customOptionText === 'string'
    ? input.customOptionText.trim().slice(0, 240)
    : null;

  if (!validOptions.length) {
    return { optionId: null, optionIds: [], rankedOptions: [], swipeVotes: [], customOptionText };
  }

  if (pollType === 'swipe') {
    const byOption = new Map();
    if (Array.isArray(input.swipeVotes)) {
      for (const vote of input.swipeVotes) {
        const optionId = Number(vote?.optionId);
        if (!Number.isInteger(optionId) || !validIds.has(optionId)) continue;
        byOption.set(optionId, normalizeDirection(vote?.direction));
      }
    }

    if (byOption.size === 0) {
      const approvedIds = new Set(normalizeOptionIds(
        input.optionId ?? input.optionIds ?? input.rankedOptions,
        validIds
      ));
      if (approvedIds.size === 0 && fallbackId !== null) approvedIds.add(fallbackId);
      for (const option of validOptions) {
        const optionId = Number(option.id);
        byOption.set(optionId, approvedIds.has(optionId) ? 'right' : 'left');
      }
    } else {
      for (const option of validOptions) {
        const optionId = Number(option.id);
        if (!byOption.has(optionId)) byOption.set(optionId, 'left');
      }
    }

    return {
      optionId: null,
      optionIds: [],
      rankedOptions: [],
      swipeVotes: validOptions.map((option) => ({
        optionId: Number(option.id),
        direction: byOption.get(Number(option.id)) || 'left'
      })),
      customOptionText
    };
  }

  if (pollType === 'ranking') {
    const ranked = normalizeOptionIds(input.rankedOptions ?? input.optionIds ?? input.optionId, validIds);
    for (const option of validOptions) {
      const optionId = Number(option.id);
      if (!ranked.includes(optionId)) ranked.push(optionId);
    }
    return { optionId: null, optionIds: [], rankedOptions: ranked, swipeVotes: [], customOptionText };
  }

  const selectedIds = normalizeOptionIds(input.optionIds ?? input.optionId ?? input.rankedOptions, validIds);
  const optionIds = selectedIds.length > 0 ? selectedIds : (fallbackId !== null ? [fallbackId] : []);
  return {
    optionId: optionIds[0] || null,
    optionIds,
    rankedOptions: [],
    swipeVotes: [],
    customOptionText
  };
}

async function simulateAgentMessage(io, roomId, userId, text) {
  throwIfWorkCancelled();
  const timestamp = nowIso();
  const result = db
    .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)')
    .run(roomId, userId, text, timestamp);
  
  const msgId = Number(result.lastInsertRowid);
  const userRow = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const sender_username = userRow ? userRow.username : 'agent';

  if (io) {
    io.to(`room:${roomId}`).emit('receive_message', {
      id: msgId,
      room_id: roomId,
      sender_id: userId,
      sender_name: sender_username,
      text,
      timestamp
    });
  }
  rememberAgentEvent(userId, `Said in room ${roomId}: "${String(text || '').slice(0, 180)}"`);

  // Trigger CIME's post-processing
  await processAgent3AfterMessage({ roomId, userId });
  throwIfWorkCancelled();

  // Agent 3 is the sole conversational driver in personal rooms. Real socket messages consume
  // this action and skip Agent 1; the simulator must do the same or every simulated answer gets
  // a second, stale bot reply and the next simulated turn races the personal state machine.
  consumePersonalRoomReplyAction(roomId);
  const roomState = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId);
  if (roomState?.room_type === 'personal') return;

  // Trigger bot reply if auto-bot is enabled (personal room or group/conv with <=1 active human user)
  const { roomShouldAutoBot, generateAgent1Reply } = await import('./agent1Service.js');
  if (roomShouldAutoBot(roomId)) {
    try {
      const botReply = await generateAgent1Reply({ roomId });
      if (botReply && io) {
        io.to(`room:${roomId}`).emit('receive_message', botReply);
      }
    } catch (err) {
      console.error('Simulation bot reply failed:', err);
    }
  }
}

async function simulateAgentVote(io, pollId, userId, voteData) {
  throwIfWorkCancelled();
  const poll = db.prepare('SELECT id, room_id, question, is_closed, expires_at, poll_type, poll_stage FROM polls WHERE id = ?').get(pollId);
  if (!poll) return;
  if (poll.is_closed === 1 || (poll.expires_at && poll.expires_at <= nowIso())) return;
  const pollOptions = db.prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC').all(pollId);
  const normalizedVote = normalizeSimulationVoteData(poll.poll_type, pollOptions, voteData);
  if (!pollOptions.length) return;

  if (poll.poll_type === 'swipe') {
    db.prepare('DELETE FROM swipe_votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId);

    const insertSwipe = db.prepare(
      'INSERT OR REPLACE INTO swipe_votes (poll_id, user_id, option_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const vote of normalizedVote.swipeVotes) {
      insertSwipe.run(pollId, userId, vote.optionId, vote.direction, nowIso());
    }
    const approvedLabels = normalizedVote.swipeVotes
      .filter((vote) => vote.direction === 'right')
      .map((vote) => pollOptions.find((option) => Number(option.id) === vote.optionId)?.option_text)
      .filter(Boolean);
    rememberAgentEvent(userId, `Voted on "${poll.question}" with swipe approvals: ${approvedLabels.join(', ') || 'none'}.`);
    if (io) io.to(`room:${poll.room_id}`).emit('polls_updated', { roomId: poll.room_id });
    await maybeResolvePollEarlyForVote(pollId, poll.room_id);
    return;
  }

  const isContinuous = poll.poll_type === 'continuous' || poll.poll_stage === 'continuous';

  db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId);

  const { optionId, optionIds, rankedOptions, customOptionText } = normalizedVote;

  if (Array.isArray(rankedOptions) && rankedOptions.length > 0) {
    const insertVote = db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank) VALUES (?, ?, ?, ?, ?)');
    let rank = 1;
    for (const optId of rankedOptions) {
      insertVote.run(pollId, optId, userId, nowIso(), rank++);
    }
  } else if (Array.isArray(optionIds) && optionIds.length > 0) {
    const insertVote = db.prepare(`
      INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
      VALUES (?, ?, ?, ?, 1, ?)
    `);
    for (const optId of optionIds) {
      insertVote.run(pollId, optId, userId, nowIso(), customOptionText || null);
    }
  } else if (optionId) {
    db.prepare(
      `
      INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
      VALUES (?, ?, ?, ?, 1, ?)
    `
    ).run(pollId, optionId, userId, nowIso(), customOptionText || null);
  } else {
    // Fallback: vote for first option to prevent getting stuck
    const firstOption = db.prepare('SELECT id FROM poll_options WHERE poll_id = ? LIMIT 1').get(pollId);
    if (firstOption) {
      db.prepare(
        `
        INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
        VALUES (?, ?, ?, ?, 1, ?)
      `
      ).run(pollId, firstOption.id, userId, nowIso(), null);
    }
  }

  if (isContinuous) {
    const currentVote = db.prepare(`
      SELECT option_id, custom_option_text
      FROM poll_votes
      WHERE poll_id = ? AND user_id = ?
      ORDER BY rank ASC, option_id ASC
      LIMIT 1
    `).get(pollId, userId);
    if (currentVote) {
      recordContinuousVoteAudit({
        pollId,
        userId,
        optionId: currentVote.option_id,
        customOptionText: currentVote.custom_option_text || null,
        source: 'simulation_continuous_vote'
      });
    }
  }

  const votedLabels = db.prepare(`
    SELECT po.option_text
    FROM poll_options po
    JOIN poll_votes pv ON pv.option_id = po.id
    WHERE pv.poll_id = ? AND pv.user_id = ?
    ORDER BY pv.rank ASC, po.id ASC
  `).all(pollId, userId).map((row) => row.option_text);
  rememberAgentEvent(userId, `Voted on "${poll.question}" with: ${votedLabels.join(', ') || 'fallback option'}.`);

  if (poll.question && poll.question.toLowerCase().includes('relevant or interesting to you')) {
    db.prepare('DELETE FROM user_topic_preferences WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM topic_preference_responses WHERE poll_id = ? AND user_id = ?').run(pollId, userId);
    const votedOptions = db.prepare(`
      SELECT po.option_text
      FROM poll_votes pv
      JOIN poll_options po ON po.id = pv.option_id
      WHERE pv.poll_id = ? AND pv.user_id = ?
    `).all(pollId, userId);

    const selectedTopics = votedOptions.map((opt) => opt.option_text).filter((topic) => topic && topic.toLowerCase() !== 'all topics');
    const selectedAllTopics = votedOptions.some((opt) => opt.option_text.toLowerCase() === 'all topics') || selectedTopics.length === 0;

    db.prepare(
      `
      INSERT INTO topic_preference_responses (user_id, room_id, poll_id, selected_topics_json, selected_all_topics, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(poll_id, user_id) DO UPDATE SET
        room_id = excluded.room_id,
        selected_topics_json = excluded.selected_topics_json,
        selected_all_topics = excluded.selected_all_topics,
        created_at = excluded.created_at
    `
    ).run(userId, poll.room_id, pollId, JSON.stringify(selectedTopics), selectedAllTopics ? 1 : 0, nowIso());

    const insertPref = db.prepare('INSERT INTO user_topic_preferences (user_id, topic) VALUES (?, ?)');
    for (const topic of selectedTopics) {
      insertPref.run(userId, topic);
    }
    if (selectedAllTopics) {
      insertPref.run(userId, 'All topics');
    }
  }

  if (io) io.to(`room:${poll.room_id}`).emit('polls_updated', { roomId: poll.room_id });
  await maybeResolvePollEarlyForVote(pollId, poll.room_id);
}

export function getSimulationStatus() {
  return simulationState;
}

export async function stopSimulation(interruptProcess = false) {
  simulationGeneration++;
  if (simulationTimeout) {
    clearTimeout(simulationTimeout);
    simulationTimeout = null;
  }
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
  simulationState.isRunning = false;
  global.isSimulationRunning = false;
  global.simulatedPersonas = {};
  console.log('[SIMULATION] Stopped.');
  if (interruptProcess) {
    try {
      const { interruptDecisionProcess } = await import('./agent3Service.js');
      interruptDecisionProcess();
    } catch (err) {
      console.error('[SIMULATION] Failed to interrupt decision process:', err);
    }
  }
}

export async function runSimulationStep(io) {
  try {
    const state = db.prepare('SELECT global_question, decision_context, current_phase FROM system_state WHERE id = 1').get();
    if (!state) return;

    const currentPhase = state.current_phase;

    // Check stop conditions
    if (currentPhase === 'completed' || currentPhase === 'idle') {
      await stopSimulation();
      return;
    }

    const agents = Object.entries(simulationState.personas).map(([userId, config]) => ({
      userId: Number(userId),
      type: config.type,
      otherness: config.otherness
    }));

    if (currentPhase === 'gathering') {
      // Process personal phase questions in parallel
      const rooms = db.prepare("SELECT id, name FROM rooms WHERE room_type = 'personal' AND is_active = 1 AND collection_complete = 0").all();
      const allQuestions = db.prepare("SELECT id, topic, question_text, is_general_question FROM gathering_questions ORDER BY question_order ASC, id ASC").all();

      if (simulationState.stopAt === 'personal') {
        let shouldStop = false;
        for (const room of rooms) {
          const username = room.name.replace('-personal', '');
          const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
          if (!user) continue;
          const agentConfig = simulationState.personas[user.id];
          if (!agentConfig) continue;
          const answered = db.prepare("SELECT question_id FROM gathering_answers WHERE user_id = ? AND response_status IN ('accepted', 'skipped_invalid')").all(user.id).map(r => r.question_id);
          const nextQ = allQuestions.find(q => !answered.includes(q.id));
          if (nextQ && nextQ.is_general_question === 1) {
            shouldStop = true;
            break;
          }
        }
        if (shouldStop) {
          console.log('[SIMULATION] Stopping before voting on the final openness poll in personal rooms.');
          await stopSimulation(false);
          return;
        }
      }

      const promises = rooms.map(async (room) => {
        const username = room.name.replace('-personal', '');
        const user = db.prepare("SELECT id FROM users WHERE username = ?").get(username);
        if (!user) return;

        const agentConfig = simulationState.personas[user.id];
        if (!agentConfig) return; // Not a simulated agent
        const profile = getProfile(user.id);

        // Check if the last message in the room was from the Bot.
        // If the last message was from the agent/user, we must wait for the bot to ask the next question.
        const lastMsg = db.prepare("SELECT sender_id FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1").get(room.id);
        if (lastMsg && lastMsg.sender_id !== null) {
          return;
        }

        const answered = db.prepare("SELECT question_id FROM gathering_answers WHERE user_id = ? AND response_status IN ('accepted', 'skipped_invalid')").all(user.id).map(r => r.question_id);
        const nextQ = allQuestions.find(q => !answered.includes(q.id));

        if (nextQ) {
          if (nextQ.is_general_question === 1) {
            const openPoll = db.prepare('SELECT id, question FROM polls WHERE room_id = ? AND is_closed = 0').get(room.id);
            if (openPoll) {
              if (openPoll.question.toLowerCase().includes('relevant or interesting to you')) {
                const options = db.prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ?').all(openPoll.id);
                const randomVal = simulationRandom('topic-preference-mode', user.id, openPoll.id);
                let selectedIds = [];
                if (randomVal < 0.3) {
                  const allTopicsOpt = options.find(o => o.option_text === 'All topics');
                  if (allTopicsOpt) selectedIds = [allTopicsOpt.id];
                } else {
                  const specificOpts = options.filter(o => o.option_text !== 'All topics');
                  if (specificOpts.length > 0) {
                    const firstPick = specificOpts[Math.floor(
                      simulationRandom('topic-preference-first', user.id, openPoll.id) * specificOpts.length
                    )];
                    selectedIds.push(firstPick.id);
                    if (specificOpts.length > 1 && simulationRandom('topic-preference-second-gate', user.id, openPoll.id) < 0.5) {
                      const remaining = specificOpts.filter(o => o.id !== firstPick.id);
                      const secondPick = remaining[Math.floor(
                        simulationRandom('topic-preference-second', user.id, openPoll.id) * remaining.length
                      )];
                      selectedIds.push(secondPick.id);
                    }
                  }
                }
                if (selectedIds.length === 0 && options.length > 0) {
                  selectedIds = [options[0].id];
                }
                await simulateAgentVote(io, openPoll.id, user.id, { optionIds: selectedIds });
              } else {
                const options = db.prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ?').all(openPoll.id);
                // Disagreeable / independent agents (low Agreeableness) lean "No" more often.
                const shouldVoteNo = (profile.ocean.A < 0.25)
                  || (simulationRandom('personal-final', user.id, openPoll.id) < 0.25);
                const noOpt = options.find(o => o.option_text.toLowerCase() === 'no');
                let chosenOpt;
                if (shouldVoteNo && noOpt) {
                  chosenOpt = noOpt;
                } else {
                  const yesOpt = options.find(o => o.option_text.toLowerCase().includes('yes') || o.option_text.toLowerCase().includes('open') || o.option_text.toLowerCase().includes('6') || o.option_text.toLowerCase().includes('5') || o.option_text.toLowerCase().includes('4'));
                  chosenOpt = yesOpt || options[options.length - 1];
                }
                if (chosenOpt) {
                  await simulateAgentVote(io, openPoll.id, user.id, { optionId: chosenOpt.id });
                }
              }
            }
          } else {
            const roomState = db.prepare('SELECT gathering_retry_count FROM rooms WHERE id = ?').get(room.id);
            const isRetry = Number(roomState?.gathering_retry_count || 0) > 0;
            // On a retry, do not replay a configured answer that was already judged unrelated to
            // this question. Ask the simulation LLM for a direct answer to the current topic.
            const opts = isRetry ? [] : (simulationState.preferences[nextQ.topic] || []);
            if (opts.length > 0) {
              const chosen = opts[user.id % opts.length];
              await simulateAgentMessage(io, room.id, user.id, chosen);
            } else {
              // Generate a custom response voiced in the agent's personality.
              const stance = profile.stanceFor(nextQ.topic);
              const memoryContext = getAgentMemoryContext(user.id);
              const systemPrompt = [
                `You are ${username} participating in a deliberation about: ${state.global_question}.`,
                personaPromptBlock(profile),
                stance.position ? `Your stance on "${nextQ.topic}": ${stance.position}.` : '',
                `Relevant memories from your earlier simulation turns:\n${memoryContext}`,
                'Use the memories to stay consistent, but adapt if the conversation gives a good reason.',
                `STYLE: at most ${profile.gates.wordCap} words; ${profile.gates.wordCap <= 25 ? 'terse and reserved.' : profile.gates.wordCap >= 80 ? 'assertive and elaborate.' : 'clear and to the point.'}`
              ].filter(Boolean).join('\n');
              const userPrompt = `The facilitator asks: "${nextQ.question_text}"`;
              
              const response = await callLlmCompletions({
                model: simulationState.model,
                messages: [
                  { role: 'system', content: systemPrompt },
                  { role: 'user', content: userPrompt }
                ]
              });
              const reply = response.choices?.[0]?.message?.content?.trim() || "I agree.";
              await simulateAgentMessage(io, room.id, user.id, reply);
            }
          }
        }
      });
      await Promise.all(promises);
    } else if (currentPhase === 'discussing') {
      // Check if all group rooms are finished and we need to reconcile/transition
      const activeGroupRooms = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE room_type = 'group' AND is_active = 1").get()?.c || 0;
      if (activeGroupRooms > 0) {
        const activeGroupRoomCountVal = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE room_type IN ('group', 'convergence') AND is_active = 1 AND collection_complete = 0").get()?.c || 0;
        if (activeGroupRoomCountVal === 0) {
          const activeConvergenceRooms = db.prepare("SELECT 1 FROM rooms WHERE room_type = 'convergence' AND is_active = 1").get();
          if (!activeConvergenceRooms) {
            if (simulationState.stopAt === 'discussing') {
              await stopSimulation(false);
              return;
            }
            console.log('[SIMULATION] All discussion groups finished, triggering transition to convergence...');
            const { reconcileClosedDiscussionRooms } = await import('./agent3Service.js');
            await reconcileClosedDiscussionRooms();
            return;
          }
        }
      }

      // Process group discussions & voting in parallel
      const activeRooms = db.prepare("SELECT id, name, room_type FROM rooms WHERE is_active = 1 AND room_type IN ('group', 'convergence') AND collection_complete = 0").all();

      if (simulationState.stopAt === 'discussing') {
        const groupRooms = activeRooms.filter(r => r.room_type === 'group');
        let allAtGeneralPoll = groupRooms.length > 0;
        for (const r of groupRooms) {
          const openPolls = db.prepare("SELECT id, question, suggestion FROM polls WHERE room_id = ? AND is_closed = 0").all(r.id);
          let hasGenPoll = false;
          for (const poll of openPolls) {
            const isGenPoll = db.prepare("SELECT 1 FROM gathering_questions WHERE (topic = ? OR question_text = ?) AND is_general_question = 1").get(poll.suggestion, poll.question);
            if (isGenPoll) {
              hasGenPoll = true;
              break;
            }
          }
          if (!hasGenPoll) {
            allAtGeneralPoll = false;
            break;
          }
        }
        if (allAtGeneralPoll) {
          console.log('[SIMULATION] All active group rooms reached the final consensus poll. Stopping.');
          await stopSimulation(false);
          return;
        }
      }

      const roomPromises = activeRooms.map(async (room) => {
        const members = db.prepare("SELECT u.id, u.username FROM users u JOIN room_members rm ON rm.user_id = u.id WHERE rm.room_id = ? AND u.is_admin = 0").all(room.id);
        // Convergence rooms open with a report-review card, not an ordinary discussion prompt.
        // Simulated participants must take the same explicit agree/reopen action as humans
        // before the review window can unlock voting.
        if (room.room_type === 'convergence' && isConvergenceReviewLocked(room.id)) {
          await simulateConvergenceReview(io, room, members);
        }
        const openPolls = db.prepare("SELECT id, question, poll_type, suggestion, mandatory FROM polls WHERE room_id = ? AND is_closed = 0").all(room.id);

        const memberPromises = members.map(async (member) => {
          const agentConfig = simulationState.personas[member.id];
          if (!agentConfig) return;
          const profile = getProfile(member.id);

          // 1. Handle open polls
          for (const poll of openPolls) {
            if (simulationState.stopAt === 'discussing' && room.room_type === 'group') {
              const isGenPoll = db.prepare("SELECT 1 FROM gathering_questions WHERE (topic = ? OR question_text = ?) AND is_general_question = 1").get(poll.suggestion, poll.question);
              if (isGenPoll) continue;
            }
            const cacheKey = `${poll.id}-${member.id}`;
            const options = db.prepare("SELECT id, option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC").all(poll.id);
            const hasVoted = poll.poll_type === 'swipe'
              ? (options.length > 0 && ((db.prepare("SELECT COUNT(DISTINCT option_id) AS c FROM swipe_votes WHERE poll_id = ? AND user_id = ?").get(poll.id, member.id)?.c || 0) >= options.length))
              : db.prepare("SELECT 1 FROM poll_votes WHERE poll_id = ? AND user_id = ? LIMIT 1").get(poll.id, member.id);
            if (!hasVoted && !skippedVotes.has(cacheKey)) {
              if (options.length === 0) continue;

              // Abstention gate: p_abstain = d·(1 - Conscientiousness) (or explicit override).
              if (simulationRandom('abstain', poll.id, member.id) < profile.gates.pAbstain) {
                const abstainedOption = options.find(o => {
                  const txt = o.option_text.toLowerCase();
                  return txt === 'abstained' || txt === 'abstain';
                });
                if (abstainedOption) {
                  await simulateAgentVote(io, poll.id, member.id, { optionId: abstainedOption.id });
                  continue;
                } else if (poll.mandatory !== 1) {
                  // No abstained option available (e.g. sub-topic poll), and not mandatory, so agent decides "not to vote"
                  skippedVotes.add(cacheKey);
                  continue;
                }
                // Mandatory poll with no abstain option: fall through and cast a real vote.
              }

              // Propose-new-option gate: p_other = c·Openness (or explicit override).
              const otherOption = options.find(o => o.option_text.toLowerCase() === 'other');
              const useOther = otherOption
                && (simulationRandom('write-in', poll.id, member.id) < profile.gates.pOther);

              if (useOther) {
                // The model only decides WHETHER to propose; the LLM writes the option text.
                const userRow = db.prepare("SELECT extracted_preferences FROM users WHERE id = ?").get(member.id);
                const pref = userRow?.extracted_preferences || 'consensus';
                const stance = profile.stanceFor(poll.suggestion || poll.question);
                const memoryContext = getAgentMemoryContext(member.id);
                const response = await callLlmCompletions({
                  model: simulationState.model,
                  messages: [
                    { role: 'system', content: `You are ${member.username}.\n${personaPromptBlock(profile)}\nYour stance on topic "${poll.suggestion}": ${stance.position || pref}.\nRelevant memories:\n${memoryContext}\nSuggest a brief, specific new preference option for this topic in 2-5 words. Keep it compatible with your persona and stance unless the debate has changed your mind.` },
                    { role: 'user', content: 'Suggest option text:' }
                  ]
                });
                const customText = response.choices?.[0]?.message?.content?.trim() || 'Alternative consensus';
                await simulateAgentVote(io, poll.id, member.id, { optionId: otherOption.id, customOptionText: customText });
              } else {
                // The vote is DECIDED HERE by the random-utility (softmax) model — not by the LLM —
                // so every persona knob is an auditable coefficient and there is no agreement bias.
                let voteData;
                try {
                  const decision = await computeVoteDecision({
                    profile,
                    poll,
                    options,
                    roomId: room.id,
                    rng: () => simulationRandom('vote-choice', poll.id, member.id, poll.poll_type)
                  });
                  if (poll.poll_type === 'swipe') voteData = { swipeVotes: decision.swipeVotes };
                  else if (poll.poll_type === 'ranking') voteData = { rankedOptions: decision.ranked };
                  else voteData = { optionId: decision.choiceId };
                } catch (e) {
                  console.error('[SIMULATION] vote-model failed, voting first option:', e.message);
                  voteData = { optionId: options[0].id };
                }
                await simulateAgentVote(io, poll.id, member.id, voteData);
              }
            }
          }

          // 2. Participate in discussion. Whether/when to speak is governed by the OCEAN-derived
          // participation gates (p_speak from Extraversion, delay ticks, direct-mention need).
          if (openPolls.length === 0) {
            const lastMsg = db.prepare("SELECT id, sender_id, text FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1").get(room.id);
            if (lastMsg && lastMsg.sender_id === member.id) return;

            const gates = profile.gates;
            const lastAgentMsg = db.prepare("SELECT id FROM messages WHERE room_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 1").get(room.id, member.id);
            const needsFirstContribution = room.room_type === 'group' && !lastAgentMsg;

            const lastMsgText = lastMsg ? lastMsg.text : '';
            const isDirectMention = lastMsgText && lastMsgText.toLowerCase().includes(`@${member.username.toLowerCase()}`);
            if (!needsFirstContribution && gates.requiresDirectMention && !isDirectMention) {
              return;
            }

            let ticksObserved = 999;
            if (lastAgentMsg) {
              ticksObserved = db.prepare("SELECT COUNT(*) as c FROM messages WHERE room_id = ? AND id > ?").get(room.id, lastAgentMsg.id)?.c || 0;
            }
            if (!needsFirstContribution && ticksObserved < gates.delayTicks) {
              return;
            }

            const shouldReply = needsFirstContribution || isDirectMention || (
              simulationRandom('speak', room.id, member.id, lastMsg?.id || 0, ticksObserved) < gates.pSpeak
            );
            if (!shouldReply) {
              return;
            }

            const recentMessages = db.prepare("SELECT m.sender_id, u.username, m.text FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.room_id = ? ORDER BY m.id DESC LIMIT 12").all(room.id);
            const transcript = recentMessages.reverse().map(m => `${m.username || 'Bot'}: ${m.text}`).join('\n');
            const userRow = db.prepare("SELECT extracted_preferences FROM users WHERE id = ?").get(member.id);
            const pref = userRow?.extracted_preferences || 'consensus';
            const stance = profile.stanceFor(room.name);

            const memoryContext = getAgentMemoryContext(member.id);
            const systemPrompt = [
              `You are ${member.username} debating in a group.`,
              personaPromptBlock(profile),
              `Your initial preference: ${stance.position || pref}.`,
              `Relevant memories:\n${memoryContext}`,
              'Before speaking, infer the current social state: who seems aligned, what is unresolved, and what contribution would move the room forward.',
              'When you take a position, give a short reason for it instead of a bare preference statement.',
              'Contribute to the group discussion.',
              `STYLE: Keep your message to at most ${gates.wordCap} words; ${gates.wordCap <= 25 ? 'be terse and reserved.' : gates.wordCap >= 80 ? 'be assertive and elaborate, challenge and synthesize.' : 'be clear and to the point.'}`
            ].join('\n');
            const userPrompt = `Recent discussion:\n${transcript}`;

            const response = await callLlmCompletions({
              model: simulationState.model,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
              ]
            });

            const replyText = response.choices?.[0]?.message?.content?.trim();
            if (replyText) {
              await simulateAgentMessage(io, room.id, member.id, replyText);
            }
          }
        });
        await Promise.all(memberPromises);
      });
      await Promise.all(roomPromises);
    }
  } catch (error) {
    if (error.name !== 'AbortError') console.error('[SIMULATION ERROR]', error);
  }
}

export function startSimulation(io, config) {
  stopSimulation();
  skippedVotes.clear();
  simulationMemories.clear();
  personaProfiles.clear();
  convergenceReviewProcessing.clear();

  simulationState = {
    isRunning: true,
    stopAt: config.stopAt || 'personal',
    model: config.model || 'gpt-5.6-luna',
    seed: Number.isInteger(Number(config.seed)) ? Number(config.seed) : 20260720,
    personas: config.personas || {},
    preferences: config.preferences || {}
  };
  global.isSimulationRunning = true;
  global.simulatedPersonas = config.personas || {};

  console.log('[SIMULATION] Started with config:', JSON.stringify(simulationState));

  const version = simulationGeneration;
  const decisionWork = createDecisionWorkContext({ workType: 'simulation' });
  const work = {
    ...decisionWork,
    isCurrent: () => version === simulationGeneration && simulationState.isRunning && decisionWork.isCurrent()
  };

  // Run loop sequentially
  async function loop() {
    if (!work.isCurrent()) return;
    await runWithWorkContext(work, () => runSimulationStep(io));
    if (work.isCurrent()) {
      simulationTimeout = setTimeout(loop, 3000);
    }
  }
  loop();
}
