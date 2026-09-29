import { createRouter } from '../middleware/router.js';
import bcrypt from 'bcrypt';
import { db, ensureAdminsInAllRooms, ensureAdminsInRoom, ensurePersonalRoomsForAllUsers } from '../config/db.js';
import { DEFAULT_PRIMARY_MODEL, SUPPORTED_CHAT_MODELS, env } from '../config/env.js';
import { authMiddleware, adminMiddleware } from '../middleware/auth.js';
import {
  assignPromptToPersonalRooms,
  createPromptFile,
  emitDecisionStatus,
  generatePreferencePrompt,
  getDecisionStatus,
  loadPromptMarkdown,
  listPromptFiles,
  logAgentEvent,
  saveAgentInstruction,
  createClusteredDiscussionRooms,
  createConvergenceDiscussionRoom
} from '../services/agent2Service.js';
import { forceCloseOpenPersonalChats, forceCreatePollFromDiscussion, completeDecision, getAccumulatedDecisions, forceShowdown, forceShowdownForRoom, getUnresolvedRoomMemoryTopics, countLegitimateFailedPolls, getDetailedConvergenceRecap, interruptDecisionProcess, createBotMessage, getConvergenceSummaryData } from '../services/agent3Service.js';
import { getAgentPrompt, getConfiguredModels, getDecisionSettings, renderTemplate, updateDecisionSettings, getSavedDefaultSettings, saveCurrentSettingsAsDefault, resetSettingsToDefault } from '../services/agentConfigService.js';
import { initializeLog, readLog } from '../services/decisionLogService.js';
import { classifyCustomOption, classifyHumanMessageProactiveness } from '../services/customOptionAnalysisService.js';
import { analyzeDeliberativeMessagesWithLLM } from '../services/deliberativeQualityService.js';
import { withRequestWork, throwIfWorkCancelled, runWithWorkContext } from '../services/workContext.js';
import { beginDecisionRun, createDecisionWorkContext, getDecisionWorkVersion } from '../services/decisionWorkService.js';
import { cancelDecisionWork } from '../services/agent3Service.js';
import { buildComputedRunExport } from '../services/runExportService.js';
import client from '../services/llm.js';
import { startSimulation, stopSimulation, getSimulationStatus } from '../services/simulationService.js';
import {
  buildPersonaAutofillPopulationInstructions,
  getPersonaAutofillPlan,
  normalizePersonaAutofillMode
} from '../services/simulationPersonaService.js';

const router = createRouter();
router.use(authMiddleware, adminMiddleware);
const llm = client;

function nowIso() {
  return new Date().toISOString();
}

function emit(io, event, payload, roomId = null) {
  if (!io) return;
  if (roomId) io.to(`room:${roomId}`).emit(event, payload);
  else io.emit(event, payload);
}

function getPollsForRoom(roomId, includeResults = true) {
  const polls = db.prepare('SELECT * FROM polls WHERE room_id = ? ORDER BY id DESC').all(roomId);
  return polls.map((poll) => {
    const options = db
      .prepare(
        `
        SELECT po.id, po.option_text, COUNT(voter.id) AS votes
        FROM poll_options po
        LEFT JOIN poll_votes pv ON pv.option_id = po.id
        LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ?
        GROUP BY po.id
        ORDER BY po.id ASC
      `
      )
      .all(poll.id);
    return {
      ...poll,
      show_results: poll.show_results === 1,
      is_closed: poll.is_closed === 1 || (poll.expires_at && poll.expires_at <= nowIso()),
      mandatory: poll.mandatory === 1,
      options: options.map((o) => ({
        ...o,
        votes: includeResults || poll.show_results === 1 ? o.votes : null
      }))
    };
  });
}

function isClosePersonalChatsCommand(message) {
  return /\b(close|finish|end|stop)\b[\s\S]*\b(conversation|conversations|personal chat|personal chats|phase 1|gathering)\b/i.test(message);
}

function normalizePollOptions(options) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of options || []) {
    const option = String(raw || '').trim();
    if (!option) continue;
    const key = option.toLowerCase();
    if (key === 'other' || key === 'keep discussing') continue;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(option);
  }
  cleaned.push('Keep discussing');
  return cleaned;
}

function defaultGeneralAnswers() {
  return [
    'No',
    'Probably no, but I can try',
    'I am hesitant',
    'Maybe',
    'Yes, I am open',
    'Yes, very open'
  ];
}

function normalizeQuestionAnswers(rawAnswers) {
  const answers = Array.isArray(rawAnswers) ? rawAnswers : [];
  const seen = new Set();
  const cleaned = [];
  for (const raw of answers.slice(0, 8)) {
    const value = String(raw || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(value);
  }
  return cleaned;
}

function normalizeDeliberationQuestions(input, globalQuestion) {
  const list = Array.isArray(input) ? input : [];
  return list.slice(0, 10).map((item, index) => {
    const questionText = String(item?.question_text || item?.question || '').trim();
    const predefinedAnswers = normalizeQuestionAnswers(item?.predefined_answers || item?.answers);
    return {
      topic: String(item?.topic || `topic-${index + 1}`).trim() || `topic-${index + 1}`,
      question_text: questionText,
      question_order: Number.isInteger(Number(item?.question_order)) ? Number(item.question_order) : index + 1,
      predefined_answers_json: JSON.stringify(predefinedAnswers),
      is_general_question: item?.is_general_question ? 1 : 0
    };
  }).filter((question) => question.question_text);
}

function resolveDiscussionRoomMention(message) {
  const text = String(message || '').trim();
  const groupMatch = text.match(/\b(?:discussion\s+)?(?:group|room)\s+(\d+)\b/i);
  if (groupMatch) {
    const groupNumber = Number(groupMatch[1]);
    const room = db
      .prepare(
        `
        SELECT id, name
        FROM rooms
        WHERE room_type = 'group'
          AND is_active = 1
          AND (
            LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?) OR
            LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?)
          )
        ORDER BY id DESC
        LIMIT 1
        `
      )
      .get(
        `Discussion Group ${groupNumber}`,
        `Discussion Group ${groupNumber} (%)`,
        `Group ${groupNumber}`,
        `Group ${groupNumber} (%)`
      );
    if (room) return room;
  }

  const explicitRoomIdMatch = text.match(/\b(?:room\s*#?|id\s*#?)\s*(\d{2,})\b/i);
  if (explicitRoomIdMatch) {
    const roomId = Number(explicitRoomIdMatch[1]);
    const room = db.prepare("SELECT id, name FROM rooms WHERE id = ? AND room_type = 'group' AND is_active = 1").get(roomId);
    if (room) return room;
  }

  const activeRooms = db.prepare("SELECT id, name FROM rooms WHERE room_type = 'group' AND is_active = 1 ORDER BY id ASC").all();
  if (activeRooms.length === 1) return activeRooms[0];
  return null;
}

function resolveRoomMention(mentionText) {
  const text = String(mentionText || '').trim();
  const numericId = Number(text.replace(/[^0-9]/g, ''));
  if (numericId && text.includes('#')) {
    const room = db.prepare("SELECT id, name FROM rooms WHERE id = ?").get(numericId);
    if (room) return room;
  }
  
  let room = db.prepare("SELECT id, name FROM rooms WHERE LOWER(name) = LOWER(?)").get(text);
  if (room) return room;

  room = db.prepare("SELECT id, name FROM rooms WHERE LOWER(name) LIKE LOWER(?)").get(`%${text}%`);
  if (room) return room;

  const groupMatch = text.match(/\b(?:discussion\s+)?(?:group|room)\s+(\d+)\b/i);
  if (groupMatch) {
    const groupNumber = Number(groupMatch[1]);
    const r = db
      .prepare(
        `
        SELECT id, name
        FROM rooms
        WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?) OR
              LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?)
        ORDER BY id DESC
        LIMIT 1
        `
      )
      .get(
        `Discussion Group ${groupNumber}`,
        `Discussion Group ${groupNumber} (%)`,
        `Group ${groupNumber}`,
        `Group ${groupNumber} (%)`
      );
    if (r) return r;
  }

  return null;
}

router.get('/decision-process', (_req, res) => {
  return res.json(getDecisionStatus());
});

router.post('/decision-process/start', async (req, res) => {
  const {
    globalQuestion,
    decisionContext = '',
    generalDescription = '',
    roomTimerMinutes = 3,
    deliberationQuestions = [],
    generalQuestionAnswers = []
  } = req.body;
  if (!globalQuestion || typeof globalQuestion !== 'string' || !globalQuestion.trim()) {
    return res.status(400).json({ error: 'globalQuestion is required' });
  }
  if (!decisionContext || typeof decisionContext !== 'string' || !decisionContext.trim()) {
    return res.status(400).json({ error: 'decisionContext is required' });
  }
  if (typeof generalDescription !== 'string') {
    return res.status(400).json({ error: 'generalDescription must be a string' });
  }
  try {
    const cleanQuestion = globalQuestion.trim();
    const cleanContext = decisionContext.trim();
    const cleanDescription = generalDescription.trim();
    const normalizedQuestions = normalizeDeliberationQuestions(deliberationQuestions, cleanQuestion);
    if (!normalizedQuestions.length) {
      return res.status(400).json({ error: 'At least one deliberation question is required' });
    }
    await stopSimulation(false);
    cancelDecisionWork();
    beginDecisionRun({ mode: 'human' });
    ensurePersonalRoomsForAllUsers();
    db.prepare('DELETE FROM agent_events').run();
    db.prepare('DELETE FROM agent_instructions').run();
    db.prepare('DELETE FROM gathering_questions').run();
    db.prepare('DELETE FROM gathering_answers').run();
    db.prepare('DELETE FROM topic_preference_responses').run();
    db.prepare('DELETE FROM polls').run();
    db.prepare('DELETE FROM poll_votes').run();
    db.prepare('DELETE FROM room_decisions').run();
    db.prepare('UPDATE rooms SET is_active = 0').run();
    // Remove stale group/convergence rooms from any previous run so they don't linger on user
    // dashboards or cause "(2)" name collisions when new rooms are created. Personal rooms are
    // recreated fresh below.
    db.prepare("DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
    db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
    db.prepare("DELETE FROM rooms WHERE room_type IN ('group','convergence')").run();
    const settings = getDecisionSettings();
    db.prepare(
      `
      UPDATE system_state
      SET global_question = ?,
          decision_context = ?,
          general_description = ?,
          current_phase = ?,
          discussion_round = 0,
          room_timer_minutes = ?,
          active_topic_index = 0,
          deliberation_config_json = ?,
          showdown_initiated = 0
      WHERE id = 1
    `
    ).run(
      cleanQuestion,
      cleanContext,
      cleanDescription,
      'gathering',
      Number(roomTimerMinutes) || settings.room_timer_minutes || 3,
      JSON.stringify(normalizedQuestions)
    );

    const insertQ = db.prepare(
      'INSERT INTO gathering_questions (topic, question_text, question_order, predefined_answers_json, is_general_question, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const nowStr = new Date().toISOString();
    db.transaction(() => {
      normalizedQuestions.forEach((q) => {
        insertQ.run(q.topic, q.question_text, q.question_order, q.predefined_answers_json, q.is_general_question, nowStr);
      });
      // Admin-defined options for the final general-question vote. Trim, drop empties/dupes; fall
      // back to the default openness scale if fewer than two valid options were provided.
      const cleanedGeneralAnswers = [...new Set(
        (Array.isArray(generalQuestionAnswers) ? generalQuestionAnswers : [])
          .map((a) => String(a || '').trim())
          .filter(Boolean)
      )];
      const finalGeneralAnswers = cleanedGeneralAnswers.length >= 2 ? cleanedGeneralAnswers : defaultGeneralAnswers();
      insertQ.run(
        'general-question',
        cleanQuestion,
        normalizedQuestions.length + 1,
        JSON.stringify(finalGeneralAnswers),
        1,
        nowStr
      );
    })();

    const setupWork = createDecisionWorkContext({ workType: 'setup' });
    const prompt = await runWithWorkContext(setupWork, () => generatePreferencePrompt(cleanQuestion, cleanContext));
    if (!setupWork.isCurrent()) return res.status(409).json({ error: 'The decision process was stopped or replaced.' });
    initializeLog(settings, cleanQuestion, cleanContext);
    const io = req.app.get('io');
    io.emit('process_started', { globalQuestion: cleanQuestion, generalDescription: cleanDescription, process_started_at: nowStr });
    assignPromptToPersonalRooms(prompt, cleanQuestion, io);
    emitDecisionStatus(io);
    return res.json({ ok: true, prompt });
  } catch (error) {
    return res.status(500).json({ error: `Failed to start decision process: ${error.message}` });
  }
});

router.post('/decision-process/fast-simulation', async (req, res) => {
  const { stopAt } = req.body;
  if (stopAt !== 'discussing') {
    return res.status(400).json({ error: 'Only fast simulating to convergence (stopAt = discussing) is currently supported.' });
  }

  try {
    const io = req.app.get('io');
    
    db.prepare('DELETE FROM agent_events').run();
    db.prepare('DELETE FROM agent_instructions').run();
    db.prepare('DELETE FROM polls').run();
    db.prepare('DELETE FROM poll_votes').run();
    db.prepare('DELETE FROM swipe_votes').run();
    db.prepare('DELETE FROM room_decisions').run();
    db.prepare('UPDATE rooms SET is_active = 0').run();
    // Clear stale group/convergence rooms from a previous run so repeated fast-simulations don't
    // accumulate rooms or create "(2)"-suffixed duplicate names.
    db.prepare("DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
    db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
    db.prepare("DELETE FROM rooms WHERE room_type IN ('group','convergence')").run();

    db.prepare(
      `
      UPDATE system_state
      SET current_phase = 'discussing',
          discussion_round = 1,
          active_topic_index = 0,
          showdown_initiated = 0
      WHERE id = 1
    `
    ).run();

    const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
    
    const allUsers = db.prepare('SELECT id FROM users WHERE is_admin = 0').all();
    const questions = db.prepare('SELECT topic FROM gathering_questions WHERE is_general_question = 0').all();
    
    if (questions.length > 0) {
      const updatePref = db.prepare('UPDATE users SET extracted_preferences = ? WHERE id = ?');
      const insertTopicPref = db.prepare('INSERT INTO topic_preference_responses (user_id, selected_topics_json, selected_all_topics, created_at) VALUES (?, ?, ?, ?)');
      const now = new Date().toISOString();
      db.transaction(() => {
        allUsers.forEach(u => {
          const pref = { topics: [] };
          for (const q of questions) {
            if (Math.random() > 0.5) pref.topics.push(q.topic);
          }
          if (pref.topics.length === 0) pref.topics.push(questions[0].topic);
          updatePref.run(JSON.stringify(pref), u.id);
          try {
            insertTopicPref.run(u.id, JSON.stringify(pref.topics), 0, now);
          } catch(e) {}
        });
      })();
    }

    const preferences = db.prepare("SELECT id, username, extracted_preferences FROM users WHERE is_admin = 0").all();
    const createdGroups = await createClusteredDiscussionRooms({ globalQuestion: state.global_question, preferences, io });
    
    const insertDecision = db.prepare('INSERT INTO room_decisions (room_id, decision_round, decision_text, normalized_decision, created_at) VALUES (?, ?, ?, ?, ?)');
    const updateRoom = db.prepare("UPDATE rooms SET collection_complete = 1, is_active = 0 WHERE id = ?");
    const updateMemory = db.prepare('UPDATE rooms SET topic_memory_json = ? WHERE id = ?');

    const mockDecisions = [];
    const nowDecision = new Date().toISOString();
    db.transaction(() => {
      for (let i = 0; i < createdGroups.length; i++) {
        const room = createdGroups[i];

        // Simulate a realistic per-topic resolution inside each group room so the convergence
        // summary has real agreed/disagreed data to display (instead of an empty mock decision).
        let memory = [];
        try {
          const row = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(room.roomId);
          memory = JSON.parse(row?.topic_memory_json || '[]');
        } catch (e) { memory = []; }

        // Alternate the general-question outcome across rooms so convergence sees a spread of votes.
        const generalDecisionText = (i % 2 === 0)
          ? 'Yes: 100%, No: 0%, abstained: 0%'
          : 'Yes: 0%, No: 100%, abstained: 0%';

        for (const entry of memory) {
          if (entry.is_general_question) {
            entry.status = 'resolved';
            entry.suggestion = entry.key;
            entry.decision = generalDecisionText;
            entry.summary = generalDecisionText;
          } else {
            const opts = Array.isArray(entry.options)
              ? entry.options.filter(o => o && !['keep discussing', 'other'].includes(String(o).toLowerCase()))
              : [];
            // Different rooms pick different options for shared topics -> some topics end up
            // "open" (disagreement) in convergence, while single-room topics come out "agreed".
            const chosen = opts.length > 0 ? opts[i % opts.length] : `Agreed option for ${entry.key}`;
            entry.status = 'resolved';
            entry.suggestion = entry.key;
            entry.decision = chosen;
            entry.summary = `${chosen}: 2; Keep discussing: 0; Other: 0`;
          }
        }
        updateMemory.run(JSON.stringify(memory), room.roomId);
        updateRoom.run(room.roomId);

        insertDecision.run(room.roomId, 1, generalDecisionText, generalDecisionText, nowDecision);
        mockDecisions.push({
          room_id: room.roomId,
          room_name: room.name,
          decision_text: generalDecisionText,
          normalized_decision: generalDecisionText
        });
      }
    })();
    
    const convergenceRoom = await createConvergenceDiscussionRoom({
      globalQuestion: state.global_question,
      decisions: mockDecisions,
      io
    });
    
    if (convergenceRoom && convergenceRoom.roomId) {
      const summaryData = getConvergenceSummaryData(1);
      const summaryPayload = JSON.stringify(summaryData);
      createBotMessage(convergenceRoom.roomId, `[ConvergenceSummary=${summaryPayload}]`, 'system_summary');
      // Open the configured interactive review window (polling stays locked until it finalizes).
      db.prepare('UPDATE rooms SET convergence_summary_at = ?, convergence_finalized = 0 WHERE id = ?')
        .run(new Date().toISOString(), convergenceRoom.roomId);

      emitDecisionStatus(io);
    }
    
    return res.json({ ok: true, message: 'Fast simulation completed. Ready for convergence.' });

  } catch (error) {
    console.error('Fast simulation error:', error);
    return res.status(500).json({ error: error.stack });
  }
});

router.get('/simulation/users', (req, res) => {
  try {
    const users = db.prepare("SELECT id, username FROM users WHERE is_admin = 0 ORDER BY username COLLATE NOCASE, id").all();
    return res.json({ users });
  } catch (error) {
    return res.status(500).json({ error: `Failed to fetch users: ${error.message}` });
  }
});

router.post('/simulation/users', (req, res) => {
  const usernames = Array.isArray(req.body?.usernames)
    ? [...new Set(req.body.usernames.map((value) => String(value || '').trim()).filter(Boolean))]
    : [];
  const password = String(req.body?.password || '');

  if (getSimulationStatus().isRunning) {
    return res.status(409).json({ error: 'Stop the simulation before adding participants.' });
  }
  const phase = db.prepare('SELECT current_phase FROM system_state WHERE id = 1').get()?.current_phase;
  if (!['idle', 'completed'].includes(phase)) {
    return res.status(409).json({ error: 'Finish or interrupt the active decision before adding participants.' });
  }
  if (!usernames.length || usernames.length > 100) {
    return res.status(400).json({ error: 'Provide between 1 and 100 usernames.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'The shared password must be at least 6 characters.' });
  }
  const invalid = usernames.find((username) => username.length < 3 || username.length > 64);
  if (invalid) {
    return res.status(400).json({ error: `Username "${invalid}" must contain 3 to 64 characters.` });
  }

  const existing = db.prepare(`
    SELECT username FROM users
    WHERE lower(username) IN (${usernames.map(() => '?').join(', ')})
  `).all(...usernames.map((username) => username.toLowerCase()));
  if (existing.length) {
    return res.status(409).json({ error: `Already exists: ${existing.map((row) => row.username).join(', ')}` });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const insert = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 0)');
    const created = db.transaction(() => usernames.map((username) => ({
      id: Number(insert.run(username, hash).lastInsertRowid),
      username
    })))();
    ensurePersonalRoomsForAllUsers();
    req.app.get('io')?.emit('users_updated');
    return res.status(201).json({ users: created });
  } catch (error) {
    return res.status(409).json({ error: `Could not create participants: ${error.message}` });
  }
});

router.get('/simulation/status', (req, res) => {
  return res.json(getSimulationStatus());
});

router.post('/simulation/start', async (req, res) => {
  const {
    stopAt,
    model,
    seed,
    personas,
    preferences,
    globalQuestion,
    decisionContext = '',
    generalDescription = '',
    deliberationQuestions = [],
    roomTimerMinutes,
  } = req.body || {};

  try {
    if (!Array.isArray(deliberationQuestions)) return res.status(400).json({ error: 'deliberationQuestions must be an array' });
    if (stopAt && !['personal', 'discussing', 'convergence'].includes(stopAt)) return res.status(400).json({ error: 'Invalid simulation stop phase' });
    const selectedParticipantIds = personas && typeof personas === 'object'
      ? [...new Set(Object.keys(personas)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0))]
      : [];
    if (selectedParticipantIds.length === 0) {
      return res.status(400).json({ error: 'Select at least one active simulation agent before starting.' });
    }
    const participantPlaceholders = selectedParticipantIds.map(() => '?').join(', ');
    const validParticipantIds = db.prepare(`
      SELECT id
      FROM users
      WHERE is_admin = 0 AND id IN (${participantPlaceholders})
    `).all(...selectedParticipantIds).map((row) => row.id);
    if (validParticipantIds.length !== selectedParticipantIds.length) {
      const validSet = new Set(validParticipantIds);
      const invalidIds = selectedParticipantIds.filter((id) => !validSet.has(id));
      return res.status(400).json({ error: `Simulation contains invalid participant account(s): ${invalidIds.join(', ')}` });
    }
    let finalQuestions = deliberationQuestions || [];
    let finalGlobalQuestion = globalQuestion;
    let finalDecisionContext = decisionContext;
    let finalGeneralDescription = generalDescription;

    const stateRow = db.prepare('SELECT global_question, decision_context, general_description, deliberation_config_json FROM system_state WHERE id = 1').get();

    if (!finalGlobalQuestion && stateRow?.global_question) {
      finalGlobalQuestion = stateRow.global_question;
    }
    if (!finalDecisionContext && stateRow?.decision_context) {
      finalDecisionContext = stateRow.decision_context;
    }
    if (!finalGeneralDescription && stateRow?.general_description) {
      finalGeneralDescription = stateRow.general_description;
    }

    if (!finalQuestions || finalQuestions.length === 0) {
      if (stateRow?.deliberation_config_json) {
        try {
          finalQuestions = JSON.parse(stateRow.deliberation_config_json);
        } catch (e) {}
      }
    }

    if (!finalQuestions || finalQuestions.length === 0) {
      const dbQuestions = db.prepare('SELECT topic, question_text, predefined_answers_json, question_order, is_general_question FROM gathering_questions WHERE is_general_question = 0').all();
      finalQuestions = dbQuestions.map(q => ({
        topic: q.topic,
        question_text: q.question_text,
        predefined_answers: JSON.parse(q.predefined_answers_json || '[]'),
        question_order: q.question_order,
        is_general_question: q.is_general_question === 1
      }));
    }

    const cleanQuestion = String(finalGlobalQuestion || '').trim() || 'Budget allocation';
    const cleanContext = String(finalDecisionContext || '').trim();
    const cleanDescription = String(finalGeneralDescription || '').trim();

    const normalizedQuestions = normalizeDeliberationQuestions(finalQuestions, cleanQuestion);

    if (!normalizedQuestions.length) {
      return res.status(400).json({ error: 'No deliberation questions configured in settings. Please configure them first.' });
    }

    const settings = getDecisionSettings();
    const roomTimerMinutesVal = Number(roomTimerMinutes) || settings.room_timer_minutes || 3;

    const simulationSeed = Number.isInteger(Number(seed)) ? Number(seed) : 20260720;
    const preparationVersion = getDecisionWorkVersion();
    const preparation = { workType: 'setup', isCurrent: () => getDecisionWorkVersion() === preparationVersion };
    const generalQuestion = { topic: 'general-question', question_text: cleanQuestion,
      predefined_answers_json: JSON.stringify(['Yes', 'No']), is_general_question: 1 };
    const prompt = await runWithWorkContext(preparation, () => generatePreferencePrompt(cleanQuestion, cleanContext, {
      generalDescription: cleanDescription, adminGuidance: '', questions: [...normalizedQuestions, generalQuestion]
    }));
    if (!preparation.isCurrent()) return res.status(409).json({ error: 'The process changed while preparing the simulation.' });
    await stopSimulation(false);
    if (!preparation.isCurrent()) return res.status(409).json({ error: 'The process changed while preparing the simulation.' });
    const io = req.app.get('io');
    let openingMessages;
    db.transaction(() => {
      cancelDecisionWork();
      // Persist the selected simulation scope before any asynchronous setup or
      // Agent 3 sweep can inspect the gathering phase.
      beginDecisionRun({ participantIds: selectedParticipantIds, mode: 'simulation', seed: simulationSeed });

      // A simulation may be started directly from the Simulation tab, so repair
      // personal-room membership here as well as through the manual admin action.
      ensurePersonalRoomsForAllUsers();

      // 1. Reset database tables just like /decision-process/start
      db.prepare('DELETE FROM agent_events').run();
      db.prepare('DELETE FROM agent_instructions').run();
      db.prepare('DELETE FROM gathering_questions').run();
      db.prepare('DELETE FROM gathering_answers').run();
      db.prepare('DELETE FROM topic_preference_responses').run();
      db.prepare('DELETE FROM polls').run();
      db.prepare('DELETE FROM poll_votes').run();
      db.prepare('DELETE FROM room_decisions').run();
      db.prepare('UPDATE rooms SET is_active = 0').run();
      // Remove stale group/convergence rooms from any previous run (same cleanup as
      // /decision-process/start); leftovers with an old decision_round would otherwise be
      // counted by the round reconciler and block completion.
      db.prepare("DELETE FROM messages WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
      db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type IN ('group','convergence'))").run();
      db.prepare("DELETE FROM rooms WHERE room_type IN ('group','convergence')").run();

      db.prepare(
        `
        UPDATE system_state
        SET global_question = ?,
            decision_context = ?,
            general_description = ?,
            current_phase = ?,
            discussion_round = 0,
            room_timer_minutes = ?,
            active_topic_index = 0,
            deliberation_config_json = ?,
            showdown_initiated = 0
        WHERE id = 1
      `
      ).run(
        cleanQuestion,
        cleanContext,
        cleanDescription,
        'gathering',
        roomTimerMinutesVal,
        JSON.stringify(normalizedQuestions)
      );

      const insertQ = db.prepare(
        'INSERT INTO gathering_questions (topic, question_text, question_order, predefined_answers_json, is_general_question, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      );
      const nowStr = new Date().toISOString();
      db.transaction(() => {
        normalizedQuestions.forEach((q) => {
          insertQ.run(q.topic, q.question_text, q.question_order, q.predefined_answers_json, q.is_general_question, nowStr);
        });
        insertQ.run(
          'general-question',
          cleanQuestion,
          normalizedQuestions.length + 1,
          JSON.stringify(['Yes', 'No']),
          1,
          nowStr
        );
      })();

      openingMessages = assignPromptToPersonalRooms(prompt, cleanQuestion, null, selectedParticipantIds);
    })();
    initializeLog(settings, cleanQuestion, cleanContext);
    io.emit('process_started', { globalQuestion: cleanQuestion, generalDescription: cleanDescription,
      process_started_at: db.prepare('SELECT decision_run_started_at FROM system_state WHERE id = 1').get().decision_run_started_at });
    for (const message of openingMessages) io.to(`room:${message.room_id}`).emit('receive_message', message);
    io.emit('rooms_updated');

    // Start the simulation only after the selected rooms have been prepared, so
    // the first loop cannot observe a half-reset process.
    startSimulation(io, { stopAt, model, seed, personas, preferences });
    emitDecisionStatus(io);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: `Failed to start simulation: ${error.message}` });
  }
});

router.post('/simulation/stop', async (req, res) => {
  try {
    await stopSimulation(true);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/decision-process/showdown', async (req, res) => {
  try {
    db.prepare('UPDATE system_state SET showdown_initiated = 1 WHERE id = 1').run();
    await forceShowdown();
    emitDecisionStatus(req.app.get('io'));
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: `Failed to trigger showdown: ${error.message}` });
  }
});

router.post('/decision-process/interrupt', async (req, res) => {
  try {
    interruptDecisionProcess();
    stopSimulation();
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: `Failed to interrupt process: ${error.message}` });
  }
});

router.get('/decision-process/settings', (_req, res) => {
  return res.json({ settings: getDecisionSettings() });
});

router.patch('/decision-process/settings', async (req, res) => {
  try {
    const settings = updateDecisionSettings(req.body || {});
    const state = db.prepare('SELECT global_question, decision_context, current_phase FROM system_state WHERE id = 1').get();
    if (state?.global_question && state.current_phase === 'gathering') {
      const prompt = await generatePreferencePrompt(state.global_question, state.decision_context || '');
      db.prepare("UPDATE rooms SET system_prompt = ? WHERE room_type = 'personal' AND is_active = 1").run(prompt);
      logAgentEvent('agent2', 'Updated decision settings and personal prompts', JSON.stringify(settings));
    } else {
      logAgentEvent('agent2', 'Updated decision settings', JSON.stringify(settings));
    }
    emitDecisionStatus(req.app.get('io'));
    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ error: `Failed to update decision settings: ${error.message}` });
  }
});

router.get('/decision-process/settings/default', (_req, res) => {
  return res.json({ settings: getSavedDefaultSettings() });
});

// "Set default": snapshot the currently active settings as the new baseline for "Reset to default".
router.post('/decision-process/settings/set-default', (_req, res) => {
  try {
    const settings = saveCurrentSettingsAsDefault();
    logAgentEvent('agent2', 'Saved current settings as default', JSON.stringify(settings));
    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ error: `Failed to save default settings: ${error.message}` });
  }
});

// "Reset to default": apply the saved default snapshot (or factory defaults if none was ever saved).
router.post('/decision-process/settings/reset-default', async (req, res) => {
  try {
    const settings = resetSettingsToDefault();
    const state = db.prepare('SELECT global_question, decision_context, current_phase FROM system_state WHERE id = 1').get();
    if (state?.global_question && state.current_phase === 'gathering') {
      const prompt = await generatePreferencePrompt(state.global_question, state.decision_context || '');
      db.prepare("UPDATE rooms SET system_prompt = ? WHERE room_type = 'personal' AND is_active = 1").run(prompt);
      logAgentEvent('agent2', 'Reset decision settings to default and updated personal prompts', JSON.stringify(settings));
    } else {
      logAgentEvent('agent2', 'Reset decision settings to default', JSON.stringify(settings));
    }
    emitDecisionStatus(req.app.get('io'));
    return res.json({ settings });
  } catch (error) {
    return res.status(500).json({ error: `Failed to reset decision settings: ${error.message}` });
  }
});

router.post('/decision-process/agents/:agentKey/chat', async (req, res) => {
  const { agentKey } = req.params;
  const { message } = req.body;
  if (!['agent1', 'agent2', 'agent3'].includes(agentKey)) return res.status(400).json({ error: 'Invalid agentKey' });
  if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });

  const status = getDecisionStatus();
  const agent = status.agents.find((item) => item.key === agentKey);
  const lower = message.toLowerCase();
  if (agentKey === 'agent3' && isClosePersonalChatsCommand(message)) {
    const result = await forceCloseOpenPersonalChats(`Admin to Agent 3: ${message.trim()}`);
    emitDecisionStatus(req.app.get('io'));
    return res.json({
      reply: result.ok ? `${result.message} I checked whether the group phase can start.` : result.message,
      instructions: agent?.instructions || ''
    });
  }

  const shouldSaveInstruction = lower.includes('instruction') || lower.includes('prompt') || lower.includes('ask users') || lower.includes('change');
  let savedInstructions = agent?.instructions || '';
  if (shouldSaveInstruction) {
    savedInstructions = saveAgentInstruction(agentKey, message.trim());
    if (agentKey === 'agent1') {
      const activeRooms = db.prepare('SELECT id, system_prompt FROM rooms WHERE is_active = 1').all();
      const patch = `\n\n## Admin Live Guidance\n- ${message.trim()}`;
      const update = db.prepare('UPDATE rooms SET system_prompt = ? WHERE id = ?');
      for (const room of activeRooms) update.run(`${room.system_prompt || ''}${patch}`, room.id);
    }
    emitDecisionStatus(req.app.get('io'));
  } else {
    logAgentEvent(agentKey, 'Admin asked for status', message.trim());
  }

  if (!llm) {
    return res.json({
      reply: `${agent?.name || agentKey}: ${agent?.doing || 'I am monitoring the process.'} ${agent?.why || ''}`.trim(),
      instructions: savedInstructions
    });
  }

  const response = await llm.chat.completions.create({
    model: env.openaiModel,
    temperature: 0.2,
    max_completion_tokens: 300,
    messages: [
      {
        role: 'system',
        content: renderTemplate('admin-templates.md#Admin Agent Chat System', {
          agent_name: agent?.name,
          agent_role: agent?.role,
          agent_prompt: getAgentPrompt(agentKey)
        })
      },
      {
        role: 'user',
        content: renderTemplate('admin-templates.md#Admin Agent Chat User', {
          status: JSON.stringify(status, null, 2),
          decision_log: JSON.stringify(readLog() || {}, null, 2),
          message
        })
      }
    ],
    metadata: { caller: `admin-${agentKey}` }
  });

  return res.json({
    reply: response.choices?.[0]?.message?.content?.trim() || 'I updated the process notes.',
    instructions: savedInstructions
  });
});

router.post('/decision-process/agent-chat', async (req, res) => {
  const { message } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });

  const mentions = [...message.matchAll(/@(agent[123])\b/gi)].map((match) => match[1].toLowerCase());
  const targetKeys = mentions.length ? [...new Set(mentions)] : ['agent1', 'agent2', 'agent3'];
  const status = getDecisionStatus();
  const cleanMessage = message.replace(/@(agent[123])\b/gi, '').trim() || message.trim();
  const replies = [];
  const pollRequested = /\b(vote|poll|voting|ballot)\b/i.test(cleanMessage);
  const closePersonalRequested = isClosePersonalChatsCommand(cleanMessage);
  const closeGroupRequested = /\b(close|finish|end|stop|terminate)\b[\s\S]*\b(group|room|discussion)\b/i.test(cleanMessage) && !closePersonalRequested;

  const sendMsgMatch = cleanMessage.match(/(?:send|post|say|write)\s+(?:this\s+)?(?:message|msg|text)?\s*(?:in|to)?\s+([^:]+):(?:\s*["']([^"']+)["']|\s*(.+))/i);
  if (sendMsgMatch) {
    const roomMention = sendMsgMatch[1].trim();
    const messageText = (sendMsgMatch[2] || sendMsgMatch[3] || '').trim();
    const targetRoom = resolveRoomMention(roomMention);
    
    if (!targetRoom) {
      return res.json({
        replies: [
          {
            agentKey: 'agent3',
            agentName: 'Agent 3',
            reply: `I couldn't find the room "${roomMention}" to send the message. Please verify the room name.`
          }
        ]
      });
    }
    
    const timestamp = nowIso();
    const result = db
      .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)')
      .run(targetRoom.id, messageText, timestamp);

    const payload = {
      id: Number(result.lastInsertRowid),
      room_id: targetRoom.id,
      sender_id: null,
      sender_name: 'Bot',
      text: messageText,
      timestamp,
      is_bot: true
    };

    const io = req.app.get('io');
    if (io) {
      io.to(`room:${targetRoom.id}`).emit('receive_message', payload);
    }
    
    logAgentEvent('admin', `Admin sent message to room ${targetRoom.id} via Agent Console command`, messageText);
    
    return res.json({
      replies: [
        {
          agentKey: 'agent3',
          agentName: 'Agent 3',
          reply: `I have posted that message in "${targetRoom.name}" as the bot.`
        }
      ]
    });
  }

  if (targetKeys.includes('agent3') && closePersonalRequested) {
    const result = await forceCloseOpenPersonalChats(`Admin request: ${cleanMessage}`);
    emitDecisionStatus(req.app.get('io'));
    return res.json({
      replies: [
        {
          agentKey: 'agent3',
          agentName: 'Agent 3',
          reply: result.ok ? `${result.message} I checked whether the group discussion should open now.` : result.message
        }
      ]
    });
  }

  if (targetKeys.includes('agent3') && closeGroupRequested) {
    let extractedName = cleanMessage.replace(/\b(close|finish|end|stop|terminate)\b/i, '').trim();
    extractedName = extractedName.replace(/^(the\s+)?room\s+(called:?\s*)?/i, '').trim();
    extractedName = extractedName.replace(/\broom\b$/i, '').trim();

    const targetRoom = resolveRoomMention(extractedName) || resolveDiscussionRoomMention(cleanMessage);
    const activeRooms = db.prepare("SELECT id, name, room_type FROM rooms WHERE is_active = 1 AND room_type IN ('group', 'convergence', 'personal')").all();
    
    let selectedRoom = targetRoom;
    if (!selectedRoom) {
      const activeGroups = activeRooms.filter(r => r.room_type === 'group' || r.room_type === 'convergence');
      if (activeGroups.length === 1) {
        selectedRoom = activeGroups[0];
      }
    }
    
    if (!selectedRoom) {
      return res.json({
        replies: [
          {
            agentKey: 'agent3',
            agentName: 'Agent 3',
            reply: 'I need to know which room to close. Please specify the room name (e.g., close Discussion Group 2 or close tom-personal).'
          }
        ]
      });
    }

    const roomType = selectedRoom.room_type || db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(selectedRoom.id)?.room_type;
    
    if (roomType === 'personal') {
      db.prepare('UPDATE rooms SET is_active = 0 WHERE id = ?').run(selectedRoom.id);
      return res.json({
        replies: [{ agentKey: 'agent3', agentName: 'Agent 3', reply: `Personal room "${selectedRoom.name}" has been closed.` }]
      });
    }

    const agreedOptions = getAccumulatedDecisions(selectedRoom.id);
    const decisionText = agreedOptions.join(', ') || 'unspecified decision';
    
    completeDecision(selectedRoom.id, decisionText, `Admin requested close: ${cleanMessage}`);
    emitDecisionStatus(req.app.get('io'));
    
    return res.json({
      replies: [
        {
          agentKey: 'agent3',
          agentName: 'Agent 3',
          reply: `Discussion room "${selectedRoom.name}" has been successfully closed. Finalized decision: ${decisionText}.`
        }
      ]
    });
  }

  if (targetKeys.includes('agent3') && pollRequested) {
    const targetRoom = resolveDiscussionRoomMention(cleanMessage);
    const activeRoomCount = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE room_type = 'group' AND is_active = 1").get()?.c || 0;
    if (!targetRoom && activeRoomCount > 1) {
      return res.json({
        replies: [
          {
            agentKey: 'agent3',
            agentName: 'Agent 3',
            reply: 'I need the target discussion room before I open a poll. Please mention the room name, for example: @agent3 create a poll in Discussion Group 2.'
          }
        ]
      });
    }
    const pollResult = await forceCreatePollFromDiscussion(`Admin request: ${cleanMessage}`, targetRoom?.id || null);
    if (pollResult.ok) {
      emitDecisionStatus(req.app.get('io'));
      return res.json({
        replies: [
          {
            agentKey: 'agent3',
            agentName: 'Agent 3',
            reply: `Poll created in ${pollResult.roomName || `room ${pollResult.roomId}`} with options: ${pollResult.options.join(', ')}.`
          }
        ]
      });
    }
    return res.json({
      replies: [
        {
          agentKey: 'agent3',
          agentName: 'Agent 3',
          reply: pollResult.message || 'I could not create a poll for that room.'
        }
      ]
    });
  }

  for (const agentKey of targetKeys) {
    const agent = status.agents.find((item) => item.key === agentKey);
    const lower = cleanMessage.toLowerCase();
    const shouldSaveInstruction =
      lower.includes('instruction') ||
      lower.includes('prompt') ||
      lower.includes('ask users') ||
      lower.includes('change') ||
      lower.includes('tell users') ||
      lower.includes('behave');
    let savedInstructions = agent?.instructions || '';
    if (shouldSaveInstruction) {
      savedInstructions = saveAgentInstruction(agentKey, cleanMessage);
      if (agentKey === 'agent1') {
        const activeRooms = db.prepare('SELECT id, system_prompt FROM rooms WHERE is_active = 1').all();
        const patch = `\n\n## Admin Live Guidance\n- ${cleanMessage}`;
        const update = db.prepare('UPDATE rooms SET system_prompt = ? WHERE id = ?');
        for (const room of activeRooms) update.run(`${room.system_prompt || ''}${patch}`, room.id);
      }
    } else {
      logAgentEvent(agentKey, 'Admin asked for status', cleanMessage);
    }

    let reply;
    if (!llm) {
      reply = `${agent?.doing || 'Monitoring the process.'} ${agent?.why || ''}`.trim();
    } else {
      const response = await llm.chat.completions.create({
        model: env.openaiModel,
        temperature: 0.2,
        max_completion_tokens: 1000,
        messages: [
          {
            role: 'system',
            content: renderTemplate('admin-templates.md#Admin Agent Chat System', {
              agent_name: agent?.name,
              agent_role: agent?.role,
              agent_prompt: getAgentPrompt(agentKey)
            })
          },
          {
            role: 'user',
            content: renderTemplate('admin-templates.md#Admin Agent Chat User', {
              status: JSON.stringify(status, null, 2),
              message: cleanMessage
            })
          }
        ],
        metadata: { caller: `admin-${agentKey}` }
      });
      reply = response.choices?.[0]?.message?.content?.trim() || 'I updated the process notes.';
    }
    replies.push({ agentKey, agentName: agent?.name || agentKey, reply, instructions: savedInstructions });
  }

  emitDecisionStatus(req.app.get('io'));

  if (!mentions.length && replies.length > 1) {
    if (!llm) {
      return res.json({
        replies: [
          {
            agentKey: 'all',
            agentName: 'Agents',
            reply: replies.map((reply) => `${reply.agentName}: ${reply.reply}`).join(' ')
          }
        ]
      });
    }
    const summary = await llm.chat.completions.create({
      model: env.openaiModel,
      temperature: 0.2,
      max_completion_tokens: 260,
      messages: [
        {
          role: 'system',
          content: renderTemplate('admin-templates.md#Admin Agent Summary System')
        },
        { role: 'user', content: replies.map((reply) => `${reply.agentName}: ${reply.reply}`).join('\n\n') }
      ],
      metadata: { caller: 'admin-summary' }
    });
    return res.json({
      replies: [
        {
          agentKey: 'all',
          agentName: 'Agents',
          reply: summary.choices?.[0]?.message?.content?.trim() || replies[0].reply
        }
      ]
    });
  }

  return res.json({ replies });
});

router.get('/prompts', (_req, res) => res.json({ prompts: listPromptFiles() }));

router.post('/prompts', (req, res) => {
  try {
    const filename = createPromptFile(req.body);
    return res.status(201).json({ ok: true, filename });
  } catch (error) {
    const message = String(error.message || 'Failed');
    return res.status(message.includes('exists') ? 409 : 400).json({ error: message });
  }
});

router.get('/users', (_req, res) => {
  const users = db
    .prepare('SELECT id, username, is_admin, profile_info, extracted_preferences FROM users ORDER BY username ASC')
    .all()
    .map((u) => ({ ...u, is_admin: u.is_admin === 1 }));
  return res.json({ users });
});

router.post('/users', (req, res) => {
  const { username, password, is_admin } = req.body;
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'username must be at least 3 chars' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'password must be at least 6 chars' });
  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)').run(username.trim(), hash, is_admin ? 1 : 0);
    ensurePersonalRoomsForAllUsers();
    if (is_admin) ensureAdminsInAllRooms();
    return res.status(201).json({ user: { id: Number(result.lastInsertRowid), username: username.trim(), is_admin: !!is_admin } });
  } catch {
    return res.status(409).json({ error: 'username already exists' });
  }
});

router.delete('/users/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId)) return res.status(400).json({ error: 'Invalid userId' });
  if (userId === req.user.id) return res.status(400).json({ error: 'Cannot delete your own admin user' });
  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existing) return res.status(404).json({ error: 'User not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  req.app.get('io')?.in(`user:${userId}`).disconnectSockets(true);
  return res.json({ ok: true });
});

router.get('/rooms', (_req, res) => {
  const rooms = db
    .prepare(
      `
      SELECT r.id, r.name, r.prompt_file, r.room_type, r.is_active, r.collection_complete,
             COUNT(DISTINCT CASE WHEN u.is_admin = 0 THEN rm.user_id END) AS participant_count,
             COUNT(DISTINCT m.id) AS messages_count
      FROM rooms r
      LEFT JOIN room_members rm ON rm.room_id = r.id
      LEFT JOIN users u ON u.id = rm.user_id
      LEFT JOIN messages m ON m.room_id = r.id
      GROUP BY r.id
      ORDER BY r.name ASC
    `
    )
    .all()
    .map((r) => ({ ...r, is_active: r.is_active === 1 }));

  const members = db
    .prepare(
      `
      SELECT rm.room_id, u.id AS user_id, u.username, u.is_admin
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      ORDER BY u.is_admin ASC, u.username ASC
    `
    )
    .all();

  const byRoom = new Map();
  for (const row of members) {
    if (!byRoom.has(row.room_id)) byRoom.set(row.room_id, []);
    byRoom.get(row.room_id).push({ id: row.user_id, username: row.username, is_admin: row.is_admin === 1 });
  }

  return res.json({
    rooms: rooms.map((room) => ({
      ...room,
      members: byRoom.get(room.id) || [],
      polls: getPollsForRoom(room.id, true)
    }))
  });
});

router.post('/rooms', (req, res) => {
  const { name, prompt_file = 'default.md', userIds = [], room_type = 'group' } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Room name is required' });
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(prompt_file)) return res.status(400).json({ error: 'Invalid prompt_file' });
  if (!['group', 'personal'].includes(room_type)) return res.status(400).json({ error: 'Invalid room_type' });

  try {
    const roomResult = db
      .prepare('INSERT INTO rooms (name, prompt_file, room_type, is_active, system_prompt) VALUES (?, ?, ?, 1, ?)')
      .run(name.trim(), prompt_file, room_type, loadPromptMarkdown(prompt_file));
    const roomId = Number(roomResult.lastInsertRowid);
    const insertMember = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');
    for (const userId of userIds) insertMember.run(Number(userId), roomId);
    ensureAdminsInRoom(roomId);
    return res.status(201).json({ room: { id: roomId, name: name.trim(), prompt_file } });
  } catch {
    return res.status(409).json({ error: 'Room name already exists' });
  }
});

router.patch('/rooms/:roomId', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  const { prompt_file } = req.body;
  if (!prompt_file || !/^[a-zA-Z0-9._-]+\.md$/.test(prompt_file)) {
    return res.status(400).json({ error: 'Invalid prompt_file' });
  }
  db.prepare('UPDATE rooms SET prompt_file = ?, system_prompt = ? WHERE id = ?').run(prompt_file, loadPromptMarkdown(prompt_file), roomId);
  return res.json({ ok: true });
});

router.put('/rooms/:roomId/members', (req, res) => {
  const roomId = Number(req.params.roomId);
  const { userIds } = req.body;
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!Array.isArray(userIds) || userIds.some((id) => !Number.isInteger(id))) return res.status(400).json({ error: 'userIds must be integers' });

  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const beforeMembers = db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId).map((r) => r.user_id);
  db.transaction(() => {
    db.prepare('DELETE FROM room_members WHERE room_id = ?').run(roomId);
    const insert = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');
    for (const userId of userIds) insert.run(userId, roomId);
    ensureAdminsInRoom(roomId);
  })();

  const io = req.app.get('io');
  const adminIds = db.prepare('SELECT id FROM users WHERE is_admin = 1').all().map((admin) => admin.id);
  const effectiveMembers = new Set([...userIds, ...adminIds]);
  for (const removedId of beforeMembers.filter((id) => !effectiveMembers.has(id))) {
    if (io) {
      io.to(`user:${removedId}`).emit('membership_revoked', { roomId });
      io.in(`user:${removedId}`).socketsLeave(`room:${roomId}`);
    }
  }
  return res.json({ ok: true });
});

// Bulk cleanup for generated discussion rooms. This deliberately targets only
// room_type='group'; personal rooms and convergence rooms are never touched.
router.delete('/rooms/discussion-groups', (req, res) => {
  const groupRooms = db.prepare("SELECT id FROM rooms WHERE room_type = 'group'").all();
  if (groupRooms.length === 0) return res.json({ ok: true, deleted: 0 });

  const roomIds = groupRooms.map((room) => room.id);
  const members = db
    .prepare(`SELECT DISTINCT user_id, room_id FROM room_members WHERE room_id IN (${roomIds.map(() => '?').join(',')})`)
    .all(...roomIds);

  db.transaction(() => {
    // Room foreign keys are cascading, but explicitly removing memberships
    // keeps this operation safe on older databases created before migrations.
    db.prepare(`DELETE FROM room_members WHERE room_id IN (${roomIds.map(() => '?').join(',')})`).run(...roomIds);
    db.prepare(`DELETE FROM rooms WHERE id IN (${roomIds.map(() => '?').join(',')})`).run(...roomIds);
  })();

  const io = req.app.get('io');
  if (io) {
    for (const member of members) {
      io.to(`user:${member.user_id}`).emit('membership_revoked', { roomId: member.room_id });
      io.in(`user:${member.user_id}`).socketsLeave(`room:${member.room_id}`);
    }
    io.emit('rooms_updated');
  }

  return res.json({ ok: true, deleted: roomIds.length });
});

// Repair the invariant that every non-admin user belongs to the personal room
// named after that user. This does not clear room history or change room state.
router.post('/rooms/restore-personal-memberships', (req, res) => {
  try {
    const missingBefore = db.prepare(`
      SELECT COUNT(*) AS count
      FROM users u
      LEFT JOIN rooms r ON r.name = u.username || '-personal' AND r.room_type = 'personal'
      LEFT JOIN room_members rm ON rm.user_id = u.id AND rm.room_id = r.id
      WHERE u.is_admin = 0 AND rm.user_id IS NULL
    `).get()?.count || 0;

    ensurePersonalRoomsForAllUsers();

    const missingAfter = db.prepare(`
      SELECT COUNT(*) AS count
      FROM users u
      LEFT JOIN rooms r ON r.name = u.username || '-personal' AND r.room_type = 'personal'
      LEFT JOIN room_members rm ON rm.user_id = u.id AND rm.room_id = r.id
      WHERE u.is_admin = 0 AND rm.user_id IS NULL
    `).get()?.count || 0;

    const io = req.app.get('io');
    if (io) {
      io.emit('rooms_updated');
      io.emit('users_updated');
    }

    return res.json({
      ok: true,
      restored: Math.max(0, Number(missingBefore) - Number(missingAfter)),
      remaining: Number(missingAfter)
    });
  } catch (error) {
    return res.status(500).json({ error: `Failed to restore personal room memberships: ${error.message}` });
  }
});

router.delete('/rooms/:roomId', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  db.prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
  return res.json({ ok: true });
});

router.delete('/rooms/:roomId/messages', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  db.prepare('DELETE FROM messages WHERE room_id = ?').run(roomId);
  return res.json({ ok: true });
});

router.post('/rooms/:roomId/polls', (req, res) => {
  const roomId = Number(req.params.roomId);
  const { question, options, mandatory, timer_minutes } = req.body;
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!question || typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'question is required' });
  if (!Array.isArray(options) || options.length < 2) return res.status(400).json({ error: 'At least 2 options are required' });
  const finalOptions = normalizePollOptions(options);
  if (finalOptions.length < 3) return res.status(400).json({ error: 'At least 2 non-empty options are required' });

  const timer = timer_minutes === null || timer_minutes === undefined || timer_minutes === '' ? null : Number(timer_minutes);
  if (timer !== null && (!Number.isFinite(timer) || timer <= 0)) return res.status(400).json({ error: 'timer_minutes must be positive' });
  const expiresAt = timer === null ? null : new Date(Date.now() + timer * 60 * 1000).toISOString();

  const pollId = db.transaction(() => {
    const pollRes = db
      .prepare('INSERT INTO polls (room_id, question, show_results, is_closed, mandatory, expires_at, created_at) VALUES (?, ?, 0, 0, ?, ?, ?)')
      .run(roomId, question.trim(), mandatory ? 1 : 0, expiresAt, nowIso());
    const id = Number(pollRes.lastInsertRowid);
    const insertOption = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)');
    for (const option of finalOptions) insertOption.run(id, option);
    return id;
  })();

  emit(req.app.get('io'), 'polls_updated', { roomId }, roomId);
  return res.status(201).json({ pollId });
});

router.patch('/polls/:pollId', async (req, res) => {
  const pollId = Number(req.params.pollId);
  if (!Number.isInteger(pollId)) return res.status(400).json({ error: 'Invalid pollId' });
  const poll = db.prepare('SELECT id, room_id FROM polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  const { show_results, is_closed, mandatory, timer_minutes } = req.body;
  const fields = [];
  const values = [];
  if (show_results !== undefined) { fields.push('show_results = ?'); values.push(show_results ? 1 : 0); }
  
  let shouldResolve = false;
  if (is_closed !== undefined) {
    if (is_closed) {
      shouldResolve = true;
    } else {
      fields.push('is_closed = ?');
      values.push(0);
      fields.push('closed_at = ?');
      values.push(null);
    }
  }
  
  if (mandatory !== undefined) { fields.push('mandatory = ?'); values.push(mandatory ? 1 : 0); }
  if (timer_minutes !== undefined) {
    if (timer_minutes === null || timer_minutes === '') {
      fields.push('expires_at = ?');
      values.push(null);
    } else {
      const timer = Number(timer_minutes);
      if (!Number.isFinite(timer) || timer <= 0) return res.status(400).json({ error: 'timer_minutes must be positive or null' });
      fields.push('expires_at = ?');
      values.push(new Date(Date.now() + timer * 60 * 1000).toISOString());
    }
  }
  if (!fields.length && !shouldResolve) return res.status(400).json({ error: 'Nothing to update' });
  if (fields.length) {
    values.push(pollId);
    db.prepare(`UPDATE polls SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  if (shouldResolve) {
    const { resolvePoll } = await import('../services/agent3Service.js');
    await resolvePoll(pollId, poll.room_id);
  }
  emit(req.app.get('io'), 'polls_updated', { roomId: poll.room_id }, poll.room_id);
  return res.json({ ok: true });
});

router.delete('/polls/:pollId', (req, res) => {
  const pollId = Number(req.params.pollId);
  if (!Number.isInteger(pollId)) return res.status(400).json({ error: 'Invalid pollId' });
  const poll = db.prepare('SELECT id, room_id FROM polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  db.prepare('DELETE FROM polls WHERE id = ?').run(pollId);
  emit(req.app.get('io'), 'polls_updated', { roomId: poll.room_id }, poll.room_id);
  return res.json({ ok: true });
});

router.post('/agent/chat', async (req, res) => {
  if (!llm) return res.status(400).json({ error: 'OPENAI API key not configured' });
  const { message, history = [] } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message is required' });

  const tools = [
    { type: 'function', function: { name: 'create_room', parameters: { type: 'object', properties: { name: { type: 'string' }, userIds: { type: 'array', items: { type: 'number' } }, prompt_file: { type: 'string' } }, required: ['name'] } } },
    { type: 'function', function: { name: 'move_users_to_room', parameters: { type: 'object', properties: { roomId: { type: 'number' }, userIds: { type: 'array', items: { type: 'number' } } }, required: ['roomId', 'userIds'] } } },
    { type: 'function', function: { name: 'create_poll', parameters: { type: 'object', properties: { roomId: { type: 'number' }, question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, mandatory: { type: 'boolean' }, timer_minutes: { type: 'number' } }, required: ['roomId', 'question', 'options'] } } },
    { type: 'function', function: { name: 'create_prompt_file', parameters: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] } } }
  ];

  const response = await llm.chat.completions.create({
    model: env.openaiModel,
    temperature: 0.2,
    tools,
    tool_choice: 'auto',
    messages: [{ role: 'system', content: renderTemplate('admin-templates.md#Admin Operations Agent System') }, ...history, { role: 'user', content: message }],
    metadata: { caller: 'admin-operations' }
  });

  const toolCalls = response.choices?.[0]?.message?.tool_calls || [];
  const outputs = [];
  for (const call of toolCalls) {
    const name = call.function.name;
    const args = JSON.parse(call.function.arguments || '{}');
    if (name === 'create_room') {
      const pf = String(args.prompt_file || 'default.md');
      const roomRes = db.prepare("INSERT INTO rooms (name, prompt_file, room_type, is_active, system_prompt) VALUES (?, ?, 'group', 1, ?)").run(String(args.name).trim(), pf, loadPromptMarkdown(pf));
      const roomId = Number(roomRes.lastInsertRowid);
      const insertMember = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');
      for (const userId of args.userIds || []) insertMember.run(Number(userId), roomId);
      ensureAdminsInRoom(roomId);
      outputs.push({ tool: name, ok: true, roomId });
    } else if (name === 'move_users_to_room') {
      db.prepare('DELETE FROM room_members WHERE room_id = ?').run(Number(args.roomId));
      const insertMember = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');
      for (const userId of args.userIds || []) insertMember.run(Number(userId), Number(args.roomId));
      ensureAdminsInRoom(Number(args.roomId));
      outputs.push({ tool: name, ok: true });
    } else if (name === 'create_poll') {
      const finalOptions = normalizePollOptions(args.options || []);
      const expiresAt = args.timer_minutes ? new Date(Date.now() + Number(args.timer_minutes) * 60 * 1000).toISOString() : null;
      const pollRes = db.prepare('INSERT INTO polls (room_id, question, show_results, is_closed, mandatory, expires_at, created_at) VALUES (?, ?, 0, 0, ?, ?, ?)').run(Number(args.roomId), String(args.question), args.mandatory ? 1 : 0, expiresAt, nowIso());
      const pollId = Number(pollRes.lastInsertRowid);
      const insertOption = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)');
      for (const option of finalOptions) insertOption.run(pollId, option);
      emit(req.app.get('io'), 'polls_updated', { roomId: Number(args.roomId) }, Number(args.roomId));
      outputs.push({ tool: name, ok: true, pollId });
    } else if (name === 'create_prompt_file') {
      const filename = createPromptFile(args);
      outputs.push({ tool: name, ok: true, filename });
    }
  }

  return res.json({ reply: response.choices?.[0]?.message?.content || 'Done.', tool_outputs: outputs });
});

router.get('/db/tables', (req, res) => {
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC")
      .all();
    res.json({ success: true, tables: tables.map((t) => t.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/db/tables/:tableName', (req, res) => {
  const { tableName } = req.params;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name);

    if (!tables.includes(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
    const totalRows = countRow ? countRow.count : 0;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 25);
    const offset = (page - 1) * limit;

    const sortBy = req.query.sortBy || '';
    const sortOrder = (req.query.sortOrder || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
    let orderByClause = '';
    if (sortBy && columns.some((c) => c.name === sortBy)) {
      orderByClause = `ORDER BY ${sortBy} ${sortOrder}`;
    }

    const rows = db.prepare(`SELECT * FROM ${tableName} ${orderByClause} LIMIT ? OFFSET ?`).all(limit, offset);

    res.json({
      success: true,
      columns,
      rows,
      pagination: {
        totalRows,
        page,
        limit,
        totalPages: Math.ceil(totalRows / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/db/tables/:tableName/clean', (req, res) => {
  const { tableName } = req.params;
  const { mode, days = 7 } = req.body;
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((t) => t.name);

    if (!tables.includes(tableName)) {
      return res.status(400).json({ error: 'Invalid table name' });
    }

    if (mode === 'all') {
      db.prepare(`DELETE FROM ${tableName}`).run();
      return res.json({ success: true, message: `Successfully deleted all rows from ${tableName}.` });
    }

    if (mode === 'older_than') {
      const parsedDays = parseInt(days);
      if (isNaN(parsedDays) || parsedDays < 0) {
        return res.status(400).json({ error: 'Invalid number of days' });
      }

      // Check what columns the table has
      const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map(c => c.name);
      
      let dateColumn = null;
      if (columns.includes('timestamp')) {
        dateColumn = 'timestamp';
      } else if (columns.includes('created_at')) {
        dateColumn = 'created_at';
      } else if (columns.includes('updated_at')) {
        dateColumn = 'updated_at';
      }

      if (!dateColumn) {
        return res.status(400).json({ error: `Table "${tableName}" does not have a timestamp, created_at, or updated_at column to filter by age.` });
      }

      const cutoffDate = new Date(Date.now() - parsedDays * 24 * 60 * 60 * 1000).toISOString();
      const info = db.prepare(`DELETE FROM ${tableName} WHERE ${dateColumn} < ?`).run(cutoffDate);

      return res.json({ success: true, message: `Successfully deleted ${info.changes} rows older than ${parsedDays} days from ${tableName}.` });
    }

    return res.status(400).json({ error: 'Invalid clean mode. Must be "all" or "older_than".' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/rooms/:roomId/messages/send-bot', (req, res) => {
  const roomId = Number(req.params.roomId);
  const { text } = req.body;
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }

  const room = db.prepare('SELECT id FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });

  const timestamp = nowIso();
  const result = db
    .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)')
    .run(roomId, text.trim(), timestamp);

  const payload = {
    id: Number(result.lastInsertRowid),
    room_id: roomId,
    sender_id: null,
    sender_name: 'Bot',
    text: text.trim(),
    timestamp,
    is_bot: true
  };

  const io = req.app.get('io');
  if (io) {
    io.to(`room:${roomId}`).emit('receive_message', payload);
  }

  logAgentEvent('admin', `Admin sent message to room ${roomId}`, text.trim());

  return res.json({ success: true, message: payload });
});

router.post('/decision-process/generate-questions', async (req, res) => {
  const { globalQuestion, generalDescription, count } = req.body;
  if (!globalQuestion || !globalQuestion.trim()) {
    return res.status(400).json({ error: 'globalQuestion is required' });
  }
  const qCount = Math.min(10, Math.max(1, Number(count) || 5));
  
  if (!client) {
    return res.status(500).json({ error: 'LLM client is not configured' });
  }

  try {
    const prompt = `You are an expert facilitator. Given a global decision question: "${globalQuestion}"
and a general description of the decision problem: "${generalDescription || ''}",
generate exactly ${qCount} sub-topic deliberation questions that will help users explore aspects of the decision. Each question must focus on a specific sub-topic and contain up to 6 predefined answers.

Format the output strictly as a JSON array where each object has:
- "topic": a brief camelCase or short slug/identifier (max 20 chars, e.g. "funding", "roadSafety")
- "question_text": the full question to ask the user
- "predefined_answers": an array of 2 to 6 options

Do not include any markdown formatting wrappers (like \`\`\`json), comments, or introductory text. Return ONLY the raw valid JSON array.`;

    const response = await client.chat.completions.create({
      model: env.cheapModel,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      metadata: { caller: 'admin_generate_questions' }
    });

    const contentText = response.choices?.[0]?.message?.content || '';
    let cleaned = contentText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Response is not a JSON array');

    const formatted = parsed.map((item, index) => {
      const answers = Array.isArray(item.predefined_answers) ? item.predefined_answers : [];
      const paddedAnswers = [...answers.slice(0, 6)];
      while (paddedAnswers.length < 6) paddedAnswers.push('');
      return {
        topic: String(item.topic || `topic-${index + 1}`).trim(),
        question_text: String(item.question_text || '').trim(),
        predefined_answers: paddedAnswers,
        question_order: index + 1
      };
    });

    return res.json({ questions: formatted });
  } catch (err) {
    console.error('Failed to generate deliberation questions:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/decision-process/generate-description', async (req, res) => {
  const { globalQuestion } = req.body;
  if (!globalQuestion || !globalQuestion.trim()) {
    return res.status(400).json({ error: 'globalQuestion is required' });
  }

  if (!client) {
    return res.status(500).json({ error: 'LLM client is not configured' });
  }

  try {
    const prompt = `You are an expert copywriter. Given a global decision question: "${globalQuestion}",
write a detailed, welcoming, and clear general description of the decision problem to be shown to participants. This description should introduce the context of the decision, invite them to share their perspectives, and outline what the process hopes to achieve.

Write a clear, structured paragraph (around 80-150 words) suitable for human participants. Return ONLY the description text without any headers, conversational intro, or markdown code blocks.`;

    const response = await client.chat.completions.create({
      model: env.cheapModel,
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      metadata: { caller: 'admin_generate_description' }
    });

    const descriptionText = (response.choices?.[0]?.message?.content || '').trim();
    return res.json({ description: descriptionText });
  } catch (err) {
    console.error('Failed to generate user description:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/simulation/generate-persona', async (req, res) => {
  const {
    username,
    userProfile = {},
    globalQuestion = '',
    decisionContext = '',
    generalDescription = '',
    deliberationQuestions = [],
    perspective = '',
    autofillMode = 'mixed_perspectives',
    assignmentIndex = 0,
    populationSize = 1
  } = req.body || {};
  const savedState = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get() || {};
  const savedQuestions = db.prepare('SELECT topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY question_order ASC, id ASC').all().map((question) => {
    let predefinedAnswers = [];
    try { predefinedAnswers = JSON.parse(question.predefined_answers_json || '[]'); } catch { predefinedAnswers = []; }
    return { ...question, predefined_answers: Array.isArray(predefinedAnswers) ? predefinedAnswers : [] };
  });
  const cleanUsername = String(username || '').trim();
  const resolvedGlobalQuestion = String(globalQuestion || savedState.global_question || '').trim();
  const resolvedDecisionContext = String(decisionContext || savedState.decision_context || '').trim();
  const resolvedGeneralDescription = String(generalDescription || savedState.general_description || '').trim();
  if (!cleanUsername) return res.status(400).json({ error: 'username is required' });
  if (!client) return res.status(500).json({ error: 'LLM client is not configured' });

  const suppliedQuestions = Array.isArray(deliberationQuestions) && deliberationQuestions.length > 0
    ? deliberationQuestions
    : savedQuestions;
  const topics = suppliedQuestions
    .filter((question) => !question?.is_general_question)
    .map((question) => ({
      topic: String(question?.topic || '').trim(),
      question: String(question?.question_text || question?.question || '').trim(),
      options: Array.isArray(question?.predefined_answers)
        ? question.predefined_answers.map((option) => String(option || '').trim()).filter(Boolean).slice(0, 8)
        : []
    }))
    .filter((question) => question.topic || question.question)
    .slice(0, 20);

  const profileText = [
    userProfile?.profile_info ? `Stored profile information: ${String(userProfile.profile_info).slice(0, 1200)}` : '',
    userProfile?.extracted_preferences ? `Stored preferences: ${String(userProfile.extracted_preferences).slice(0, 1200)}` : ''
  ].filter(Boolean).join('\n');
  const topicText = topics.length
    ? topics.map((item, index) => `${index + 1}. Topic: ${item.topic}\n   Question: ${item.question || '(not provided)'}\n   Options: ${item.options.join(' | ') || '(none)'}`).join('\n')
    : '(No deliberation topics were configured.)';
  const normalizedMode = normalizePersonaAutofillMode(autofillMode);
  const plan = getPersonaAutofillPlan({
    mode: normalizedMode,
    assignmentIndex,
    populationSize,
    topicCount: topics.length
  });
  // Keep the legacy perspective field useful for individual autofill callers while
  // using the population plan as the source of truth for bulk autofill.
  const requestedPerspective = String(perspective || '').trim().toLowerCase();
  const populationInstructions = buildPersonaAutofillPopulationInstructions({
    ...plan,
    lens: requestedPerspective || plan.lens
  });

  try {
    const { primaryModel } = getConfiguredModels();
    const response = await client.chat.completions.create({
      model: primaryModel || DEFAULT_PRIMARY_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'You create a transparent simulation persona for a civic deliberation study.',
            'Use only the decision context and topics supplied by the administrator.',
            'Do not invent personal facts that are not needed. Make the profile plausible, balanced, and useful for producing varied but relevant discussion.',
            populationInstructions,
            'Use the assigned lens as a coherent starting point, include nuance, acknowledge reasonable counterarguments, and distinguish the topics from one another.',
            'Return JSON only with this exact shape: {"backstory":"...","stances":{"TOPIC":{"position":"...","intensity":0.0}}}.',
            'Include one stance entry for every supplied topic, using the exact topic string as the key.',
            'Intensity must be a number from 0 to 1. Keep backstory under 500 words and each position under 80 words.'
          ].join('\n')
        },
        {
          role: 'user',
          content: [
            `Participant username: ${cleanUsername}`,
            profileText,
            `Global question: ${resolvedGlobalQuestion.slice(0, 1500)}`,
            `Additional context: ${resolvedDecisionContext.slice(0, 2500)}`,
            `General description: ${resolvedGeneralDescription.slice(0, 2500)}`,
            `Deliberation topics:\n${topicText}`
          ].filter(Boolean).join('\n\n')
        }
      ],
      metadata: { caller: 'simulation_persona_autofill' }
    });

    let parsed = {};
    try {
      parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    } catch {
      const match = String(response.choices?.[0]?.message?.content || '').match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch { parsed = {}; }
      }
    }

    const backstory = String(parsed.backstory || '').trim().slice(0, 2400);
    const rawStances = parsed.stances && typeof parsed.stances === 'object' ? parsed.stances : {};
    const stances = {};
    for (const item of topics) {
      const source = rawStances[item.topic] || {};
      stances[item.topic] = {
        position: String(source.position || '').trim().slice(0, 500),
        intensity: Math.max(0, Math.min(1, Number.isFinite(Number(source.intensity)) ? Number(source.intensity) : 0.5))
      };
    }
    return res.json({
      backstory,
      stances,
      perspective: requestedPerspective || plan.lens,
      autofillMode: normalizedMode,
      assignmentIndex: plan.assignmentIndex,
      populationSize: plan.populationSize,
      model: primaryModel || DEFAULT_PRIMARY_MODEL
    });
  } catch (err) {
    console.error('Failed to generate simulation persona:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/llm-models', (req, res) => {
  try {
    const dbRows = db.prepare('SELECT call_key, model_name FROM llm_call_models').all();
    const modelMap = {};
    for (const r of dbRows) {
      modelMap[r.call_key] = r.model_name;
    }
    
    const CALLER_KEYS = [
      'admin_suggest_reopen',
      'admin_generate_report',
      'admin_reconcile_members',
      'admin_generate_questions',
      'admin_generate_description',
      'decision_suggest',
      'agent1_reply',
      'preference_prompt',
      'personal_room_prompt',
      'convergence_room_prompt',
      'room_report',
      'agent3-evaluateReadyToVote',
      'draft_poll',
      'infer_poll',
      'recap_report',
      'room_completion',
      'suggest_reopen_topic',
      'classify_custom_option',
      'proactiveness',
      'simulation_persona_autofill',
      'room_status',
      'simulation'
    ];

    const defaults = {
      admin_suggest_reopen: env.openaiModel,
      admin_generate_report: env.openaiModel,
      admin_reconcile_members: env.openaiModel,
      admin_generate_questions: env.cheapModel,
      admin_generate_description: env.cheapModel,
      decision_suggest: env.openaiModel,
      agent1_reply: env.openaiModel,
      preference_prompt: env.openaiModel,
      personal_room_prompt: env.openaiModel,
      convergence_room_prompt: env.openaiModel,
      room_report: env.openaiModel,
      'agent3-evaluateReadyToVote': env.cheapModel,
      draft_poll: env.openaiModel,
      infer_poll: env.openaiModel,
      recap_report: env.openaiModel,
      room_completion: env.openaiModel,
      suggest_reopen_topic: env.openaiModel,
      classify_custom_option: env.openaiModel,
      proactiveness: env.openaiModel,
      simulation_persona_autofill: env.openaiModel,
      room_status: env.openaiModel,
      simulation: env.cheapModel
    };

    const results = CALLER_KEYS.map(key => {
      let currentVal = modelMap[key];
      let defVal = defaults[key] || env.cheapModel;
      const allowed = SUPPORTED_CHAT_MODELS;
      if (currentVal && !allowed.includes(currentVal)) {
        currentVal = undefined;
      }
      return {
        call_key: key,
        model_name: currentVal || defVal
      };
    });

    return res.json({ models: results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/llm-models', (req, res) => {
  const { call_key, model_name } = req.body;
  if (!call_key || !model_name) {
    return res.status(400).json({ error: 'call_key and model_name are required' });
  }
  const allowed = SUPPORTED_CHAT_MODELS;
  if (!allowed.includes(model_name)) {
    return res.status(400).json({ error: `Invalid model. Choose one of: ${allowed.join(', ')}` });
  }
  try {
    db.prepare(`
      INSERT INTO llm_call_models (call_key, model_name)
      VALUES (?, ?)
      ON CONFLICT(call_key) DO UPDATE SET model_name = excluded.model_name
    `).run(call_key, model_name);
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/decision-process/message-count', (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM messages').get();
    return res.json({ count: row?.c || 0 });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Helper to normalize and group topics dynamically based on active gathering questions
function getNormalizedTopic(suggestion, question, activeTopics) {
  if (!suggestion && !question) return 'general-question';

  const sug = String(suggestion || '').toLowerCase().trim();
  const q = String(question || '').toLowerCase().trim();

  if (sug === 'general-question' || q === 'general-question') {
    return 'general-question';
  }

  // Match openness questions
  if (q.includes('changing your mind') || q.includes('open to debate') || q.includes('openness')) {
    return 'general-question';
  }

  // Match topic preference questions
  if (q.includes('topics are most relevant') || q.includes('which of the following topics') || q.includes('topic preference')) {
    return 'general-question';
  }

  // Match global question
  const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
  if (state?.global_question) {
    const gq = String(state.global_question).toLowerCase().trim();
    if (q === gq || q.includes(gq)) {
      return 'general-question';
    }
  }

  const genRow = db.prepare("SELECT topic, question_text FROM gathering_questions WHERE is_general_question = 1 LIMIT 1").get();
  if (genRow) {
    const genTopic = String(genRow.topic || '').toLowerCase().trim();
    const genText = String(genRow.question_text || '').toLowerCase().trim();
    if (sug === genTopic || q === genText) {
      return 'general-question';
    }
  }

  // 1. Direct case-insensitive match with active topics
  for (const t of activeTopics) {
    if (sug === t.topic.toLowerCase() || q === t.topic.toLowerCase()) {
      return t.topic;
    }
  }

  // 2. Word overlap matching (excluding common stopwords)
  const stopWords = new Set([
    'whether', 'should', 'come', 'from', 'the', 'and', 'for', 'to', 'a', 'in', 'of',
    'on', 'with', 'at', 'by', 'an', 'be', 'is', 'are', 'was', 'were', 'or', 'about',
    'how', 'which', 'what', 'who', 'whom', 'this', 'that', 'these', 'those'
  ]);
  
  const getWords = (text) => {
    return text.toLowerCase()
      .replace(/[^\w\s-]/g, ' ') // keep dashes for hyphenated words
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  };

  const targetWords = getWords(sug + ' ' + q);
  if (targetWords.length === 0) {
    return 'general-question';
  }

  let bestTopic = 'general-question';
  let maxOverlap = 0;

  for (const t of activeTopics) {
    const topicWords = new Set([...getWords(t.topic || ''), ...getWords(t.question_text || '')]);
    let overlap = 0;
    for (const w of targetWords) {
      if (topicWords.has(w)) overlap++;
    }
    if (overlap > maxOverlap) {
      maxOverlap = overlap;
      bestTopic = t.topic;
    }
  }

  if (maxOverlap === 0) {
    return 'general-question';
  }

  return bestTopic;
}

function normalizeComparableText(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getPollOptionTexts(pollId, optionsByPoll) {
  return (optionsByPoll[pollId] || [])
    .map(opt => opt.option_text)
    .filter(Boolean);
}

function buildVoteSnapshot(poll, userVotes, optionsByPoll) {
  const pollOptions = optionsByPoll[poll.id] || [];
  const optionTextById = new Map(pollOptions.map(opt => [opt.id, String(opt.option_text || '').trim()]));
  const orderedVotes = [...(userVotes || [])].sort((a, b) => {
    const rankA = Number(a.rank || 1);
    const rankB = Number(b.rank || 1);
    if (rankA !== rankB) return rankA - rankB;
    return Number(a.option_id || 0) - Number(b.option_id || 0);
  });

  if (poll.poll_type === 'ranking') {
    const rankMap = new Map();
    const optionOrder = [];
    const seen = new Set();

    for (const v of orderedVotes) {
      const text = optionTextById.get(v.option_id);
      if (!text) continue;
      const key = normalizeComparableText(text);
      if (!seen.has(key)) {
        seen.add(key);
        optionOrder.push(text);
      }
      if (!rankMap.has(key)) {
        rankMap.set(key, Number(v.rank || 1));
      }
    }

    return {
      pollId: poll.id,
      pollType: 'ranking',
      optionOrder,
      rankMap,
      topOptionKey: optionOrder[0] ? normalizeComparableText(optionOrder[0]) : null
    };
  }

  const selectedText = orderedVotes.length > 0 ? optionTextById.get(orderedVotes[0].option_id) : null;
  const rankMap = new Map();
  const optionOrder = [];

  if (selectedText) {
    const selectedKey = normalizeComparableText(selectedText);
    rankMap.set(selectedKey, 1);
    optionOrder.push(selectedText);
    for (const opt of pollOptions) {
      const key = normalizeComparableText(opt.option_text);
      if (key && !rankMap.has(key)) {
        rankMap.set(key, 2);
      }
    }
  }

  return {
    pollId: poll.id,
    pollType: 'plurality',
    optionOrder,
    rankMap,
    topOptionKey: selectedText ? normalizeComparableText(selectedText) : null
  };
}

function compareVoteSnapshots(firstSnapshot, lastSnapshot, allOptionKeys) {
  if (!firstSnapshot || !lastSnapshot) {
    return null;
  }
  if (!firstSnapshot.rankMap.size || !lastSnapshot.rankMap.size) {
    return null;
  }

  const firstMaxRank = firstSnapshot.pollType === 'ranking'
    ? Math.max(...firstSnapshot.rankMap.values(), 1)
    : 2;
  const lastMaxRank = lastSnapshot.pollType === 'ranking'
    ? Math.max(...lastSnapshot.rankMap.values(), 1)
    : 2;

  const getRank = (snapshot, key, maxRank) => {
    if (snapshot.rankMap.has(key)) {
      return Number(snapshot.rankMap.get(key));
    }
    if (snapshot.pollType === 'ranking') {
      return maxRank + 1;
    }
    return 2;
  };

  const optionKeys = [...allOptionKeys].filter(Boolean);
  let concordant = 0;
  let discordant = 0;
  let comparablePairs = 0;

  for (let i = 0; i < optionKeys.length; i++) {
    for (let j = i + 1; j < optionKeys.length; j++) {
      const a = optionKeys[i];
      const b = optionKeys[j];

      const firstCmp = Math.sign(getRank(firstSnapshot, a, firstMaxRank) - getRank(firstSnapshot, b, firstMaxRank));
      const lastCmp = Math.sign(getRank(lastSnapshot, a, lastMaxRank) - getRank(lastSnapshot, b, lastMaxRank));

      if (firstCmp === 0 || lastCmp === 0) {
        continue;
      }

      comparablePairs++;
      if (firstCmp === lastCmp) {
        concordant++;
      } else {
        discordant++;
      }
    }
  }

  if (comparablePairs === 0) {
    return null;
  }

  const kendallLike = (concordant - discordant) / comparablePairs;
  const opinionMixingIndex = Number(((1 - kendallLike) / 2).toFixed(4));

  return {
    kendallLike: Number(kendallLike.toFixed(4)),
    opinionMixingIndex,
    comparablePairs
  };
}

function calculateOpinionMixingStats(scopePolls, votesByPoll, optionsByPoll) {
  const orderedPolls = [...scopePolls].sort((a, b) => {
    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    if (timeA !== timeB) return timeA - timeB;
    return Number(a.id) - Number(b.id);
  });

  // Opinion change is only meaningful on the SAME issue: a user's first and last votes are
  // compared within one topic (poll.suggestion), never across topics whose option sets differ.
  const userTopicEvents = new Map();
  const participantIds = new Set();

  for (const poll of orderedPolls) {
    const pollVotes = votesByPoll[poll.id] || [];
    const votesByUser = {};
    for (const vote of pollVotes) {
      participantIds.add(vote.user_id);
      if (!votesByUser[vote.user_id]) {
        votesByUser[vote.user_id] = [];
      }
      votesByUser[vote.user_id].push(vote);
    }

    const topicKey = String(poll.suggestion || poll.question || '').toLowerCase();
    for (const userId of Object.keys(votesByUser)) {
      const key = `${userId}::${topicKey}`;
      if (!userTopicEvents.has(key)) {
        userTopicEvents.set(key, { userId: Number(userId), events: [] });
      }
      userTopicEvents.get(key).events.push({
        poll,
        votes: votesByUser[userId]
      });
    }
  }

  let weightedIndexSum = 0;
  let totalComparablePairs = 0;
  const comparableUserIds = new Set();
  let comparableUsers = 0;
  let rankingEvidenceUsers = 0;
  let pluralityEvidenceUsers = 0;

  for (const [, { userId, events }] of userTopicEvents.entries()) {
    const userEventsSorted = [...events].sort((a, b) => {
      const timeA = new Date(a.poll.created_at).getTime();
      const timeB = new Date(b.poll.created_at).getTime();
      if (timeA !== timeB) return timeA - timeB;
      return Number(a.poll.id) - Number(b.poll.id);
    });

    if (userEventsSorted.length < 2) {
      continue;
    }

    const firstEvent = userEventsSorted[0];
    const lastEvent = userEventsSorted[userEventsSorted.length - 1];
    const firstSnapshot = buildVoteSnapshot(firstEvent.poll, firstEvent.votes, optionsByPoll);
    const lastSnapshot = buildVoteSnapshot(lastEvent.poll, lastEvent.votes, optionsByPoll);
    const optionKeys = new Set([
      ...getPollOptionTexts(firstEvent.poll.id, optionsByPoll).map(normalizeComparableText),
      ...getPollOptionTexts(lastEvent.poll.id, optionsByPoll).map(normalizeComparableText),
      ...firstSnapshot.rankMap.keys(),
      ...lastSnapshot.rankMap.keys()
    ]);

    const comparison = compareVoteSnapshots(firstSnapshot, lastSnapshot, optionKeys);
    if (!comparison) {
      continue;
    }

    comparableUserIds.add(userId);
    totalComparablePairs += comparison.comparablePairs;
    weightedIndexSum += comparison.opinionMixingIndex * comparison.comparablePairs;

    if (firstSnapshot.pollType === 'ranking' || lastSnapshot.pollType === 'ranking') {
      rankingEvidenceUsers++;
    } else {
      pluralityEvidenceUsers++;
    }
  }

  comparableUsers = comparableUserIds.size;
  const participantCount = participantIds.size;
  const opinionMixingIndex = totalComparablePairs > 0 ? Number((weightedIndexSum / totalComparablePairs).toFixed(4)) : 0;
  const opinionMixingCoverage = participantCount > 0 ? Number((comparableUsers / participantCount).toFixed(4)) : 0;

  return {
    opinionMixingIndex,
    opinionMixingCoverage,
    comparableUsers,
    participantCount,
    comparablePairs: totalComparablePairs,
    rankingEvidenceUsers,
    pluralityEvidenceUsers
  };
}

router.get('/decision-process/statistics', withRequestWork(async (req, res) => {
  try {
    // ── Query params for filtering ──
    const filterTopic = req.query.topic || null;       // e.g. "Budget allocation"
    const filterRoomType = req.query.room_type || null; // e.g. "group", "convergence", "personal"

    // ── Fetch rooms for room_type joining (EXCLUDING personal rooms) ──
    const rooms = db.prepare("SELECT id, name, room_type, is_active FROM rooms WHERE room_type <> 'personal'").all();
    const roomById = {};
    for (const r of rooms) roomById[r.id] = r;

    // Reconstruct each room's participant population: current members plus anyone who wrote
    // a message or cast a vote there (membership rows are removed when users move on to the
    // convergence round, so history alone is not enough). Gini / participation-equality must
    // be computed over the users who could actually participate in that scope — using the
    // whole user base would add structural zeros and overstate inequality.
    const roomPopulationStmt = db.prepare(`
      SELECT DISTINCT u.id
      FROM users u
      WHERE u.is_admin = 0
        AND (
          EXISTS (SELECT 1 FROM room_members rm WHERE rm.user_id = u.id AND rm.room_id = ?)
          OR EXISTS (SELECT 1 FROM messages m WHERE m.sender_id = u.id AND m.room_id = ?)
          OR EXISTS (
            SELECT 1 FROM poll_votes pv JOIN polls p ON p.id = pv.poll_id
            WHERE pv.user_id = u.id AND p.room_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM swipe_votes sv JOIN polls p ON p.id = sv.poll_id
            WHERE sv.user_id = u.id AND p.room_id = ?
          )
        )
    `);
    const roomPopulations = {};
    for (const r of rooms) {
      roomPopulations[r.id] = roomPopulationStmt.all(r.id, r.id, r.id, r.id).map((row) => row.id);
    }

    // ── Distinct available room types (for frontend selectors) ──
    const allRoomTypesSet = new Set();
    for (const r of rooms) allRoomTypesSet.add(r.room_type);

    // Fetch active topics strictly from gathering questions (excluding general question)
    const activeTopics = db.prepare("SELECT topic, question_text FROM gathering_questions WHERE topic IS NOT NULL AND topic <> 'general-question' AND is_general_question = 0").all();
    const availableTopics = activeTopics.map(t => t.topic);

    let allPolls = db.prepare(`
      SELECT p.id, p.room_id, p.question, p.is_closed, p.created_at, p.poll_type, p.suggestion, p.has_consensus 
      FROM polls p
      JOIN rooms r ON r.id = p.room_id
      WHERE r.room_type <> 'personal'
    `).all();

    // ── Check if experiment is active ──
    // Quality assessments need the same decision context that participants saw.
    // Selecting only current_phase here silently produced empty context fields in
    // the LLM prompts for completed runs.
    const systemState = db.prepare(`
      SELECT current_phase, global_question, decision_context, general_description
      FROM system_state
      WHERE id = 1
    `).get();
    const isExperimentActive = systemState && (systemState.current_phase === 'gathering' || systemState.current_phase === 'discussing');

    // Helper to count words in a message
    function countWords(text) {
      if (!text) return 0;
      return text.trim().split(/\s+/).filter(Boolean).length;
    }

    // Helper to calculate Gini coefficient
    function calculateGini(messageCounts) {
      const sum = messageCounts.reduce((s, c) => s + c, 0);
      const n = messageCounts.length;
      if (sum === 0 || n === 0) return 0;
      let absDiffSum = 0;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          absDiffSum += Math.abs(messageCounts[i] - messageCounts[j]);
        }
      }
      const mean = sum / n;
      return absDiffSum / (2 * n * n * mean);
    }

    // ── Apply filters ──
    let polls = allPolls;
    if (filterRoomType) {
      const validRoomIds = new Set(rooms.filter(r => r.room_type === filterRoomType).map(r => r.id));
      polls = polls.filter(p => validRoomIds.has(p.room_id));
    }
    if (filterTopic) {
      polls = polls.filter(p => getNormalizedTopic(p.suggestion, p.question, activeTopics) === filterTopic);
    }

    const filteredRoomIds = filterRoomType
      ? new Set(rooms.filter(r => r.room_type === filterRoomType).map(r => r.id))
      : null;

    const options = db.prepare('SELECT id, poll_id, option_text FROM poll_options').all();
    
    // We only count votes of non-admin users in non-personal rooms
    const votes = db.prepare(`
      SELECT pv.poll_id, pv.option_id, pv.user_id, pv.created_at, pv.rank, pv.custom_option_text, NULL as swipe_direction
      FROM poll_votes pv
      JOIN users u ON u.id = pv.user_id
      JOIN polls p ON p.id = pv.poll_id
      JOIN rooms r ON r.id = p.room_id
      WHERE u.is_admin = 0 AND r.room_type <> 'personal'
    `).all();

    const swipeVotes = db.prepare(`
      SELECT sv.poll_id, sv.option_id, sv.user_id, sv.created_at, 1 as rank, NULL as custom_option_text, sv.swipe_direction
      FROM swipe_votes sv
      JOIN users u ON u.id = sv.user_id
      JOIN polls p ON p.id = sv.poll_id
      JOIN rooms r ON r.id = p.room_id
      WHERE u.is_admin = 0 AND r.room_type <> 'personal'
    `).all();

    votes.push(...swipeVotes);

    const allContextMessages = db.prepare(`
      SELECT m.id, m.room_id, m.sender_id, COALESCE(u.username, 'Bot') AS sender_name, m.text, m.timestamp
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      ORDER BY m.room_id ASC, m.timestamp ASC, m.id ASC
    `).all();
    
    // Human messages from non-admin users (EXCLUDING personal rooms)
    let messages = db.prepare(`
      SELECT m.id, m.room_id, m.sender_id, m.text, m.timestamp 
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      JOIN rooms r ON r.id = m.room_id
      WHERE u.is_admin = 0 AND r.room_type <> 'personal'
    `).all();
    if (filteredRoomIds) messages = messages.filter(m => filteredRoomIds.has(m.room_id));

    // Calculate word counts for messages
    let totalWordsGlobal = 0;
    for (const m of messages) {
      m.wordCount = countWords(m.text);
      totalWordsGlobal += m.wordCount;
    }
    const avgWordsPerMessageGlobal = messages.length > 0
      ? Number((totalWordsGlobal / messages.length).toFixed(2))
      : 0;

    // Bot messages (sender_id IS NULL) — for counting questions to the bot (EXCLUDING personal rooms)
    let botMessages = db.prepare(`
      SELECT m.id, m.room_id, m.timestamp 
      FROM messages m
      JOIN rooms r ON r.id = m.room_id
      WHERE m.sender_id IS NULL AND r.room_type <> 'personal'
    `).all();
    if (filteredRoomIds) botMessages = botMessages.filter(m => filteredRoomIds.has(m.room_id));
    const totalBotMessages = botMessages.length;
    
    const users = db.prepare('SELECT id, username FROM users WHERE is_admin = 0').all();
    const totalSystemUsers = users.length;
    const allUserIds = users.map(u => u.id);

    // ── Filtered poll IDs set (for filtering votes) ──
    const filteredPollIds = new Set(polls.map(p => p.id));

    // Group options by poll_id
    const optionsByPoll = {};
    for (const opt of options) {
      if (!optionsByPoll[opt.poll_id]) optionsByPoll[opt.poll_id] = [];
      optionsByPoll[opt.poll_id].push(opt);
    }

    const processedPollById = {};
    const pollsByRoomAll = {};
    // Display filters must not change historical assessment inputs. Otherwise
    // switching topics invalidates the same message's cache on every refresh.
    for (const rawPoll of allPolls) {
      const normalizedPoll = {
        id: rawPoll.id,
        room_id: rawPoll.room_id,
        suggestion: getNormalizedTopic(rawPoll.suggestion, rawPoll.question, activeTopics),
        question: rawPoll.question,
        created_at: rawPoll.created_at
      };
      processedPollById[rawPoll.id] = normalizedPoll;
      if (!pollsByRoomAll[rawPoll.room_id]) pollsByRoomAll[rawPoll.room_id] = [];
      pollsByRoomAll[rawPoll.room_id].push(normalizedPoll);
    }
    for (const roomId in pollsByRoomAll) {
      pollsByRoomAll[roomId].sort((a, b) => {
        const timeA = new Date(a.created_at).getTime();
        const timeB = new Date(b.created_at).getTime();
        if (timeA !== timeB) return timeA - timeB;
        return a.id - b.id;
      });
    }

    const messagesByRoomAll = {};
    for (const msg of allContextMessages) {
      if (!messagesByRoomAll[msg.room_id]) messagesByRoomAll[msg.room_id] = [];
      messagesByRoomAll[msg.room_id].push(msg);
    }

    function formatContextTranscript(roomId, pollId) {
      const poll = processedPollById[pollId];
      if (!poll) return { recentMessages: '', previousPollOptions: [] };

      const roomPolls = pollsByRoomAll[roomId] || [];
      const pollIndex = roomPolls.findIndex((entry) => entry.id === pollId);
      const previousPoll = pollIndex > 0 ? roomPolls[pollIndex - 1] : null;
      let previousSameTopicPoll = null;
      for (let i = pollIndex - 1; i >= 0; i--) {
        const candidate = roomPolls[i];
        if (candidate && candidate.suggestion === poll.suggestion) {
          previousSameTopicPoll = candidate;
          break;
        }
      }

      const roomMessages = messagesByRoomAll[roomId] || [];
      const pollTime = new Date(poll.created_at).getTime();
      const previousTime = previousPoll ? new Date(previousPoll.created_at).getTime() : null;
      const transcriptMessages = roomMessages.filter((msg) => {
        const msgTime = new Date(msg.timestamp).getTime();
        if (msgTime >= pollTime) return false;
        if (previousTime !== null && msgTime <= previousTime) return false;
        return true;
      });

      const recentMessages = transcriptMessages.map((msg) => {
        const sender = msg.sender_name || (msg.sender_id === null ? 'Bot' : 'Unknown');
        return `[${msg.id}] ${msg.timestamp} ${sender}: ${msg.text}`;
      }).join('\n');

      const previousPollOptions = previousSameTopicPoll
        ? (optionsByPoll[previousSameTopicPoll.id] || []).map((opt) => opt.option_text)
        : [];

      return { recentMessages, previousPollOptions };
    }

    function formatMessageContext(roomId, messageTimestamp, messageId) {
      const roomMessages = messagesByRoomAll[roomId] || [];
      const currentTime = new Date(messageTimestamp).getTime();
      const currentMessageIndex = roomMessages.findIndex((msg) => msg.id === messageId);
      const recentWindow = currentMessageIndex >= 0
        ? roomMessages.slice(Math.max(0, currentMessageIndex - 10), currentMessageIndex)
        : roomMessages.filter((msg) => new Date(msg.timestamp).getTime() < currentTime).slice(-10);

      const recentMessages = recentWindow.map((msg) => {
        const sender = msg.sender_name || (msg.sender_id === null ? 'Bot' : 'Unknown');
        return `[${msg.id}] ${msg.timestamp} ${sender}: ${msg.text}`;
      }).join('\n');

      const roomPolls = pollsByRoomAll[roomId] || [];
      let currentPoll = null;
      for (const poll of roomPolls) {
        if (new Date(poll.created_at).getTime() <= currentTime) {
          currentPoll = poll;
        } else {
          break;
        }
      }
      let previousSameTopicPoll = null;
      if (currentPoll) {
        for (let i = roomPolls.findIndex((p) => p.id === currentPoll.id) - 1; i >= 0; i--) {
          const candidate = roomPolls[i];
          if (candidate && candidate.suggestion === currentPoll.suggestion) {
            previousSameTopicPoll = candidate;
            break;
          }
        }
      }

      const previousPollOptions = previousSameTopicPoll
        ? (optionsByPoll[previousSameTopicPoll.id] || []).map((opt) => opt.option_text)
        : [];

      const currentPollOptions = currentPoll
        ? (optionsByPoll[currentPoll.id] || []).map((opt) => opt.option_text)
        : [];

      return {
        recentMessages,
        currentPollQuestion: currentPoll?.question || '',
        currentPollOptions,
        previousPollOptions
      };
    }

    function deliberativeContextForMessage(message) {
      const base = formatMessageContext(message.room_id, message.timestamp, message.id);
      return {
        ...base,
        globalQuestion: systemState?.global_question || '',
        decisionContext: systemState?.decision_context || '',
        generalDescription: systemState?.general_description || '',
        roomName: roomById[message.room_id]?.name || `Room ${message.room_id}`
      };
    }

    // Group votes by poll_id (only for filtered polls)
    const votesByPoll = {};
    for (const v of votes) {
      if (!filteredPollIds.has(v.poll_id)) continue;
      if (!votesByPoll[v.poll_id]) votesByPoll[v.poll_id] = [];
      votesByPoll[v.poll_id].push(v);
    }

    let totalFailed = 0;
    let totalTies = 0;
    let totalPolls = polls.length;
    let entropySumGlobal = 0;
    let entropyCountGlobal = 0;

    const processedPolls = polls.map(poll => {
      const pollVotes = votesByPoll[poll.id] || [];
      const voters = new Set(pollVotes.map(v => v.user_id));
      const uniqueVotersCount = voters.size;
      const isFailed = uniqueVotersCount === 0;

      let isTie = false;
      let entropy = 0;
      let normalizedEntropy = 0;
      let giniImpurity = 0;

      if (!isFailed) {
        const pollOptions = optionsByPoll[poll.id] || [];
        const M = pollOptions.length;
        
        const optionScores = {};
        for (const opt of pollOptions) {
          optionScores[opt.id] = 0;
        }

         if (poll.poll_type === 'ranking') {
          // Entropy must be comparable across poll types, so ranking polls use the
          // distribution of FIRST choices (rank = 1) rather than Borda score shares:
          // Borda totals are structurally compressed (every option receives points from
          // every ballot), which inflates entropy regardless of actual disagreement.
          for (const v of pollVotes) {
            if (v.rank === 1 && optionScores[v.option_id] !== undefined) {
              optionScores[v.option_id] += 1;
            }
          }
        } else if (poll.poll_type === 'swipe') {
          for (const v of pollVotes) {
            if (v.swipe_direction === 'right' && optionScores[v.option_id] !== undefined) {
              optionScores[v.option_id] += 1;
            }
          }
        } else {
          for (const v of pollVotes) {
            if (optionScores[v.option_id] !== undefined) {
              optionScores[v.option_id] += 1;
            }
          }
        }

        const scores = Object.values(optionScores);
        const maxScore = Math.max(...scores);
        const tiedOptionsCount = scores.filter(s => s === maxScore).length;
        isTie = maxScore > 0 && tiedOptionsCount > 1;

        const sumScores = scores.reduce((sum, s) => sum + s, 0);
        if (sumScores > 0) {
          let entSum = 0;
          let giniSum = 0;
          for (const score of scores) {
            const p = score / sumScores;
            if (p > 0) {
              entSum -= p * Math.log2(p);
              giniSum += p * p;
            }
          }
          entropy = entSum;
          giniImpurity = 1 - giniSum;
          normalizedEntropy = M > 1 ? entSum / Math.log2(M) : 0;
        }
      }

      if (isFailed) totalFailed++;
      if (isTie) totalTies++;
      if (uniqueVotersCount > 0) {
        entropySumGlobal += normalizedEntropy;
        entropyCountGlobal++;
      }

      return {
        id: poll.id,
        room_id: poll.room_id,
        suggestion: getNormalizedTopic(poll.suggestion, poll.question, activeTopics),
        question: poll.question,
        poll_type: poll.poll_type,
        created_at: poll.created_at,
        votersCount: uniqueVotersCount,
        isFailed,
        isTie,
        entropy: normalizedEntropy,
        giniImpurity,
        isClosed: poll.is_closed === 1,
        hasConsensus: poll.has_consensus
      };
    });

    // ── Topic-level metrics ──
    const topicsMap = {};
    for (const p of processedPolls) {
      if (!p.suggestion || p.suggestion === 'general-question') continue;
      const key = `${p.room_id}::${p.suggestion}`;
      if (!topicsMap[key]) {
        topicsMap[key] = [];
      }
      topicsMap[key].push(p);
    }

    let topicsCount = 0;
    let topicsPassedFirstTry = 0;
    let totalPollsOnTopics = 0;
    let totalVotesOnTopics = 0;

    for (const key in topicsMap) {
      topicsCount++;
      const topicPolls = topicsMap[key].sort((a, b) => a.id - b.id);
      totalPollsOnTopics += topicPolls.length;

      if (topicPolls[0] && topicPolls[0].hasConsensus === 1) {
        topicsPassedFirstTry++;
      }

      let topicVotesCount = 0;
      for (const p of topicPolls) {
        topicVotesCount += p.votersCount;
      }
      totalVotesOnTopics += topicVotesCount;
    }

    const avgVotesPerTopic = topicsCount > 0 ? (totalVotesOnTopics / topicsCount) : 0;
    const avgPollsPerTopic = topicsCount > 0 ? (totalPollsOnTopics / topicsCount) : 0;
    const firstTrySuccessRate = topicsCount > 0 ? (topicsPassedFirstTry / topicsCount) : 0;

    // ── Custom suggestions stats ──
    const filteredVotes = votes.filter(v => filteredPollIds.has(v.poll_id));
    const customOptionVotes = filteredVotes.filter(v => v.custom_option_text && v.custom_option_text.trim() !== '');
    const totalSuggestions = customOptionVotes.length;
    
    const uniqueSuggestions = new Set(customOptionVotes.map(v => v.custom_option_text.trim().toLowerCase()));
    const uniqueSuggestionsCount = uniqueSuggestions.size;

    const newOptionCounts = {
      extension: 0,
      contradiction: 0,
      combination: 0,
      unrelated: 0
    };
    const constructiveCounts = {
      support: 0,
      opposition: 0,
      modification: 0,
      mitigation: 0,
      neutral: 0
    };
    const constructiveUserCounts = new Map();

    for (const vote of customOptionVotes) {
      const poll = processedPollById[vote.poll_id];
      if (!poll) {
        newOptionCounts.unrelated++;
        constructiveCounts.neutral++;
        continue;
      }

      const pollOptions = (optionsByPoll[poll.id] || []).map((opt) => opt.option_text);
      const { recentMessages, previousPollOptions } = formatContextTranscript(poll.room_id, poll.id);
      const analysis = await classifyCustomOption({
        pollId: poll.id,
        userId: vote.user_id,
        optionId: vote.option_id,
        customOptionText: vote.custom_option_text.trim(),
        roomId: poll.room_id,
        roomName: roomById[poll.room_id]?.name || `Room ${poll.room_id}`,
        globalQuestion: systemState?.global_question || '',
        decisionContext: systemState?.decision_context || '',
        generalDescription: systemState?.general_description || '',
        pollQuestion: poll.question,
        pollOptions,
        recentMessages,
        previousPollOptions
      });

      const reciprocityType = new Set(['extension', 'contradiction', 'combination', 'unrelated']).has(analysis.reciprocity?.type)
        ? analysis.reciprocity.type
        : 'unrelated';
      newOptionCounts[reciprocityType] = (newOptionCounts[reciprocityType] || 0) + 1;

      const constructiveLabel = new Set(['support', 'opposition', 'modification', 'mitigation', 'neutral']).has(analysis.constructive?.label)
        ? analysis.constructive.label
        : 'neutral';
      constructiveCounts[constructiveLabel] = (constructiveCounts[constructiveLabel] || 0) + 1;

      if (!constructiveUserCounts.has(vote.user_id)) {
        constructiveUserCounts.set(vote.user_id, {
          support: 0,
          opposition: 0,
          modification: 0,
          mitigation: 0,
          neutral: 0
        });
      }
      constructiveUserCounts.get(vote.user_id)[constructiveLabel]++;
    }

    let constructiveProposalUsersAnalyzed = 0;
    let constructiveProposalUsersMorePropositive = 0;
    const constructiveProposalByUser = {};
    for (const [userId, counts] of constructiveUserCounts.entries()) {
      const constructiveCount = (counts.modification || 0) + (counts.mitigation || 0);
      const reactiveCount = (counts.support || 0) + (counts.opposition || 0) + constructiveCount;
      if (reactiveCount <= 0) {
        constructiveProposalByUser[userId] = {
          support: counts.support || 0,
          opposition: counts.opposition || 0,
          modification: counts.modification || 0,
          mitigation: counts.mitigation || 0,
          neutral: counts.neutral || 0,
          rate: null
        };
        continue;
      }
      const rate = constructiveCount / reactiveCount;
      constructiveProposalUsersAnalyzed++;
      if (rate > 0.5) constructiveProposalUsersMorePropositive++;
      constructiveProposalByUser[userId] = {
        support: counts.support || 0,
        opposition: counts.opposition || 0,
        modification: counts.modification || 0,
        mitigation: counts.mitigation || 0,
        neutral: counts.neutral || 0,
        rate: Number(rate.toFixed(4))
      };
    }

    const proactivenessCounts = {
      support: 0,
      opposition: 0,
      modification: 0,
      mitigation: 0,
      neutral: 0
    };
    const proactivenessUserCounts = new Map();
    const proactivenessLabelByMessageId = new Map();

    for (const msg of messages) {
      const context = formatMessageContext(msg.room_id, msg.timestamp, msg.id);
      const analysis = await classifyHumanMessageProactiveness({
        messageId: msg.id,
        userId: msg.sender_id,
        roomId: msg.room_id,
        roomName: roomById[msg.room_id]?.name || `Room ${msg.room_id}`,
        globalQuestion: systemState?.global_question || '',
        decisionContext: systemState?.decision_context || '',
        generalDescription: systemState?.general_description || '',
        messageText: msg.text,
        recentMessages: context.recentMessages,
        currentPollQuestion: context.currentPollQuestion,
        currentPollOptions: context.currentPollOptions,
        previousPollOptions: context.previousPollOptions
      });

      const label = new Set(['support', 'opposition', 'modification', 'mitigation', 'neutral']).has(analysis.label)
        ? analysis.label
        : 'neutral';
      proactivenessLabelByMessageId.set(msg.id, label);
      proactivenessCounts[label] = (proactivenessCounts[label] || 0) + 1;

      if (!proactivenessUserCounts.has(msg.sender_id)) {
        proactivenessUserCounts.set(msg.sender_id, {
          support: 0,
          opposition: 0,
          modification: 0,
          mitigation: 0,
          neutral: 0
        });
      }
      proactivenessUserCounts.get(msg.sender_id)[label]++;
    }

    let proactivenessUsersAnalyzed = 0;
    let proactivenessUsersMorePropositive = 0;
    const proactivenessByUser = {};
    for (const [userId, counts] of proactivenessUserCounts.entries()) {
      const constructiveCount = (counts.modification || 0) + (counts.mitigation || 0);
      const reactiveCount = (counts.support || 0) + (counts.opposition || 0) + constructiveCount;
      if (reactiveCount <= 0) {
        proactivenessByUser[userId] = {
          support: counts.support || 0,
          opposition: counts.opposition || 0,
          modification: counts.modification || 0,
          mitigation: counts.mitigation || 0,
          neutral: counts.neutral || 0,
          rate: null
        };
        continue;
      }
      const rate = constructiveCount / reactiveCount;
      proactivenessUsersAnalyzed++;
      if (rate > 0.5) proactivenessUsersMorePropositive++;
      proactivenessByUser[userId] = {
        support: counts.support || 0,
        opposition: counts.opposition || 0,
        modification: counts.modification || 0,
        mitigation: counts.mitigation || 0,
        neutral: counts.neutral || 0,
        rate: Number(rate.toFixed(4))
      };
    }

    let suggestionsWon = 0;
    for (const poll of processedPolls) {
      if (poll.isFailed) continue;

      const pollOptions = optionsByPoll[poll.id] || [];
      const pollVotes = votesByPoll[poll.id] || [];
      const M = pollOptions.length;
      
      const optionScores = {};
      for (const opt of pollOptions) {
        optionScores[opt.id] = 0;
      }

      if (poll.poll_type === 'ranking') {
        for (const v of pollVotes) {
          if (optionScores[v.option_id] !== undefined) {
            optionScores[v.option_id] += (M - v.rank + 1);
          }
        }
      } else {
        for (const v of pollVotes) {
          if (optionScores[v.option_id] !== undefined) {
            optionScores[v.option_id] += 1;
          }
        }
      }

      let winOptText = null;
      let winScore = -1;
      for (const opt of pollOptions) {
        const score = optionScores[opt.id] || 0;
        if (score > winScore) {
          winScore = score;
          winOptText = opt.option_text;
        }
      }

      if (winOptText) {
        const winClean = winOptText.trim().toLowerCase();
        const isCustomWin = winClean === 'other' || uniqueSuggestions.has(winClean);
        if (isCustomWin) {
          suggestionsWon++;
        }
      }
    }

    const proactivenessTotal =
      (proactivenessCounts.support || 0) +
      (proactivenessCounts.opposition || 0) +
      (proactivenessCounts.modification || 0) +
      (proactivenessCounts.mitigation || 0) +
      (proactivenessCounts.neutral || 0);
    const proactivenessNonNeutral =
      (proactivenessCounts.support || 0) +
      (proactivenessCounts.opposition || 0) +
      (proactivenessCounts.modification || 0) +
      (proactivenessCounts.mitigation || 0);
    const proactivenessRate = proactivenessNonNeutral > 0
      ? Number((((proactivenessCounts.modification || 0) + (proactivenessCounts.mitigation || 0)) / proactivenessNonNeutral).toFixed(4))
      : 0;
    const proactivenessUsersRate = proactivenessUsersAnalyzed > 0
      ? Number((proactivenessUsersMorePropositive / proactivenessUsersAnalyzed).toFixed(4))
      : 0;

    // ── Option Switching Detection ──
    let totalOptionSwitches = 0;
    let totalSwitchOpportunities = 0;
    const switchDetails = [];
    const switchesByTopic = {}; // track per suggestion topic
    for (const topic of availableTopics) {
      switchesByTopic[topic] = { switches: 0, opportunities: 0 };
    }

    for (const key in topicsMap) {
      const topicPolls = topicsMap[key].sort((a, b) => a.id - b.id);
      const suggestion = topicPolls[0]?.suggestion;
      
      for (let i = 0; i < topicPolls.length - 1; i++) {
        const pollA = topicPolls[i];
        const pollB = topicPolls[i + 1];
        const votesA = votesByPoll[pollA.id] || [];
        const votesB = votesByPoll[pollB.id] || [];

        const userTopOptionA = {};
        const optionsMapA = {};
        for (const opt of (optionsByPoll[pollA.id] || [])) optionsMapA[opt.id] = opt.option_text;
        
        if (pollA.poll_type === 'ranking') {
          for (const v of votesA) {
            if (v.rank === 1 && optionsMapA[v.option_id]) {
              userTopOptionA[v.user_id] = optionsMapA[v.option_id];
            }
          }
        } else {
          for (const v of votesA) {
            if (optionsMapA[v.option_id]) {
              userTopOptionA[v.user_id] = optionsMapA[v.option_id];
            }
          }
        }

        const userTopOptionB = {};
        const optionsMapB = {};
        for (const opt of (optionsByPoll[pollB.id] || [])) optionsMapB[opt.id] = opt.option_text;
        
        if (pollB.poll_type === 'ranking') {
          for (const v of votesB) {
            if (v.rank === 1 && optionsMapB[v.option_id]) {
              userTopOptionB[v.user_id] = optionsMapB[v.option_id];
            }
          }
        } else {
          for (const v of votesB) {
            if (optionsMapB[v.option_id]) {
              userTopOptionB[v.user_id] = optionsMapB[v.option_id];
            }
          }
        }

        let switchesInPair = 0;
        let opportunitiesInPair = 0;
        for (const uid in userTopOptionA) {
          if (userTopOptionB[uid]) {
            opportunitiesInPair++;
            if (userTopOptionA[uid].toLowerCase() !== userTopOptionB[uid].toLowerCase()) {
              switchesInPair++;
            }
          }
        }

        totalOptionSwitches += switchesInPair;
        totalSwitchOpportunities += opportunitiesInPair;

        if (suggestion) {
          switchesByTopic[suggestion].switches += switchesInPair;
          switchesByTopic[suggestion].opportunities += opportunitiesInPair;
        }

        if (opportunitiesInPair > 0) {
          switchDetails.push({
            created_at: pollB.created_at,
            switches: switchesInPair,
            opportunities: opportunitiesInPair,
            rate: switchesInPair / opportunitiesInPair
          });
        }
      }
    }

    const optionSwitchRate = totalSwitchOpportunities > 0
      ? Number((totalOptionSwitches / totalSwitchOpportunities).toFixed(4))
      : 0;

    // ── Time-series ──
    const times = [];
    for (const p of polls) if (p.created_at) times.push(new Date(p.created_at).getTime());
    for (const m of messages) if (m.timestamp) times.push(new Date(m.timestamp).getTime());
    for (const b of botMessages) if (b.timestamp) times.push(new Date(b.timestamp).getTime());
    
    const startMs = times.length > 0 ? Math.min(...times) : Date.now() - 3600000;
    const maxTime = times.length > 0 ? Math.max(...times) : Date.now();

    // Check if the filtered room type is active
    let isActiveBound = isExperimentActive;
    if (filterRoomType) {
      isActiveBound = rooms.some(r => r.room_type === filterRoomType && r.is_active === 1);
    }
    const endMs = isActiveBound ? Date.now() : maxTime;
    const totalDuration = endMs - startMs;

    const binMs = 60 * 1000; 
    const numBins = Math.max(1, Math.ceil(totalDuration / binMs));

    const bins = [];
    for (let i = 0; i < numBins; i++) {
      const binStart = startMs + i * binMs;
      const binEnd = binStart + binMs;
      bins.push({
        startTime: new Date(binStart).toISOString(),
        endTime: new Date(binEnd).toISOString(),
        label: new Date(binStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        pollsCreated: 0,
        failedPolls: 0,
        tiePolls: 0,
        pollsResolved: 0,
        pollsPassed: 0,
        rankingPolls: 0,
        entropySum: 0,
        entropyCount: 0,
        messageCount: 0,
        totalWords: 0,
        botMessageCount: 0,
        optionSwitches: 0,
        switchOpportunities: 0,
        activeUsers: new Set(),
        userMessageCounts: {},
        messages: []
      });
    }

    // Assign polls to bins
    let totalRanking = 0;
    let totalResolved = 0;
    let totalPassedGlobal = 0;
    for (const p of processedPolls) {
      if (p.poll_type === 'ranking') totalRanking++;
      const isResolved = p.isClosed || p.hasConsensus !== null;
      if (isResolved) totalResolved++;
      if (p.hasConsensus === 1) totalPassedGlobal++;

      const pollTime = new Date(p.created_at).getTime();
      const binIndex = Math.min(numBins - 1, Math.max(0, Math.floor((pollTime - startMs) / binMs)));
      const bin = bins[binIndex];
      if (bin) {
        bin.pollsCreated++;
        if (p.poll_type === 'ranking') bin.rankingPolls++;
        if (p.isFailed) bin.failedPolls++;
        if (p.isTie) bin.tiePolls++;
        if (isResolved) bin.pollsResolved++;
        if (p.hasConsensus === 1) bin.pollsPassed++;
        if (p.votersCount > 0) {
          bin.entropySum += p.entropy;
          bin.entropyCount++;
        }
      }
    }

    // Assign human messages to bins
    for (const m of messages) {
      const msgTime = new Date(m.timestamp).getTime();
      const binIndex = Math.min(numBins - 1, Math.max(0, Math.floor((msgTime - startMs) / binMs)));
      const bin = bins[binIndex];
      if (bin) {
        bin.messageCount++;
        bin.totalWords += m.wordCount;
        bin.messages.push(m);
        bin.activeUsers.add(m.sender_id);
        if (!bin.userMessageCounts[m.sender_id]) {
          bin.userMessageCounts[m.sender_id] = 0;
        }
        bin.userMessageCounts[m.sender_id]++;
      }
    }

    // Assign bot messages to bins
    for (const b of botMessages) {
      const msgTime = new Date(b.timestamp).getTime();
      const binIndex = Math.min(numBins - 1, Math.max(0, Math.floor((msgTime - startMs) / binMs)));
      const bin = bins[binIndex];
      if (bin) {
        bin.botMessageCount++;
      }
    }

    // Assign option switch events to bins
    for (const sd of switchDetails) {
      const sdTime = new Date(sd.created_at).getTime();
      const binIndex = Math.min(numBins - 1, Math.max(0, Math.floor((sdTime - startMs) / binMs)));
      const bin = bins[binIndex];
      if (bin) {
        bin.optionSwitches += sd.switches;
        bin.switchOpportunities += sd.opportunities;
      }
    }

    const timeSeries = await Promise.all(bins.map(async (bin) => {
      const activeUsersCount = bin.activeUsers.size;
      const deliberativeQuality = await analyzeDeliberativeMessagesWithLLM({
        messageRows: bin.messages,
        userIds: allUserIds,
        getContextForMessage: deliberativeContextForMessage
      });
      
      const messageCounts = allUserIds.map(uid => bin.userMessageCounts[uid] || 0);
      let giniCoefficient = 0;
      const sumMessages = messageCounts.reduce((s, c) => s + c, 0);
      if (sumMessages > 0 && totalSystemUsers > 0) {
        let absDiffSum = 0;
        for (let i = 0; i < totalSystemUsers; i++) {
          for (let j = 0; j < totalSystemUsers; j++) {
            absDiffSum += Math.abs(messageCounts[i] - messageCounts[j]);
          }
        }
        const meanMessages = sumMessages / totalSystemUsers;
        giniCoefficient = absDiffSum / (2 * totalSystemUsers * totalSystemUsers * meanMessages);
      }

      return {
        label: bin.label,
        startTime: bin.startTime,
        endTime: bin.endTime,
        pollsCreated: bin.pollsCreated,
        failedPolls: bin.failedPolls,
        tiePolls: bin.tiePolls,
        pollsResolved: bin.pollsResolved,
        pollsPassed: bin.pollsPassed,
        passedPollsRatio: bin.pollsResolved > 0 ? (bin.pollsPassed / bin.pollsResolved) : 0,
        rankingPolls: bin.rankingPolls,
        avgEntropy: bin.entropyCount > 0 ? bin.entropySum / bin.entropyCount : 0,
        messageCount: bin.messageCount,
        avgWordsPerMessage: bin.messageCount > 0 ? Number((bin.totalWords / bin.messageCount).toFixed(2)) : 0,
        deliberativeQuality: deliberativeQuality.score,
        deliberativeQualityDimensions: deliberativeQuality.dimensions,
        botMessageCount: bin.botMessageCount,
        optionSwitchRate: bin.switchOpportunities > 0 ? Number((bin.optionSwitches / bin.switchOpportunities).toFixed(4)) : 0,
        optionSwitches: bin.optionSwitches,
        activeUsersCount,
        giniCoefficient: Number(giniCoefficient.toFixed(4)),
        activeUserRatio: totalSystemUsers > 0 ? activeUsersCount / totalSystemUsers : 0
      };
    }));

    // Global participation Gini
    const globalUserMessageCounts = {};
    for (const uid of allUserIds) globalUserMessageCounts[uid] = 0;
    for (const m of messages) {
      if (globalUserMessageCounts[m.sender_id] !== undefined) {
        globalUserMessageCounts[m.sender_id]++;
      }
    }
    const globalMessageCounts = Object.values(globalUserMessageCounts);
    const globalSumMessages = globalMessageCounts.reduce((s, c) => s + c, 0);
    let globalGiniCoefficient = 0;
    if (globalSumMessages > 0 && totalSystemUsers > 0) {
      let absDiffSum = 0;
      for (let i = 0; i < totalSystemUsers; i++) {
        for (let j = 0; j < totalSystemUsers; j++) {
          absDiffSum += Math.abs(globalMessageCounts[i] - globalMessageCounts[j]);
        }
      }
      const meanMsg = globalSumMessages / totalSystemUsers;
      globalGiniCoefficient = absDiffSum / (2 * totalSystemUsers * totalSystemUsers * meanMsg);
    }

    const avgEntropyGlobal = entropyCountGlobal > 0 ? entropySumGlobal / entropyCountGlobal : 0;
    const deliberativeQualityGlobal = await analyzeDeliberativeMessagesWithLLM({
      messageRows: messages,
      userIds: allUserIds,
      getContextForMessage: deliberativeContextForMessage
    });

    function aggregateOpinionMixingStats(metricRows) {
      let weightedIndexSum = 0;
      let weightedCoverageSum = 0;
      let comparablePairs = 0;
      let totalComparableUsers = 0;
      let totalParticipants = 0;
      let rankingEvidenceUsers = 0;
      let pluralityEvidenceUsers = 0;

      for (const row of metricRows) {
        if (!row) continue;
        totalComparableUsers += row.comparableUsers || 0;
        totalParticipants += row.participantCount || 0;
        rankingEvidenceUsers += row.rankingEvidenceUsers || 0;
        pluralityEvidenceUsers += row.pluralityEvidenceUsers || 0;

        const weight = row.comparablePairs || 0;
        if (weight > 0) {
          weightedIndexSum += (row.opinionMixingIndex || 0) * weight;
          weightedCoverageSum += (row.opinionMixingCoverage || 0) * weight;
          comparablePairs += weight;
        }
      }

      return {
        opinionMixingIndex: comparablePairs > 0 ? Number((weightedIndexSum / comparablePairs).toFixed(4)) : 0,
        opinionMixingCoverage: comparablePairs > 0 ? Number((weightedCoverageSum / comparablePairs).toFixed(4)) : 0,
        comparableUsers: totalComparableUsers,
        participantCount: totalParticipants,
        comparablePairs,
        rankingEvidenceUsers,
        pluralityEvidenceUsers
      };
    }

    // Helper: Map messages & bot messages to active topics
    const pollsByRoom = {};
    for (const p of polls) {
      if (!pollsByRoom[p.room_id]) pollsByRoom[p.room_id] = [];
      pollsByRoom[p.room_id].push(p);
    }
    for (const rId in pollsByRoom) {
      pollsByRoom[rId].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }

    function getTopicForTimestamp(roomId, timestamp) {
      const roomPolls = pollsByRoom[roomId] || [];
      if (roomPolls.length === 0) return 'general-question';
      const time = new Date(timestamp).getTime();
      let activePoll = roomPolls[0];
      for (const p of roomPolls) {
        if (new Date(p.created_at).getTime() <= time) {
          activePoll = p;
        } else {
          break;
        }
      }
      return getNormalizedTopic(activePoll.suggestion, activePoll.question, activeTopics);
    }

    // ── Topic comparison data ──
    const topicOpinionMixingMetrics = [];
    const topicsComparison = await Promise.all(availableTopics.map(async (topic) => {
      const topicPolls = processedPolls.filter(p => p.suggestion === topic);
      const topicMessages = messages.filter(m => getTopicForTimestamp(m.room_id, m.timestamp) === topic);
      const topicBotMessages = botMessages.filter(b => getTopicForTimestamp(b.room_id, b.timestamp) === topic);
      // Population for this topic = union of participants of the rooms that discussed it.
      const topicRoomIds = new Set([...topicPolls.map(p => p.room_id), ...topicMessages.map(m => m.room_id)]);
      const topicUserIds = [...new Set([...topicRoomIds].flatMap((rid) => roomPopulations[rid] || []))];
      const topicPopulation = topicUserIds.length > 0 ? topicUserIds : allUserIds;

      const totalResolved = topicPolls.filter(p => p.isClosed || p.hasConsensus !== null).length;
      const totalPassed = topicPolls.filter(p => p.hasConsensus === 1).length;
      const passedPollsRatio = totalResolved > 0 ? totalPassed / totalResolved : 0;

      const entropyPolls = topicPolls.filter(p => p.votersCount > 0);
      const avgEntropy = entropyPolls.length > 0
        ? entropyPolls.reduce((sum, p) => sum + p.entropy, 0) / entropyPolls.length
        : 0;

      const totalWords = topicMessages.reduce((sum, m) => sum + m.wordCount, 0);
      const avgWordsPerMessage = topicMessages.length > 0
        ? Number((totalWords / topicMessages.length).toFixed(2))
        : 0;
      const deliberativeQuality = await analyzeDeliberativeMessagesWithLLM({
        messageRows: topicMessages,
        userIds: topicPopulation,
        getContextForMessage: deliberativeContextForMessage
      });

      const topicUserCounts = {};
      for (const uid of topicPopulation) topicUserCounts[uid] = 0;
      for (const m of topicMessages) {
        if (topicUserCounts[m.sender_id] !== undefined) topicUserCounts[m.sender_id]++;
      }
      const giniCoefficient = Number(calculateGini(Object.values(topicUserCounts)).toFixed(4));

      const switches = switchesByTopic[topic] || { switches: 0, opportunities: 0 };
      const optionSwitchRate = switches.opportunities > 0
        ? Number((switches.switches / switches.opportunities).toFixed(4))
        : 0;

      const opinionMixing = calculateOpinionMixingStats(topicPolls, votesByPoll, optionsByPoll);
      topicOpinionMixingMetrics.push(opinionMixing);

      const suggestionsCount = customOptionVotes.filter(v => {
        const p = processedPolls.find(pl => pl.id === v.poll_id);
        return p && p.suggestion === topic;
      }).length;

      return {
        topic,
        passedPollsRatio,
        avgEntropy,
        giniCoefficient,
        messageCount: topicMessages.length,
        botMessageCount: topicBotMessages.length,
        deliberativeQuality: deliberativeQuality.score,
        deliberativeQualityDimensions: deliberativeQuality.dimensions,
        optionSwitchRate,
        optionSwitches: switches.switches,
        avgWordsPerMessage,
        suggestionsCount,
        opinionMixingIndex: opinionMixing.opinionMixingIndex,
        opinionMixingCoverage: opinionMixing.opinionMixingCoverage,
        opinionMixingComparableUsers: opinionMixing.comparableUsers,
        opinionMixingComparablePairs: opinionMixing.comparablePairs,
        opinionMixingMethod: opinionMixing.rankingEvidenceUsers > 0 ? 'ranking+choice' : 'choice'
      };
    }));

    // ── Room comparison data ──
    const roomOpinionMixingMetrics = [];
    const roomsComparison = await Promise.all(rooms.map(async (room) => {
      const roomPolls = processedPolls.filter(p => p.room_id === room.id);
      const roomMessages = messages.filter(m => m.room_id === room.id);
      const roomBotMessages = botMessages.filter(b => b.room_id === room.id);

      const totalResolved = roomPolls.filter(p => p.isClosed || p.hasConsensus !== null).length;
      const totalPassed = roomPolls.filter(p => p.hasConsensus === 1).length;
      const passedPollsRatio = totalResolved > 0 ? totalPassed / totalResolved : 0;

      const entropyPolls = roomPolls.filter(p => p.votersCount > 0);
      const avgEntropy = entropyPolls.length > 0
        ? entropyPolls.reduce((sum, p) => sum + p.entropy, 0) / entropyPolls.length
        : 0;

      const totalWords = roomMessages.reduce((sum, m) => sum + m.wordCount, 0);
      const avgWordsPerMessage = roomMessages.length > 0
        ? Number((totalWords / roomMessages.length).toFixed(2))
        : 0;
      // Room-scoped population (members + contributors), not the whole user base.
      const roomPopulation = (roomPopulations[room.id] && roomPopulations[room.id].length > 0)
        ? roomPopulations[room.id]
        : allUserIds;
      const deliberativeQuality = await analyzeDeliberativeMessagesWithLLM({
        messageRows: roomMessages,
        userIds: roomPopulation,
        getContextForMessage: deliberativeContextForMessage
      });

      const roomUserCounts = {};
      for (const uid of roomPopulation) roomUserCounts[uid] = 0;
      for (const m of roomMessages) {
        if (roomUserCounts[m.sender_id] !== undefined) roomUserCounts[m.sender_id]++;
      }
      const giniCoefficient = Number(calculateGini(Object.values(roomUserCounts)).toFixed(4));

      const suggestionsCount = customOptionVotes.filter(v => {
        const p = processedPolls.find(pl => pl.id === v.poll_id);
        return p && p.room_id === room.id;
      }).length;

      const opinionMixing = calculateOpinionMixingStats(roomPolls, votesByPoll, optionsByPoll);
      roomOpinionMixingMetrics.push(opinionMixing);

      return {
        roomId: room.id,
        roomName: room.name,
        roomType: room.room_type,
        passedPollsRatio,
        avgEntropy,
        giniCoefficient,
        messageCount: roomMessages.length,
        botMessageCount: roomBotMessages.length,
        deliberativeQuality: deliberativeQuality.score,
        deliberativeQualityDimensions: deliberativeQuality.dimensions,
        optionSwitchRate: null,
        optionSwitches: null,
        avgWordsPerMessage,
        suggestionsCount,
        opinionMixingIndex: opinionMixing.opinionMixingIndex,
        opinionMixingCoverage: opinionMixing.opinionMixingCoverage,
        opinionMixingComparableUsers: opinionMixing.comparableUsers,
        opinionMixingComparablePairs: opinionMixing.comparablePairs,
        opinionMixingMethod: opinionMixing.rankingEvidenceUsers > 0 ? 'ranking+choice' : 'choice'
      };
    }));

    // ── Sankey data ──
    const sankeyData = {};
    const finalDecisionPolls = allPolls.filter(p => {
      const topic = getNormalizedTopic(p.suggestion, p.question, activeTopics);
      return topic === 'general-question' && !(p.question.includes('open') || p.question.includes('debate'));
    });

    for (const p of allPolls) {
      const topic = getNormalizedTopic(p.suggestion, p.question, activeTopics);
      if (topic === 'general-question') continue;
      if (!sankeyData[topic]) sankeyData[topic] = {};
      const roomId = p.room_id;
      const room = roomById[roomId];
      const roomName = room ? room.name : `Room ${roomId}`;
      if (!sankeyData[topic][roomId]) {
        sankeyData[topic][roomId] = {
          roomId,
          roomName,
          roomType: room ? room.room_type : 'group',
          polls: [],
          userVotes: {}
        };
      }
      const sankeyPoll = { ...p, suggestion: topic };
      sankeyData[topic][roomId].polls.push(sankeyPoll);
    }

    for (const topic in sankeyData) {
      for (const roomId in sankeyData[topic]) {
        const roomData = sankeyData[topic][roomId];

        const roomFinalPolls = finalDecisionPolls.filter(fp => fp.room_id === Number(roomId));
        for (const fp of roomFinalPolls) {
          roomData.polls.push({
            ...fp,
            suggestion: topic,
            isFinalDecision: true
          });
        }

        roomData.polls.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

        // Prepend virtual personal poll
        const personalPoll = {
          id: `personal_${topic}_${roomId}`,
          room_id: Number(roomId),
          question: 'Initial preferences from personal rooms',
          created_at: new Date(0).toISOString(),
          poll_type: 'plurality',
          suggestion: topic,
          isPersonalPhase: true
        };
        roomData.polls.unshift(personalPoll);

        const roomMembers = db.prepare(`
          SELECT DISTINCT u.id, u.username
          FROM users u
          LEFT JOIN room_members rm ON u.id = rm.user_id AND rm.room_id = ?
          LEFT JOIN messages m ON u.id = m.sender_id AND m.room_id = ?
          LEFT JOIN poll_votes pv ON u.id = pv.user_id AND pv.poll_id IN (SELECT id FROM polls WHERE room_id = ?)
          WHERE u.is_admin = 0 AND (rm.room_id IS NOT NULL OR m.room_id IS NOT NULL OR pv.poll_id IS NOT NULL)
        `).all(roomId, roomId, roomId);

        for (const m of roomMembers) {
          roomData.userVotes[m.id] = {
            username: m.username,
            votes: []
          };
        }

        for (const poll of roomData.polls) {
          if (poll.isPersonalPhase) {
            for (const memberId in roomData.userVotes) {
              const gAnswer = db.prepare(`
                SELECT ga.answer_text, ga.matched_predefined_answer, gq.predefined_answers_json
                FROM gathering_answers ga
                JOIN gathering_questions gq ON gq.id = ga.question_id
                WHERE ga.user_id = ? AND gq.topic = ?
              `).get(Number(memberId), topic);

              let pref = '';
              if (gAnswer) {
                pref = gAnswer.matched_predefined_answer;
                if (!pref && gAnswer.predefined_answers_json && gAnswer.answer_text) {
                  let options = [];
                  try {
                    options = JSON.parse(gAnswer.predefined_answers_json);
                  } catch (e) {}

                  let maxOverlap = 0;
                  let bestOption = '';
                  const stopWords = new Set([
                    'whether', 'should', 'come', 'from', 'the', 'and', 'for', 'to', 'a', 'in', 'of',
                    'on', 'with', 'at', 'by', 'an', 'be', 'is', 'are', 'was', 'were', 'or', 'about',
                    'how', 'which', 'what', 'who', 'whom', 'this', 'that', 'these', 'those'
                  ]);
                  const getWords = (text) => {
                    return String(text || '').toLowerCase()
                      .replace(/[^\w\s-]/g, ' ')
                      .split(/\s+/)
                      .filter(w => w.length > 2 && !stopWords.has(w));
                  };
                  const answerWords = getWords(gAnswer.answer_text);
                  for (const opt of options) {
                    const optWords = getWords(opt);
                    let overlap = 0;
                    for (const w of answerWords) {
                      if (optWords.includes(w)) overlap++;
                    }
                    if (overlap > maxOverlap) {
                      maxOverlap = overlap;
                      bestOption = opt;
                    }
                  }
                  if (maxOverlap > 0) {
                    pref = bestOption;
                  }
                }
              }

              roomData.userVotes[memberId].votes.push({
                pollId: poll.id,
                optionText: pref || 'Did Not Vote'
              });
            }
            continue;
          }

	          const pollVotes = votesByPoll[poll.id] || [];
	          const pollOptions = optionsByPoll[poll.id] || [];
	          const optMap = {};
	          for (const opt of pollOptions) optMap[opt.id] = opt.option_text;
	          const customOtherByUser = {};
	          const customOtherTexts = [];
	          for (const v of pollVotes) {
	            const customText = typeof v.custom_option_text === 'string' ? v.custom_option_text.trim() : '';
	            if (!customText) continue;
	            customOtherByUser[v.user_id] = customText;
	            customOtherTexts.push(customText);
	          }
	          const getVoteDisplayText = (vote) => {
	            const optionText = optMap[vote.option_id];
	            if (!optionText) return optionText;
	            if (optionText.toLowerCase() !== 'other') return optionText;
	            const directCustomText = typeof vote.custom_option_text === 'string' ? vote.custom_option_text.trim() : '';
	            return directCustomText || customOtherByUser[vote.user_id] || customOtherTexts[0] || optionText;
	          };

	          const userTopVote = {};
	          if (poll.poll_type === 'ranking') {
	            for (const v of pollVotes) {
	              const displayText = getVoteDisplayText(v);
	              if (v.rank === 1 && displayText) {
	                userTopVote[v.user_id] = displayText;
	              }
	            }
	          } else if (poll.poll_type === 'swipe') {
	            const userApproved = {};
	            const userAnySwipe = new Set();
	            for (const v of pollVotes) {
	              userAnySwipe.add(v.user_id);
	              const displayText = getVoteDisplayText(v);
	              if (v.swipe_direction === 'right' && displayText) {
	                if (!userApproved[v.user_id]) userApproved[v.user_id] = [];
	                userApproved[v.user_id].push(displayText);
	              }
	            }
            for (const memberId in roomData.userVotes) {
              const uId = Number(memberId);
              if (userApproved[uId] && userApproved[uId].length > 0) {
                userApproved[uId].sort();
                userTopVote[uId] = userApproved[uId].join(', ');
              } else if (userAnySwipe.has(uId)) {
                userTopVote[uId] = 'Rejected All';
              }
            }
	          } else {
	            for (const v of pollVotes) {
	              const displayText = getVoteDisplayText(v);
	              if (displayText) {
	                userTopVote[v.user_id] = displayText;
	              }
	            }
	          }

          for (const memberId in roomData.userVotes) {
            const voteText = userTopVote[memberId] || 'Did Not Vote';
            roomData.userVotes[memberId].votes.push({
              pollId: poll.id,
              optionText: voteText
            });
          }
        }
      }
    }

    const aggregatedOpinionMixing = aggregateOpinionMixingStats(topicOpinionMixingMetrics);

    throwIfWorkCancelled();
    return res.json({
      experimentActive: isExperimentActive,
      summary: {
        totalPolls,
        totalRankingPolls: totalRanking,
        totalResolvedPolls: totalResolved,
        totalPassedPolls: totalPassedGlobal,
        passedPollsRatio: totalResolved > 0 ? totalPassedGlobal / totalResolved : 0,
        failedPolls: totalFailed,
        failedPollsRatio: totalPolls > 0 ? totalFailed / totalPolls : 0,
        tiePolls: totalTies,
        tiePollsRatio: totalPolls > 0 ? totalTies / totalPolls : 0,
        avgEntropy: avgEntropyGlobal,
        globalGiniCoefficient: Number(globalGiniCoefficient.toFixed(4)),
        deliberativeQuality: {
          score: deliberativeQualityGlobal.score,
          messageCount: deliberativeQualityGlobal.messageCount,
          dimensions: deliberativeQualityGlobal.dimensions,
          weights: deliberativeQualityGlobal.weights,
          method: deliberativeQualityGlobal.method,
          analyzedMessages: deliberativeQualityGlobal.analyzedMessages,
          sourceBreakdown: deliberativeQualityGlobal.sourceBreakdown
        },
        totalMessages: messages.length,
        avgWordsPerMessage: avgWordsPerMessageGlobal,
        totalBotMessages,
        totalUsers: totalSystemUsers,
        // Topic-level follow-up stats
        topicsCount,
        topicsPassedFirstTry,
        firstTrySuccessRate: Number(firstTrySuccessRate.toFixed(4)),
        avgVotesPerTopic: Number(avgVotesPerTopic.toFixed(2)),
        avgPollsPerTopic: Number(avgPollsPerTopic.toFixed(2)),
        // Custom suggestion stats
        totalSuggestions,
        uniqueSuggestionsCount,
        suggestionsWon,
        newOptionsSuggested: {
          total: totalSuggestions,
          analyzed: totalSuggestions,
          extensionCount: newOptionCounts.extension,
          contradictionCount: newOptionCounts.contradiction,
          combinationCount: newOptionCounts.combination,
          unrelatedCount: newOptionCounts.unrelated,
          extensionRate: totalSuggestions > 0 ? Number((newOptionCounts.extension / totalSuggestions).toFixed(4)) : 0,
          contradictionRate: totalSuggestions > 0 ? Number((newOptionCounts.contradiction / totalSuggestions).toFixed(4)) : 0,
          combinationRate: totalSuggestions > 0 ? Number((newOptionCounts.combination / totalSuggestions).toFixed(4)) : 0,
          unrelatedRate: totalSuggestions > 0 ? Number((newOptionCounts.unrelated / totalSuggestions).toFixed(4)) : 0
        },
        proactiveness: {
          total: proactivenessTotal,
          supportCount: proactivenessCounts.support || 0,
          oppositionCount: proactivenessCounts.opposition || 0,
          modificationCount: proactivenessCounts.modification || 0,
          mitigationCount: proactivenessCounts.mitigation || 0,
          neutralCount: proactivenessCounts.neutral || 0,
          supportRate: proactivenessTotal > 0 ? Number(((proactivenessCounts.support || 0) / proactivenessTotal).toFixed(4)) : 0,
          oppositionRate: proactivenessTotal > 0 ? Number(((proactivenessCounts.opposition || 0) / proactivenessTotal).toFixed(4)) : 0,
          modificationRate: proactivenessTotal > 0 ? Number(((proactivenessCounts.modification || 0) / proactivenessTotal).toFixed(4)) : 0,
          mitigationRate: proactivenessTotal > 0 ? Number(((proactivenessCounts.mitigation || 0) / proactivenessTotal).toFixed(4)) : 0,
          neutralRate: proactivenessTotal > 0 ? Number(((proactivenessCounts.neutral || 0) / proactivenessTotal).toFixed(4)) : 0,
          rate: proactivenessRate,
          propositiveUsersAnalyzed: proactivenessUsersAnalyzed,
          propositiveUsersCount: proactivenessUsersMorePropositive,
          propositiveUsersRate: proactivenessUsersRate
        },
        // Constructiveness of custom "Other" options (LLM-classified), distinct from the
        // message-level proactiveness block above.
        constructiveProposal: (() => {
          const total =
            (constructiveCounts.support || 0) +
            (constructiveCounts.opposition || 0) +
            (constructiveCounts.modification || 0) +
            (constructiveCounts.mitigation || 0) +
            (constructiveCounts.neutral || 0);
          const nonNeutral = total - (constructiveCounts.neutral || 0);
          const rate = nonNeutral > 0
            ? Number((((constructiveCounts.modification || 0) + (constructiveCounts.mitigation || 0)) / nonNeutral).toFixed(4))
            : 0;
          return {
            total,
            supportCount: constructiveCounts.support || 0,
            oppositionCount: constructiveCounts.opposition || 0,
            modificationCount: constructiveCounts.modification || 0,
            mitigationCount: constructiveCounts.mitigation || 0,
            neutralCount: constructiveCounts.neutral || 0,
            supportRate: total > 0 ? Number(((constructiveCounts.support || 0) / total).toFixed(4)) : 0,
            oppositionRate: total > 0 ? Number(((constructiveCounts.opposition || 0) / total).toFixed(4)) : 0,
            modificationRate: total > 0 ? Number(((constructiveCounts.modification || 0) / total).toFixed(4)) : 0,
            mitigationRate: total > 0 ? Number(((constructiveCounts.mitigation || 0) / total).toFixed(4)) : 0,
            neutralRate: total > 0 ? Number(((constructiveCounts.neutral || 0) / total).toFixed(4)) : 0,
            rate,
            propositiveUsersAnalyzed: constructiveProposalUsersAnalyzed,
            propositiveUsersCount: constructiveProposalUsersMorePropositive,
            propositiveUsersRate: constructiveProposalUsersAnalyzed > 0
              ? Number((constructiveProposalUsersMorePropositive / constructiveProposalUsersAnalyzed).toFixed(4))
              : 0,
            byUser: constructiveProposalByUser
          };
        })(),
        // Option switching stats
        totalOptionSwitches,
        totalSwitchOpportunities,
        optionSwitchRate,
        opinionMixingIndex: aggregatedOpinionMixing.opinionMixingIndex,
        opinionMixingCoverage: aggregatedOpinionMixing.opinionMixingCoverage,
        opinionMixingComparableUsers: aggregatedOpinionMixing.comparableUsers,
        opinionMixingComparablePairs: aggregatedOpinionMixing.comparablePairs
      },
      // Filter metadata for frontend selectors
      filters: {
        availableTopics: availableTopics.sort(),
        availableRoomTypes: [...allRoomTypesSet].sort(),
        activeTopic: filterTopic,
        activeRoomType: filterRoomType
      },
      timeSeries,
      topicsComparison,
      roomsComparison,
      sankeyData,
      polls: processedPolls
    });
  } catch (error) {
    if (error.name === 'AbortError') return;
    return res.status(500).json({ error: error.message });
  }
}, 'quality'));

router.get('/decision-process/recap-details', async (_req, res) => {
  try {
    const detailed = await getDetailedConvergenceRecap(2);
    return res.json({ detailed });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Download the current run's stored records and cached analyses. This endpoint is intentionally
// synchronous and database-only: downloading data must never start a quality-analysis LLM call.
router.get('/decision-process/export', (req, res) => {
  try {
    const exportData = buildComputedRunExport();
    const runId = exportData.manifest.decisionRunId || 'no-run';
    const safeRunId = String(runId).replace(/[^a-z0-9-]/gi, '').slice(0, 32) || 'no-run';
    const filename = `cime-computed-run-${safeRunId}.json`;
    res.set({
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store'
    });
    return res.send(JSON.stringify(exportData, null, 2));
  } catch (error) {
    console.error('Failed to export computed run data:', error);
    return res.status(500).json({ error: `Failed to export computed run data: ${error.message}` });
  }
});

router.get('/monitoring', (req, res) => {
  try {
    const rooms = db.prepare(`
      SELECT id, name, room_type, is_active, timer_expires_at, topic_memory_json, collection_complete
      FROM rooms
      WHERE room_type IN ('group', 'convergence')
      ORDER BY id DESC
    `).all();

    const activeTopics = db.prepare('SELECT topic, question_text FROM gathering_questions WHERE is_general_question = 0').all();

    const result = rooms.map(room => {
      const members = db.prepare(`
        SELECT u.id, u.username, u.is_admin
        FROM users u
        JOIN room_members rm ON rm.user_id = u.id
        WHERE rm.room_id = ?
      `).all(room.id);
      
      const humanNicknames = members.filter(m => m.is_admin === 0).map(m => m.username);
      
      let memory = [];
      try {
        memory = JSON.parse(room.topic_memory_json || '[]');
      } catch (e) {}

      const resolvedTopics = memory
        .filter(t => t.status === 'resolved')
        .map(t => {
          const rawTopic = t.suggestion || t.key || t.topic || '';
          const normalized = getNormalizedTopic(rawTopic, rawTopic, activeTopics);
          return {
            topic: normalized,
            decision: t.decision || t.summary || 'Resolved'
          };
        });

      const unresolvedTopics = memory
        .filter(t => t.status !== 'resolved')
        .map(t => {
          const rawTopic = t.suggestion || t.key || t.topic || '';
          return getNormalizedTopic(rawTopic, rawTopic, activeTopics);
        });

      const polls = db.prepare(`
        SELECT suggestion, question, COUNT(*) as count
        FROM polls
        WHERE room_id = ?
        GROUP BY suggestion, question
      `).all(room.id);

      const votingAttempts = {};
      polls.forEach(p => {
        const normalized = getNormalizedTopic(p.suggestion, p.question, activeTopics);
        votingAttempts[normalized] = (votingAttempts[normalized] || 0) + p.count;
      });

      let timeLeftSeconds = 0;
      if (room.is_active === 1 && room.timer_expires_at) {
        const diffMs = new Date(room.timer_expires_at).getTime() - Date.now();
        timeLeftSeconds = Math.max(0, Math.ceil(diffMs / 1000));
      }

      return {
        id: room.id,
        name: room.name,
        room_type: room.room_type,
        is_active: room.is_active === 1,
        collection_complete: room.collection_complete === 1,
        timeLeftSeconds,
        membersCount: humanNicknames.length,
        membersNicknames: humanNicknames,
        resolvedTopics,
        unresolvedTopics,
        votingAttempts
      };
    });

    return res.json({ rooms: result });
  } catch (error) {
    return res.status(500).json({ error: `Failed to fetch monitoring status: ${error.message}` });
  }
});

router.post('/rooms/:roomId/showdown', async (req, res) => {
  const roomId = Number(req.params.roomId);
  try {
    db.prepare('UPDATE system_state SET showdown_initiated = 1 WHERE id = 1').run();
    await forceShowdownForRoom(roomId);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: `Failed to trigger showdown for room: ${error.message}` });
  }
});

router.get('/llm-logs', (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const logs = db
      .prepare(
        `SELECT id, created_at, room_id, caller, prompt, response, tokens_used, model,
                input_tokens, output_tokens, cached_input_tokens, reasoning_tokens, session_id, work_type
         FROM llm_logs
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit);
    return res.json(logs);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

export default router;
