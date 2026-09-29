import { env } from '../config/env.js';
import { db } from '../config/db.js';
import { renderTemplate, getConfiguredModels } from './agentConfigService.js';
import { getUnresolvedRoomMemoryTopics } from './agent3Service.js';
import client from './llm.js';
import { throwIfWorkCancelled } from './workContext.js';

function getRecentMessages(roomId, limit = 40) {
  return db
    .prepare(
      `
      SELECT m.id, m.text, m.sender_id, u.username AS sender_name
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = ?
      ORDER BY m.id DESC
      LIMIT ?
    `
    )
    .all(roomId, limit)
    .reverse();
}

function getParticipants(roomId) {
  return db
    .prepare(
      `
      SELECT u.username
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
      ORDER BY u.username ASC
    `
    )
    .all(roomId)
    .map((r) => r.username);
}

export function roomShouldAutoBot(roomId) {
  const room = db.prepare('SELECT room_type, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (!room) return false;
  if (room.room_type === 'personal') {
    return true;
  }
  const c = db
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
    `
    )
    .get(roomId);
  return (c?.c || 0) <= 1;
}

export async function generateAgent1Reply({ roomId, triggerText, allowDuringPoll = false }) {
  throwIfWorkCancelled();
  if (!client) return null;

  const room = db
    .prepare('SELECT id, name, system_prompt, is_active, room_type, collection_complete, convergence_finalized FROM rooms WHERE id = ?')
    .get(roomId);
  if (!room || room.is_active !== 1) return null;

  // True while a convergence room is still inside its summary review window.
  const inConvergenceReview = room.room_type === 'convergence'
    && room.convergence_finalized !== 1
    && room.collection_complete !== 1;

  const openMandatoryPoll = db
    .prepare(
      `
      SELECT id
      FROM polls
      WHERE room_id = ?
        AND mandatory = 1
        AND is_closed = 0
        AND (expires_at IS NULL OR expires_at > ?)
      LIMIT 1
    `
    )
    .get(roomId, new Date().toISOString());
  // A poll is a parallel interaction, not a gag order. When a participant directly asks the bot
  // something while a poll is open (allowDuringPoll), we still answer their question — we just
  // must not push the discussion forward or nudge. Automatic/quiet triggers stay silent so we
  // don't distract people from voting.
  if (openMandatoryPoll && !allowDuringPoll) return null;

  const participants = getParticipants(roomId);
  const history = getRecentMessages(roomId, 40);
  const systemPrompt = room.system_prompt?.trim() || renderTemplate('agent1-templates.md#Agent1 Fallback');
  
  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
  const runId = db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id;

  let currentTopicInstruction = '';
  if (inConvergenceReview) {
    currentTopicInstruction = `\nCRITICAL: This convergence room just opened with the interactive Convergence Summary card, and participants are in the summary review window. Do NOT start discussing or voting on any topic yet. If a participant asks what is happening or what to do, explain: they should read the summary of what the previous rooms decided; the top box shows each room's final vote on the main question; each sub-topic below shows the agreed solution with a "reopen!" button they can click if they disagree, or is marked still-open with the conflicting options; clicking "reopen!" silently flags that point to be voted again; when the review window ends you will tell them which points still need to be discussed and the voting will begin. Keep the answer short and friendly.`;
  } else if (room.room_type === 'group' || room.room_type === 'convergence') {
    const unresolved = getUnresolvedRoomMemoryTopics(roomId);
    // The full set of topics THIS room is responsible for. Topic-preference clustering assigns
    // each room a SUBSET of the overall decision's topics, so the bot must be told exactly which
    // topics belong to this room and must never discuss anything outside them.
    let roomTopics = [];
    try {
      const raw = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId)?.topic_memory_json;
      roomTopics = (JSON.parse(raw || '[]') || []).filter((x) => x && !x.is_general_question);
    } catch { roomTopics = []; }
    const roomTopicList = roomTopics.map((x) => `"${x.question || x.suggestion || x.key}"`).join('; ');
    if (unresolved.length > 0) {
      const t = unresolved[0];
      const topicName = t.suggestion || t.key;
      const topicQuestion = t.question || topicName;
      const topicOptions = Array.isArray(t.options) && t.options.length > 0
        ? t.options.join(', ')
        : 'only the options participants raise themselves';
      // Strong grounding: the background context (global question / decision context) often
      // describes the WHOLE decision with many facets this room is NOT responsible for. Pin the
      // bot to this room's assigned topics and, within them, the single active one.
      const scopeLine = roomTopicList
        ? `This room is responsible ONLY for the following topic(s): ${roomTopicList}. You must NEVER discuss, ask about, or reference anything outside this room's topics — not other parts of the overall decision, not budget/location/timing/logistics or any other facet, even if it appears in the background context above, unless a participant has explicitly raised it in this room's messages.`
        : `You must NEVER discuss anything outside this room's assigned topic, even if it appears in the background context above, unless a participant explicitly raised it in this room's messages.`;
      currentTopicInstruction = `\nCRITICAL: ${scopeLine}\nRight now the group is on ONE of those topics:\n  Question: "${topicQuestion}"\n  Options currently on the table: ${topicOptions}\nStay strictly on THIS question and THESE options until it is resolved. Do NOT move to the room's other topics until the current one is done, do NOT evaluate the global question as a whole, and NEVER invent options or details.`;
    } else {
      currentTopicInstruction = `\nCRITICAL: All topics have been resolved. Wait for the final phase.`;
    }
  }

  // If a poll is currently open and we're answering a direct question, tell the bot to help but
  // not to steer the vote: answer the question, then invite them to cast their vote in the poll.
  if (openMandatoryPoll && allowDuringPoll) {
    currentTopicInstruction += `\nNOTE: A poll is currently open in this room. Answer the participant's question clearly and briefly, then gently remind them they can cast their vote in the open poll when ready. Do NOT tell them how to vote or which option to pick.`;
  }

  const messages = [
    {
      role: 'system',
      content: renderTemplate('agent1-templates.md#Agent1 Runtime Context', {
        room_system_prompt: systemPrompt,
        agent1_prompt: systemPrompt,
        room_name: room.name,
        participants: participants.join(', ') || 'none',
        global_question: state?.global_question || 'Not specified',
        decision_context: state?.decision_context || 'None',
          general_description: state?.general_description || '',
        current_phase: state?.current_phase || 'unknown',
        current_topic_instruction: currentTopicInstruction
      })
    }
  ];

  for (const msg of history) {
    if (msg.sender_id === null) {
      messages.push({ role: 'assistant', content: msg.text });
    } else {
      messages.push({
        role: 'user',
        name: (msg.sender_name || 'user').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
        content: msg.text
      });
    }
  }

  if (triggerText) {
    messages.push({ role: 'system', content: renderTemplate('agent1-templates.md#Agent1 Trigger Context', { trigger_text: triggerText }) });
  }

  if (room.room_type === 'personal') {
    const { getAnsweredQuestionIds, getAllDeliberationQuestions } = await import('./agent3Service.js');
    const user = db.prepare('SELECT rm.user_id FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0').get(roomId);
    let criticalRule = `CRITICAL RULE: You have finished asking all questions. If the user asks if you are finished, confirm that you have finished gathering their preferences and that they are just waiting for the other users to finish so the group discussion can begin.`;
    if (room.collection_complete === 1) {
      criticalRule = `CRITICAL RULE: Gathering is complete. You are waiting for other participants to finish. The user may ask questions about the project, the decision-making process, or the topic. Answer their questions directly, accurately, and politely. Keep them engaged in a helpful conversation about the project/process while they wait. Do NOT ask them any more preference-gathering questions. If the user asks something completely unrelated to the decision topic or process, respond exactly with: "I am here to facilitate the decision-making process. I cannot assist with queries outside this scope."`;
    } else if (user) {
      const answeredIds = getAnsweredQuestionIds(user.user_id);
      const allQs = getAllDeliberationQuestions();
      let nextQ = null;
      const roomState = db.prepare('SELECT current_gathering_question_id, gathering_retry_count FROM rooms WHERE id = ?').get(roomId);
      if (roomState?.current_gathering_question_id) {
        nextQ = allQs.find(q => q.id === roomState.current_gathering_question_id) || null;
        if (nextQ && answeredIds.has(nextQ.id)) {
          nextQ = null;
        }
      }
      if (!nextQ) {
        nextQ = allQs.find(q => !answeredIds.has(q.id));
        if (nextQ) {
          db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(nextQ.id, roomId);
        }
      }
      
      if (!nextQ || nextQ.is_general_question) {
        // Only return null if it's NOT a user-triggered query (mention or process question)
        const isUserQuery = triggerText && (triggerText.includes('Process Question') || triggerText.includes('Mention'));
        if (!isUserQuery) {
          return null; // Agent 3 handles the final poll message and waiting phase
        }
      }
      
      if (nextQ && !nextQ.is_general_question) {
        db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(nextQ.id, roomId);
        criticalRule = `CRITICAL RULE: You MUST strictly ask the user the following question: "${nextQ.question_text}". Do not move to other topics or ask other questions until they have answered this specific question. Wait for their answer. If they ask a clarifying question, answer it directly using the **Additional Context from Municipality/Admin** provided above. If they provide an answer but it's completely unrelated to the question or very unclear, politely explain why it doesn't answer the question. Finally, you MUST explicitly repeat the question "${nextQ.question_text}" at the end of your response to nudge the user back to the active topic. Never send a message without asking this question at the end.`;
      }
    }
    messages.push({
      role: 'system',
      content: renderTemplate('agent1-templates.md#Agent1 Personal Runtime', { critical_rule: criticalRule })
    });
  }

  if ((room.room_type === 'group' || room.room_type === 'convergence') && !inConvergenceReview) {
    if (room.collection_complete === 1) {
      messages.push({
        role: 'system',
        content: `CRITICAL RULE: The decision process in this room is completed, and you are waiting for other rooms to finish. Engage in a light, polite chat with the users about the decision topic to keep them busy, but do NOT discuss any unresolved topics or ask them to change their preferences, as their decisions are already locked. If a user asks a question or makes a request that is completely unrelated to the decision topic or process (e.g. general knowledge questions, jokes, math, coding, or off-topic questions like "is a steak vegetarian?"), you must respond exactly with: "I am here to facilitate the decision-making process. I cannot assist with queries outside this scope." Do not add any punctuation, greetings, or other text.`
      });
    } else {
      const { getUnresolvedRoomMemoryTopics } = await import('./agent3Service.js');
      const unresolved = getUnresolvedRoomMemoryTopics(roomId);
      const activeTopic = unresolved[0];
      const topicName = activeTopic?.suggestion || activeTopic?.key || 'the current active topic';
      let activeTopicOptions = activeTopic?.options && activeTopic.options.length > 0 
        ? activeTopic.options.join(', ') 
        : 'None provided. Ask the users for suggestions.';
        
      if (activeTopic?.is_general_question) {
        activeTopicOptions = 'Yes, No, Abstained';
      }

      let voteCooldownInstruction = `If a user asks to vote or mentions voting, answer naturally and explain what will happen next. Do not repeat a fixed warning or list of options unless it is genuinely relevant to the user's question.`;
      messages.push({
        role: 'system',
        content: renderTemplate('agent1-templates.md#Agent1 Group Runtime', { 
          active_topic: topicName,
          active_topic_options: activeTopicOptions,
          vote_cooldown_instruction: voteCooldownInstruction
        })
      });
    }
  }

  const completion = await client.chat.completions.create({
    model: getConfiguredModels().primaryModel,
    messages,
    temperature: 0.4,
    max_completion_tokens: 350,
    metadata: { roomId, caller: 'agent1_reply' }
  });

  throwIfWorkCancelled();
  if (db.prepare('SELECT is_active FROM rooms WHERE id = ?').get(roomId)?.is_active !== 1
      || db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id !== runId) return null;

  const text = completion.choices?.[0]?.message?.content?.trim();
  if (!text) return null;

  const timestamp = new Date().toISOString();
  const result = db
    .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)')
    .run(roomId, text, timestamp);

  return {
    id: Number(result.lastInsertRowid),
    room_id: roomId,
    sender_id: null,
    sender_name: 'Bot',
    text,
    timestamp,
    is_bot: true
  };
}
