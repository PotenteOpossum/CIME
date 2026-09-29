import { createRouter } from '../middleware/router.js';
import { db } from '../config/db.js';
import { authMiddleware } from '../middleware/auth.js';
import { evaluateResponseValidity } from '../services/responseValidityService.js';
import {
  maybeResolvePollEarlyForVote,
  generateRoomAnalysisReport,
  countLegitimateFailedPolls,
  checkPersonalRoom,
  maybeAdvanceToGroupPhase,
  getConvergenceReviewWindowMs,
  recordConvergenceReopen,
  recordConvergenceAgreement,
  submitContinuousSuggestion,
  announceContinuousVoteChange,
  recordContinuousVoteAudit
} from '../services/agent3Service.js';
import { getDecisionSettings } from '../services/agentConfigService.js';

// Defensive: make sure the convergence agreement table exists even if the database was last
// migrated by an older build. This runs whenever the backend loads this module.
db.exec(`
  CREATE TABLE IF NOT EXISTS convergence_agreements (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS convergence_review_actions (
    room_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('agree', 'reopen')),
    topic_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, user_id, action, topic_key)
  );
`);

const router = createRouter();
router.use(authMiddleware);

function nowIso() {
  return new Date().toISOString();
}

function assertRoomMember(userId, roomId) {
  const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  if (user?.is_admin === 1) return true;
  return !!db.prepare('SELECT 1 FROM room_members WHERE user_id = ? AND room_id = ?').get(userId, roomId);
}

async function refreshPersonalRoomProgress(roomId, userId) {
  const room = db.prepare('SELECT room_type, is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.room_type !== 'personal' || room.collection_complete === 1) return;

  const state = db.prepare('SELECT current_phase FROM system_state WHERE id = 1').get();
  if (state?.current_phase !== 'gathering') return;

  const completed = await checkPersonalRoom(roomId, userId);
  if (completed) {
    await maybeAdvanceToGroupPhase();
  }
}

export function getPollsForRoom(roomId, userId) {
  const cleanUserId = typeof userId === 'number' ? userId : null;
  const room = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId);
  const roomType = room?.room_type || 'group';
  const generalQuestionRow = db.prepare('SELECT topic, question_text FROM gathering_questions WHERE is_general_question = 1 ORDER BY question_order DESC, id DESC LIMIT 1').get();

  const polls = db
    .prepare(
      `
      SELECT id, room_id, question, show_results, is_closed, mandatory, expires_at, created_at, poll_type, poll_stage, has_consensus, suggestion, chain_stage, minimum_live_until, stability_started_at, review_until
      FROM polls
      WHERE room_id = ?
      ORDER BY id DESC
    `
    )
    .all(roomId)
    .map((p) => ({
      ...p,
      show_results: p.show_results === 1,
      is_closed: p.is_closed === 1 || (p.expires_at && p.expires_at <= nowIso()),
      mandatory: p.mandatory === 1,
      has_consensus: p.has_consensus === 1
    }));

  return polls.map((poll) => {
    let isGlobalQuestion = false;
    if (generalQuestionRow && (poll.suggestion === generalQuestionRow.topic || poll.question === generalQuestionRow.question_text)) {
      isGlobalQuestion = true;
    }

    const isFirstPollOnTopic = !isGlobalQuestion && roomType !== 'personal' && (poll.suggestion || poll.question) && (() => {
      const key = poll.suggestion || poll.question;
      const priorCount = db.prepare(
        'SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND id < ?'
      ).get(roomId, key, key, poll.id)?.c || 0;
      return priorCount === 0;
    })();

    const isContinuous = poll.poll_type === 'continuous' || poll.poll_stage === 'continuous';
    let options = db
      .prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC')
      .all(poll.id);

    // Continuous voting always exposes a stable write-in option. Add it lazily as
    // well as at poll creation so polls created by an older build are repaired
    // without changing their existing option IDs or votes.
    if (isContinuous && !options.some((option) => String(option.option_text).trim().toLowerCase() === 'other')) {
      db.prepare(`
        INSERT INTO poll_options (poll_id, option_text)
        SELECT ?, 'Other'
        WHERE NOT EXISTS (
          SELECT 1 FROM poll_options WHERE poll_id = ? AND LOWER(TRIM(option_text)) = 'other'
        )
      `).run(poll.id, poll.id);
      options = db
        .prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC')
        .all(poll.id);
    }

    const votes = db
      .prepare('SELECT option_id, custom_option_text FROM poll_votes WHERE poll_id = ? AND user_id = ? ORDER BY rank ASC')
      .all(poll.id, cleanUserId);

    const allVotes = poll.poll_type === 'swipe'
      ? db.prepare(`
          SELECT sv.option_id, sv.swipe_direction
          FROM swipe_votes sv
          JOIN users u ON u.id = sv.user_id
          WHERE sv.poll_id = ? AND u.is_admin = 0
        `).all(poll.id)
      : db.prepare(`
          SELECT pv.option_id, pv.rank, pv.custom_option_text
          FROM poll_votes pv
          JOIN users u ON u.id = pv.user_id
          WHERE pv.poll_id = ? AND u.is_admin = 0
        `).all(poll.id);

    const customVotes = poll.poll_type === 'swipe'
      ? db.prepare(`
          SELECT pv.option_id, pv.custom_option_text
          FROM poll_votes pv
          JOIN users u ON u.id = pv.user_id
          WHERE pv.poll_id = ? AND u.is_admin = 0
        `).all(poll.id)
      : [];

    const hasVoted = poll.poll_type === 'swipe'
      ? (db.prepare('SELECT 1 FROM swipe_votes WHERE poll_id = ? AND user_id = ? LIMIT 1').get(poll.id, cleanUserId) !== undefined)
      : (votes.length > 0);

    const otherOption = options.find((o) => o.option_text.toLowerCase() === 'other');
    const otherOptionId = otherOption?.id;

    // We will build a list of options dynamically to include custom suggestions
    const finalOptions = [...options];
    // Borda count size is fixed (the predefined option count, matching resolvePoll); using the
    // growing finalOptions.length would give votes counted before/after a custom write-in
    // different point scales.
    const rankN = options.length;
    const votesMap = {};
    for (const opt of finalOptions) {
      votesMap[opt.id] = 0;
    }

    const showCustomOptions = poll.show_results || poll.is_closed || isContinuous;

    for (const v of allVotes) {
      if (poll.poll_type === 'swipe') {
        if (v.swipe_direction === 'right') {
          votesMap[v.option_id] = (votesMap[v.option_id] || 0) + 1;
        }
      } else {
        if (v.option_id === otherOptionId && v.custom_option_text && v.custom_option_text.trim() !== '') {
          const text = v.custom_option_text.trim();
          if (showCustomOptions) {
            let existing = finalOptions.find((o) => o.option_text === text);
            if (!existing) {
              existing = { id: `custom-${text}`, option_text: text };
              finalOptions.push(existing);
              votesMap[existing.id] = 0;
            }
            
            if (poll.poll_type === 'ranking') {
              const pts = rankN - (v.rank || 1) + 1;
              votesMap[existing.id] = (votesMap[existing.id] || 0) + pts;
            } else {
              votesMap[existing.id] = (votesMap[existing.id] || 0) + 1;
            }
          } else {
            votesMap[otherOptionId] = (votesMap[otherOptionId] || 0) + 1;
          }
        } else {
          if (poll.poll_type === 'ranking') {
            const pts = rankN - (v.rank || 1) + 1;
            votesMap[v.option_id] = (votesMap[v.option_id] || 0) + pts;
          } else {
            votesMap[v.option_id] = (votesMap[v.option_id] || 0) + 1;
          }
        }
      }
    }

    if (poll.poll_type === 'swipe') {
      for (const cv of customVotes) {
        if (cv.option_id === otherOptionId && cv.custom_option_text && cv.custom_option_text.trim() !== '') {
          const text = cv.custom_option_text.trim();
          if (showCustomOptions) {
            let existing = finalOptions.find((o) => o.option_text === text);
            if (!existing) {
              existing = { id: `custom-${text}`, option_text: text };
              finalOptions.push(existing);
              votesMap[existing.id] = 0;
            }
            votesMap[existing.id] = (votesMap[existing.id] || 0) + 1;
          } else {
            votesMap[otherOptionId] = (votesMap[otherOptionId] || 0) + 1;
          }
        }
      }
    }

    const selectedOptionId = votes.length > 0 ? votes[0].option_id : null;
    let renderedOptions = finalOptions;
    let continuousMeta = null;
    if (isContinuous) {
      const settings = getDecisionSettings();
      const eligibleMembers = db.prepare(`
        SELECT COUNT(*) AS c
        FROM room_members rm JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = ? AND u.is_admin = 0
      `).get(roomId)?.c || 0;
      const currentVoters = db.prepare(`
        SELECT COUNT(DISTINCT pv.user_id) AS c
        FROM poll_votes pv JOIN users u ON u.id = pv.user_id
        WHERE pv.poll_id = ? AND u.is_admin = 0
      `).get(poll.id)?.c || 0;
      const approvalShare = Number(settings.poll_approval_threshold) === 3 ? 1 : Number(settings.poll_approval_threshold) === 2 ? 0.75 : 0.51;
      const quorumRequired = eligibleMembers > 0 ? Math.max(1, Math.ceil(eligibleMembers * settings.minimum_votes_for_approval / 100)) : 0;
      const approvalRequired = eligibleMembers > 0 ? Math.max(1, Math.ceil(eligibleMembers * approvalShare)) : 0;
      const sorted = finalOptions
        .map((option) => ({ ...option, liveVotes: Number(votesMap[option.id] || 0) }))
        .sort((a, b) => {
          const voteDifference = b.liveVotes - a.liveVotes;
          if (voteDifference !== 0) return voteDifference;
          // IDs are insertion order for persisted options. Prefer newer options
          // at the eight-option boundary, so the oldest tied option drops out.
          const aId = Number(a.id);
          const bId = Number(b.id);
          if (Number.isFinite(aId) && Number.isFinite(bId)) return bId - aId;
          return 0;
        });
      const liveOther = sorted.find((option) => String(option.option_text).trim().toLowerCase() === 'other');
      const rankedOptions = sorted.filter((option) => String(option.option_text).trim().toLowerCase() !== 'other');
      const visible = rankedOptions.slice(0, settings.maximum_visible_options || 8);
      if (selectedOptionId && !visible.some((option) => option.id === selectedOptionId)) {
        const selected = sorted.find((option) => option.id === selectedOptionId);
        if (selected) visible.push(selected);
      }
      // Other is a permanent interaction affordance, not a ranked suggestion;
      // keep it visible even when the live option set exceeds the top-eight cap.
      if (liveOther && !visible.some((option) => option.id === liveOther.id)) visible.push(liveOther);
      renderedOptions = visible;
      const stabilityRemaining = poll.stability_started_at
        ? Math.max(0, (settings.consensus_stability_duration_seconds * 1000) - (Date.now() - new Date(poll.stability_started_at).getTime()))
        : 0;
      continuousMeta = {
        eligible_members: eligibleMembers,
        current_votes: currentVoters,
        quorum_required: quorumRequired,
        approval_required: approvalRequired,
        approval_threshold_percent: Math.round(approvalShare * 100),
        minimum_live_until: poll.minimum_live_until,
        stability_started_at: poll.stability_started_at,
        stability_remaining_seconds: Math.ceil(stabilityRemaining / 1000),
        maximum_visible_options: settings.maximum_visible_options
      };
    }

    return {
      ...poll,
      max_choices: (() => {
        if (poll.poll_type !== 'plurality') return 1;
        if (poll.question && poll.question.toLowerCase().includes('select all that apply')) {
          return options.length;
        }
        if (isFirstPollOnTopic || poll.chain_stage === 'multi_select' || (poll.question && (poll.question.includes('explore further') || poll.question.toLowerCase().includes('select one or more')))) {
          return Math.min(3, options.length);
        }
        return 1;
      })(),
      my_vote_option_id: votes.length > 0 ? votes[0].option_id : null,
      my_vote_custom_text: votes.find((v) => v.custom_option_text)?.custom_option_text || null,
      my_ranked_options: votes.map((v) => v.option_id),
      my_vote_option_ids: votes.map((v) => v.option_id),
      has_voted: hasVoted,
      ...(continuousMeta ? { continuous: continuousMeta } : {}),
      options: renderedOptions.map((o) => ({
        id: o.id,
        option_text: o.option_text,
        votes: (poll.show_results || poll.is_closed || isContinuous) ? (votesMap[o.id] || 0) : null
      }))
    };
  });
}

router.get('/', (req, res) => {
  const rooms = db
    .prepare(
      `
      SELECT r.id, r.name, r.is_active, r.room_type,
             COALESCE(r.collection_complete, 0) AS collection_complete,
             COALESCE(r.collection_banner, '') AS collection_banner,
             COALESCE(r.timer_expires_at, NULL) AS timer_expires_at,
             (
               SELECT COUNT(*)
               FROM room_members rm_count
               JOIN users u_count ON u_count.id = rm_count.user_id
               WHERE rm_count.room_id = r.id
                 AND u_count.is_admin = 0
             ) AS participant_count
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE rm.user_id = ?
        AND (
          r.name = (SELECT username FROM users WHERE id = ?) || '-personal'
          OR (r.room_type IN ('group', 'convergence') AND r.is_active = 1)
        )
      ORDER BY r.name ASC
    `
    )
    .all(req.user.id, req.user.id)
    .map((r) => ({ ...r, is_active: r.is_active === 1, collection_complete: r.collection_complete === 1 }));
  return res.json({ rooms });
});

router.get('/:roomId', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Access denied for this room' });
  const room = db
    .prepare(
      `
      SELECT r.id, r.name, r.is_active, r.room_type,
             COALESCE(r.collection_complete, 0) AS collection_complete,
             COALESCE(r.collection_banner, '') AS collection_banner,
             COALESCE(r.timer_expires_at, NULL) AS timer_expires_at,
             (
               SELECT COUNT(*)
               FROM room_members rm_count
               JOIN users u_count ON u_count.id = rm_count.user_id
               WHERE rm_count.room_id = r.id
                 AND u_count.is_admin = 0
             ) AS participant_count
      FROM rooms r
      WHERE r.id = ?
    `
    )
    .get(roomId);
  return res.json({ room: { ...room, is_active: room.is_active === 1, collection_complete: room.collection_complete === 1 } });
});

router.get('/:roomId/messages', async (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Access denied for this room' });
  await refreshPersonalRoomProgress(roomId, req.user.id).catch((error) => {
    console.error('Failed to refresh personal room progress before loading messages:', error);
  });

  const room = db
    .prepare(
      `
      SELECT r.id, r.name, r.is_active, r.room_type,
             COALESCE(r.collection_complete, 0) AS collection_complete,
             COALESCE(r.collection_banner, '') AS collection_banner,
             COALESCE(r.timer_expires_at, NULL) AS timer_expires_at,
             (
               SELECT COUNT(*)
               FROM room_members rm_count
               JOIN users u_count ON u_count.id = rm_count.user_id
               WHERE rm_count.room_id = r.id
                 AND u_count.is_admin = 0
             ) AS participant_count
      FROM rooms r
      WHERE r.id = ?
    `
    )
    .get(roomId);

  const messages = db
    .prepare(
      `
      SELECT m.id, m.room_id, m.sender_id, m.text, m.timestamp,
             COALESCE(u.username, 'Bot') AS sender_name,
             CASE WHEN m.sender_id IS NULL THEN 1 ELSE 0 END AS is_bot
      FROM messages m
      LEFT JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = ?
      ORDER BY m.id ASC
    `
    )
    .all(roomId);

  return res.json({ messages, room: { ...room, is_active: room.is_active === 1, collection_complete: room.collection_complete === 1 } });
});

router.get('/:roomId/polls', async (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Access denied for this room' });
  await refreshPersonalRoomProgress(roomId, req.user.id).catch((error) => {
    console.error('Failed to refresh personal room progress before loading polls:', error);
  });
  return res.json({ polls: getPollsForRoom(roomId, req.user.id) });
});

router.get('/:roomId/status', async (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Access denied for this room' });

  await refreshPersonalRoomProgress(roomId, req.user.id).catch((error) => {
    console.error('Failed to refresh personal room progress before loading status:', error);
  });

  const userRow = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.user.id);
  const isAdmin = userRow?.is_admin === 1;
  const roomMeta = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId);

  let kicked = false;
  let warning = false;
  let remainingSeconds = 60;

  // An open mandatory poll keeps the participant eligible during the vote window;
  // it does not prevent chat. This flag is only used to pause inactivity ejection.
  const openMandatoryPoll = db
    .prepare(
      `
      SELECT p.id, p.question
      FROM polls p
      WHERE p.room_id = ?
        AND p.mandatory = 1
        AND p.is_closed = 0
        AND (p.expires_at IS NULL OR p.expires_at > ?)
      ORDER BY p.id DESC
      LIMIT 1
    `
    )
    .get(roomId, nowIso());

  const isSimulatedAgent = !!(global.isSimulationRunning && global.simulatedPersonas && global.simulatedPersonas[req.user.id]);
  // The inactivity kick only makes sense while the room is actively deliberating. A user
  // returning later to a finished or deactivated room (e.g. to read the final report) must
  // never be removed for "inactivity".
  const roomLifecycle = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  const statePhase = db.prepare('SELECT current_phase FROM system_state WHERE id = 1').get()?.current_phase;
  const roomIsLive = roomLifecycle?.is_active === 1
    && roomLifecycle?.collection_complete !== 1
    && ['gathering', 'discussing'].includes(statePhase);
  if (!isAdmin && !isSimulatedAgent && !openMandatoryPoll && roomIsLive) {
    const settings = getDecisionSettings();
    const timeoutMin = settings.user_inactivity_timeout_minutes !== undefined ? settings.user_inactivity_timeout_minutes : 5;
    
    const lastMsg = db.prepare('SELECT timestamp FROM messages WHERE sender_id = ? AND room_id = ? ORDER BY id DESC LIMIT 1').get(req.user.id, roomId);
    const lastVoteVal = db.prepare(`
      SELECT created_at FROM poll_votes
      WHERE user_id = ? AND poll_id IN (SELECT id FROM polls WHERE room_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(req.user.id, roomId);
    const lastSwipeVal = db.prepare(`
      SELECT created_at FROM swipe_votes
      WHERE user_id = ? AND poll_id IN (SELECT id FROM polls WHERE room_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(req.user.id, roomId);
    // Start from 0 (not Date.now(), which previously made elapsed always ~0 so no one was ever
    // kicked) and take the most recent real activity: a message, a vote, or a swipe vote.
    let lastActiveMs = 0;
    let hasActivity = false;
    if (lastMsg) {
      lastActiveMs = Math.max(lastActiveMs, new Date(lastMsg.timestamp).getTime());
      hasActivity = true;
    }
    if (lastVoteVal) {
      lastActiveMs = Math.max(lastActiveMs, new Date(lastVoteVal.created_at).getTime());
      hasActivity = true;
    }
    if (lastSwipeVal) {
      lastActiveMs = Math.max(lastActiveMs, new Date(lastSwipeVal.created_at).getTime());
      hasActivity = true;
    }

    // A user who has never interacted yet gets the benefit of the doubt (no kick); only a
    // previously-active participant who then goes silent is treated as inactive.
    const elapsedMin = hasActivity ? (Date.now() - lastActiveMs) / (60 * 1000) : 0;

    if (elapsedMin >= timeoutMin + 1) {
      db.prepare('DELETE FROM room_members WHERE user_id = ? AND room_id = ?').run(req.user.id, roomId);
      
      const timestamp = new Date().toISOString();
      const msgText = `${req.user.username} has been removed from the discussion room due to inactivity.`;
      db.prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)').run(roomId, msgText, timestamp);
      
      try {
        const io = req.app.get('io');
        if (io) {
          io.in(`user:${req.user.id}`).socketsLeave(`room:${roomId}`);
          io.to(`user:${req.user.id}`).emit('membership_revoked', { roomId });
          io.to(`room:${roomId}`).emit('receive_message', {
            id: Date.now(),
            room_id: roomId,
            sender_id: null,
            sender_name: 'Bot',
            text: msgText,
            timestamp,
            is_bot: true
          });
          io.to(`room:${roomId}`).emit('room_status_updated', { roomId });
          io.to(`room:${roomId}`).emit('rooms_updated');
          io.to(`user:${req.user.id}`).emit('rooms_updated');
        }
      } catch (err) {}

      const openPolls = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').all(roomId);
      for (const poll of openPolls) {
        await maybeResolvePollEarlyForVote(poll.id, roomId).catch((error) => {
          console.error('Failed to re-evaluate poll after inactivity kick:', error);
        });
      }

      if (roomMeta?.room_type === 'personal') {
        await maybeAdvanceToGroupPhase().catch((error) => {
          console.error('Failed to advance group phase after inactivity kick:', error);
        });
      }

      kicked = true;
    } else if (elapsedMin >= timeoutMin) {
      warning = true;
      const totalWarningMs = (timeoutMin + 1) * 60 * 1000;
      const elapsedMs = elapsedMin * 60 * 1000;
      remainingSeconds = Math.max(0, Math.ceil((totalWarningMs - elapsedMs) / 1000));
    }
  }

  if (kicked) {
    return res.json({ kicked: true });
  }

  const room = db.prepare('SELECT room_type, collection_complete, topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  const collectionComplete = room?.collection_complete === 1;

  let ongoingTopic = null;
  let tieVotes = 0;
  const pointsDecided = [];

  if (room) {
    let memory = [];
    try {
      memory = JSON.parse(room.topic_memory_json || '[]');
    } catch (e) {}

    const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
    const realGlobalQuestion = state?.global_question || 'general-question';

    for (const entry of memory) {
      let topicKey = entry.suggestion || entry.key || entry.question || entry.summary;
      const isGen = entry.is_general_question || topicKey === 'general-question' || entry.key === 'general-question';
      let topicDisplayName = topicKey;
      if (isGen) {
        topicDisplayName = realGlobalQuestion;
      } else {
        const qRow = db.prepare('SELECT question_text FROM gathering_questions WHERE topic = ?').get(topicKey);
        if (qRow && qRow.question_text) {
          topicDisplayName = qRow.question_text;
        }
      }
      if (entry.status === 'resolved') {
        const winner = entry.decision || entry.summary || 'resolved';
        pointsDecided.push(`${topicDisplayName}: ${winner}`);
      }
    }

    if (!collectionComplete && room.room_type !== 'personal') {
      const unresolved = memory.filter((entry) => String(entry.status || '').toLowerCase() !== 'resolved');
      const activeTopicObj = unresolved[0];
      if (activeTopicObj) {
        let topicKey = activeTopicObj.suggestion || activeTopicObj.key || activeTopicObj.question;
        const isGen = activeTopicObj.is_general_question || topicKey === 'general-question' || activeTopicObj.key === 'general-question';
        let topicDisplayName = topicKey;
        if (isGen) {
          topicDisplayName = realGlobalQuestion;
        } else {
          const qRow = db.prepare('SELECT question_text FROM gathering_questions WHERE topic = ?').get(topicKey);
          if (qRow && qRow.question_text) {
            topicDisplayName = qRow.question_text;
          }
        }
        ongoingTopic = topicDisplayName;
        tieVotes = countLegitimateFailedPolls(roomId, activeTopicObj.suggestion || activeTopicObj.key);
      }
    }
  }

  return res.json({
    status: {
      ongoing_topic: ongoingTopic,
      tie_votes: tieVotes,
      points_decided: pointsDecided
    },
    warning,
    remaining_seconds: remainingSeconds
  });
});
router.post('/:roomId/reopen-topic', async (req, res) => {
  const roomId = Number(req.params.roomId);
  const { topicKey } = req.body;
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!topicKey) return res.status(400).json({ error: 'Missing topicKey' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Not a member of this room' });

  const room = db
    .prepare('SELECT room_type, topic_memory_json, convergence_summary_at, convergence_finalized FROM rooms WHERE id = ?')
    .get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.room_type !== 'convergence') return res.status(400).json({ error: 'Only allowed in convergence rooms' });

  const result = recordConvergenceReopen(roomId, req.user.id, topicKey);
  if (!result.success) {
    const status = result.error === 'The review window has closed.'
      ? 409
      : result.error === 'Topic not found in room memory' ? 404 : 400;
    return res.status(status).json({ error: result.error });
  }
  return res.json(result);
});

// A participant pressed "I agree" on the convergence summary. Record it; if every non-admin
// member has agreed, close the review window immediately (even before the configured duration).
router.post('/:roomId/convergence-agree', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Not a member of this room' });

  const room = db.prepare('SELECT room_type, convergence_finalized FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.room_type !== 'convergence') return res.status(400).json({ error: 'Only allowed in convergence rooms' });
  if (room.convergence_finalized === 1) return res.json({ success: true, finalized: true });

  try {
    const result = recordConvergenceAgreement(roomId, req.user.id);
    if (!result.success) {
      const status = result.error === 'The review window has closed.' ? 409 : 400;
      return res.status(status).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    console.error('Failed to finalize convergence room after unanimous agreement:', err);
    return res.status(500).json({ error: 'Could not record convergence agreement' });
  }
});

// Live state of the convergence summary review window, polled by clients while the summary card
// is on screen: whether the window has finalized, seconds left, and which topics were reopened.
router.get('/:roomId/convergence-status', (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId)) return res.status(403).json({ error: 'Not a member of this room' });

  const room = db
    .prepare('SELECT room_type, topic_memory_json, convergence_summary_at, convergence_finalized FROM rooms WHERE id = ?')
    .get(roomId);
  if (!room || room.room_type !== 'convergence') {
    return res.json({ isConvergence: false });
  }

  const windowMs = getConvergenceReviewWindowMs();
  const startedAt = room.convergence_summary_at ? new Date(room.convergence_summary_at).getTime() : NaN;
  const elapsed = Number.isNaN(startedAt) ? Infinity : Date.now() - startedAt;
  const secondsRemaining = Number.isFinite(elapsed) ? Math.max(0, Math.ceil((windowMs - elapsed) / 1000)) : 0;
  const finalized = room.convergence_finalized === 1 || secondsRemaining === 0;

  // Only reveal which topics were reopened AFTER the review window closes, so a participant's
  // reopen choice stays private during the configured review window.
  let reopenedKeys = [];
  if (finalized) {
    try {
      const memory = JSON.parse(room.topic_memory_json || '[]');
      reopenedKeys = memory.filter(m => m.reopened === true).map(m => m.key);
    } catch (e) { reopenedKeys = []; }
  }

  const memberCount = db
    .prepare('SELECT COUNT(*) AS c FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0')
    .get(roomId)?.c || 0;
  const agreedCount = db
    .prepare('SELECT COUNT(*) AS c FROM convergence_agreements ca JOIN users u ON u.id = ca.user_id WHERE ca.room_id = ? AND u.is_admin = 0')
    .get(roomId)?.c || 0;
  const youAgreed = !!db.prepare('SELECT 1 FROM convergence_agreements WHERE room_id = ? AND user_id = ?').get(roomId, req.user.id);

  return res.json({
    isConvergence: true,
    summaryAt: room.convergence_summary_at || null,
    secondsRemaining,
    finalized,
    reopenedKeys,
    memberCount,
    agreedCount,
    youAgreed
  });
});


router.post('/polls/:pollId/vote', async (req, res) => {
  const pollId = Number(req.params.pollId);
  const { optionId, optionIds, rankedOptions, customOptionText, swipeVotes, requestId } = req.body;
  if (!Number.isInteger(pollId)) {
    return res.status(400).json({ error: 'Invalid pollId' });
  }
  if (
    !Number.isInteger(optionId) &&
    (!Array.isArray(rankedOptions) || rankedOptions.length === 0) &&
    (!Array.isArray(optionIds) || optionIds.length === 0) &&
    (!Array.isArray(swipeVotes) || swipeVotes.length === 0) &&
    (!customOptionText || customOptionText.trim() === '')
  ) {
    return res.status(400).json({ error: 'Invalid optionId, optionIds, rankedOptions, swipeVotes, or customOptionText' });
  }

  const poll = db.prepare('SELECT id, room_id, is_closed, expires_at, poll_type, poll_stage FROM polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.is_closed === 1 || (poll.expires_at && poll.expires_at <= nowIso())) {
    return res.status(400).json({ error: 'Poll is closed' });
  }
  if (!assertRoomMember(req.user.id, poll.room_id)) {
    return res.status(403).json({ error: 'Access denied for this room poll' });
  }
  if (req.user.is_admin) {
    return res.status(403).json({ error: 'Admins are ghost observers and cannot vote.' });
  }

  if (poll.poll_type === 'continuous' || poll.poll_stage === 'continuous') {
    // Older clients submitted the single selection as optionIds. Accept exactly
    // one ID from either shape, but never silently turn a multi-select payload
    // into a live vote.
    const continuousOptionId = Number.isInteger(optionId)
      ? optionId
      : (Array.isArray(optionIds) && optionIds.length === 1 && Number.isInteger(optionIds[0]) ? optionIds[0] : null);
    if (!Number.isInteger(continuousOptionId)) {
      return res.status(400).json({ error: 'Continuous voting requires one option.' });
    }
    const option = db.prepare('SELECT id, option_text FROM poll_options WHERE id = ? AND poll_id = ?').get(continuousOptionId, pollId);
    if (!option) return res.status(400).json({ error: 'Option does not belong to this poll' });

    const trimmedCustomOptionText = typeof customOptionText === 'string' ? customOptionText.trim() : '';
    const isOther = String(option.option_text).trim().toLowerCase() === 'other';
    if (isOther && !trimmedCustomOptionText) {
      return res.status(400).json({ error: 'Please describe your option.' });
    }
    if (!isOther && trimmedCustomOptionText) {
      return res.status(400).json({ error: 'A write-in description can only be submitted with Other.' });
    }
    let validatedCustomOptionText = trimmedCustomOptionText;
    if (isOther && validatedCustomOptionText) {
      const validity = await evaluateResponseValidity({
        text: validatedCustomOptionText,
        questionText: poll.question,
        roomContext: `Poll ${pollId} in room ${poll.room_id}`
      });
      if (!validity.is_valid) {
        return res.status(400).json({ error: 'That write-in option does not appear to be a meaningful response. Please try again.' });
      }
    }
    const timestamp = nowIso();
    const replaceVote = db.transaction(() => {
      db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, req.user.id);
      db.prepare(`
        INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
        VALUES (?, ?, ?, ?, 1, NULL)
      `).run(pollId, continuousOptionId, req.user.id, timestamp);
      if (isOther) {
        db.prepare('UPDATE poll_votes SET custom_option_text = ? WHERE poll_id = ? AND option_id = ? AND user_id = ?')
          .run(validatedCustomOptionText, pollId, continuousOptionId, req.user.id);
      }
    });
    replaceVote();
    recordContinuousVoteAudit({
      pollId,
      userId: req.user.id,
      optionId: continuousOptionId,
      customOptionText: isOther ? validatedCustomOptionText : null,
      requestId: requestId || null,
      source: 'human_continuous_vote'
    });
    announceContinuousVoteChange({
      pollId,
      roomId: poll.room_id,
      optionId: continuousOptionId,
      customOptionText: isOther ? validatedCustomOptionText : null
    });
    const io = req.app.get('io');
    if (io) io.to(`room:${poll.room_id}`).emit('polls_updated', { roomId: poll.room_id });
    maybeResolvePollEarlyForVote(pollId, poll.room_id).catch(err => console.error('[continuous vote] resolution error:', err.message || err));
    return res.json({
      ok: true,
      current_option_id: continuousOptionId,
      current_custom_option_text: isOther ? validatedCustomOptionText : null
    });
  }

  const trimmedCustomOptionText = typeof customOptionText === 'string' ? customOptionText.trim() : '';
  let validatedCustomOptionText = trimmedCustomOptionText;
  if (trimmedCustomOptionText) {
    const validity = await evaluateResponseValidity({
      text: trimmedCustomOptionText,
      questionText: poll.question,
      roomContext: `Poll ${pollId} in room ${poll.room_id}`
    });
    if (!validity.is_valid) {
      validatedCustomOptionText = '';
    }
  }

  // Handle swipe votes separately from normal poll votes
  if (poll.poll_type === 'swipe') {
    if (!Array.isArray(swipeVotes) || !swipeVotes.length || swipeVotes.some(vote =>
      !vote || !Number.isInteger(vote.optionId) || typeof vote.direction !== 'string' || !['left', 'right'].includes(vote.direction.toLowerCase()))) {
      return res.status(400).json({ error: 'Invalid swipe replacement' });
    }
    try {
      db.transaction(() => {
        if (Array.isArray(swipeVotes)) {
          const insertSwipe = db.prepare(
            'INSERT OR REPLACE INTO swipe_votes (poll_id, user_id, option_id, swipe_direction, created_at) VALUES (?, ?, ?, ?, ?)'
          );
          const deleteSwipe = db.prepare('DELETE FROM swipe_votes WHERE poll_id = ? AND user_id = ?');
          deleteSwipe.run(pollId, req.user.id);
          for (const vote of swipeVotes) {
            if (Number.isInteger(vote.optionId)) {
              const direction = (vote.direction || 'right').toLowerCase();
              insertSwipe.run(pollId, req.user.id, vote.optionId, direction, nowIso());
            }
          }
        }
      })();
    } catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Invalid swipe replacement' });
      throw error;
    }

    if (validatedCustomOptionText) {
      let otherOption = db.prepare("SELECT id FROM poll_options WHERE poll_id = ? AND LOWER(option_text) = 'other'").get(pollId);
      if (!otherOption) {
        const resOpt = db.prepare("INSERT INTO poll_options (poll_id, option_text) VALUES (?, 'Other')").run(pollId);
        otherOption = { id: Number(resOpt.lastInsertRowid) };
      }
      db.prepare("DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?").run(pollId, req.user.id);
      db.prepare(`
        INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
        VALUES (?, ?, ?, ?, 1, ?)
      `).run(pollId, otherOption.id, req.user.id, nowIso(), validatedCustomOptionText);
    }

    const io = req.app.get('io');
    if (io) io.to(`room:${poll.room_id}`).emit('polls_updated', { roomId: poll.room_id });
    maybeResolvePollEarlyForVote(pollId, poll.room_id).catch(err => console.error('[vote] poll resolution error:', err.message || err));
    return res.json({ ok: true });
  }

  try {
    db.transaction(() => {
      db.prepare('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, req.user.id);

      if (Array.isArray(rankedOptions)) {
        if (!rankedOptions.length || rankedOptions.some(id => !Number.isInteger(id))) throw Object.assign(new Error('Invalid ranking'), { status: 400 });
        const insertVote = db.prepare('INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank) VALUES (?, ?, ?, ?, ?)');
        let rank = 1;
        for (const optId of rankedOptions) {
          if (Number.isInteger(optId)) {
            insertVote.run(pollId, optId, req.user.id, nowIso(), rank++);
          }
        }
      } else if (Array.isArray(optionIds)) {
        if (!optionIds.length || optionIds.some(id => !Number.isInteger(id))) throw Object.assign(new Error('Invalid selections'), { status: 400 });
        const insertVote = db.prepare(`
          INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
          VALUES (?, ?, ?, ?, 1, ?)
        `);
        for (const optId of optionIds) {
          if (Number.isInteger(optId)) {
            const option = db.prepare('SELECT id, option_text FROM poll_options WHERE id = ? AND poll_id = ?').get(optId, pollId);
            if (!option) throw Object.assign(new Error('Invalid selection'), { status: 400 });
            if (option) {
              const isOther = option.option_text.toLowerCase() === 'other';
              insertVote.run(pollId, optId, req.user.id, nowIso(), isOther ? (validatedCustomOptionText || null) : null);
            }
          }
        }
      } else {
        const option = db.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId);
        if (!option) throw Object.assign(new Error('Option does not belong to this poll'), { status: 400 });

        db.prepare(
          `
          INSERT INTO poll_votes (poll_id, option_id, user_id, created_at, rank, custom_option_text)
          VALUES (?, ?, ?, ?, 1, ?)
        `
        ).run(pollId, optionId, req.user.id, nowIso(), validatedCustomOptionText || null);
      }
    })();
  } catch (error) {
    // Rollback also restores a prior vote if a replacement violates a DB constraint.
    if (error.status === 400 || String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(400).json({ error: 'Invalid vote replacement' });
    }
    throw error;
  }

  if (poll.question && poll.question.toLowerCase().includes('relevant or interesting to you')) {
    db.prepare('DELETE FROM user_topic_preferences WHERE user_id = ?').run(req.user.id);
    db.prepare('DELETE FROM topic_preference_responses WHERE poll_id = ? AND user_id = ?').run(pollId, req.user.id);
    const votedOptions = db.prepare(`
      SELECT po.option_text
      FROM poll_votes pv
      JOIN poll_options po ON po.id = pv.option_id
      WHERE pv.poll_id = ? AND pv.user_id = ?
      ORDER BY po.id ASC
    `).all(pollId, req.user.id);

    const selectedTopics = votedOptions.map((opt) => opt.option_text).filter((topic) => topic && topic.toLowerCase() !== 'all topics');
    const selectedAllTopics = votedOptions.some((opt) => opt.option_text.toLowerCase() === 'all topics') || selectedTopics.length === 0;
    const selectedJson = JSON.stringify(selectedTopics);

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
    ).run(req.user.id, poll.room_id, pollId, selectedJson, selectedAllTopics ? 1 : 0, nowIso());

    const insertPref = db.prepare('INSERT INTO user_topic_preferences (user_id, topic) VALUES (?, ?)');
    for (const topic of selectedTopics) {
      insertPref.run(req.user.id, topic);
    }
    if (selectedAllTopics) {
      insertPref.run(req.user.id, 'All topics');
    }
  }

  const io = req.app.get('io');
  if (io) io.to(`room:${poll.room_id}`).emit('polls_updated', { roomId: poll.room_id });
  maybeResolvePollEarlyForVote(pollId, poll.room_id).catch(err => console.error('[vote] poll resolution error:', err.message || err));

  return res.json({ ok: true });
});

router.post('/polls/:pollId/suggestions', async (req, res) => {
  const pollId = Number(req.params.pollId);
  if (!Number.isInteger(pollId)) return res.status(400).json({ error: 'Invalid pollId' });
  const poll = db.prepare('SELECT id, room_id, poll_type, poll_stage FROM polls WHERE id = ?').get(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!assertRoomMember(req.user.id, poll.room_id) || req.user.is_admin) return res.status(403).json({ error: 'Access denied for this poll' });
  if (poll.poll_type !== 'continuous' && poll.poll_stage !== 'continuous') return res.status(400).json({ error: 'Suggestions are only available during live voting.' });
  try {
    const result = await submitContinuousSuggestion({
      pollId,
      userId: req.user.id,
      text: req.body?.text,
      requestId: req.body?.requestId || null
    });
    return res.json({ ok: true, suggestion: result });
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Suggestion could not be processed.' });
  }
});

router.get('/:roomId/recap', async (req, res) => {
  const roomId = Number(req.params.roomId);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'Invalid roomId' });
  if (!assertRoomMember(req.user.id, roomId) && req.user.is_admin !== 1) return res.status(403).json({ error: 'Access denied for this room' });

  const room = db.prepare('SELECT room_type, collection_complete, recap_report FROM rooms WHERE id = ?').get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (room.collection_complete !== 1) {
    return res.status(400).json({ error: 'Room has not completed yet' });
  }

  // For the final (convergence) room, only ever return the finished Final Analysis Report. If it
  // is still being generated, respond 202 so the client keeps polling — never a draft/fallback.
  if (room.room_type === 'convergence') {
    if (room.recap_report && room.recap_report.trim()) {
      return res.json({ report: room.recap_report });
    }
    return res.status(202).json({ error: 'The final report is still being generated.' });
  }

  let report = room.recap_report;
  if (!report || room.room_type === 'group') {
    report = await generateRoomAnalysisReport(roomId);
  }

  return res.json({ report: report || 'Summary report not available.' });
});

export default router;
