import { db } from '../config/db.js';
import { getDecisionSettings } from './agentConfigService.js';
import { readLog } from './decisionLogService.js';
import { surveyExport } from './surveyService.js';

const EXPORT_VERSION = 2;

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowsFromIds(table, column, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`SELECT * FROM ${table} WHERE ${column} IN (${placeholders})`).all(...ids);
}

function rowsSince(table, timeColumn, since, extraWhere = '', extraParams = []) {
  if (process.env.CIME_ENGINE === 'true') since = null;
  const clauses = [];
  const params = [];
  if (since) {
    clauses.push(`${timeColumn} >= ?`);
    params.push(since);
  }
  if (extraWhere) clauses.push(extraWhere);
  return db.prepare(`SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`)
    .all(...params, ...extraParams);
}

function rowsForRooms(table, roomIds, timeColumn, since) {
  if (process.env.CIME_ENGINE === 'true') since = null;
  if (!roomIds.length) return [];
  const placeholders = roomIds.map(() => '?').join(', ');
  const params = [...roomIds];
  const timeClause = since ? ` AND ${timeColumn} >= ?` : '';
  if (since) params.push(since);
  return db.prepare(`SELECT * FROM ${table} WHERE room_id IN (${placeholders})${timeClause}`).all(...params);
}

function selectCurrentRunRooms(allRooms, since) {
  // Personal rooms are long-lived and reused between runs. Only a personal room
  // with activity in this run belongs in the export; including every personal
  // room was the reason an eight-agent simulation exported all seeded accounts.
  if (!since || process.env.CIME_ENGINE === 'true') return allRooms;
  const activityRoomIds = new Set([
    ...rowsSince('messages', 'timestamp', since).map((row) => row.room_id),
    ...rowsSince('polls', 'created_at', since).map((row) => row.room_id),
    ...rowsSince('room_decisions', 'created_at', since).map((row) => row.room_id),
    ...rowsSince('room_status', 'last_updated_at', since).map((row) => row.room_id)
  ]);

  return allRooms.filter((room) => activityRoomIds.has(room.id));
}

function collectIds(rows, key) {
  return [...new Set(rows.map((row) => Number(row[key])).filter((id) => Number.isInteger(id) && id > 0))];
}

/**
 * Build a JSON-safe snapshot of the data already computed for the current decision run.
 * This function deliberately performs database reads only. It must not call the quality
 * route because that route can trigger uncached LLM/embedding analysis on a first load.
 */
export function buildComputedRunExport() {
  const surveys = surveyExport();
  const state = db.prepare('SELECT * FROM system_state WHERE id = 1').get() || {};
  const runId = state.decision_run_id || null;
  const runStartedAt = state.decision_run_started_at || null;
  const frozenIds = process.env.CIME_ENGINE === 'true'
    ? state.decision_run_mode === 'simulation' ? parseJson(state.decision_run_participant_ids_json, []) : db.prepare('SELECT user_id FROM run_participants').all().map(p => p.user_id)
    : null;
  const allRooms = db.prepare('SELECT * FROM rooms ORDER BY id').all().filter(room => !frozenIds || room.room_type !== 'personal' || db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(room.id).some(member => frozenIds.includes(member.user_id)));
  const rooms = selectCurrentRunRooms(allRooms, runStartedAt);
  const roomIds = rooms.map((room) => room.id);

  const messages = rowsForRooms('messages', roomIds, 'timestamp', runStartedAt);
  const polls = rowsForRooms('polls', roomIds, 'created_at', runStartedAt);
  const pollIds = polls.map((poll) => poll.id);
  const pollOptions = rowsFromIds('poll_options', 'poll_id', pollIds);
  const pollVotes = rowsFromIds('poll_votes', 'poll_id', pollIds);
  const swipeVotes = rowsFromIds('swipe_votes', 'poll_id', pollIds);
  const pollVoteHistory = rowsFromIds('poll_vote_history', 'poll_id', pollIds);
  const pollSuggestions = rowsFromIds('poll_suggestions', 'poll_id', pollIds);
  const pollAnnouncements = rowsFromIds('poll_announcements', 'poll_id', pollIds);
  const topicPreferenceResponses = rowsFromIds('topic_preference_responses', 'room_id', roomIds);

  const gatheringQuestions = rowsSince('gathering_questions', 'created_at', runStartedAt);
  const gatheringAnswers = rowsSince('gathering_answers', 'created_at', runStartedAt);
  const roomDecisions = rowsForRooms('room_decisions', roomIds, 'created_at', runStartedAt);
  const roomStatus = rowsForRooms('room_status', roomIds, 'last_updated_at', runStartedAt);
  const convergenceAgreements = rowsForRooms('convergence_agreements', roomIds, 'created_at', runStartedAt);
  const convergenceReviewActions = rowsForRooms('convergence_review_actions', roomIds, 'created_at', runStartedAt);
  const customOptionAnalyses = rowsFromIds('custom_option_analyses', 'poll_id', pollIds);
  const proactivenessAnalyses = rowsFromIds('message_proactiveness_analyses', 'message_id', collectIds(messages, 'id'));
  const deliberativeQualityAnalyses = rowsFromIds('message_deliberative_quality_analyses', 'message_id', collectIds(messages, 'id'));
  const agentEvents = rowsSince('agent_events', 'created_at', runStartedAt);
  const agentInstructions = db.prepare('SELECT * FROM agent_instructions ORDER BY agent_key').all();
  const roomMembers = rowsFromIds('room_members', 'room_id', roomIds);
  const llmCallModels = db.prepare('SELECT * FROM llm_call_models ORDER BY call_key').all();

  const llmLogs = runId
    ? db.prepare('SELECT * FROM llm_logs WHERE session_id = ? ORDER BY id').all(runId)
    : rowsSince('llm_logs', 'created_at', runStartedAt);

  // Do not use the global users table as the participant list. Seeded accounts
  // remain in that table for future runs, but they are not participants in this
  // run. Derive the run population from run-scoped room membership and activity.
  const allUsers = db.prepare('SELECT id, username, is_admin, profile_info, extracted_preferences FROM users ORDER BY id').all();
  const nonAdminIds = new Set(allUsers.filter((user) => user.is_admin !== 1).map((user) => user.id));
  const participantIds = new Set([
    ...roomMembers.map((row) => row.user_id),
    ...messages.map((row) => row.sender_id),
    ...gatheringAnswers.map((row) => row.user_id),
    ...topicPreferenceResponses.map((row) => row.user_id),
    ...pollVotes.map((row) => row.user_id),
    ...swipeVotes.map((row) => row.user_id)
  ].filter((id) => nonAdminIds.has(id)));
  const users = allUsers.filter((user) => participantIds.has(user.id));
  const participantPlaceholders = [...participantIds].map(() => '?').join(', ');
  const userTopicPreferences = participantIds.size > 0
    ? db.prepare(`SELECT * FROM user_topic_preferences WHERE user_id IN (${participantPlaceholders}) ORDER BY user_id, topic`).all(...participantIds)
    : [];
  const adminUsers = allUsers.filter((user) => user.is_admin === 1);
  const quality = {
    computedOnly: true,
    note: 'Raw cached quality analyses are included. This export does not run new LLM or embedding analyses.',
    cachedMessageProactivenessAnalyses: proactivenessAnalyses,
    cachedDeliberativeQualityAnalyses: deliberativeQualityAnalyses,
    cachedCustomOptionAnalyses: customOptionAnalyses,
    coverage: {
      messages: messages.length,
      proactivenessMessages: proactivenessAnalyses.length,
      deliberativeQualityMessages: deliberativeQualityAnalyses.length,
      customOptionAnalyses: customOptionAnalyses.length
    }
  };

  const records = {
    surveyResponses: surveys.responses,
    users,
    ...(process.env.CIME_ENGINE === 'true' ? { participantIdentities: db.prepare('SELECT user_id, joined_at, prolific_pid, prolific_study_id, prolific_session_id FROM run_participants ORDER BY user_id').all() } : {}),
    adminUsers,
    rooms,
    roomMembers,
    messages,
    gatheringQuestions,
    gatheringAnswers,
    polls,
    pollOptions,
    pollVotes,
    swipeVotes,
    pollVoteHistory,
    pollSuggestions,
    pollAnnouncements,
    topicPreferenceResponses,
    roomDecisions,
    roomStatus,
    convergenceAgreements,
    convergenceReviewActions,
    agentEvents,
    agentInstructions,
    userTopicPreferences,
    llmCallModels,
    llmLogs
  };

  const recordCounts = Object.fromEntries(Object.entries(records).map(([key, value]) => [key, value.length]));
  return {
    manifest: {
      exportVersion: EXPORT_VERSION,
      exportType: 'cime-computed-run-data',
      generatedAt: new Date().toISOString(),
      decisionRunId: runId,
      platformRunId: process.env.CIME_RUN_ID || null,
      decisionRunStartedAt: runStartedAt,
      currentPhase: state.current_phase || 'idle',
      participantCount: users.length,
      participantUserIds: users.map((user) => user.id),
      participantUsernames: users.map((user) => user.username),
      recordCounts,
      qualityComputedOnly: true
    },
    configuration: {
      surveys: surveys.definitions,
      globalQuestion: state.global_question || '',
      decisionContext: state.decision_context || '',
      generalDescription: state.general_description || '',
      discussionRound: state.discussion_round ?? 0,
      roomTimerMinutes: state.room_timer_minutes ?? null,
      activeTopicIndex: state.active_topic_index ?? 0,
      settings: getDecisionSettings(),
      deliberationQuestions: gatheringQuestions.map((question) => ({
        ...question,
        predefined_answers: parseJson(question.predefined_answers_json, [])
      })),
      decisionLog: readLog(),
      ...(process.env.CIME_ENGINE === 'true' ? { runSnapshot: parseJson(db.prepare('SELECT config_json FROM run_metadata WHERE id = 1').get()?.config_json, {}) } : {})
    },
    quality,
    records
  };
}
