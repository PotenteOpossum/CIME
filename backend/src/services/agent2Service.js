import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../config/env.js';
import { db, ensureAdminsInRoom } from '../config/db.js';
import { clusteringPublicReason, describeDecisionSettings, getAgentPrompt, getDecisionSettings, renderTemplate, settingToRoomTimerMinutes, getConfiguredModels } from './agentConfigService.js';
import { appendAgentEvent } from './decisionLogService.js';
import client from './llm.js';
import { getGroupingSeed } from './decisionWorkService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const promptsDir = path.join(__dirname, '../../prompts');
// client imported from llm.js

function ensurePromptsDir() {
  if (!fs.existsSync(promptsDir)) fs.mkdirSync(promptsDir, { recursive: true });
}

function sanitizeFileName(filename) {
  const safe = filename?.trim();
  if (!safe || !/^[a-zA-Z0-9._-]+\.md$/.test(safe)) {
    throw new Error('Invalid markdown filename');
  }
  return safe;
}

export function listPromptFiles() {
  ensurePromptsDir();
  return fs.readdirSync(promptsDir).filter((n) => /^[a-zA-Z0-9._-]+\.md$/.test(n)).sort();
}

export function createPromptFile({ filename, content }) {
  ensurePromptsDir();
  const safe = sanitizeFileName(filename);
  if (typeof content !== 'string' || !content.trim()) throw new Error('Invalid content');
  const target = path.join(promptsDir, safe);
  if (fs.existsSync(target)) throw new Error('Prompt file already exists');
  fs.writeFileSync(target, content, 'utf-8');
  return safe;
}

export function loadPromptMarkdown(filename) {
  ensurePromptsDir();
  const safe = sanitizeFileName(filename || 'default.md');
  const target = path.join(promptsDir, safe);
  if (!fs.existsSync(target)) {
    const fallback = path.join(promptsDir, 'default.md');
    if (fs.existsSync(fallback)) return fs.readFileSync(fallback, 'utf-8');
    return renderTemplate('agent1-templates.md#Agent1 Fallback');
  }
  return fs.readFileSync(target, 'utf-8');
}

export function logAgentEvent(agentKey, summary, detail = '') {
  db.prepare('INSERT INTO agent_events (agent_key, summary, detail, created_at) VALUES (?, ?, ?, ?)').run(
    agentKey,
    summary,
    detail,
    new Date().toISOString()
  );
  appendAgentEvent(agentKey, summary, detail);
}

export function getAgentInstructions(agentKey) {
  return db.prepare('SELECT instructions FROM agent_instructions WHERE agent_key = ?').get(agentKey)?.instructions || '';
}

export function saveAgentInstruction(agentKey, instruction) {
  const trimmed = String(instruction || '').trim();
  if (!trimmed) return getAgentInstructions(agentKey);
  const existing = getAgentInstructions(agentKey);
  const next = existing ? `${existing}\n- ${trimmed}` : `- ${trimmed}`;
  db.prepare(
    `
    INSERT INTO agent_instructions (agent_key, instructions, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(agent_key) DO UPDATE SET
      instructions = excluded.instructions,
      updated_at = excluded.updated_at
  `
  ).run(agentKey, next, new Date().toISOString());
  logAgentEvent(agentKey, 'Admin added guidance', trimmed);
  return next;
}

function getGeneralDescription() {
  return db.prepare('SELECT general_description FROM system_state WHERE id = 1').get()?.general_description || '';
}

/** Turn the formal decision question into a short subject for personal onboarding. */
export function buildDecisionSubject(globalQuestion, decisionContext = '', generalDescription = '') {
  let subject = String(globalQuestion || '').replace(/\s+/g, ' ').trim();
  if (!subject) {
    subject = String(generalDescription || decisionContext || 'the decision').replace(/\s+/g, ' ').trim();
  }
  subject = subject.replace(/[.!?]+$/, '').trim();
  subject = subject.replace(/^(do you support|would you support|are you in favor of|are you for)\s+/i, '');
  subject = subject.replace(/\s+according to the changes agreed during this consultation$/i, ' and how it could change');
  subject = subject.replace(/^renovating\s+(.+)$/i, 'the renovation of $1');
  if (!subject) return 'the decision';
  return subject.charAt(0).toLowerCase() + subject.slice(1);
}

// A simulation may intentionally use only a subset of the participant accounts.
// Returning null keeps the normal decision-process behavior: every non-admin user
// is in scope. An empty array is meaningful and represents a simulation with no
// selected agents, which callers can handle without silently falling back to all users.
export function getSimulationParticipantIds() {
  if (global.isSimulationRunning && global.simulatedPersonas && typeof global.simulatedPersonas === 'object') {
    return [...new Set(
      Object.keys(global.simulatedPersonas)
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    )];
  }

  // The simulation route persists its participant scope before it starts the
  // asynchronous personal-room setup. This closes the race in which Agent 3
  // could run during setup while the in-memory simulation globals were still
  // unset and accidentally inspect every seeded account.
  const state = db.prepare(`
    SELECT current_phase, decision_run_mode, decision_run_participant_ids_json
    FROM system_state
    WHERE id = 1
  `).get();
  if (state?.decision_run_mode !== 'simulation' || !['gathering', 'discussing'].includes(state.current_phase)) {
    return null;
  }
  try {
    const ids = JSON.parse(state.decision_run_participant_ids_json || '[]');
    return Array.isArray(ids)
      ? [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
      : [];
  } catch {
    return [];
  }
}

export async function generatePreferencePrompt(globalQuestion, decisionContext = '', proposed = {}) {
  const generalDescription = proposed.generalDescription ?? getGeneralDescription();
  const extra = proposed.adminGuidance ?? getAgentInstructions('agent1');
  const basePrompt = getAgentPrompt('agent1');
  const settings = getDecisionSettings();
  const settingsText = describeDecisionSettings(settings);
  const gatheringQuestions = proposed.questions ?? db
    .prepare('SELECT id, topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY question_order ASC, id ASC')
    .all();
  let gatheringQuestionsText = 'None generated.';
  if (gatheringQuestions.length > 0) {
    gatheringQuestionsText = gatheringQuestions.map((q, i) => {
      let answers = [];
      try {
        answers = Array.isArray(q.predefined_answers_json) ? q.predefined_answers_json : JSON.parse(q.predefined_answers_json || '[]');
      } catch {
        answers = [];
      }
      const answerText = answers.length ? ` Answers: ${answers.join(' | ')}` : '';
      const generalTag = q.is_general_question === 1 ? ' (general question)' : '';
      return `${i + 1}. [${q.topic}] ${q.question_text}${generalTag}${answerText}`;
    }).join('\n');
  }

  const sharedCollectionPolicy = renderTemplate('agent2-templates.md#Shared Collection Policy', {
    gathering_questions: gatheringQuestionsText
  });
  const sharedPhase1CollectionPolicy = renderTemplate('agent2-templates.md#Shared Phase 1 Collection Policy', {
    global_question: globalQuestion,
    decision_context: decisionContext || 'No additional context provided.',
          general_description: generalDescription,
    shared_collection_policy: sharedCollectionPolicy
  });
  const adminGuidanceSection = extra ? `## Admin Guidance\n${extra}` : '';
  if (!client) {
    return renderTemplate('agent2-templates.md#Preference Prompt Final', {
      agent1_prompt: basePrompt,
      shared_collection_policy: sharedPhase1CollectionPolicy,
      generated_instructions: 'Follow the shared collection policy above.',
      settings: settingsText,
      admin_guidance_section: adminGuidanceSection
    });
  }

  const res = await client.chat.completions.create({
    model: getConfiguredModels().primaryModel,
    temperature: 0.3,
    max_completion_tokens: 500,
    messages: [
      {
        role: 'system',
        content: renderTemplate('agent2-templates.md#Preference Prompt Generation System', {
          agent2_prompt: getAgentPrompt('agent2')
        })
      },
      {
        role: 'user',
        content: renderTemplate('agent2-templates.md#Preference Prompt Generation User', {
          agent1_prompt: basePrompt,
          shared_collection_policy: sharedPhase1CollectionPolicy,
          settings: settingsText,
          decision_context: decisionContext || 'No additional context provided.',
          general_description: generalDescription,
          admin_guidance: extra || 'none',
          gathering_questions: gatheringQuestionsText
        })
      }
    ],
    metadata: { caller: 'agent2-preference-prompt' }
  });

  const generated = res.choices?.[0]?.message?.content?.trim();
  return renderTemplate('agent2-templates.md#Preference Prompt Final', {
    agent1_prompt: basePrompt,
    shared_collection_policy: sharedPhase1CollectionPolicy,
    generated_instructions: generated || 'Follow the shared collection policy above.',
    settings: settingsText,
    admin_guidance_section: adminGuidanceSection
  });
}

export function applyRoomTimer(roomId, minutes) {
  const cleanMinutes = Math.max(1, Number(minutes) || 1);
  const expiresAt = new Date(Date.now() + cleanMinutes * 60 * 1000).toISOString();
  db.prepare('UPDATE rooms SET room_timer_minutes = ?, timer_expires_at = ?, opened_at = ? WHERE id = ?')
    .run(cleanMinutes, expiresAt, new Date().toISOString(), roomId);
  return expiresAt;
}

export function getDecisionStatus() {
  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase, discussion_round FROM system_state WHERE id = 1').get();
  const questions = db
    .prepare(
      `
      SELECT id, topic, question_text, question_order, predefined_answers_json, is_general_question, created_at
      FROM gathering_questions
      ORDER BY question_order ASC, id ASC
    `
    )
    .all()
    .map((row) => ({
      ...row,
      is_general_question: row.is_general_question === 1,
      predefined_answers: (() => {
        try {
          return Array.isArray(row.predefined_answers_json) ? row.predefined_answers_json : JSON.parse(row.predefined_answers_json || '[]');
        } catch {
          return [];
        }
      })()
    }));
  const simulationParticipantIds = getSimulationParticipantIds();
  const allParticipantIds = db.prepare('SELECT id FROM users WHERE is_admin = 0').all().map((row) => row.id);
  const participantIdSet = simulationParticipantIds === null
    ? null
    : new Set(simulationParticipantIds);
  const participantIds = participantIdSet === null
    ? allParticipantIds
    : allParticipantIds.filter((id) => participantIdSet.has(id));
  const completedParticipantIds = db
    .prepare(
      `
      SELECT DISTINCT u.id
      FROM users u
      JOIN room_members rm ON rm.user_id = u.id
      JOIN rooms r ON r.id = rm.room_id
      WHERE u.is_admin = 0
        AND r.room_type = 'personal'
        AND r.name = u.username || '-personal'
        AND COALESCE(r.collection_complete, 0) = 1
      `
    )
    .all()
    .map((row) => row.id);
  const completedParticipantSet = new Set(completedParticipantIds);
  const total = participantIds.length;
  const completed = participantIds.filter((id) => completedParticipantSet.has(id)).length;
  const latestEvents = db
    .prepare(
      `
      SELECT agent_key, summary, detail, created_at
      FROM agent_events
      ORDER BY id DESC
      LIMIT 100
    `
    )
    .all();
  const agentMeta = [
    {
      key: 'agent1',
      name: 'Agent 1',
      role: 'Conversational Agent',
      doing:
        state?.current_phase === 'gathering'
          ? 'Collecting personal preferences'
          : state?.current_phase === 'discussing'
            ? 'Hosting the group discussion'
            : 'Waiting for an active decision phase',
      why: 'It talks with users and follows the active room prompt.'
    },
    {
      key: 'agent2',
      name: 'Agent 2',
      role: 'Coordination Agent',
      doing:
        state?.current_phase === 'gathering'
          ? 'Managing the personal-chat strategy'
          : state?.current_phase === 'discussing'
            ? 'Maintaining the group discussion strategy'
            : 'Waiting for kickoff',
      why: 'It creates prompts, activates rooms, and adjusts strategy.'
    },
    {
      key: 'agent3',
      name: 'Agent 3',
      role: 'Quality Agent',
      doing:
        state?.current_phase === 'gathering'
          ? 'Checking whether each user has provided enough information'
          : state?.current_phase === 'discussing'
            ? 'Watching for vote readiness and resolving polls'
            : 'Monitoring the process state',
      why: 'It controls phase transitions, poll creation, and closure decisions.'
    }
  ];
  return {
    global_question: state?.global_question || '',
    decision_context: state?.decision_context || '',
    general_description: state?.general_description || '',
    current_phase: state?.current_phase || 'idle',
    discussion_round: state?.discussion_round || 0,
    process_started_at: questions[0]?.created_at || null,
    deliberation_questions: questions,
    phase1: { completed, total },
    settings: getDecisionSettings(),
    agents: agentMeta.map((agent) => ({
      ...agent,
      instructions: getAgentInstructions(agent.key),
      events: latestEvents.filter((event) => event.agent_key === agent.key).slice(0, 20)
    }))
  };
}

export function emitDecisionStatus(io) {
  if (io) io.emit('decision_process_updated', getDecisionStatus());
}

export function assignPromptToPersonalRooms(promptMarkdown, globalQuestion, io = null, participantIds = null) {
  const firstQuestion = db
    .prepare(
      `
      SELECT id, question_text, topic
      FROM gathering_questions
      WHERE is_general_question = 0
      ORDER BY question_order ASC, id ASC
      LIMIT 1
    `
    )
    .get();
  const scopedParticipantIds = Array.isArray(participantIds)
    ? [...new Set(participantIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))]
    : null;
  const participantScopeSql = scopedParticipantIds === null
    ? ''
    : scopedParticipantIds.length > 0
      ? `AND u.id IN (${scopedParticipantIds.map(() => '?').join(',')})`
      : 'AND 1 = 0';
  const rooms = db
    .prepare(
      `
      SELECT r.id AS room_id, u.id AS user_id, u.username
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE r.room_type = 'personal'
        AND u.is_admin = 0
        AND r.name = u.username || '-personal'
        ${participantScopeSql}
      ORDER BY u.username ASC
    `
    )
    .all(...(scopedParticipantIds || []));

  const updateRoom = db.prepare('UPDATE rooms SET system_prompt = ?, is_active = 1, collection_complete = 0, collection_banner = \'\' WHERE id = ?');
  const setCurrentQuestion = db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?');
  const clearMessages = db.prepare('DELETE FROM messages WHERE room_id = ?');
  const insertMessage = db.prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)');
  const resetUsers = db.prepare("UPDATE users SET extracted_preferences = '' WHERE is_admin = 0");
  const decisionState = db.prepare('SELECT decision_context, general_description FROM system_state WHERE id = 1').get();
  const decisionSubject = buildDecisionSubject(globalQuestion, decisionState?.decision_context, decisionState?.general_description);

  const messages = db.transaction(() => {
    if (scopedParticipantIds !== null) {
      // A simulation intentionally uses a subset of accounts. Reset the
      // lifecycle flags of every other personal room so stale completed rooms
      // from an older run cannot satisfy the gathering barrier.
      db.prepare(`
        UPDATE rooms
        SET is_active = 0,
            collection_complete = 0,
            collection_banner = '',
            current_gathering_question_id = NULL,
            gathering_retry_count = 0,
            timer_expires_at = NULL,
            room_timer_minutes = 0
        WHERE room_type = 'personal'
      `).run();
    }
    resetUsers.run();
    db.prepare('DELETE FROM room_decisions').run();
    db.prepare('DELETE FROM room_status').run();
    db.prepare('DELETE FROM user_topic_preferences').run();
    db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type = 'group')").run();
    db.prepare("UPDATE rooms SET is_active = 0, decision_round = 0, collection_complete = 0, collection_banner = '', room_timer_minutes = 0, timer_expires_at = NULL, topic_memory_json = '[]' WHERE room_type = 'group'").run();
    const created = [];
    for (const room of rooms) {
      updateRoom.run(promptMarkdown, room.room_id);
      setCurrentQuestion.run(firstQuestion?.id || null, room.room_id);
      applyRoomTimer(room.room_id, settingToRoomTimerMinutes());
      clearMessages.run(room.room_id);
      const text = renderTemplate('agent2-templates.md#Personal Start Message', {
        username: room.username,
        global_question: globalQuestion,
        decision_subject: decisionSubject,
        first_question: firstQuestion?.question_text || globalQuestion,
        first_topic: firstQuestion?.topic || 'the decision'
      });
      const timestamp = new Date().toISOString();
      const result = insertMessage.run(room.room_id, text, timestamp);
      created.push({
        id: Number(result.lastInsertRowid),
        room_id: room.room_id,
        sender_id: null,
        sender_name: 'Bot',
        text,
        timestamp,
        is_bot: true,
        timer_expires_at: null
      });
    }
    return created;
  })();

  for (const message of messages) {
    if (io) io.to(`room:${message.room_id}`).emit('receive_message', message);
  }
  if (io) io.emit('rooms_updated');
  logAgentEvent('agent2', 'Started decision process', `Global question: ${globalQuestion}`);
  logAgentEvent('agent1', 'Opened personal chats', `Started ${messages.length} personal preference conversations.`);
  emitDecisionStatus(io);
  return messages;
}

export function createOrGetGlobalDiscussionRoom() {
  const existing = db.prepare('SELECT id FROM rooms WHERE name = ?').get('Global Discussion');
  if (existing) {
    db.prepare("UPDATE rooms SET is_active = 1, room_type = 'group' WHERE id = ?").run(existing.id);
    applyRoomTimer(existing.id, settingToRoomTimerMinutes());
    return existing.id;
  }

  const inserted = db
    .prepare(
      "INSERT INTO rooms (name, room_type, is_active, system_prompt, prompt_file) VALUES (?, 'group', 1, ?, 'default.md')"
    )
    .run('Global Discussion', renderTemplate('agent2-templates.md#Mediator Initial Prompt'));
  const roomId = Number(inserted.lastInsertRowid);
  applyRoomTimer(roomId, settingToRoomTimerMinutes());
  return roomId;
}

export function addAllUsersToRoom(roomId) {
  const simulationParticipantIds = getSimulationParticipantIds();
  const users = db.prepare('SELECT id FROM users WHERE is_admin = 0').all()
    .filter((user) => simulationParticipantIds === null || simulationParticipantIds.includes(user.id));
  const insertMember = db.prepare(
    'INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING'
  );
  const tx = db.transaction(() => {
    for (const user of users) insertMember.run(user.id, roomId);
  });
  tx();
}

function stableAlphabeticalSort(users) {
  return [...users].sort((a, b) => {
    const nameA = String(a.username || '').toLowerCase();
    const nameB = String(b.username || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

function chooseRoomCount(userCount, minUsersPerRoom, minRooms) {
  if (userCount < minUsersPerRoom) return userCount > 0 ? 1 : 0;
  const maxRooms = Math.max(1, Math.floor(userCount / minUsersPerRoom));
  return Math.min(maxRooms, Math.max(1, minRooms));
}

function emptyClusters(roomCount) {
  return Array.from({ length: roomCount }, () => []);
}

function targetRoomSizes(userCount, roomCount) {
  const base = Math.floor(userCount / roomCount);
  const remainder = userCount % roomCount;
  return Array.from({ length: roomCount }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

function normalizeTopicSelection(rawTopics, allTopics) {
  const allowed = new Set(allTopics);
  const cleaned = [];
  let selectedAllTopics = false;
  for (const raw of Array.isArray(rawTopics) ? rawTopics : []) {
    const topic = String(raw || '').trim();
    if (!topic) continue;
    if (topic.toLowerCase() === 'all topics') {
      selectedAllTopics = true;
      continue;
    }
    if (!allowed.has(topic)) continue;
    if (!cleaned.includes(topic)) cleaned.push(topic);
  }
  if (cleaned.length >= allTopics.length && allTopics.length > 0) {
    selectedAllTopics = true;
  }
  return {
    selectedTopics: cleaned,
    selectedAllTopics
  };
}

function loadTopicPreferenceSelections(users, allTopics) {
  const byUser = new Map();
  const responseRows = db
    .prepare(
      `
      SELECT user_id, selected_topics_json, selected_all_topics
      FROM topic_preference_responses
      ORDER BY id DESC
    `
    )
    .all();

  for (const row of responseRows) {
    if (byUser.has(row.user_id)) continue;
    let rawTopics = [];
    try {
      rawTopics = Array.isArray(row.selected_topics_json) ? row.selected_topics_json : JSON.parse(row.selected_topics_json || '[]');
    } catch {
      rawTopics = [];
    }
    const normalized = normalizeTopicSelection(rawTopics, allTopics);
    byUser.set(row.user_id, {
      selectedTopics: normalized.selectedTopics,
      selectedAllTopics: row.selected_all_topics === 1 || normalized.selectedAllTopics
    });
  }

  if (byUser.size === 0) {
    const legacyRows = db.prepare('SELECT user_id, topic FROM user_topic_preferences').all();
    const grouped = new Map();
    for (const row of legacyRows) {
      if (!grouped.has(row.user_id)) grouped.set(row.user_id, []);
      grouped.get(row.user_id).push(row.topic);
    }
    for (const [userId, rawTopics] of grouped.entries()) {
      const normalized = normalizeTopicSelection(rawTopics, allTopics);
      byUser.set(userId, {
        selectedTopics: normalized.selectedTopics,
        selectedAllTopics: normalized.selectedAllTopics
      });
    }
  }

  return users.map((user) => {
    const prefs = byUser.get(user.id) || { selectedTopics: [], selectedAllTopics: true };
    const topics = prefs.selectedAllTopics ? [] : prefs.selectedTopics.filter((topic) => allTopics.includes(topic));
    return {
      ...user,
      selected_topics: topics,
      selected_all_topics: prefs.selectedAllTopics || topics.length === allTopics.length
    };
  });
}

function buildTopicPreferenceClusters(users, settings, allTopics) {
  if (!users.length) return [];
  const minUsersPerRoom = settings.clustering_min_users_per_room || 2;
  const minRooms = settings.clustering_min_rooms || 1;
  const capacityRooms = chooseRoomCount(users.length, minUsersPerRoom, minRooms);
  if (!capacityRooms) return [];

  // A "flexible" participant chose all topics (or none): they are happy in any room. Everyone else
  // is "strict" — they chose a specific subset and should only ever be placed with the topics they
  // actually picked.
  const isFlexible = (user) =>
    user.selected_all_topics ||
    !Array.isArray(user.selected_topics) ||
    user.selected_topics.length === 0 ||
    user.selected_topics.length >= allTopics.length;
  const strictUsers = users.filter((user) => !isFlexible(user));
  const flexibleUsers = users.filter(isFlexible);

  // Affinity groups: participants who selected the EXACT same set of topics belong together. This
  // is the key to a clean split — people interested in the same topics share a room, and a room
  // only ever covers topics its members actually chose (no more mixing unrelated interests).
  const signatureOf = (user) => [...new Set(user.selected_topics)].sort().join('||');
  const groupMap = new Map();
  for (const user of strictUsers) {
    const key = signatureOf(user);
    if (!groupMap.has(key)) groupMap.set(key, { topics: [...new Set(user.selected_topics)].sort(), users: [] });
    groupMap.get(key).users.push(user);
  }
  const affinityGroups = [...groupMap.values()].sort(
    (a, b) => b.users.length - a.users.length || a.topics.join().localeCompare(b.topics.join())
  );

  const roomCount = Math.max(1, Math.min(capacityRooms, users.length));
  const roomSizes = targetRoomSizes(users.length, roomCount);
  const rooms = Array.from({ length: roomCount }, (_unused, index) => ({
    users: [],
    topics: new Set(),
    targetSize: roomSizes[index] || minUsersPerRoom
  }));
  const capLeft = (room) => Math.max(0, room.targetSize - room.users.length);

  // Place each affinity group whole, into the room that best matches its topics (and avoids
  // dragging in foreign topics), preferring an empty room so distinct interests separate cleanly.
  for (const group of affinityGroups) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < rooms.length; i += 1) {
      const room = rooms[i];
      const shared = [...room.topics].filter((topic) => group.topics.includes(topic)).length;
      const foreign = [...room.topics].filter((topic) => !group.topics.includes(topic)).length;
      const score = (room.users.length === 0 ? 20 : 0) + shared * 10 - foreign * 15 + capLeft(room);
      if (score > bestScore) { bestScore = score; bestIndex = i; }
    }
    for (const user of group.users) rooms[bestIndex].users.push(user);
    for (const topic of group.topics) rooms[bestIndex].topics.add(topic);
  }

  // Fill remaining capacity with flexible participants, emptiest room first.
  for (const user of flexibleUsers) {
    rooms.sort((a, b) => capLeft(b) - capLeft(a) || a.users.length - b.users.length);
    rooms[0].users.push(user);
    for (const topic of (Array.isArray(user.selected_topics) ? user.selected_topics : [])) rooms[0].topics.add(topic);
  }

  // Balance toward the admin's room count: move participants out of over-minimum rooms into any
  // room still below the minimum size (including empty ones), so as many rooms as possible reach
  // the minimum. This covers "everyone picked the same topic but the admin wants 2 rooms": that
  // one large group is split across rooms (splitting same-topic participants is fine). A move
  // prefers the donor participant whose topics best match the receiving room, to keep rooms
  // coherent, and never drops a donor room below the minimum.
  let balanceGuard = 0;
  while (balanceGuard < 200) {
    balanceGuard += 1;
    const needy = rooms
      .filter((room) => room.users.length < minUsersPerRoom)
      .sort((a, b) => a.users.length - b.users.length)[0];
    if (!needy) break;
    const donor = rooms
      .filter((room) => room !== needy && room.users.length > minUsersPerRoom)
      .sort((a, b) => b.users.length - a.users.length)[0];
    if (!donor) break;
    let bestUserIndex = donor.users.length - 1;
    let bestOverlap = -1;
    for (let ui = 0; ui < donor.users.length; ui += 1) {
      const overlap = (donor.users[ui].selected_topics || []).filter((topic) => needy.topics.has(topic)).length;
      if (overlap > bestOverlap) { bestOverlap = overlap; bestUserIndex = ui; }
    }
    const [moved] = donor.users.splice(bestUserIndex, 1);
    needy.users.push(moved);
    donor.topics = new Set(donor.users.flatMap((user) => user.selected_topics || []));
    for (const topic of (moved.selected_topics || [])) needy.topics.add(topic);
  }

  // Merge any room left below the minimum into the most topic-compatible remaining room.
  let mergeGuard = 0;
  while (rooms.length > 1
    && rooms.some((room) => room.users.length > 0 && room.users.length < minUsersPerRoom)
    && mergeGuard < 20) {
    mergeGuard += 1;
    const idx = rooms.findIndex((room) => room.users.length > 0 && room.users.length < minUsersPerRoom);
    if (idx < 0) break;
    const target = rooms
      .map((room, i) => (i === idx ? null : { i, score: [...room.topics].filter((topic) => rooms[idx].topics.has(topic)).length * 4 + room.users.length }))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)[0];
    if (!target) break;
    const into = Math.min(target.i, idx);
    const from = Math.max(target.i, idx);
    for (const user of rooms[from].users) rooms[into].users.push(user);
    for (const topic of rooms[from].topics) rooms[into].topics.add(topic);
    rooms.splice(from, 1);
  }

  const finalRooms = rooms
    .filter((room) => room.users.length > 0)
    .map((room) => ({ users: room.users, topics: [...room.topics] }));

  // Safety net: every admin topic must be decided somewhere. A topic that nobody selected (so no
  // affinity group carries it) is attached to the most suitable room.
  const uncoveredTopics = allTopics.filter((topic) => !finalRooms.some((room) => room.topics.includes(topic)));
  for (const topic of uncoveredTopics) {
    const target = finalRooms
      .map((room, index) => ({
        index,
        score: (room.users.length < minUsersPerRoom ? 3 : 0) + room.topics.length + room.users.filter((user) => (user.selected_topics || []).includes(topic)).length
      }))
      .sort((a, b) => b.score - a.score)[0];
    if (target) finalRooms[target.index].topics.push(topic);
  }

  return finalRooms;
}

function groupingRandom(seed) {
  if (!Number.isInteger(seed)) return Math.random;
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export async function clusterUsers(users, settings, { seed = getGroupingSeed() } = {}) {
  const minUsersPerRoom = settings.clustering_min_users_per_room || 2;

  if (settings.clustering_strategy === 'topic_preference') {
    const allTopics = db.prepare('SELECT topic FROM gathering_questions WHERE is_general_question = 0 ORDER BY question_order ASC, id ASC').all().map(t => t.topic);
    if (allTopics.length === 0) {
      const roomCount = chooseRoomCount(users.length, minUsersPerRoom, settings.clustering_min_rooms);
      if (!roomCount) return [];
      const clusters = emptyClusters(roomCount);
      const ordered = stableAlphabeticalSort(users);
      ordered.forEach((user, index) => clusters[index % roomCount].push(user));
      return clusters.map((cluster) => ({ users: cluster, topics: [] }));
    }
    const withSelections = loadTopicPreferenceSelections(users, allTopics);
    return buildTopicPreferenceClusters(withSelections, settings, allTopics);
  }

  const roomCount = chooseRoomCount(users.length, minUsersPerRoom, settings.clustering_min_rooms);
  if (!roomCount) return [];

  if (settings.clustering_strategy === 'random') {
    const clusters = emptyClusters(roomCount);
    const ordered = stableAlphabeticalSort(users);
    const random = groupingRandom(seed);
    for (let i = ordered.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
    }
    ordered.forEach((user, index) => clusters[index % roomCount].push(user));
    return clusters.map((cluster) => ({ users: cluster, topics: [] }));
  }

  if (!client) {
    const clusters = emptyClusters(roomCount);
    const ordered = stableAlphabeticalSort(users);
    ordered.forEach((user, index) => clusters[index % roomCount].push(user));
    return clusters.map((cluster) => ({ users: cluster, topics: [] }));
  }

  const userPreferencesText = users.map(u => `- ${u.username}: ${u.extracted_preferences || 'No preferences'}`).join('\n');
  const sizes = targetRoomSizes(users.length, roomCount);

  try {
    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: renderTemplate('agent2-templates.md#User Clustering System', {
            strategy: settings.clustering_strategy,
            room_count: roomCount,
            target_sizes: sizes.join(', ')
          })
        },
        {
          role: 'user',
          content: `Users:\n${userPreferencesText}`
        }
      ],
      metadata: { caller: 'agent2-clustering' }
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters : [];
    const stats = parsed.similarity_stats || 'No stats provided.';
    logAgentEvent('agent2', 'Clustered users', `Created ${clusters.length} rooms using ${settings.clustering_strategy} strategy.\nSimilarity Stats: ${stats}`);
    const userMap = new Map(users.map(u => [u.username, u]));
    const result = [];
    for (const cluster of clusters) {
      const roomUsers = [];
      for (const username of cluster) {
        const u = userMap.get(username);
        if (u) roomUsers.push(u);
      }
      if (roomUsers.length > 0) result.push(roomUsers);
    }

    const assignedUserIds = new Set(result.flat().map(u => u.id));
    const missedUsers = users.filter(u => !assignedUserIds.has(u.id));
    if (missedUsers.length > 0) {
      if (result.length === 0) {
        result.push(missedUsers);
      } else {
        for (const u of missedUsers) {
          result.sort((a, b) => a.length - b.length);
          result[0].push(u);
        }
      }
    }
    return result.map((cluster) => ({ users: cluster, topics: [] }));
  } catch (error) {
    console.error('Clustering via LLM failed, using alphabetical fallback:', error);
    logAgentEvent('agent2', 'Clustering via LLM failed', `Error: ${error.message}. Falling back to alphabetical clustering.`);
    const clusters = emptyClusters(roomCount);
    const ordered = stableAlphabeticalSort(users);
    ordered.forEach((user, index) => clusters[index % roomCount].push(user));
    return clusters.map((cluster) => ({ users: cluster, topics: [] }));
  }
}

function uniqueRoomName(baseName) {
  const existing = db.prepare('SELECT 1 FROM rooms WHERE name = ?').get(baseName);
  if (!existing) return baseName;
  let index = 2;
  while (db.prepare('SELECT 1 FROM rooms WHERE name = ?').get(`${baseName} (${index})`)) {
    index += 1;
  }
  return `${baseName} (${index})`;
}

export async function createClusteredDiscussionRooms({ globalQuestion, preferences, io = null, deferActivation = false }) {
  const decisionContext = db.prepare('SELECT decision_context, general_description FROM system_state WHERE id = 1').get()?.decision_context || '';
  const settings = getDecisionSettings();
  const clusters = await clusterUsers(preferences, settings);
  const nextRound = 1;
  const deliberationQs = db.prepare('SELECT topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY is_general_question ASC, question_order ASC, id ASC').all();

  const insertRoom = db.prepare(
    "INSERT INTO rooms (name, room_type, is_active, system_prompt, prompt_file, decision_round, topic_memory_json) VALUES (?, 'group', ?, ?, 'default.md', ?, ?)"
  );
  const insertMember = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');

  const isTopicPref = settings.clustering_strategy === 'topic_preference';

  const createdRooms = [];
  const createRoomsTx = db.transaction(() => {
    db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type = 'group')").run();
    db.prepare("UPDATE rooms SET is_active = 0 WHERE room_type = 'group'").run();

    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index];
      const clusterUsersList = Array.isArray(cluster?.users) ? cluster.users : cluster;
      const assignedTopics = isTopicPref ? (cluster?.topics || []) : null;
      // A topic-preference clustering fallback can produce a room without an
      // explicit topic list. Such a room must still be usable, so give it the
      // full deliberation scope rather than creating a group with only the
      // general question and no first topic to vote on.
      const fallbackTopics = deliberationQs
        .filter((q) => q.is_general_question !== 1)
        .map((q) => q.topic)
        .filter(Boolean);
      const topicScope = isTopicPref && (!assignedTopics || assignedTopics.length === 0)
        ? fallbackTopics
        : assignedTopics;
      const filteredMemory = deliberationQs.filter(q => {
        if (q.is_general_question === 1) return true;
        if (!isTopicPref) return true;
        return topicScope.includes(q.topic);
      }).map(q => {
        let options = [];
        try {
          options = Array.isArray(q.predefined_answers_json) ? q.predefined_answers_json : JSON.parse(q.predefined_answers_json || '[]');
        } catch { }
        return {
          key: q.topic || q.question_text,
          question: q.question_text,
          options: options,
          suggestion: q.topic || q.question_text,
          status: 'open',
          is_general_question: q.is_general_question === 1
        };
      });
      const memoryJsonStr = JSON.stringify(filteredMemory);

      const preferredName = clusters.length === 1 ? 'Global Discussion' : `Discussion Group ${index + 1}`;
      // Reclaim the clean name from a stale leftover so participants never see "Discussion Group 1 (2)".
      // Only an inactive room with NO members and NO recorded decision is deleted — i.e. a throwaway
      // staging room from a failed prior clustering attempt. A real completed round's room (which has a
      // recorded decision) is never touched, so we fall back to unique suffixing only in that safe case.
      const collision = db.prepare('SELECT id FROM rooms WHERE name = ? AND is_active = 0').get(preferredName);
      if (collision) {
        const hasDecision = db.prepare('SELECT COUNT(*) AS n FROM room_decisions WHERE room_id = ?').get(collision.id).n;
        const hasMembers = db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ?').get(collision.id).n;
        if (!hasDecision && !hasMembers) {
          db.transaction(() => {
            db.prepare('DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE room_id = ?)').run(collision.id);
            db.prepare('DELETE FROM swipe_votes WHERE poll_id IN (SELECT id FROM polls WHERE room_id = ?)').run(collision.id);
            db.prepare('DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE room_id = ?)').run(collision.id);
            db.prepare('DELETE FROM polls WHERE room_id = ?').run(collision.id);
            db.prepare('DELETE FROM messages WHERE room_id = ?').run(collision.id);
            db.prepare('DELETE FROM rooms WHERE id = ?').run(collision.id);
          })();
        }
      }
      const roomName = uniqueRoomName(preferredName);
      const roomId = Number(insertRoom.run(roomName, deferActivation ? 0 : 1, '', nextRound, memoryJsonStr).lastInsertRowid);
      createdRooms.push({ roomId, name: roomName, users: clusterUsersList.map((user) => user.username), topics: assignedTopics || [], prompt: { clusterUsersList, assignedTopics, index } });
      for (const user of clusterUsersList) insertMember.run(user.id, roomId);
      ensureAdminsInRoom(roomId);
      applyRoomTimer(roomId, settingToRoomTimerMinutes());
    }
  });

  try {
    createRoomsTx();

    for (const room of createdRooms) {
      const { clusterUsersList, assignedTopics, index } = room.prompt;
      let prompt;
      try {
        prompt = await generateMediatorPrompt({
          globalQuestion,
          decisionContext,
          preferences: clusterUsersList,
          clusterContext: isTopicPref
            ? `topic preference discussion group ${index + 1} covering topics: ${(assignedTopics || []).join(', ')}.`
            : `${settings.clustering_strategy} discussion group ${index + 1}. ${clusteringPublicReason(settings.clustering_strategy)}`
        });
      } catch (error) {
        // Prompt generation must never strand a half-created group. The group can
        // still start with the deterministic mediator instructions below.
        console.error(`[createClusteredDiscussionRooms] mediator prompt failed for room ${room.roomId}:`, error.message || error);
        logAgentEvent('agent2', 'Mediator prompt fallback', `Room ${room.roomId}: ${error.message || error}`);
        prompt = `You are the mediator for a discussion about: ${globalQuestion}. Keep the group focused on the assigned topics, invite every participant to contribute, and guide them toward a concrete decision.`;
      }
      db.prepare('UPDATE rooms SET system_prompt = ? WHERE id = ?').run(prompt, room.roomId);
    }
  } catch (error) {
    // The inserts happen before asynchronous prompt generation. If anything
    // unexpected fails afterwards, remove memberships and deactivate only the
    // rooms created by this attempt so the next sweep can retry cleanly.
    const createdRoomIds = createdRooms.map((room) => room.roomId);
    if (createdRoomIds.length > 0) {
      const placeholders = createdRoomIds.map(() => '?').join(',');
      db.transaction(() => {
        db.prepare(`DELETE FROM room_members WHERE room_id IN (${placeholders})`).run(...createdRoomIds);
        db.prepare(`UPDATE rooms SET is_active = 0 WHERE id IN (${placeholders})`).run(...createdRoomIds);
      })();
    }
    throw error;
  }

  for (const room of createdRooms) {
    delete room.prompt;
  }

  logAgentEvent(
    'agent2',
    'Created discussion groups',
    JSON.stringify({
      strategy: settings.clustering_strategy,
      public_reason: clusteringPublicReason(settings.clustering_strategy),
      min_users_per_room: settings.clustering_min_users_per_room,
      min_rooms: settings.clustering_min_rooms,
      groups: createdRooms
    })
  );
  if (io) io.emit('rooms_updated');
  db.prepare('UPDATE system_state SET discussion_round = ? WHERE id = 1').run(nextRound);
  return createdRooms;
}

// --- Convergence option building -------------------------------------------------------------
// Options that are never offered as real convergence choices.
const CONVERGENCE_META = new Set(['other', 'keep discussing', '']);
function convNormLabel(s) { return String(s || '').trim().toLowerCase(); }

// The poll that actually produced a room's decision on a topic = the last closed poll on it.
function getDecisivePoll(roomId, topicKey) {
  return db.prepare(
    "SELECT id, poll_type FROM polls WHERE room_id = ? AND LOWER(suggestion) = ? AND is_closed = 1 ORDER BY id DESC LIMIT 1"
  ).get(roomId, String(topicKey || '').trim().toLowerCase());
}

// Vote totals per option-label for ONE poll, resolving write-ins (stored under "Other") to their
// real text so a write-in winner/runner-up is visible rather than hidden under "Other".
function getDecisivePollVoteTotals(pollId, pollType) {
  const totals = new Map();
  const add = (label, v) => { const t = String(label || '').trim(); if (!t) return; totals.set(t, (totals.get(t) || 0) + (Number(v) || 0)); };
  if (pollType === 'swipe') {
    for (const r of db.prepare(
      "SELECT po.option_text t, COUNT(DISTINCT sv.user_id) v FROM poll_options po LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right' LEFT JOIN users u ON u.id = sv.user_id AND u.is_admin = 0 WHERE po.poll_id = ? GROUP BY po.id"
    ).all(pollId)) add(r.t, r.v);
    for (const r of db.prepare(
      "SELECT TRIM(pv.custom_option_text) t, COUNT(DISTINCT pv.user_id) v FROM poll_votes pv JOIN poll_options po ON po.id = pv.option_id AND po.poll_id = ? JOIN users u ON u.id = pv.user_id AND u.is_admin = 0 WHERE pv.poll_id = ? AND LOWER(TRIM(po.option_text)) = 'other' AND TRIM(COALESCE(pv.custom_option_text,'')) != '' GROUP BY LOWER(TRIM(pv.custom_option_text))"
    ).all(pollId, pollId)) add(r.t, r.v);
  } else if (pollType === 'ranking') {
    const nOpts = db.prepare('SELECT COUNT(*) c FROM poll_options WHERE poll_id = ?').get(pollId)?.c || 1;
    for (const r of db.prepare(
      "SELECT po.option_text t, SUM(? - pv.rank + 1) v FROM poll_options po JOIN poll_votes pv ON pv.option_id = po.id JOIN users u ON u.id = pv.user_id AND u.is_admin = 0 WHERE po.poll_id = ? AND pv.rank IS NOT NULL GROUP BY po.id"
    ).all(nOpts, pollId)) add(r.t, r.v);
  } else {
    // continuous / plurality
    for (const r of db.prepare(
      "SELECT CASE WHEN LOWER(TRIM(po.option_text)) = 'other' AND TRIM(COALESCE(pv.custom_option_text,'')) != '' THEN TRIM(pv.custom_option_text) ELSE po.option_text END t, COUNT(DISTINCT pv.user_id) v FROM poll_votes pv JOIN poll_options po ON po.id = pv.option_id AND po.poll_id = ? JOIN users u ON u.id = pv.user_id AND u.is_admin = 0 WHERE pv.poll_id = ? GROUP BY t"
    ).all(pollId, pollId)) add(r.t, r.v);
  }
  return totals;
}

// Aggregate each room's DECISIVE-poll vote totals for a topic (option A), excluding meta options.
// Returns [{ text, votes }] sorted by votes desc.
function getTopicDecisiveRanking(topicKey, groupRoomIds) {
  const agg = new Map();
  for (const roomId of groupRoomIds) {
    const dp = getDecisivePoll(roomId, topicKey);
    if (!dp) continue;
    for (const [label, v] of getDecisivePollVoteTotals(dp.id, dp.poll_type)) {
      if (CONVERGENCE_META.has(convNormLabel(label))) continue;
      agg.set(label, (agg.get(label) || 0) + v);
    }
  }
  return [...agg.entries()].map(([text, votes]) => ({ text, votes })).sort((a, b) => b.votes - a.votes || a.text.localeCompare(b.text));
}

export async function createConvergenceDiscussionRoom({ globalQuestion, decisions, io = null }) {
  const stateRow = db.prepare('SELECT decision_context, general_description FROM system_state WHERE id = 1').get();
  const decisionContext = stateRow?.decision_context || '';
  const generalDescription = stateRow?.general_description || '';
  const currentRound = db.prepare('SELECT discussion_round FROM system_state WHERE id = 1').get()?.discussion_round || 1;
  const nextRound = currentRound + 1;
  const simulationParticipantIds = getSimulationParticipantIds();
  const simulationParticipantSet = simulationParticipantIds === null ? null : new Set(simulationParticipantIds);
  const allUsers = db
    .prepare('SELECT id, username, extracted_preferences FROM users WHERE is_admin = 0 ORDER BY username ASC')
    .all()
    .filter((user) => simulationParticipantSet === null || simulationParticipantSet.has(user.id));
  const decisionText = decisions
    .map((decision) => `- ${decision.room_name}: ${decision.decision_text}`)
    .join('\n');
  const extra = getAgentInstructions('agent1');
  const prompt = renderTemplate('agent2-templates.md#Convergence Room Context', {
    agent1_prompt: getAgentPrompt('agent1'),
    global_question: globalQuestion,
    decision_context: decisionContext || 'No additional context provided.',
          general_description: generalDescription,
    room_decisions: decisionText || '- no previous room decisions',
    settings: describeDecisionSettings(),
    admin_guidance_section: extra ? `## Admin Guidance\n${extra}` : ''
  });
  const deliberationQs = db.prepare('SELECT topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY is_general_question ASC, question_order ASC, id ASC').all();
  const groupRooms = db.prepare(`SELECT id, name, topic_memory_json FROM rooms WHERE room_type = 'group' AND decision_round = ?`).all(currentRound);
  const groupRoomIds = groupRooms.map((r) => r.id);
  const initialMemory = deliberationQs.map(q => {
    const key = q.topic || q.question_text;
    const predefined = (() => {
      try {
        const arr = Array.isArray(q.predefined_answers_json) ? q.predefined_answers_json : JSON.parse(q.predefined_answers_json || '[]');
        return (Array.isArray(arr) ? arr : []).map((o) => String(o || '').trim()).filter((o) => o && !CONVERGENCE_META.has(convNormLabel(o)));
      } catch { return []; }
    })();

    if (q.is_general_question === 1) {
      return { key, question: q.question_text, options: predefined, suggestion: key, decision: null, status: 'open', is_general_question: true };
    }

    // The DISTINCT decisions each group room reached on this topic (write-in winners already carry
    // their real text in `decision`).
    const decisionsSeen = new Map();
    for (const room of groupRooms) {
      let memory = [];
      try { memory = JSON.parse(room.topic_memory_json || '[]'); } catch (e) {}
      const entry = memory.find((m) => m.key === key);
      const d = entry && entry.status === 'resolved' ? String(entry.decision || entry.summary || '').trim() : '';
      if (d) { const n = d.toLowerCase(); if (!decisionsSeen.has(n)) decisionsSeen.set(n, d); }
    }
    const uniqueDecisions = [...decisionsSeen.values()];

    let status = 'open';
    let decision = null;
    let options = [];
    if (uniqueDecisions.length > 1) {
      // DISPUTED across rooms -> vote among all the distinct room decisions (up to 8).
      status = 'open';
      options = uniqueDecisions.slice(0, 8);
    } else if (uniqueDecisions.length === 1) {
      // AGREED / single room -> pre-resolved; reopening it offers the winner + the top runner-up
      // (most-voted option among all rooms' DECISIVE polls, write-ins resolved; ties broken at random).
      status = 'resolved';
      decision = uniqueDecisions[0];
      const ranking = getTopicDecisiveRanking(key, groupRoomIds);
      const others = ranking.filter((r) => convNormLabel(r.text) !== convNormLabel(decision));
      let runnerUp = null;
      if (others.length) {
        const topVotes = others[0].votes;
        const tied = others.filter((r) => r.votes === topVotes);
        runnerUp = tied[Math.floor(Math.random() * tied.length)].text;
      }
      if (!runnerUp) runnerUp = predefined.find((o) => convNormLabel(o) !== convNormLabel(decision)) || null;
      options = runnerUp ? [decision, runnerUp] : [decision];
    } else {
      // Never resolved by any room -> keep it open with the predefined options.
      status = 'open';
      options = predefined.length >= 2 ? predefined : getTwoMostVotedOptionsForTopic(key);
    }

    // A swipe needs at least two options; backfill from the predefined list if necessary.
    if (options.length < 2) {
      for (const o of predefined) {
        if (!options.some((x) => convNormLabel(x) === convNormLabel(o))) options.push(o);
        if (options.length >= 2) break;
      }
    }

    return { key, question: q.question_text, options, suggestion: key, decision, status, is_general_question: false };
  });
  const memoryJsonStr = JSON.stringify(initialMemory);

  const insertRoom = db.prepare(
    "INSERT INTO rooms (name, room_type, is_active, system_prompt, prompt_file, decision_round, topic_memory_json) VALUES (?, 'convergence', 1, ?, 'default.md', ?, ?)"
  );
  const roomName = uniqueRoomName(`Convergence Round ${nextRound}`);
  const roomId = Number(insertRoom.run(roomName, prompt, nextRound, memoryJsonStr).lastInsertRowid);
  applyRoomTimer(roomId, settingToRoomTimerMinutes());
  const insertMember = db.prepare('INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING');
  db.transaction(() => {
    db.prepare("DELETE FROM room_members WHERE room_id IN (SELECT id FROM rooms WHERE room_type = 'group')").run();
    db.prepare("UPDATE rooms SET is_active = 0 WHERE room_type = 'group'").run();
    for (const user of allUsers) insertMember.run(user.id, roomId);
    ensureAdminsInRoom(roomId);
    db.prepare('UPDATE system_state SET current_phase = ?, discussion_round = ?, showdown_initiated = 0 WHERE id = 1').run('discussing', nextRound);
  })();

  logAgentEvent(
    'agent2',
    'Created convergence discussion room',
    JSON.stringify({
      previous_round: currentRound,
      new_round: nextRound,
      roomId,
      decisions: decisions.map((decision) => ({
        room: decision.room_name,
        decision: decision.decision_text
      }))
    })
  );
  if (io) {
    io.emit('rooms_updated');
  }
  emitDecisionStatus(io);
  return { roomId, name: roomName, users: allUsers.map((user) => user.username), pollData: null };
}

export async function generateMediatorPrompt({ globalQuestion, decisionContext = '', preferences, clusterContext = '' }) {
  const generalDescription = getGeneralDescription();
  const prefText = preferences.length
    ? preferences.map((p) => `- ${p.username}: ${p.extracted_preferences || 'n/a'}`).join('\n')
    : '- no preferences collected';
  const extra = getAgentInstructions('agent1');
  const basePrompt = getAgentPrompt('agent1');
  const settingsText = describeDecisionSettings();
  const adminGuidanceSection = extra ? `## Admin Guidance\n${extra}` : '';
  const groupingContextSection = clusterContext ? `Grouping context: ${clusterContext}\n` : '';

  if (!client) {
    return renderTemplate('agent2-templates.md#Group Discussion Context', {
      agent1_prompt: basePrompt,
      global_question: globalQuestion,
      decision_context: decisionContext || 'No additional context provided.',
          general_description: generalDescription,
      preferences: prefText,
      grouping_context_section: groupingContextSection,
      settings: settingsText,
      admin_guidance_section: adminGuidanceSection
    });
  }

  try {
    const res = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0.3,
      max_completion_tokens: 700,
      messages: [
        {
          role: 'system',
          content: renderTemplate('agent2-templates.md#Group Prompt Generation System', {
            agent2_prompt: getAgentPrompt('agent2')
          })
        },
        {
          role: 'user',
          content: renderTemplate('agent2-templates.md#Group Prompt Generation User', {
            agent1_prompt: basePrompt,
            global_question: globalQuestion,
            decision_context: decisionContext || 'No additional context provided.',
            general_description: generalDescription,
            preferences: prefText,
            grouping_context_section: groupingContextSection,
            settings: settingsText,
            admin_guidance: extra || 'none'
          })
        }
      ],
      metadata: { caller: 'agent2-mediator-prompt' }
    });

    return res.choices?.[0]?.message?.content?.trim() || renderTemplate('agent2-templates.md#Group Prompt Fallback', { global_question: globalQuestion });
  } catch (error) {
    console.error('generateMediatorPrompt LLM call failed, using fallback:', error.message || error);
    return renderTemplate('agent2-templates.md#Group Discussion Context', {
      agent1_prompt: basePrompt,
      global_question: globalQuestion,
      decision_context: decisionContext || 'No additional context provided.',
      general_description: generalDescription,
      preferences: prefText,
      grouping_context_section: groupingContextSection,
      settings: settingsText,
      admin_guidance_section: adminGuidanceSection
    });
  }
}

export function appendDisagreementNudge(roomId, nudgeText) {
  const row = db.prepare('SELECT system_prompt FROM rooms WHERE id = ?').get(roomId);
  const current = row?.system_prompt || renderTemplate('agent2-templates.md#Mediator Fallback');
  db.prepare('UPDATE rooms SET system_prompt = ? WHERE id = ?').run(`${current}\n\n${nudgeText}`, roomId);
}

export function getTwoMostVotedOptionsForTopic(topicKey) {
  const normalizedKey = String(topicKey || '').trim().toLowerCase();
  
  // Find all group room polls on this topic
  const polls = db.prepare(`
    SELECT id, poll_type FROM polls
    WHERE room_id IN (SELECT id FROM rooms WHERE room_type = 'group')
      AND LOWER(suggestion) = ?
  `).all(normalizedKey);

  const optionVoteTotals = {};

  for (const p of polls) {
    const totalOptions = db.prepare('SELECT COUNT(*) as c FROM poll_options WHERE poll_id = ?').get(p.id)?.c || 1;
    let optionVotes = [];
    if (p.poll_type === 'swipe') {
      optionVotes = db.prepare(`
        SELECT po.option_text, COUNT(DISTINCT sv.user_id) AS votes
        FROM poll_options po
        LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right'
        LEFT JOIN users voter ON voter.id = sv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ?
        GROUP BY po.id
      `).all(p.id);
    } else if (p.poll_type === 'ranking') {
      optionVotes = db.prepare(`
        SELECT po.option_text, SUM(? - pv.rank + 1) AS votes
        FROM poll_options po
        LEFT JOIN poll_votes pv ON pv.option_id = po.id
        LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ? AND pv.rank IS NOT NULL
        GROUP BY po.id
      `).all(totalOptions, p.id);
    } else {
      optionVotes = db.prepare(`
        SELECT po.option_text, COUNT(voter.id) AS votes
        FROM poll_options po
        LEFT JOIN poll_votes pv ON pv.option_id = po.id
        LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ?
        GROUP BY po.id
      `).all(p.id);
    }

    for (const opt of optionVotes) {
      const txt = String(opt.option_text || '').trim();
      const lower = txt.toLowerCase();
      if (!txt || lower === 'keep discussing' || lower === 'other' || lower === 'yes' || lower === 'no' || lower === 'abstained' || lower === 'abstain') {
        continue;
      }
      optionVoteTotals[txt] = (optionVoteTotals[txt] || 0) + (opt.votes || 0);
    }
  }

  const sorted = Object.entries(optionVoteTotals)
    .map(([text, votes]) => ({ text, votes }))
    .sort((a, b) => b.votes - a.votes || a.text.localeCompare(b.text));

  const result = sorted.slice(0, 2).map(item => item.text);
  if (result.length < 2) {
    const q = db.prepare('SELECT predefined_answers_json FROM gathering_questions WHERE LOWER(topic) = ? OR LOWER(question_text) = ?').get(normalizedKey, normalizedKey);
    if (q?.predefined_answers_json) {
      try {
        const rawOptions = JSON.parse(q.predefined_answers_json);
        if (Array.isArray(rawOptions)) {
          const cleanRaw = rawOptions.filter(o => {
            const l = String(o).toLowerCase();
            return l !== 'keep discussing' && l !== 'other';
          });
          const combined = [...result, ...cleanRaw];
          return [...new Set(combined)].slice(0, 2);
        }
      } catch {}
    }
  }
  return result;
}
