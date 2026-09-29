import { env } from '../config/env.js';
import { db } from '../config/db.js';
import {
  appendDisagreementNudge,
  createConvergenceDiscussionRoom,
  createClusteredDiscussionRooms,
  emitDecisionStatus,
  logAgentEvent,
  getSimulationParticipantIds
} from './agent2Service.js';
import { generateAgent1Reply } from './agent1Service.js';
import {
  describeDecisionSettings,
  getAgentPrompt,
  getDecisionSettings,
  renderTemplate,
  settingToNudgeDelayMs,
  settingToTimeBeforePollMs,
  getConfiguredModels,
} from './agentConfigService.js';
import { evaluateResponseValidity } from './responseValidityService.js';
import client from './llm.js';
import { getWorkContext, throwIfWorkCancelled, runWithWorkContext } from './workContext.js';
import { createDecisionWorkContext, invalidateDecisionWork, setDecisionTimeout as setTimeout, setDecisionInterval as setInterval } from './decisionWorkService.js';

// client imported from llm.js
const pollTimers = new Map();
const pendingPollTimeouts = new Map();
const groupNudgeTimers = new Map();
const groupNudgeLastAttemptAt = new Map();
const convergenceReviewTimers = new Map();
const processingRooms = new Set();
// Per-poll serialization for live-vote suggestion processing. Two participants can submit the
// same brand-new option at the same time; without serialization both pass semantic-duplicate
// detection (each embeds against the option set before the other commits) and two identical
// options are created. Running suggestions for a poll one-at-a-time lets the second see the
// first's committed option and merge into it.
const suggestionLocks = new Map();
function runExclusive(map, key, task) {
  const prev = map.get(key) || Promise.resolve();
  const run = prev.then(task, task); // run regardless of the previous task's outcome
  const tail = run.catch(() => {}); // non-rejecting tail so the chain keeps flowing
  map.set(key, tail);
  tail.then(() => { if (map.get(key) === tail) map.delete(key); });
  return run;
}
let ioRef = null;

function nowIso() {
  return new Date().toISOString();
}

function getGeneralDescription() {
  return db.prepare('SELECT general_description FROM system_state WHERE id = 1').get()?.general_description || '';
}

function replaceOtherInRows(rows, pollId) {
  return rows.map(r => {
    let text = r.option_text;
    if (text && text.toLowerCase() === 'other') {
      const custom = db.prepare(`
        SELECT custom_option_text, COUNT(*) as c
        FROM poll_votes
        WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
        GROUP BY custom_option_text
        ORDER BY c DESC, custom_option_text ASC
        LIMIT 1
      `).get(pollId);
      if (custom && custom.custom_option_text) {
        text = custom.custom_option_text.trim();
      }
    }
    return { ...r, option_text: text };
  });
}

function emitPollsUpdated(roomId) {
  if (ioRef) ioRef.to(`room:${roomId}`).emit('polls_updated', { roomId });
}

function emitRoomUpdated(roomId, isActive) {
  if (!ioRef) return;
  const lifecycle = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  ioRef.to(`room:${roomId}`).emit('room_updated', {
    roomId,
    is_active: lifecycle ? lifecycle.is_active === 1 : !!isActive,
    collection_complete: lifecycle ? lifecycle.collection_complete === 1 : false
  });
}

function getEffectivePollTimerMinutes(roomId, isGlobalQuestion = false) {
  const baseMinutes = getDecisionSettings().poll_timer_minutes || 2;
  const room = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId);
  return room?.room_type === 'group' && isGlobalQuestion ? baseMinutes * 2 : baseMinutes;
}

export function isPollLifecycleMessage(text) {
  const value = String(text || '').trim();
  return (
    /^a mandatory poll has been created\b/i.test(value) ||
    /^voting closes in\b/i.test(value) ||
    /^a poll will appear shortly\b/i.test(value) ||
    /^the poll\b[\s\S]*\bclosed\b/i.test(value) ||
    /^the final poll closed\b/i.test(value) ||
    /^the swipe round did not reach full agreement\b/i.test(value) ||
    /^the swipe round did not reach agreement\b/i.test(value) ||
    /^the live voting phase has ended\b/i.test(value) ||
    /^the ranking vote is now open\b/i.test(value) ||
    /^a new relevant option has been added to the live vote\b/i.test(value) ||
    /^a participant proposed a new option\b/i.test(value) ||
    /^the current leading option is\b/i.test(value) ||
    /^the live vote is currently tied\b/i.test(value) ||
    /^a quorum has been reached\b/i.test(value) ||
    /^the ranking poll has concluded\b/i.test(value)
  );
}

// Vote requests are intentionally detected from ordinary chat text. The readiness
// LLM still decides whether the discussion is substantive enough; this helper only
// identifies when the bot should explain why a requested vote cannot open yet.
export function isVoteIntentText(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  return (
    /\b(can|could|shall|should|let(?:'s| us)|time to)\b[\s\S]*\b(vote|poll)\b/i.test(value) ||
    /\b(vote|poll)\b[\s\S]*\b(now|ready|please|yet)\b/i.test(value) ||
    /\b(?:we(?:'re| are)|everyone is|all(?: of us)? are|i(?:'m| am))\s+ready\s+(?:to\s+vote)?\b/i.test(value) ||
    /\b(?:i|we)\s+(?:want|would like)\s+to\s+vote\b/i.test(value) ||
    /^vote\s+(?:now|please)\b/i.test(value)
  );
}

export function getRequiredReadinessParticipants(memberCount, sensitivity) {
  const members = Math.max(0, Number(memberCount) || 0);
  const scale = Math.min(10, Math.max(1, Math.round(Number(sensitivity) || 1)));
  if (members === 0) return 1;
  return Math.min(members, Math.max(1, Math.ceil((members * scale) / 10)));
}

export function getReadinessParticipantGate(roomId, activeTurnMessages, sensitivity) {
  const memberNames = db.prepare(`
    SELECT LOWER(u.username) AS username
    FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND u.is_admin = 0
  `).all(roomId).map((row) => row.username);
  const memberSet = new Set(memberNames);
  const eligibleNames = memberSet.size > 0
    ? memberSet
    : new Set(activeTurnMessages.filter((message) => message.sender_name !== 'Bot')
      .map((message) => String(message.sender_name || '').trim().toLowerCase()).filter(Boolean));
  const activeUsers = new Set(activeTurnMessages
    .filter((message) => message.sender_name !== 'Bot')
    .map((message) => String(message.sender_name || '').trim().toLowerCase())
    .filter((username) => eligibleNames.has(username)));
  const memberCount = eligibleNames.size;
  const requiredUsers = getRequiredReadinessParticipants(memberCount, sensitivity);
  return {
    memberCount,
    activeUsers,
    requiredUsers,
    enoughDistinctParticipants: activeUsers.size >= requiredUsers
  };
}

function emitVoteReadinessNotice(roomId, text) {
  // Multiple participants may request a vote within the same second. Avoid sending
  // an identical explanation repeatedly while still allowing updated counts to show.
  const duplicate = db.prepare(`
    SELECT id FROM messages
    WHERE room_id = ? AND sender_id IS NULL AND text = ?
      AND timestamp >= ?
    LIMIT 1
  `).get(roomId, text, new Date(Date.now() - 10_000).toISOString());
  if (!duplicate) createBotMessage(roomId, text);
}

export function getGroupInactivityAnchor(roomId) {
  const messages = db
    .prepare('SELECT id, sender_id, text, timestamp FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 200')
    .all(roomId);

  const meaningfulMessage = messages.find((message) => {
    return message.sender_id !== null || !isPollLifecycleMessage(message.text);
  });
  if (meaningfulMessage) {
    return {
      key: `message:${meaningfulMessage.id}`,
      messageId: Number(meaningfulMessage.id),
      timestamp: meaningfulMessage.timestamp
    };
  }

  const room = db.prepare('SELECT opened_at, timer_expires_at, room_timer_minutes FROM rooms WHERE id = ?').get(roomId);
  let openedAt = room?.opened_at;
  if (!openedAt && room?.timer_expires_at && Number(room.room_timer_minutes) > 0) {
    openedAt = new Date(new Date(room.timer_expires_at).getTime() - Number(room.room_timer_minutes) * 60 * 1000).toISOString();
  }
  if (!openedAt) return null;
  return { key: `room:${openedAt}`, messageId: null, timestamp: openedAt };
}

export function createBotMessage(roomId, text, type = 'agent') {
  throwIfWorkCancelled();
  const timestamp = nowIso();
  const result = db
    .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)')
    .run(roomId, text, timestamp);
  const payload = {
    id: Number(result.lastInsertRowid),
    room_id: roomId,
    sender_id: null,
    sender_name: 'Bot',
    text,
    timestamp,
    is_bot: true
  };
  if (ioRef) ioRef.to(`room:${roomId}`).emit('receive_message', payload);
  return payload;
}

function approvalShareForLevel(level) {
  if (Number(level) === 3) return 1;
  if (Number(level) === 2) return 0.75;
  return 0.51;
}

function claimPollAnnouncement(pollId, eventKey) {
  const result = db.prepare(
    'INSERT OR IGNORE INTO poll_announcements (poll_id, event_key, created_at) VALUES (?, ?, ?)'
  ).run(pollId, eventKey, nowIso());
  return result.changes === 1;
}

function getContinuousMetrics(pollId, roomId) {
  const eligible = db.prepare(`
    SELECT COUNT(*) AS c
    FROM room_members rm
    JOIN users u ON u.id = rm.user_id
    WHERE rm.room_id = ? AND u.is_admin = 0
  `).get(roomId)?.c || 0;
  const counts = db.prepare(`
    SELECT pv.option_id, po.option_text, COUNT(DISTINCT pv.user_id) AS votes
    FROM poll_votes pv
    JOIN poll_options po ON po.id = pv.option_id AND po.poll_id = ?
    JOIN users u ON u.id = pv.user_id AND u.is_admin = 0
    WHERE pv.poll_id = ?
    GROUP BY pv.option_id
    ORDER BY votes DESC, pv.option_id DESC
  `).all(pollId, pollId);
  const voted = db.prepare(`
    SELECT COUNT(DISTINCT pv.user_id) AS c
    FROM poll_votes pv
    JOIN users u ON u.id = pv.user_id AND u.is_admin = 0
    WHERE pv.poll_id = ?
  `).get(pollId)?.c || 0;
  const settings = getDecisionSettings();
  const quorumRequired = eligible > 0
    ? Math.max(1, Math.ceil(eligible * settings.minimum_votes_for_approval / 100))
    : 0;
  const approvalRequired = eligible > 0
    ? Math.max(1, Math.ceil(eligible * approvalShareForLevel(settings.poll_approval_threshold)))
    : 0;
  const leader = counts[0] || null;
  const quorumReached = voted >= quorumRequired;
  const approvalReached = !!leader && leader.votes >= approvalRequired;
  return { eligible, counts, voted, quorumRequired, approvalRequired, quorumReached, approvalReached, leader };
}

function continuousAnnouncementKey(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 180);
}

// Current live-vote leaders, grouped so each distinct write-in counts as its own option (rather
// than lumping every "Other" vote together) and labelled with the write-in text, not "Other".
function getContinuousGroupedLeaders(pollId) {
  const currentVotes = db.prepare(`
    SELECT pv.option_id, po.option_text, pv.custom_option_text, pv.created_at
    FROM poll_votes pv
    JOIN poll_options po ON po.id = pv.option_id AND po.poll_id = ?
    JOIN users u ON u.id = pv.user_id AND u.is_admin = 0
    WHERE pv.poll_id = ?
  `).all(pollId, pollId);
  const grouped = new Map();
  for (const vote of currentVotes) {
    const writeIn = String(vote.option_text || '').trim().toLowerCase() === 'other'
      ? String(vote.custom_option_text || '').trim()
      : '';
    const label = writeIn || vote.option_text;
    const key = writeIn
      ? `custom:${continuousAnnouncementKey(writeIn)}`
      : `option:${vote.option_id}`;
    const current = grouped.get(key) || { key, label, votes: 0, latestAt: 0 };
    current.votes += 1;
    current.latestAt = Math.max(current.latestAt, new Date(vote.created_at).getTime() || 0);
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .filter((entry) => entry.votes > 0)
    .sort((a, b) => b.votes - a.votes || b.latestAt - a.latestAt || a.label.localeCompare(b.label));
}

// Announce meaningful live-vote changes once per persisted event. The database
// claim makes this safe when a vote request, timer, and socket reconnect race.
export function announceContinuousVoteChange({ pollId, roomId, optionId, customOptionText }) {
  const option = db.prepare('SELECT option_text FROM poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId);
  if (!option) return;
  const customText = String(customOptionText || '').trim();
  const isOther = String(option.option_text || '').trim().toLowerCase() === 'other';

  // Collect the announcements triggered by this single vote change and post them as ONE bot
  // message, so "a new option was proposed" and the resulting leader/tie update do not arrive
  // as two separate bubbles at the same instant.
  const parts = [];
  if (isOther && customText && claimPollAnnouncement(pollId, `custom-option:${continuousAnnouncementKey(customText)}`)) {
    parts.push(`A participant proposed a new option for the live vote: **${customText}**.`);
  }

  const leaders = getContinuousGroupedLeaders(pollId);
  const leader = leaders[0];
  if (leader) {
    const tied = leaders.filter((entry) => entry.votes === leader.votes).slice(0, 3);
    const leaderKey = tied.map((entry) => entry.key).join('|');
    if (claimPollAnnouncement(pollId, `leader:${leaderKey}:${leader.votes}`)) {
      if (tied.length > 1) {
        parts.push(`The live vote is currently tied between ${tied.map((entry) => `**${entry.label}**`).join(' and ')} with ${leader.votes} vote(s) each.`);
      } else {
        parts.push(`The current leading option is **${leader.label}** with ${leader.votes} vote(s).`);
      }
    }
  }

  if (parts.length > 0) createBotMessage(roomId, parts.join(' '));
}

function getContinuousOptionSnapshot(pollId) {
  return db.prepare(`
    SELECT po.id, po.option_text, COUNT(DISTINCT CASE WHEN u.is_admin = 0 THEN pv.user_id END) AS votes
    FROM poll_options po
    LEFT JOIN poll_votes pv ON pv.option_id = po.id AND pv.poll_id = ?
    LEFT JOIN users u ON u.id = pv.user_id
    WHERE po.poll_id = ?
    GROUP BY po.id
    ORDER BY votes DESC, po.id DESC
  `).all(pollId, pollId).map((row) => ({
    id: Number(row.id),
    option_text: row.option_text,
    votes: Number(row.votes || 0)
  }));
}

function getContinuousRankingOptions(pollId, snapshot) {
  const limit = getDecisionSettings().maximum_visible_options || 8;
  const activeIds = new Set(
    db.prepare('SELECT DISTINCT option_id FROM poll_votes WHERE poll_id = ?').all(pollId).map((row) => Number(row.option_id))
  );
  // Other is a permanent live-voting control, not a ranking candidate. The
  // ranking set is the top substantive options, plus every substantive option
  // that still has an active voter. This preserves a participant's choice even
  // when it falls outside the visible top list.
  const top = snapshot
    .filter((item) => !['other', 'keep discussing'].includes(String(item.option_text || '').trim().toLowerCase()))
    .slice(0, limit);
  for (const option of snapshot.filter((item) => {
    const label = String(item.option_text || '').trim().toLowerCase();
    return item.votes > 0 && label !== 'other' && label !== 'keep discussing';
  })) {
    if (activeIds.has(option.id) && !top.some((item) => item.id === option.id)) top.push(option);
  }

  // A write-in is stored under the stable Other option during live voting. At
  // ranking time, expose its actual text rather than asking participants to rank
  // the generic word Other.
  const writeIns = db.prepare(`
    SELECT pv.custom_option_text AS option_text, COUNT(DISTINCT pv.user_id) AS votes
    FROM poll_votes pv
    JOIN poll_options po ON po.id = pv.option_id AND po.poll_id = ?
    JOIN users u ON u.id = pv.user_id AND u.is_admin = 0
    WHERE pv.poll_id = ?
      AND LOWER(TRIM(po.option_text)) = 'other'
      AND pv.custom_option_text IS NOT NULL
      AND TRIM(pv.custom_option_text) != ''
    GROUP BY TRIM(pv.custom_option_text)
    ORDER BY votes DESC, MAX(pv.created_at) DESC
  `).all(pollId, pollId);
  for (const writeIn of writeIns) {
    if (!top.some((item) => item.option_text.toLowerCase() === writeIn.option_text.trim().toLowerCase())) {
      top.push({ option_text: writeIn.option_text.trim(), votes: Number(writeIn.votes || 0) });
    }
  }
  return top.map((option) => option.option_text).filter(Boolean);
}

function scheduleContinuousStabilityCheck(pollId, roomId, delayMs) {
  const key = `continuous:${pollId}`;
  if (pendingPollTimeouts.has(key)) clearTimeout(pendingPollTimeouts.get(key));
  const timer = setTimeout(() => {
    pendingPollTimeouts.delete(key);
    resolvePoll(pollId, roomId).catch((error) => console.error('[continuous] stability check failed:', error));
  }, Math.max(50, delayMs));
  pendingPollTimeouts.set(key, timer);
}

function scheduleContinuousReview(pollId, roomId, reviewUntil) {
  const key = `review:${pollId}`;
  if (pendingPollTimeouts.has(key)) clearTimeout(pendingPollTimeouts.get(key));
  const timer = setTimeout(() => {
    pendingPollTimeouts.delete(key);
    finalizeContinuousReview(pollId, roomId).catch((error) => console.error('[continuous] review finalization failed:', error));
  }, Math.max(50, new Date(reviewUntil).getTime() - Date.now()));
  pendingPollTimeouts.set(key, timer);
}

export async function finalizeContinuousReview(pollId, roomId) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ? AND room_id = ?').get(pollId, roomId);
  if (!poll || poll.poll_type !== 'continuous' || !poll.review_until || poll.transitioned_to_poll_id) return null;
  if (new Date(poll.review_until).getTime() > Date.now()) {
    scheduleContinuousReview(pollId, roomId, poll.review_until);
    return null;
  }
  const room = db.prepare('SELECT is_active, collection_complete, topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  const topicKey = normalizeTopicKey(poll.suggestion || poll.question);
  const memoryBeforeTransition = parseRoomMemory(room);
  const currentEntry = memoryBeforeTransition.find((item) => (
    normalizeTopicKey(item.key || item.suggestion || item.question) === topicKey
  ));
  const newerTopicPoll = db.prepare(`
    SELECT id FROM polls
    WHERE room_id = ? AND id > ? AND (suggestion = ? OR question = ?)
    ORDER BY id DESC LIMIT 1
  `).get(roomId, pollId, poll.suggestion, poll.question);

  // A delayed review callback must never resurrect a topic after the room moved on. This can
  // happen when a recovery sweep opens a newer round before the old one-minute review fires.
  if (!room || room.is_active !== 1 || room.collection_complete === 1
      || String(currentEntry?.status || '').toLowerCase() === 'resolved' || newerTopicPoll) {
    db.prepare(`
      UPDATE polls
      SET transitioned_to_poll_id = -1,
          closed_reason = CASE WHEN closed_reason = '' THEN 'stale_review_cancelled' ELSE closed_reason END
      WHERE id = ? AND transitioned_to_poll_id IS NULL
    `).run(pollId);
    return null;
  }

  const anotherOpenPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId);
  if (anotherOpenPoll) return null;
  const snapshot = (() => {
    try { return JSON.parse(poll.timeout_snapshot_json || '[]'); } catch { return []; }
  })();
  const rankingOptions = getContinuousRankingOptions(pollId, snapshot);
  const memory = parseRoomMemory(db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId));
  const key = poll.suggestion || poll.question;
  const entry = memory.find((item) => normalizeTopicKey(item.key || item.suggestion || item.question) === normalizeTopicKey(key));
  if (entry) {
    entry.status = 'disputed';
    entry.chain_stage = 'ranking';
    entry.options = rankingOptions;
    entry.updated_at = nowIso();
    db.prepare('UPDATE rooms SET topic_memory_json = ? WHERE id = ?').run(JSON.stringify(memory), roomId);
  }
  if (claimPollAnnouncement(pollId, 'ranking-open')) {
    createBotMessage(roomId, rankingOptions.length > 0
      ? `The live voting phase has ended. Here is the result so far: ${snapshot.filter((o) => o.votes > 0).slice(0, getDecisionSettings().maximum_visible_options || 8).map((o) => `**${o.option_text}** (${o.votes})`).join(', ')}. The final ranking vote will open in one minute.`
      : 'The live voting phase ended without any active votes. We will use the predefined topic options for the final ranking vote, which opens in one minute.');
  }
  const options = rankingOptions.length >= 2 ? rankingOptions : snapshot.map((o) => o.option_text).filter(Boolean).slice(0, 8);
  if (options.length < 2) {
    db.prepare('UPDATE polls SET transitioned_to_poll_id = -1 WHERE id = ?').run(pollId);
    createBotMessage(roomId, 'There were not enough valid options to open a ranking vote. The topic remains open for discussion.');
    return null;
  }
  const rankingPollId = createMandatoryPoll(
    roomId,
    poll.question,
    options,
    'Continuous voting review window ended.',
    poll.suggestion,
    null,
    true,
    'ranking',
    'ranking'
  );
  if (!rankingPollId) return null;
  db.prepare('UPDATE polls SET transitioned_to_poll_id = ? WHERE id = ?').run(rankingPollId, pollId);
  createBotMessage(roomId, 'The ranking vote is now open. Please rank the remaining options from most to least preferred.');
  emitPollsUpdated(roomId);
  return rankingPollId;
}

async function resolveContinuousPoll(poll, roomId) {
  const now = Date.now();
  const expired = poll.expires_at && new Date(poll.expires_at).getTime() <= now;
  const metrics = getContinuousMetrics(poll.id, roomId);
  const stabilityMs = (getDecisionSettings().consensus_stability_duration_seconds || 0) * 1000;
  const minimumLiveUntil = poll.minimum_live_until ? new Date(poll.minimum_live_until).getTime() : 0;
  const expiresAt = poll.expires_at ? new Date(poll.expires_at).getTime() : Infinity;
  let stabilityStartedAt = poll.stability_started_at
    ? new Date(poll.stability_started_at).getTime() : null;
  const thresholdsReached = metrics.quorumReached && metrics.approvalReached;

  // Track qualifying support while the minimum live period runs. Waiting until
  // that period ends makes consensus impossible when minimum and maximum match.
  if (!thresholdsReached) {
    if (poll.stability_started_at) {
      db.prepare('UPDATE polls SET stability_started_at = NULL WHERE id = ? AND is_closed = 0').run(poll.id);
    }
    stabilityStartedAt = null;
  } else if (stabilityStartedAt === null && !expired) {
    const started = nowIso();
    const upd = db.prepare('UPDATE polls SET stability_started_at = ? WHERE id = ? AND is_closed = 0 AND stability_started_at IS NULL').run(started, poll.id);
    stabilityStartedAt = new Date(started).getTime();
    if (upd.changes === 1 && claimPollAnnouncement(poll.id, 'quorum-reached')) {
      const leaderLabel = getContinuousGroupedLeaders(poll.id)[0]?.label;
      const leaderClause = leaderLabel
        ? `**${leaderLabel}** currently meets the approval threshold`
        : 'the current leading option meets the approval threshold';
      const earliestClosure = Math.max(minimumLiveUntil, stabilityStartedAt + stabilityMs);
      const secondsLeft = Math.max(1, Math.ceil((Math.min(earliestClosure, expiresAt) - now) / 1000));
      createBotMessage(roomId, `A quorum has been reached — ${metrics.voted}/${metrics.eligible} have voted and ${leaderClause}. Voting remains open for about ${secondsLeft} second(s). Agreement requires this support to remain above the threshold for the stability period.`);
      emitPollsUpdated(roomId);
    }
  }

  // Evaluate stability at the deadline, not at a possibly delayed callback time.
  // Expiry does not imply failure: a qualified, stable result must still win.
  const stableConsensus = thresholdsReached && (stabilityMs === 0 || (
    stabilityStartedAt !== null && Math.min(now, expiresAt) - stabilityStartedAt >= stabilityMs
  ));
  if (!expired && (!stableConsensus || now < minimumLiveUntil)) {
    if (thresholdsReached && stabilityStartedAt !== null) {
      const nextCheck = Math.min(expiresAt, Math.max(minimumLiveUntil, stabilityStartedAt + stabilityMs));
      scheduleContinuousStabilityCheck(poll.id, roomId, nextCheck - now + 100);
    }
    return false;
  }

  if (poll.review_until || poll.transitioned_to_poll_id) return false;
  const closedAt = nowIso();
  if (!stableConsensus) {
    const snapshot = getContinuousOptionSnapshot(poll.id);
    const update = db.prepare(`
      UPDATE polls
      SET is_closed = 1, closed_at = ?, has_consensus = 0, closed_reason = 'live_timeout',
          timeout_snapshot_json = ?, review_until = ?
      WHERE id = ? AND is_closed = 0
    `).run(closedAt, JSON.stringify(snapshot), new Date(now + 60 * 1000).toISOString(), poll.id);
    if (update.changes !== 1) return false;
    createBotMessage(roomId, `The live voting phase has ended without a stable agreement. The final ranking vote will begin in one minute.`);
    emitPollsUpdated(roomId);
    scheduleContinuousReview(poll.id, roomId, new Date(now + 60 * 1000).toISOString());
    return true;
  }

  const update = db.prepare(`
    UPDATE polls SET is_closed = 1, closed_at = ?, has_consensus = 1, closed_reason = 'stable_consensus'
    WHERE id = ? AND is_closed = 0
  `).run(closedAt, poll.id);
  if (update.changes !== 1) return false;
  // Report the winning option's real label — a write-in resolves to its text, never "Other".
  const winner = getContinuousGroupedLeaders(poll.id)[0]?.label || metrics.leader?.option_text || 'the leading option';
  upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
    ...parseRoomMemory(db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId)).find((item) => normalizeTopicKey(item.key || item.suggestion || item.question) === normalizeTopicKey(poll.suggestion || poll.question)),
    status: 'resolved',
    decision: winner,
    summary: metrics.counts.map((item) => `${item.option_text}: ${item.votes}`).join('; '),
    poll_id: poll.id,
    updated_at: nowIso()
  });
  createBotMessage(roomId, `The live vote stayed above the approval threshold for the required stability period. The group agreed on **${winner}**.`);
  emitPollsUpdated(roomId);
  await handleTopicTransition(roomId, winner);
  return true;
}

export async function submitContinuousSuggestion(args) {
  // Serialize per poll so concurrent identical suggestions cannot both create a new option.
  return runExclusive(suggestionLocks, args.pollId, () => submitContinuousSuggestionUnlocked(args));
}

/**
 * Persist the same audit events for live votes made by humans and simulated
 * participants. The current selection belongs in poll_votes; every selection
 * event belongs in poll_vote_history. A write-in made through the always-visible
 * Other option is also recorded in poll_suggestions so exports do not lose the
 * text merely because it used the direct vote control rather than the legacy
 * standalone suggestion endpoint.
 */
export function recordContinuousVoteAudit({
  pollId,
  userId,
  optionId,
  customOptionText = null,
  requestId = null,
  source = 'continuous_vote'
}) {
  const timestamp = nowIso();
  const cleanText = String(customOptionText || '').trim() || null;
  const analysis = JSON.stringify({
    source,
    validated: true,
    recorded_at: timestamp
  });
  db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO poll_vote_history (
        poll_id, user_id, option_id, action, custom_option_text, request_id, created_at
      ) VALUES (?, ?, ?, 'replace', ?, ?, ?)
    `).run(pollId, userId, optionId, cleanText, requestId || null, timestamp);

    if (cleanText) {
      db.prepare(`
        INSERT OR IGNORE INTO poll_suggestions (
          poll_id, user_id, source_text, status, canonical_option_id,
          analysis_json, request_id, created_at, processed_at
        ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?)
      `).run(pollId, userId, cleanText, optionId, analysis, requestId || null, timestamp, timestamp);
    }
  })();
}

async function submitContinuousSuggestionUnlocked({ pollId, userId, text, requestId = null }) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
  if (!poll || poll.poll_type !== 'continuous' || poll.is_closed === 1) throw new Error('Continuous poll is not open');
  const sourceText = String(text || '').trim();
  if (sourceText.length < 3 || sourceText.length > 240) throw new Error('Suggestion must contain 3 to 240 characters.');
  const settings = getDecisionSettings();
  if (requestId) {
    const existingRequest = db.prepare('SELECT id, status, canonical_option_id FROM poll_suggestions WHERE poll_id = ? AND user_id = ? AND request_id = ?').get(pollId, userId, requestId);
    if (existingRequest) return existingRequest;
  }
  const last = db.prepare(`SELECT created_at FROM poll_suggestions WHERE poll_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1`).get(pollId, userId);
  if (last && Date.now() - new Date(last.created_at).getTime() < settings.suggestion_cooldown_seconds * 1000) {
    throw new Error('Please wait before submitting another suggestion.');
  }
  const pending = db.prepare("SELECT id FROM poll_suggestions WHERE poll_id = ? AND user_id = ? AND status = 'pending'").get(pollId, userId);
  if (pending) throw new Error('You already have a suggestion being reviewed.');
  const insert = db.prepare(`INSERT INTO poll_suggestions (poll_id, user_id, source_text, request_id, created_at) VALUES (?, ?, ?, ?, ?)`);
  let suggestionId;
  try {
    suggestionId = Number(insert.run(pollId, userId, sourceText, requestId || null, nowIso()).lastInsertRowid);
  } catch (error) {
    if (requestId) {
      const existing = db.prepare('SELECT id, status, canonical_option_id FROM poll_suggestions WHERE poll_id = ? AND user_id = ? AND request_id = ?').get(pollId, userId, requestId);
      if (existing) return existing;
    }
    throw error;
  }
  if (!client) {
    db.prepare("UPDATE poll_suggestions SET status = 'rejected', analysis_json = ?, processed_at = ? WHERE id = ?").run(JSON.stringify({ reason: 'LLM unavailable' }), nowIso(), suggestionId);
    throw new Error('Suggestions require the configured LLM service.');
  }
  try {
    const options = db.prepare('SELECT id, option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC').all(pollId);
    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `Assess a proposed option for this decision poll. Return JSON with valid (boolean), relevant (boolean), canonical_text (string), duplicate_option_id (number or null), reason (string). Reject nonsense, insults, spam, personal attacks, and content unrelated to the decision. Existing options: ${options.map((option) => `${option.id}: ${option.option_text}`).join(' | ')}`
      }, { role: 'user', content: sourceText }],
      metadata: { roomId: poll.room_id, caller: 'continuous_option_validation' }
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    let analysis = { ...parsed };
    let canonicalId = Number.isInteger(parsed.duplicate_option_id) ? parsed.duplicate_option_id : null;
    if (!canonicalId && parsed.valid && parsed.relevant && client.embeddings?.create) {
      try {
        const embedding = await client.embeddings.create({
          model: env.embeddingModel,
          input: [sourceText, ...options.map((option) => option.option_text)],
          metadata: { roomId: poll.room_id, caller: 'continuous_option_validation_embedding' }
        });
        const vectors = embedding.data?.map((item) => item.embedding || []) || [];
        const cosine = (a, b) => {
          const dot = a.reduce((sum, value, index) => sum + value * (b[index] || 0), 0);
          const na = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
          const nb = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
          return na && nb ? dot / (na * nb) : 0;
        };
        let best = { score: 0, id: null };
        for (let index = 1; index < vectors.length; index += 1) {
          const score = cosine(vectors[0] || [], vectors[index] || []);
          if (score > best.score) best = { score, id: options[index - 1]?.id };
        }
        if (best.score >= 0.9) { canonicalId = best.id; analysis = { ...analysis, embedding_similarity: best.score }; }
      } catch (embeddingError) {
        analysis = { ...analysis, embedding_error: embeddingError.message || 'embedding unavailable' };
      }
    }
    if (!parsed.valid || !parsed.relevant) {
      db.prepare("UPDATE poll_suggestions SET status = 'rejected', analysis_json = ?, processed_at = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify(analysis), nowIso(), suggestionId);
      return { id: suggestionId, status: 'rejected', reason: parsed.reason || 'Suggestion was not relevant.' };
    }
    if (canonicalId) {
      const existing = db.prepare('SELECT id FROM poll_options WHERE id = ? AND poll_id = ?').get(canonicalId, pollId);
      if (existing) {
        db.prepare("UPDATE poll_suggestions SET status = 'merged', canonical_option_id = ?, analysis_json = ?, processed_at = ? WHERE id = ? AND status = 'pending'").run(canonicalId, JSON.stringify(analysis), nowIso(), suggestionId);
        return { id: suggestionId, status: 'merged', canonical_option_id: canonicalId };
      }
    }
    const canonicalText = String(parsed.canonical_text || sourceText).trim().slice(0, 240);
    const optionResult = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)').run(pollId, canonicalText);
    db.prepare("UPDATE poll_suggestions SET status = 'accepted', canonical_option_id = ?, analysis_json = ?, processed_at = ? WHERE id = ? AND status = 'pending'").run(Number(optionResult.lastInsertRowid), JSON.stringify(analysis), nowIso(), suggestionId);
    createBotMessage(poll.room_id, `A new relevant option has been added to the live vote: **${canonicalText}**.`);
    emitPollsUpdated(poll.room_id);
    return { id: suggestionId, status: 'accepted', canonical_option_id: Number(optionResult.lastInsertRowid), option_text: canonicalText };
  } catch (error) {
    db.prepare("UPDATE poll_suggestions SET status = 'rejected', analysis_json = ?, processed_at = ? WHERE id = ? AND status = 'pending'").run(JSON.stringify({ error: error.message }), nowIso(), suggestionId);
    throw error;
  }
}

function createContinuousPollFromSwipe(poll, roomId, entry, rows) {
  const candidateOptions = rows
    // Only options positively selected in the failed swipe survive into live
    // voting. Zero-vote options must not be silently carried forward from the
    // swipe poll or from room memory.
    .filter((row) => Number(row.votes || 0) > 0)
    .filter((row) => !['other', 'keep discussing'].includes(String(row.option_text || '').toLowerCase()))
    .sort((a, b) => Number(b.votes || 0) - Number(a.votes || 0))
    .map((row) => row.option_text)
    .filter(Boolean);
  const options = [...new Set(candidateOptions.filter((option) => {
    const value = String(option || '').toLowerCase();
    return value && value !== 'other' && value !== 'keep discussing';
  }))].slice(0, 20);
  // `Other` is a permanent live-voting control. It is sufficient when a
  // failed swipe has fewer than two positive survivors, including an all-zero
  // swipe, and lets participants introduce a relevant option without
  // resurrecting options that nobody selected.
  const safeOptions = options.length > 0 ? options : ['Other'];
  upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
    ...entry,
    status: 'discussing',
    chain_stage: 'continuous',
    options: safeOptions,
    updated_at: nowIso()
  });
  const settings = getDecisionSettings();
  const expiresAt = new Date(Date.now() + settings.live_voting_duration_minutes * 60 * 1000).toISOString();
  const continuousId = createMandatoryPoll(
    roomId,
    poll.question,
    safeOptions,
    'Swipe round did not reach approval; continuous live voting started.',
    poll.suggestion,
    null,
    true,
    'continuous',
    'continuous',
    expiresAt
  );
  db.prepare('UPDATE polls SET transitioned_to_poll_id = ?, closed_reason = COALESCE(NULLIF(closed_reason, \'\'), \'swipe_failed\') WHERE id = ?')
    .run(continuousId, poll.id);
  createBotMessage(roomId, `The swipe round did not reach agreement. Live voting is now open for ${settings.live_voting_duration_minutes} minute(s). You can change your single selection at any time or suggest a new option.`);
  emitPollsUpdated(roomId);
  return continuousId;
}

// Convergence rooms open with an admin-configured interactive summary review window. While that window
// is open (convergence_finalized !== 1) no polls may be created, so participants can read the
// summary and optionally reopen agreed topics before any voting starts.
export function isConvergenceReviewLocked(roomId) {
  const room = db.prepare('SELECT room_type, convergence_finalized FROM rooms WHERE id = ?').get(roomId);
  return !!room && room.room_type === 'convergence' && room.convergence_finalized !== 1;
}

function isWithinConvergenceReviewWindow(room) {
  if (!room || room.convergence_finalized === 1 || !room.convergence_summary_at) return false;
  const startedAt = new Date(room.convergence_summary_at).getTime();
  return Number.isFinite(startedAt) && Date.now() - startedAt < getConvergenceReviewWindowMs();
}

function findConvergenceTopicEntry(memory, topicKey) {
  const normalizedKey = normalizeTopicKey(topicKey);
  return memory.find((entry) => normalizeTopicKey(entry.key || entry.topic || entry.question || entry.suggestion) === normalizedKey);
}

// These service functions are shared by the HTTP routes and the simulation. Keeping the
// transition in one place prevents simulated participants from taking a different path from
// real participants when they review the convergence summary.
export function recordConvergenceReopen(roomId, userId, topicKey) {
  const room = db.prepare("SELECT room_type, topic_memory_json, convergence_summary_at, convergence_finalized FROM rooms WHERE id = ?").get(roomId);
  if (!room || room.room_type !== 'convergence') return { success: false, error: 'Only allowed in convergence rooms' };
  if (!isWithinConvergenceReviewWindow(room)) return { success: false, error: 'The review window has closed.' };

  const memory = parseRoomMemory(room);
  const entry = findConvergenceTopicEntry(memory, topicKey);
  if (!entry) return { success: false, error: 'Topic not found in room memory' };
  if (entry.is_general_question || String(entry.status || '').toLowerCase() !== 'resolved') {
    return { success: false, error: 'Only resolved discussion topics can be reopened' };
  }

  entry.reopened = true;
  saveRoomMemory(roomId, memory);
  db.prepare(`
    INSERT OR IGNORE INTO convergence_review_actions (room_id, user_id, action, topic_key, created_at)
    VALUES (?, ?, 'reopen', ?, ?)
  `).run(roomId, userId, entry.key, nowIso());
  return { success: true, topicKey: entry.key };
}

export function recordConvergenceAgreement(roomId, userId) {
  const room = db.prepare('SELECT room_type, convergence_finalized, convergence_summary_at FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.room_type !== 'convergence') return { success: false, error: 'Only allowed in convergence rooms' };
  if (room.convergence_finalized === 1) return { success: true, finalized: true };
  if (!isWithinConvergenceReviewWindow(room)) return { success: false, error: 'The review window has closed.' };

  const timestamp = nowIso();
  db.prepare('INSERT OR IGNORE INTO convergence_agreements (room_id, user_id, created_at) VALUES (?, ?, ?)')
    .run(roomId, userId, timestamp);
  db.prepare(`
    INSERT OR IGNORE INTO convergence_review_actions (room_id, user_id, action, topic_key, created_at)
    VALUES (?, ?, 'agree', '', ?)
  `).run(roomId, userId, timestamp);

  const memberCount = db
    .prepare('SELECT COUNT(*) AS c FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0')
    .get(roomId)?.c || 0;
  const agreedCount = db
    .prepare('SELECT COUNT(*) AS c FROM convergence_agreements ca JOIN users u ON u.id = ca.user_id WHERE ca.room_id = ? AND u.is_admin = 0')
    .get(roomId)?.c || 0;

  let finalized = false;
  if (memberCount > 0 && agreedCount >= memberCount) {
    finalizeConvergenceReviewWindow(roomId);
    finalized = true;
  }
  return { success: true, agreedCount, memberCount, finalized };
}

// The admin-defined answer options for a topic (used as a fallback so a poll always has
// at least two real options, even if the topic memory lost them).
function getPredefinedTopicOptions(topicKey) {
  const key = String(topicKey || '').trim().toLowerCase();
  if (!key) return [];
  const row = db
    .prepare('SELECT predefined_answers_json FROM gathering_questions WHERE LOWER(topic) = ? OR LOWER(question_text) = ?')
    .get(key, key);
  if (!row?.predefined_answers_json) return [];
  try {
    const arr = Array.isArray(row.predefined_answers_json) ? row.predefined_answers_json : JSON.parse(row.predefined_answers_json || '[]');
    return (Array.isArray(arr) ? arr : []).filter((o) => {
      const l = String(o).toLowerCase();
      return o && l !== 'keep discussing' && l !== 'other';
    });
  } catch {
    return [];
  }
}

function activeGroupRoomCount() {
  return db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE room_type IN ('group', 'convergence') AND is_active = 1 AND collection_complete = 0").get()?.c || 0;
}

function normalizeDecisionText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
    .join(' ')
    .trim();
}

async function evaluateOptionMatch(option1, option2) {
  if (!client) return false;
  try {
    const response = await client.chat.completions.create({
      model: env.cheapModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: renderTemplate('agent3-templates.md#Evaluate Option Match', {
            option1,
            option2
          })
        }
      ]
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    return !!parsed.is_match;
  } catch (err) {
    console.error('Error in evaluateOptionMatch:', err);
    return false;
  }
}

function recordRoomDecision(roomId, decisionText, reason) {
  const room = db.prepare('SELECT decision_round FROM rooms WHERE id = ?').get(roomId);
  const round = room?.decision_round || db.prepare('SELECT discussion_round FROM system_state WHERE id = 1').get()?.discussion_round || 1;
  const normalized = normalizeDecisionText(decisionText);
  db.prepare(
    `
    INSERT INTO room_decisions (room_id, decision_round, decision_text, normalized_decision, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(room_id) DO UPDATE SET
      decision_round = excluded.decision_round,
      decision_text = excluded.decision_text,
      normalized_decision = excluded.normalized_decision,
      reason = excluded.reason,
      created_at = excluded.created_at
  `
  ).run(roomId, round, decisionText, normalized, reason, nowIso());
  return { round, normalized };
}

let isReconcilingRooms = false;

export async function reconcileClosedDiscussionRooms() {
  if (isReconcilingRooms) return;
  isReconcilingRooms = true;
  try {
    const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase, discussion_round FROM system_state WHERE id = 1').get();
    if (!state?.global_question || state.current_phase !== 'discussing') return;
    if (activeGroupRoomCount() > 0) return;

    const round = state.discussion_round || 1;

    if (round === 1) {
      try {
        const { getSimulationStatus, stopSimulation } = await import('./simulationService.js');
        const simStatus = getSimulationStatus();
        if (simStatus && simStatus.isRunning && simStatus.stopAt === 'discussing') {
          logAgentEvent(
            'agent3',
            'Simulation Stop Phase Reached',
            'Stopping simulation after discussion groups before convergence room creation.'
          );
          await stopSimulation(false);
          return;
        }
      } catch (err) {
        console.error('Failed to check simulation status in reconcileClosedDiscussionRooms:', err);
      }
    }
    const rooms = db
      .prepare(`
        SELECT DISTINCT r.id, r.name
        FROM rooms r
        JOIN room_members rm ON rm.room_id = r.id
        JOIN users u ON u.id = rm.user_id
        WHERE r.room_type IN ('group', 'convergence')
          AND r.decision_round = ?
          AND r.is_active = 1
          AND u.is_admin = 0
        ORDER BY r.id ASC
      `)
      .all(round);
    if (!rooms.length) return;

    const decisions = db
      .prepare(
        `
        SELECT rd.room_id, r.name AS room_name, rd.decision_text, rd.normalized_decision
        FROM room_decisions rd
        JOIN rooms r ON r.id = rd.room_id
        WHERE rd.decision_round = ?
        ORDER BY rd.id ASC
      `
      )
      .all(round);
    if (decisions.length < rooms.length) {
      logAgentEvent(
        'agent3',
        'Waiting for room decisions',
        `Round ${round}: ${decisions.length}/${rooms.length} closed rooms have recorded decisions.`
      );
      emitDecisionStatus(ioRef);
      return;
    }

    const uniqueDecisions = new Set(decisions.map((decision) => decision.normalized_decision).filter(Boolean));
    if (round > 1 && uniqueDecisions.size <= 1) {
      const decisionText = decisions[0]?.decision_text || 'the shared decision';

      let yesVotes = 0;
      let noVotes = 0;
      const yesMatch = decisionText.match(/Yes:\s*(\d+)/i);
      const noMatch = decisionText.match(/No:\s*(\d+)/i);
      if (yesMatch) yesVotes = parseInt(yesMatch[1], 10);
      if (noMatch) noVotes = parseInt(noMatch[1], 10);
      // Only classify pass/reject/tie when the decision is actually a Yes/No tally; otherwise
      // (e.g. a deployment with no general Yes/No question) report a neutral conclusion rather
      // than always defaulting to "tie".
      let outcome = 'was concluded.';
      if (yesMatch || noMatch) {
        if (yesVotes > noVotes) outcome = 'passed!';
        else if (noVotes > yesVotes) outcome = 'was rejected!';
        else outcome = 'ended in a tie!';
      }

      let passedText = `The proposal "${state.global_question}" ${outcome}`;
      if (round >= 2) {
        passedText += "\n\nPlease wait for the generation of the final report and the closing of the room.";
      }

      const dbRooms = db
        .prepare(`
          SELECT DISTINCT r.id
          FROM rooms r
          JOIN room_members rm ON rm.room_id = r.id
          JOIN users u ON u.id = rm.user_id
          WHERE r.room_type IN ('group', 'convergence')
            AND r.decision_round = ?
            AND r.is_active = 1
            AND u.is_admin = 0
        `)
        .all(round);
      for (const r of dbRooms) {
        createBotMessage(r.id, passedText);
      }

      interruptDecisionProcess(true);
      logAgentEvent('agent3', 'Completed collective convergence', `All round ${round} rooms agreed on: ${decisionText}`);
      if (round >= 2) {
        // The final report is intentional work after completion. It belongs to
        // this completed run and must not carry on into a replacement run.
        const reportWork = createDecisionWorkContext({ workType: 'final-report', allowCompleted: true });
        setImmediate(() => runWithWorkContext(reportWork, async () => {
          try {
            throwIfWorkCancelled();
            const cRoom = db.prepare("SELECT id FROM rooms WHERE room_type = 'convergence' AND decision_round = ? ORDER BY id DESC LIMIT 1").get(round);
            if (cRoom) {
              const report = await generateRoomAnalysisReport(cRoom.id);
              throwIfWorkCancelled();
              if (ioRef) {
                ioRef.emit('convergence_completed', { roomId: cRoom.id, report });
              }
            }
          } catch (err) {
            if (err.name !== 'AbortError') console.error('Failed to emit convergence completed report:', err.message);
          }
        }));
      }
      return;
    }

    if (round > 1) {
      logAgentEvent(
        'agent3',
        'Detected cross-room disagreement',
        JSON.stringify({
          round,
          decisions: decisions.map((decision) => ({
            room: decision.room_name,
            decision: decision.decision_text
          }))
        })
      );
    } else {
      logAgentEvent('agent3', 'Entering Phase 4', 'Moving all users to the final global room.');
    }
    const convergenceRoom = await createConvergenceDiscussionRoom({
      globalQuestion: state.global_question,
      decisions,
      io: ioRef
    });

    if (convergenceRoom && convergenceRoom.roomId) {
      // --- CONVERGENCE SUMMARY LOGIC ---
      const summaryData = getConvergenceSummaryData(round);
      const summaryPayload = JSON.stringify(summaryData); // summaryData is already { generalResults, topics }
      createBotMessage(convergenceRoom.roomId, `[ConvergenceSummary=${summaryPayload}]`, 'system_summary');
      // Open the configured interactive review window; polling stays locked until it finalizes.
      db.prepare('UPDATE rooms SET convergence_summary_at = ?, convergence_finalized = 0 WHERE id = ?')
        .run(nowIso(), convergenceRoom.roomId);
      // --------------------------------------
      emitDecisionStatus(ioRef);
    }
  } finally {
    isReconcilingRooms = false;
  }
}

function createBotMessageForAllRoomsInRound(round, text) {
  const rooms = db
    .prepare(`
      SELECT DISTINCT r.id
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE r.room_type = 'group'
        AND r.decision_round = ?
        AND u.is_admin = 0
    `)
    .all(round);
  for (const room of rooms) createBotMessage(room.id, text);
}

export function completeDecision(roomId, decisionText, reason, suppressMessage = false) {
  if (!suppressMessage) {
    createBotMessage(roomId, renderTemplate('agent3-templates.md#Decision Confirmed Message', { decision: decisionText }));
  }
  recordRoomDecision(roomId, decisionText, reason);
  // The final convergence room has no "other rooms" to wait for and opens the Final Analysis
  // Report separately, so it should not carry a completion banner.
  const completedRoomType = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId)?.room_type;
  const completionBanner = completedRoomType === 'convergence'
    ? ''
    : 'Waiting for other rooms to finish.';
  db.prepare('UPDATE rooms SET collection_complete = 1, collection_banner = ?, timer_expires_at = NULL WHERE id = ?').run(completionBanner, roomId);
  emitRoomUpdated(roomId, true);
  if (ioRef) ioRef.to(`room:${roomId}`).emit('room_status_updated', { roomId });
  emitDecisionStatus(ioRef);
  logAgentEvent('agent3', 'Completed decision process', `${reason}: ${decisionText}`);
  setImmediate(() => {
    reconcileClosedDiscussionRooms().catch((error) => {
      logAgentEvent('agent3', 'Convergence reconciliation failed', error.message);
    });
  });
}

function getTranscript(roomId, limit = 24) {
  return db
    .prepare(
      `
      SELECT m.id, m.text, m.sender_id, COALESCE(u.username, 'Bot') AS sender_name
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



function isHumanMessage(message) {
  return message.sender_name !== 'Bot';
}

function normalizeText(text) {
  return String(text || '').toLowerCase();
}

function summarizeDeterministicPreference(transcript) {
  const userTexts = transcript.filter(isHumanMessage).map((m) => `${m.sender_name}: ${m.text}`);
  if (!userTexts.length) return 'No explicit preferences captured.';
  return userTexts.join(' | ').slice(0, 900);
}

function parsePredefinedAnswers(questionRow) {
  try {
    const raw = questionRow?.predefined_answers_json;
    if (Array.isArray(raw)) return raw;
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

function normalizeAnswerText(text) {
  return String(text || '').trim().toLowerCase();
}

function answerLooksComplete(text) {
  const normalized = normalizeAnswerText(text);
  return !!normalized && !/^(not specified|none|no answer)$/i.test(normalized);
}

function parseRoomMemory(room) {
  try {
    return Array.isArray(room?.topic_memory_json) ? room.topic_memory_json : JSON.parse(room?.topic_memory_json || '[]');
  } catch {
    return [];
  }
}

function saveRoomMemory(roomId, memory) {
  db.prepare('UPDATE rooms SET topic_memory_json = ? WHERE id = ?').run(JSON.stringify(memory || []), roomId);
}

function normalizeTopicKey(text) {
  return normalizeText(text).replace(/\s+/g, ' ').trim();
}

function matchAnswerToPredefined(text, options) {
  const normalized = normalizeTopicKey(text);
  if (!normalized) return '';
  for (const option of options || []) {
    const candidate = normalizeTopicKey(option);
    if (!candidate) continue;
    if (normalized === candidate) return option;
    if (normalized.includes(candidate) || candidate.includes(normalized)) return option;
  }
  return '';
}

function getRequiredDeliberationQuestions() {
  return db
    .prepare(
      'SELECT id, topic, question_text, question_order, predefined_answers_json, is_general_question FROM gathering_questions WHERE is_general_question = 0 ORDER BY question_order ASC, id ASC'
    )
    .all();
}

export function getAllDeliberationQuestions() {
  return db
    .prepare(
      'SELECT id, topic, question_text, question_order, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY is_general_question ASC, question_order ASC, id ASC'
    )
    .all();
}

function getGeneralQuestionRow() {
  return db
    .prepare(
      'SELECT id, topic, question_text, question_order, predefined_answers_json, is_general_question FROM gathering_questions WHERE is_general_question = 1 ORDER BY question_order DESC, id DESC LIMIT 1'
    )
    .get();
}

function normalizeQuestionPrompt(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findGatheringQuestionByText(text) {
  const needle = normalizeQuestionPrompt(text);
  if (!needle) return null;

  const allQuestions = getAllDeliberationQuestions();
  for (const question of allQuestions) {
    const candidates = [
      question.question_text,
      `How open are you to debate and changing your mind on the following topic? "${question.question_text}"`,
      `How open are you to debate and changing your mind on the following topic?\n\n"${question.question_text}"`,
      `Which of the following topics are most relevant or interesting to you? (Select all that apply)`
    ];
    if (candidates.some((candidate) => normalizeQuestionPrompt(candidate) === needle)) {
      return question;
    }
  }
  return null;
}

function findCurrentGatheringQuestion(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return null;
  let latestHumanIndex = -1;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (isHumanMessage(transcript[i])) {
      latestHumanIndex = i;
      break;
    }
  }
  if (latestHumanIndex < 0) return null;

  for (let i = latestHumanIndex - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.sender_name !== 'Bot') continue;

    const directMatch = findGatheringQuestionByText(message.text);
    if (directMatch) return directMatch;

    const quotedMatch = String(message.text || '').match(/"(.*?)"/g);
    if (quotedMatch) {
      for (const quoted of quotedMatch) {
        const inner = quoted.replace(/^"/, '').replace(/"$/, '');
        const innerMatch = findGatheringQuestionByText(inner);
        if (innerMatch) return innerMatch;
      }
    }
  }

  return null;
}

function getCurrentGatheringQuestion(roomId) {
  const roomState = db.prepare('SELECT current_gathering_question_id FROM rooms WHERE id = ?').get(roomId);
  if (!roomState?.current_gathering_question_id) return null;
  return db
    .prepare('SELECT id, topic, question_text, question_order, predefined_answers_json, is_general_question FROM gathering_questions WHERE id = ?')
    .get(roomState.current_gathering_question_id) || null;
}

function getNextGatheringQuestionAfter(questionId) {
  const questions = getAllDeliberationQuestions();
  if (!questions.length) return null;
  if (!questionId) return questions[0];
  const index = questions.findIndex((q) => q.id === questionId);
  if (index < 0) return questions[0];
  return questions.slice(index + 1).find((q) => !q.is_general_question) || questions.find((q) => q.is_general_question) || null;
}

function getNextNonGeneralGatheringQuestionAfter(questionId) {
  const questions = getAllDeliberationQuestions().filter((q) => q.is_general_question !== 1);
  if (!questions.length) return null;
  if (!questionId) return questions[0];
  const index = questions.findIndex((q) => q.id === questionId);
  if (index < 0) return questions[0];
  return questions[index + 1] || null;
}

export function getAnsweredQuestionIds(userId) {
  return new Set(
    db
      .prepare(
        `
        SELECT question_id
        FROM gathering_answers
        WHERE user_id = ?
          AND response_status IN ('accepted', 'skipped_invalid')
      `
      )
      .all(userId)
      .map((row) => row.question_id)
  );
}

function upsertRoomMemoryEntry(roomId, key, patch = {}) {
  const room = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  const memory = parseRoomMemory(room);
  const normalized = normalizeTopicKey(key);
  let entry = memory.find((item) => normalizeTopicKey(item.key || item.topic || item.question || item.suggestion || item.summary) === normalized);
  if (!entry) {
    entry = { key, created_at: nowIso() };
    memory.push(entry);
  }
  Object.assign(entry, patch, {
    key: entry.key || key,
    updated_at: nowIso()
  });
  saveRoomMemory(roomId, memory);
  return entry;
}

export function getUnresolvedRoomMemoryTopics(roomId) {
  const room = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  return parseRoomMemory(room).filter((entry) => {
    const status = String(entry.status || '').toLowerCase();
    // `timed_out` means the discussion timer ended without a topic decision. It is
    // intentionally excluded here: the final general-question poll is the only
    // remaining action for that room.
    return status !== 'resolved' && status !== 'timed_out';
  });
}

function getDiscussionPointTopics(roomId) {
  const statusRow = db.prepare('SELECT discussion_points FROM room_status WHERE room_id = ?').get(roomId);
  if (!statusRow) return [];
  try {
    const points = JSON.parse(statusRow.discussion_points || '[]');
    return Array.isArray(points) ? points.map((point) => String(point || '').trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// Runs one turn of the personal-gathering conversation with the real LLM: decides whether the
// participant's latest message actually answers the current question, and writes a natural,
// human, non-canned reply that either acknowledges the answer and moves to the next question, or
// helpfully addresses/redirects an off-topic message, a question, or gibberish. This is what
// makes the personal chat feel like talking to a smart assistant instead of a 90s form.
async function generatePersonalTurn({ text, currentQuestion, nextQuestion, predefined, roomId }) {
  if (!client) return null;
  try {
    const state = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get();
    const transcript = getTranscript(roomId, 10)
      .map((m) => `${m.sender_name}: ${m.text}`)
      .join('\n');
    const predefinedHint = Array.isArray(predefined) && predefined.length
      ? `Typical answer options for this question are: ${predefined.join(' | ')} — but the participant may answer freely in their own words.`
      : '';
    const nextQuestionLine = nextQuestion
      ? `After this one, the next question you'll ask is: "${nextQuestion}".`
      : `This is the last preference question before we move on.`;
    const askNextInstruction = nextQuestion
      ? `then ask the next question naturally, in your own words (its meaning is: "${nextQuestion}")`
      : `then let them know you've got what you need on this and will move to the next step shortly`;

    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0.6,
      max_completion_tokens: 260,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: renderTemplate('agent3-templates.md#Personal Turn System', {
            current_question: currentQuestion || 'the current question',
            global_question: state?.global_question || 'Not specified',
            decision_context: state?.decision_context || 'None',
            general_description: state?.general_description || '',
            predefined_hint: predefinedHint,
            next_question_line: nextQuestionLine,
            ask_next_instruction: askNextInstruction
          })
        },
        {
          role: 'user',
          content: renderTemplate('agent3-templates.md#Personal Turn User', {
            transcript: transcript || '(no prior messages)',
            message: text
          })
        }
      ],
      metadata: { roomId, caller: 'agent3-personalTurn' }
    });
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
    if (!reply) return null;
    const intent = ['answer', 'question', 'invalid'].includes(parsed.intent)
      ? parsed.intent
      : (parsed.is_answer === true ? 'answer' : 'invalid');
    return { is_answer: parsed.is_answer === true || intent === 'answer', intent, reply };
  } catch (err) {
    console.error('generatePersonalTurn error, falling back to deterministic flow:', err.message);
    return null;
  }
}

async function captureSequentialAnswer(userId, latestMessageId, latestText, roomId = null, questionOverride = null) {
  // Personal rooms are driven by an explicit pointer/retry state so Agent 3, not
  // generic chat completion, decides whether to retry, skip, or ask the next topic.
  const questions = getAllDeliberationQuestions();
  if (!questions.length) return;
  const answeredIds = getAnsweredQuestionIds(userId);
  const roomState = roomId
    ? db.prepare('SELECT current_gathering_question_id, gathering_retry_count FROM rooms WHERE id = ?').get(roomId)
    : null;
  const roomQuestion = roomId ? getCurrentGatheringQuestion(roomId) : null;
  const nextQuestion = questionOverride || roomQuestion || (roomState?.current_gathering_question_id
    ? questions.find((question) => question.id === roomState.current_gathering_question_id) || null
    : questions.find((question) => !answeredIds.has(question.id)));
  if (!nextQuestion) return;

  const raw = String(latestText || '').trim();
  if (!raw) return;

  // Background checks can see the same human message more than once; the source
  // message id prevents one answer from advancing multiple gathering questions.
  const alreadyProcessed = db.prepare(`
    SELECT question_id, response_status
    FROM gathering_answers
    WHERE user_id = ? AND source_message_id = ?
    ORDER BY rowid DESC
    LIMIT 1
  `).get(userId, Number(latestMessageId || 0));
  if (alreadyProcessed) {
    if (roomId) {
      personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'already_processed' });
    }
    return {
      status: alreadyProcessed.response_status || 'accepted',
      questionId: alreadyProcessed.question_id,
      alreadyProcessed: true
    };
  }

  // Never (re)process a human message that the bot has already responded to — i.e. a bot message
  // newer than it exists. This is the backstop that stops a stale message left over from a
  // previous session (before the process was restarted) from being auto-captured by the periodic
  // sweep as an answer to a freshly created question.
  if (roomId) {
    const latestBot = db
      .prepare('SELECT id FROM messages WHERE room_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1')
      .get(roomId);
    if (latestBot && Number(latestBot.id) > Number(latestMessageId || 0)) {
      personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'already_responded' });
      return { status: 'stale', questionId: nextQuestion.id, alreadyProcessed: true };
    }
  }

  const existing = db.prepare(`
    SELECT response_status, validation_attempts, source_message_id
    FROM gathering_answers
    WHERE question_id = ? AND user_id = ?
  `).get(nextQuestion.id, userId);

  if (existing && Number(existing.source_message_id || 0) === Number(latestMessageId || 0)) {
    return { status: existing.response_status || 'accepted', questionId: nextQuestion.id, alreadyProcessed: true };
  }

  // Natural LLM-driven gathering: for the deliberation questions, let a strong LLM run the turn.
  // It decides whether the message actually answers the current question and writes a human,
  // varied reply (acknowledge + ask next, or answer their question, or gracefully redirect an
  // off-topic/abusive/gibberish message). Falls back to the deterministic path below if there is
  // no LLM client or the call fails.
  if (roomId && !nextQuestion.is_general_question && client) {
    const predefinedForTurn = parsePredefinedAnswers(nextQuestion);
    const nextAfter = getNextNonGeneralGatheringQuestionAfter(nextQuestion.id);
    const turn = await generatePersonalTurn({
      text: raw,
      currentQuestion: nextQuestion.question_text,
      nextQuestion: nextAfter ? nextAfter.question_text : null,
      predefined: predefinedForTurn,
      roomId
    });

    if (turn) {
      const nowStr = new Date().toISOString();
      if (turn.is_answer) {
        const matched = matchAnswerToPredefined(raw, predefinedForTurn);
        db.prepare(
          `
          INSERT INTO gathering_answers (question_id, user_id, answer_text, raw_answer_text, matched_predefined_answer, answer_source, response_status, validation_attempts, source_message_id, created_at)
          VALUES (?, ?, ?, ?, ?, 'chat', 'accepted', 1, ?, ?)
          ON CONFLICT(question_id, user_id) DO UPDATE SET
            answer_text = excluded.answer_text,
            raw_answer_text = excluded.raw_answer_text,
            matched_predefined_answer = excluded.matched_predefined_answer,
            answer_source = excluded.answer_source,
            response_status = excluded.response_status,
            validation_attempts = excluded.validation_attempts,
            source_message_id = excluded.source_message_id,
            created_at = excluded.created_at
        `
        ).run(nextQuestion.id, userId, matched || raw, raw, matched, Number(latestMessageId || 0), nowStr);
        db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(nextAfter?.id || null, roomId);
        createBotMessage(roomId, turn.reply);
        personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'answer_ack' });
        return { status: 'accepted', questionId: nextQuestion.id };
      }
      // A question about the decision is conversationally handled, but it is not an attempt to
      // answer the gathering question. It must not consume the single retry allowed for an
      // invalid answer.
      if (turn.intent === 'question') {
        db.prepare(
          `
          INSERT INTO gathering_answers (question_id, user_id, answer_text, raw_answer_text, matched_predefined_answer, answer_source, response_status, validation_attempts, source_message_id, created_at)
          VALUES (?, ?, '', ?, '', 'chat-question', 'question_handled', 0, ?, ?)
          ON CONFLICT(question_id, user_id) DO UPDATE SET
            answer_text = excluded.answer_text,
            raw_answer_text = excluded.raw_answer_text,
            matched_predefined_answer = excluded.matched_predefined_answer,
            answer_source = excluded.answer_source,
            response_status = excluded.response_status,
            validation_attempts = excluded.validation_attempts,
            source_message_id = excluded.source_message_id,
            created_at = excluded.created_at
        `
        ).run(nextQuestion.id, userId, raw, Number(latestMessageId || 0), nowStr);
        createBotMessage(roomId, turn.reply);
        personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'redirected' });
        return { status: 'question', questionId: nextQuestion.id };
      }

      // The LLM has determined that this was not an answer to the current question. Apply the
      // same bounded retry state machine as the deterministic validity path: one retry, then
      // skip the topic. This prevents a simulation or a real user from being trapped forever.
      const retryCount = Number(roomState?.gathering_retry_count || 0);
      const shouldSkipAfterRetry = retryCount >= 1;
      const responseStatus = shouldSkipAfterRetry ? 'skipped_invalid' : 'retry';
      const nextAfterSkipped = getNextNonGeneralGatheringQuestionAfter(nextQuestion.id);
      db.prepare(
        `
        INSERT INTO gathering_answers (question_id, user_id, answer_text, raw_answer_text, matched_predefined_answer, answer_source, response_status, validation_attempts, source_message_id, created_at)
          VALUES (?, ?, '', ?, '', 'chat-invalid', ?, ?, ?, ?)
          ON CONFLICT(question_id, user_id) DO UPDATE SET
            answer_text = excluded.answer_text,
          raw_answer_text = excluded.raw_answer_text,
          matched_predefined_answer = excluded.matched_predefined_answer,
          answer_source = excluded.answer_source,
          response_status = excluded.response_status,
          validation_attempts = excluded.validation_attempts,
          source_message_id = excluded.source_message_id,
            created_at = excluded.created_at
      `
      ).run(
        nextQuestion.id,
        userId,
        raw,
        responseStatus,
        shouldSkipAfterRetry ? 2 : 1,
        Number(latestMessageId || 0),
        nowStr
      );

      if (shouldSkipAfterRetry) {
        db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(
          nextAfterSkipped?.id || null,
          roomId
        );
        createBotMessage(
          roomId,
          nextAfterSkipped
            ? `Let's skip this question and move to the next one: "${nextAfterSkipped.question_text}"`
            : "Let's skip this question and move to the next step."
        );
        personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'skip_prompt' });
        return { status: responseStatus, questionId: nextQuestion.id };
      }

      db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 1 WHERE id = ?').run(
        nextQuestion.id,
        roomId
      );
      createBotMessage(roomId, turn.reply || `I'm not sure that answers "${nextQuestion.question_text}". Please try again.`);
      personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'retry_prompt' });
      return { status: responseStatus, questionId: nextQuestion.id };
    }
  }

  const predefined = parsePredefinedAnswers(nextQuestion);

  const validity = await evaluateResponseValidity({
    text: raw,
    questionText: nextQuestion.question_text,
    roomContext: roomId ? `Room ${roomId}` : '',
    options: predefined
  });

  const shouldSkipAfterRetry = Number(roomState?.gathering_retry_count || 0) >= 1;
  const responseStatus = validity.is_valid ? 'accepted' : (shouldSkipAfterRetry ? 'skipped_invalid' : 'retry');

  const matched = matchAnswerToPredefined(raw, predefined);
  const answerText = validity.is_valid ? (matched || raw) : '';
  const answerSource = validity.is_valid ? 'chat' : 'chat-invalid';
  db.prepare(
    `
    INSERT INTO gathering_answers (question_id, user_id, answer_text, raw_answer_text, matched_predefined_answer, answer_source, response_status, validation_attempts, source_message_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(question_id, user_id) DO UPDATE SET
      answer_text = excluded.answer_text,
      raw_answer_text = excluded.raw_answer_text,
      matched_predefined_answer = excluded.matched_predefined_answer,
      answer_source = excluded.answer_source,
      response_status = excluded.response_status,
      validation_attempts = excluded.validation_attempts,
      source_message_id = excluded.source_message_id,
      created_at = excluded.created_at
  `
  ).run(
    nextQuestion.id,
    userId,
    answerText,
    raw,
    matched,
    answerSource,
    responseStatus,
    validity.is_valid ? 1 : (existing && existing.response_status === 'retry' ? Math.max(2, Number(existing.validation_attempts || 1) + 1) : 1),
    Number(latestMessageId || 0),
    new Date().toISOString()
  );

  if (roomId) {
    if (validity.is_valid) {
      const nextAfterAccepted = getNextNonGeneralGatheringQuestionAfter(nextQuestion.id);
      db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(
        nextAfterAccepted?.id || null,
        roomId
      );
      if (nextAfterAccepted) {
        createBotMessage(roomId, nextAfterAccepted.question_text);
      }
    } else if (responseStatus === 'retry') {
      db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 1 WHERE id = ?').run(nextQuestion.id, roomId);
    } else if (responseStatus === 'skipped_invalid') {
      const nextAfterSkipped = getNextNonGeneralGatheringQuestionAfter(nextQuestion.id);
      db.prepare('UPDATE rooms SET current_gathering_question_id = ?, gathering_retry_count = 0 WHERE id = ?').run(nextAfterSkipped?.id || null, roomId);
    }
  }

  const settings = getDecisionSettings();
  const isSimulatedAgent = !!(global.isSimulationRunning && global.simulatedPersonas && global.simulatedPersonas[userId]);
  if (!isSimulatedAgent && settings.kick_out_no_voters === 2 && nextQuestion.is_general_question === 1 && (matched || '').toLowerCase() === 'no') {
    const room = db.prepare('SELECT id FROM rooms WHERE room_type = "personal" AND id IN (SELECT room_id FROM room_members WHERE user_id = ?)').get(userId);
    if (room) {
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      db.prepare("UPDATE rooms SET is_active = 0, collection_complete = 1, collection_banner = 'Your participation has ended because you were not open to debate.' WHERE id = ?").run(room.id);
      if (ioRef) ioRef.to(`user:${userId}`).emit('membership_revoked', { roomId: room.id });
      logAgentEvent('agent3', 'Excluded user from process', `User ${userId} answered No to the general question.`);
      setImmediate(() => {
        maybeAdvanceToGroupPhase().catch(() => { });
      });
    }
  }

  if (!validity.is_valid && responseStatus === 'retry') {
    const questionText = nextQuestion.question_text || 'the question';
    createBotMessage(
      roomId,
      `I'm not sure that answered the question. Please try again and answer this directly: "${questionText}"`
    );
    personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'retry_prompt' });
  } else if (!validity.is_valid && responseStatus === 'skipped_invalid') {
    const nextAfterSkipped = roomId ? getNextNonGeneralGatheringQuestionAfter(nextQuestion.id) : null;
    createBotMessage(
      roomId,
      nextAfterSkipped
        ? `Let's skip this question and move to the next one: "${nextAfterSkipped.question_text}"`
        : `Let's skip this question and move to the next one.`
    );
    personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'skip_prompt' });
  } else if (validity.is_valid) {
    personalRoomReplyActions.set(roomId, { suppressAutoReply: true, reason: 'next_question_prompt' });
  }

  return {
    status: responseStatus,
    questionId: nextQuestion.id,
    questionText: nextQuestion.question_text,
    validity
  };
}

async function evaluateEnoughInfo(globalQuestion, decisionContext, transcript, roomId, userId) {
  const settings = getDecisionSettings();
  const humanMessages = transcript.filter(isHumanMessage);
  const userTurns = humanMessages.length;

  const gatheringQuestions = db
    .prepare('SELECT id, topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY question_order ASC, id ASC')
    .all();
  const requiredQuestions = gatheringQuestions.filter((q) => q.is_general_question !== 1);
  const answeredQuestionIds = getAnsweredQuestionIds(userId);
  const allRequiredAnswered = requiredQuestions.every((q) => answeredQuestionIds.has(q.id));

  if (!allRequiredAnswered && userTurns < requiredQuestions.length) {
    return {
      enough_info: false,
      preference_summary: '',
      reason: 'Not enough user turns to answer all required questions'
    };
  }

  let gatheringQuestionsText = 'None generated.';
  if (requiredQuestions.length > 0) {
    gatheringQuestionsText = requiredQuestions.map((q, i) => {
      const answers = parsePredefinedAnswers(q);
      const answerText = answers.length ? ` Answers: ${answers.join(' | ')}` : '';
      return `${i + 1}. [${q.topic}] ${q.question_text}${answerText}`;
    }).join('\n');
  }


  if (!allRequiredAnswered) {
    return {
      enough_info: false,
      preference_summary: '',
      reason: 'Not all required gathering questions have been answered.'
    };
  }

  if (!client) {
    return {
      enough_info: true,
      preference_summary: summarizeDeterministicPreference(transcript),
      reason: 'Fallback deterministic check'
    };
  }

  const response = await client.chat.completions.create({
    model: getConfiguredModels().primaryModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: renderTemplate('agent3-templates.md#Enough Info System', {
          agent3_prompt: getAgentPrompt('agent3'),
          settings: describeDecisionSettings(settings),
          min_turns: requiredQuestions.length || 1,
          gathering_questions: gatheringQuestionsText
        })
      },
      {
        role: 'user',
        content: renderTemplate('agent3-templates.md#Enough Info User', {
          global_question: globalQuestion,
          decision_context: decisionContext || 'No additional context provided.',
          general_description: getGeneralDescription(),
          transcript: transcript.map((m) => `${m.sender_name}: ${m.text}`).join('\n')
        })
      }
    ],
    metadata: { roomId, caller: 'agent3-evaluateEnoughInfo' }
  });

  const raw = response.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    const llmEnough = !!parsed.enough_info;
    const allQuestionsAnswered = gatheringQuestions.every((q) => answeredQuestionIds.has(q.id));

    if (!parsed.preference_summary) parsed.preference_summary = '';
    if (allRequiredAnswered) {
      parsed.enough_info = true;
    }

    return {
      enough_info: parsed.enough_info,
      preference_summary: typeof parsed.preference_summary === 'string' ? parsed.preference_summary.trim() : ''
    };
  } catch (err) {
    console.error('Agent 3 evaluateEnoughInfo LLM error, using fallback:', err);
    logAgentEvent('agent3', 'evaluateEnoughInfo LLM error', `Error: ${err.message}. Using fallback deterministic check.`);
    return {
      enough_info: true,
      preference_summary: summarizeDeterministicPreference(transcript)
    };
  }
}



export async function evaluateReadyToVote(roomId, globalQuestion, decisionContext, transcript) {
  const settings = getDecisionSettings();

  let roomMembers = [];
  if (roomId) {
    roomMembers = db.prepare('SELECT u.username FROM users u JOIN room_members rm ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0').all(roomId).map(m => m.username);
  }
  if (roomMembers.length === 0 && transcript && transcript.length > 0) {
    const humanMessages = transcript.filter(m => m.sender_name !== 'Bot');
    roomMembers = Array.from(new Set(humanMessages.map(m => m.sender_name)));
  }
  const participants = roomMembers.join(', ');
  const totalMembers = roomMembers.length || 2; // fallback to 2 if somehow missing

  let memberPreferencesText = 'None';
  let currentStatusText = 'Waiting for discussion to start';
  let currentAgreedPoints = [];
  let currentDiscussionPoints = [];

  let pastPollsText = 'No past polls.';
  if (roomId) {
    const pastPollsDb = db.prepare(`
      SELECT question, suggestion, is_reopened, is_closed, has_consensus
      FROM polls
      WHERE room_id = ?
      ORDER BY created_at ASC
    `).all(roomId);

    if (pastPollsDb.length > 0) {
      pastPollsText = pastPollsDb.map((p, i) =>
        `Poll ${i + 1}: Question: "${p.question}", Suggestion: "${p.suggestion}", Reopened/Failed: ${(p.is_reopened === 1 || p.has_consensus === 0)}`
      ).join('\n');
    }
  }

  if (roomId) {
    const prefs = db.prepare(`
      SELECT u.username, u.extracted_preferences 
      FROM users u 
      JOIN room_members rm ON u.id = rm.user_id 
      WHERE rm.room_id = ? AND u.is_admin = 0
    `).all(roomId);
    memberPreferencesText = prefs
      .map(p => `- ${p.username}: ${p.extracted_preferences || 'No preferences recorded yet.'}`)
      .join('\n');

    const statusRow = db.prepare('SELECT status_text, agreed_points, discussion_points FROM room_status WHERE room_id = ?').get(roomId);
    if (statusRow) {
      currentStatusText = statusRow.status_text || currentStatusText;
      try { currentAgreedPoints = JSON.parse(statusRow.agreed_points || '[]'); } catch { }
      try { currentDiscussionPoints = JSON.parse(statusRow.discussion_points || '[]'); } catch { }
    }
  }

  if (!client) {
    return {
      ready_to_vote: false,
      question: `Vote on the current proposal: ${globalQuestion}`,
      options: [],
      ready_users: [],
      required_ready_users: getRequiredReadinessParticipants(totalMembers, settings.consensus_sensitivity),
      agreed_points: [],
      discussion_points: []
    };
  }

  const response = await client.chat.completions.create({
    model: getConfiguredModels().primaryModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: renderTemplate('agent3-templates.md#Ready Vote System', {
          agent3_prompt: getAgentPrompt('agent3'),
          settings: describeDecisionSettings(settings)
        })
      },
      {
        role: 'user',
        content: renderTemplate('agent3-templates.md#Ready Vote User', {
          global_question: globalQuestion,
          decision_context: decisionContext || 'No additional context provided.',
          general_description: getGeneralDescription(),
          participants: participants,
          already_decided: roomId ? getAccumulatedDecisions(roomId).join(', ') || 'None' : 'None',
          user_preferences: memberPreferencesText,
          current_status_text: currentStatusText,
          current_agreed_points: JSON.stringify(currentAgreedPoints),
          current_discussion_points: JSON.stringify(currentDiscussionPoints),
          past_polls: pastPollsText,
          transcript: transcript.map((m) => `${m.sender_name}: ${m.text}`).join('\n')
        })
      }
    ],
    metadata: { roomId, caller: 'agent3-evaluateReadyToVote' }
  });

  const raw = response.choices?.[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    logAgentEvent('agent3', 'evaluateReadyToVote parsed', JSON.stringify(parsed));

    if (parsed.user_preferences && typeof parsed.user_preferences === 'object') {
      const updateUserPref = db.prepare('UPDATE users SET extracted_preferences = ? WHERE username = ? AND is_admin = 0');
      for (const [uname, prefs] of Object.entries(parsed.user_preferences)) {
        if (prefs && typeof prefs === 'string') {
          updateUserPref.run(prefs.trim(), uname);
        }
      }
    }

    // Extract status and save to DB
    const statusText = typeof parsed.status_text === 'string' ? parsed.status_text.trim() : '';
    const agreedPoints = getAccumulatedDecisions(roomId);
    const discussionPoints = Array.isArray(parsed.discussion_points) ? parsed.discussion_points.map(p => String(p).trim()).filter(Boolean) : [];

    if (roomId) {
      db.prepare(`
        INSERT INTO room_status (room_id, status_text, agreed_points, discussion_points, last_updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(room_id) DO UPDATE SET
          status_text = excluded.status_text,
          agreed_points = excluded.agreed_points,
          discussion_points = excluded.discussion_points,
          last_updated_at = excluded.last_updated_at
      `).run(
        roomId,
        statusText || 'Waiting for discussion to start',
        JSON.stringify(agreedPoints),
        JSON.stringify(discussionPoints),
        new Date().toISOString()
      );

      if (ioRef) {
        ioRef.to(`room:${roomId}`).emit('room_status_updated', { roomId });
      }
    }

    const rawReadyUsers = Array.isArray(parsed.ready_users) ? parsed.ready_users.map(u => String(u).trim().toLowerCase()) : [];

    // Safe intersection with actual room members to prevent hallucinations
    const lowerRoomMembers = roomMembers.map(u => String(u).toLowerCase());

    const lastBotAnnouncementIndex = transcript.map(m => m.sender_name === 'Bot' && (
      m.text.includes('mandatory poll') ||
      m.text.includes('we agreed on:') ||
      m.text.includes('agreement was reached on:') ||
      m.text.includes('Discussion reopened')
    )).lastIndexOf(true);
    const activeTurnMessages = lastBotAnnouncementIndex >= 0 ? transcript.slice(lastBotAnnouncementIndex + 1) : transcript;
    const activeTurnUsers = new Set(activeTurnMessages.filter(m => m.sender_name !== 'Bot').map(m => String(m.sender_name).toLowerCase()));

    const verifiedReadyUsers = rawReadyUsers.filter(u => lowerRoomMembers.includes(u) && activeTurnUsers.has(u));
    const readyCount = verifiedReadyUsers.length;

    logAgentEvent('agent3', 'ready_users stats', `Total members: ${totalMembers}. Ready users: ${readyCount} (${verifiedReadyUsers.join(', ')})`);

    // Consensus sensitivity is a percentage of distinct participants, not a raw
    // message count. The active-turn gate in checkGroupRoomForPoll prevents an LLM
    // call until this many participants have contributed; this second check verifies
    // that the LLM also considers those participants ready to vote.
    const requiredReadyUsers = getRequiredReadinessParticipants(totalMembers, settings.consensus_sensitivity);
    const isPollReady = readyCount >= requiredReadyUsers;

    const unresolved = getUnresolvedRoomMemoryTopics(roomId);
    const activeTopicObj = unresolved[0];

    const readyPolls = [];
    if (isPollReady && activeTopicObj) {
      let pollType = 'plurality';
      if (roomId) {
        const topicKey = activeTopicObj.suggestion || activeTopicObj.key;
        const priorPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) LIMIT 1')
          .get(roomId, topicKey, activeTopicObj.question || topicKey);
        // Every non-final topic starts with swipe; subsequent user-triggered
        // attempts enter the same continuous live-voting state machine.
        pollType = priorPoll ? 'continuous' : 'swipe';
      }

      let opt = Array.isArray(activeTopicObj.options) ? [...activeTopicObj.options] : [];
      if (opt.length === 0) {
        opt.push(activeTopicObj.suggestion || activeTopicObj.key, 'Keep discussing');
      } else if (opt.length === 1 && opt[0].toLowerCase() !== 'keep discussing' && opt[0].toLowerCase() !== 'other') {
        opt.push('Keep discussing');
      }

      readyPolls.push({
        question: activeTopicObj.question || `Vote on: ${activeTopicObj.suggestion || activeTopicObj.key}`,
        options: opt,
        suggestion: activeTopicObj.suggestion || activeTopicObj.key,
        replaces_decided_option: null,
        poll_type: pollType
      });
    }

    const firstReady = readyPolls[0] || null;
    return {
      ready_to_vote: readyPolls.length > 0,
      question: firstReady ? firstReady.question : `Vote on: ${globalQuestion}`,
      options: firstReady ? firstReady.options : [],
      suggestion: firstReady ? firstReady.suggestion : null,
      replaces_decided_option: firstReady ? firstReady.replaces_decided_option : null,
      ready_polls: readyPolls,
      ready_users: verifiedReadyUsers,
      required_ready_users: requiredReadyUsers,
      agreed_points: agreedPoints,
      discussion_points: discussionPoints
    };
  } catch (err) {
    console.error('Agent 3 evaluateReadyToVote LLM error, using fallback:', err);
    logAgentEvent('agent3', 'evaluateReadyToVote LLM error', `Error: ${err.message}. Returning false.`);
    return {
      ready_to_vote: false,
      question: `Vote on the current proposal: ${globalQuestion}`,
      options: [],
      suggestion: null,
      replaces_decided_option: null,
      ready_users: [],
      required_ready_users: getRequiredReadinessParticipants(totalMembers, settings.consensus_sensitivity),
      agreed_points: [],
      discussion_points: []
    };
  }
}

async function inferPollOptions(roomId, globalQuestion, decisionContext, transcript, suggestion) {
  const settings = getDecisionSettings();
  const fallback = ['The option currently discussed', 'Keep discussing'];
  if (!client) return { question: `Vote on: ${globalQuestion}`, options: fallback };

  let memberPreferencesText = 'None';
  if (roomId) {
    const prefs = db.prepare(`
      SELECT u.username, u.extracted_preferences 
      FROM users u 
      JOIN room_members rm ON u.id = rm.user_id 
      WHERE rm.room_id = ? AND u.is_admin = 0
    `).all(roomId);
    memberPreferencesText = prefs
      .map(p => `- ${p.username}: ${p.extracted_preferences || 'No preferences recorded yet.'}`)
      .join('\n');
  }

  const response = await client.chat.completions.create({
    model: getConfiguredModels().primaryModel,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: renderTemplate('agent3-templates.md#Infer Poll System', {})
      },
      {
        role: 'user',
        content: renderTemplate('agent3-templates.md#Infer Poll User', {
          global_question: globalQuestion,
          decision_context: decisionContext || 'No additional context provided.',
          general_description: getGeneralDescription(),
          suggestion: suggestion || 'None',
          user_preferences: memberPreferencesText,
          transcript: transcript.map((m) => `${m.sender_name}: ${m.text}`).join('\n')
        })
      }
    ],
    metadata: { roomId, caller: 'agent3-inferPollOptions' }
  });
  try {
    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const options = Array.isArray(parsed.options)
      ? parsed.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4)
      : [];
    const replacesDecidedOption = typeof parsed.replaces_decided_option === 'string' && parsed.replaces_decided_option.trim()
      ? parsed.replaces_decided_option.trim()
      : null;
    return options.length >= 2
      ? { question: parsed.question || `Vote on: ${globalQuestion}`, options, suggestion: parsed.suggestion || null, replaces_decided_option: replacesDecidedOption }
      : { question: `Vote on: ${globalQuestion}`, options: fallback, suggestion: null, replaces_decided_option: null };
  } catch (err) {
    console.error('Agent 3 inferPollOptions LLM error:', err);
    logAgentEvent('agent3', 'inferPollOptions LLM error', err.message);
    return { question: `Vote on: ${globalQuestion}`, options: fallback, suggestion: null, replaces_decided_option: null };
  }
}

export function countLegitimateFailedPolls(roomId, topicKey) {
  const suggestionLower = String(topicKey || '').toLowerCase();
  const failedPolls = db.prepare(`
    SELECT id, poll_type FROM polls
    WHERE room_id = ? AND LOWER(suggestion) = ? AND (is_reopened = 1 OR has_consensus = 0)
  `).all(roomId, suggestionLower);

  let count = 0;
  for (const p of failedPolls) {
    // A poll that received zero votes still counts as a failed round: if nobody engages, the
    // topic is not converging and the chain should escalate (swipe -> single-select -> ranking)
    // rather than reopening the same swipe forever.
    const totalVotes = p.poll_type === 'swipe'
      ? (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM swipe_votes WHERE poll_id = ?').get(p.id)?.c || 0)
      : (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM poll_votes WHERE poll_id = ?').get(p.id)?.c || 0);
    // A poll where participants actively (and only) chose "keep discussing" is a deliberate
    // decision to continue, not a failure. This only applies when there ARE votes — a zero-vote
    // poll must still count as failed (handled above).
    if (totalVotes > 0) {
      const keepDiscussingOpt = db.prepare("SELECT id FROM poll_options WHERE poll_id = ? AND LOWER(option_text) = 'keep discussing'").get(p.id);
      if (keepDiscussingOpt) {
        const nonKeepVotes = db.prepare('SELECT COUNT(*) as c FROM poll_votes WHERE poll_id = ? AND option_id != ?').get(p.id, keepDiscussingOpt.id)?.c || 0;
        if (nonKeepVotes === 0) {
          continue;
        }
      }
    }
    count++;
  }
  return count;
}

function normalizePollOptions(roomId, options, pollType = 'plurality', isGlobalQuestion = false) {
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

  let isGlobal = isGlobalQuestion;
  if (!isGlobal && roomId) {
    const lowerOptions = (options || []).map(o => String(o).trim().toLowerCase());
    if (lowerOptions.includes('yes') && lowerOptions.includes('no') && lowerOptions.includes('abstained')) {
      isGlobal = true;
    }
  }

  if (pollType !== 'ranking' && !isGlobal) {
    const room = db.prepare('SELECT room_type FROM rooms WHERE id = ?').get(roomId);
    if (room && room.room_type !== 'personal') {
      const sliced = cleaned.slice(0, 6);
      sliced.push('Keep discussing');
      sliced.push('Other');
      return sliced;
    }
  }
  return cleaned.slice(0, 8); // Ranking might have more than 6 options, let's bump it to 8
}

export function generateDeterministicRoomStatus(roomId) {
  const room = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  const memory = parseRoomMemory(room);

  const pending = memory.filter(m => String(m.status || '').toLowerCase() !== 'resolved');

  let currentTopic = null;
  if (pending.length > 0) {
    currentTopic = pending.shift();
  }

  if (currentTopic) {
    const isGen = currentTopic.is_general_question ||
      currentTopic.key === 'general-question' ||
      currentTopic.topic === 'general-question' ||
      currentTopic.suggestion === 'general-question';
    const displayLabel = isGen
      ? (currentTopic.question || currentTopic.suggestion || currentTopic.key)
      : (currentTopic.suggestion || currentTopic.key || 'Unknown');

    let label = displayLabel;
    if (label === 'general-question') {
      const generalQuestionRow = getGeneralQuestionRow();
      if (generalQuestionRow?.question_text) {
        label = generalQuestionRow.question_text;
      }
    }
    return `Discussing: ${label}`;
  } else {
    return 'All topics resolved';
  }
}

export function localUpdateRoomStatusText(roomId, text, agreedPointsOverride = null, discussionPointsOverride = null) {
  try {
    const finalStatusText = text === null ? generateDeterministicRoomStatus(roomId) : text;
    const rs = db.prepare('SELECT discussion_points FROM room_status WHERE room_id = ?').get(roomId) || {};
    const ap = JSON.stringify(agreedPointsOverride !== null ? agreedPointsOverride : getAccumulatedDecisions(roomId));
    const dp = discussionPointsOverride !== null ? JSON.stringify(discussionPointsOverride) : (rs.discussion_points || '[]');

    db.prepare(`
      INSERT INTO room_status (room_id, status_text, agreed_points, discussion_points, last_updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        status_text = excluded.status_text,
        agreed_points = excluded.agreed_points,
        discussion_points = excluded.discussion_points,
        last_updated_at = excluded.last_updated_at
    `).run(roomId, finalStatusText, ap, dp, new Date().toISOString());
    if (ioRef) {
      ioRef.to(`room:${roomId}`).emit('room_status_updated', { roomId });
    }
  } catch (err) {
    console.error('Failed to update room status text locally:', err);
  }
}

export function createMandatoryPoll(roomId, question, options, reason, suggestion = null, replacesOption = null, suppressMessage = false, pollType = 'plurality', chainStage = 'none', expiresAt = null) {
  const currentRoom = db.prepare('SELECT room_type, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (['group', 'convergence'].includes(currentRoom?.room_type) && currentRoom.collection_complete === 1) return null;
  const pollKey = `${roomId}::${String(question || '').trim().toLowerCase()}`;
  if (mandatoryPollCreationLocks.has(pollKey)) {
    const existing = db.prepare('SELECT id FROM polls WHERE room_id = ? AND question = ? ORDER BY id DESC LIMIT 1').get(roomId, question);
    return existing ? existing.id : null;
  }
  mandatoryPollCreationLocks.add(pollKey);
  try {
  const room = db.prepare('SELECT room_type, topic_memory_json FROM rooms WHERE id = ?').get(roomId);

  // Group/convergence rooms must never have two open polls at once. Multiple schedulers
  // (initial group setup, the 15s poll ticker, message-driven checks) can race into this
  // function; this in-lock check makes creation idempotent for non-personal rooms.
  if (room && room.room_type !== 'personal') {
    const alreadyOpen = db
      .prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1')
      .get(roomId, nowIso());
    if (alreadyOpen) return alreadyOpen.id;
  }

  // Force suggestion to match the active topic key for group/convergence rooms if not already a valid topic key
  let finalSuggestion = suggestion;
  if (room && room.room_type !== 'personal') {
    const passedKey = String(suggestion || '').trim();
    const isTopicKey = passedKey.length > 0 && passedKey.length < 30 && !/\s/.test(passedKey);
    if (!isTopicKey) {
      const unresolved = getUnresolvedRoomMemoryTopics(roomId);
      const activeTopic = unresolved[0];
      if (activeTopic) {
        finalSuggestion = activeTopic.suggestion || activeTopic.key;
      } else {
        const firstTopic = db.prepare('SELECT topic FROM gathering_questions WHERE is_general_question = 0 ORDER BY question_order ASC LIMIT 1').get();
        finalSuggestion = firstTopic ? firstTopic.topic : 'general-question';
      }
    }
  }

  const memory = parseRoomMemory(room);
  const normalizedKey = normalizeTopicKey(finalSuggestion || question);
  const entry = memory.find((item) => normalizeTopicKey(item.key || item.topic || item.question || item.suggestion || item.summary) === normalizedKey);
  let isGlobalQuestion = entry ? !!entry.is_general_question : false;
  if (!isGlobalQuestion && normalizeTopicKey(finalSuggestion) === 'general-question') {
    isGlobalQuestion = true;
  }
  if (!isGlobalQuestion) {
    const generalQuestionRow = getGeneralQuestionRow();
    if (generalQuestionRow && (finalSuggestion === generalQuestionRow.topic || question === generalQuestionRow.question_text)) {
      isGlobalQuestion = true;
    }
  }

  // If this is a subsequent poll (prior count >= 1),
  // we load the clustered options from the room memory (if present).
  let optionsToUse = options;
  let finalPollType = pollType;
  if (room && room.room_type !== 'personal' && isGlobalQuestion) {
    // Use the admin-defined options for the final general question (set on the decision page).
    // Fall back to a simple scale only if none were configured.
    let genOptions = [];
    try {
      const genRow = getGeneralQuestionRow();
      const arr = Array.isArray(genRow?.predefined_answers_json)
        ? genRow.predefined_answers_json
        : JSON.parse(genRow?.predefined_answers_json || '[]');
      genOptions = (Array.isArray(arr) ? arr : [])
        .map((o) => String(o || '').trim())
        .filter((o) => o && !['other', 'keep discussing'].includes(o.toLowerCase()));
    } catch { genOptions = []; }
    optionsToUse = genOptions.length >= 2 ? genOptions : ['Yes', 'No', 'Abstained'];
    finalPollType = 'plurality';
  } else if ((finalSuggestion || question) && room && room.room_type !== 'personal' && !isGlobalQuestion) {
    const topicKey = finalSuggestion || question;
    const priorCount = db.prepare(
      'SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?)'
    ).get(roomId, topicKey, topicKey)?.c || 0;
    if (priorCount >= 1 && entry && Array.isArray(entry.options) && entry.options.length > 0) {
      optionsToUse = entry.options;
    }
  }

  let finalOptions;
  if (finalPollType === 'swipe') {
    // Swipe polls show the substantive options only. Other is available through
    // the existing write-in path after the swipe stage.
    finalOptions = [...optionsToUse].filter(o => o.toLowerCase() !== 'keep discussing' && o.toLowerCase() !== 'other');
    finalOptions = [...new Set(finalOptions)];
  } else if (finalPollType === 'continuous') {
    // Live voting has one stable write-in option. The user's text is stored on
    // that option, while the option ID remains stable across vote replacements.
    finalOptions = [...optionsToUse].filter(o => o.toLowerCase() !== 'keep discussing' && o.toLowerCase() !== 'other');
    finalOptions = [...new Set([...finalOptions, 'Other'])];
  } else {
    finalOptions = normalizePollOptions(roomId, optionsToUse, finalPollType, isGlobalQuestion);
  }

  // Safety net: a topic poll must never be created with fewer than two real options. If the
  // options collapsed (e.g. a reopened topic that lost its option list), backfill from the
  // topic's most-voted prior options / admin-defined answers.
  if (!isGlobalQuestion && room && room.room_type !== 'personal' && finalPollType !== 'continuous') {
    const metaLower = new Set(['keep discussing', 'other']);
    const realOpts = finalOptions.filter((o) => !metaLower.has(String(o).toLowerCase()));
    if (realOpts.length < 2) {
      const fallback = getPredefinedTopicOptions(finalSuggestion || question);
      const merged = [...realOpts];
      for (const o of fallback) {
        if (merged.length >= 2) break;
        if (!merged.some((x) => String(x).toLowerCase() === String(o).toLowerCase())) merged.push(o);
      }
      if (finalPollType === 'swipe') {
        finalOptions = merged;
      } else {
        const metas = finalOptions.filter((o) => metaLower.has(String(o).toLowerCase()));
        finalOptions = [...merged, ...metas];
      }
    }
  }

  // For ranking polls: if we have fewer than 3 substantive options, pad with previous options
  // Ranking polls never include "Keep discussing"
  if (finalPollType === 'ranking' && !isGlobalQuestion) {
    // Remove Keep discussing if it somehow got in
    finalOptions = finalOptions.filter(o => o.toLowerCase() !== 'keep discussing');

    if (finalOptions.length < 3) {
      // Query all distinct options from previous polls on this topic
      const topicKey = finalSuggestion || question;
      const previousOptions = db.prepare(`
        SELECT DISTINCT po.option_text
        FROM poll_options po
        JOIN polls p ON p.id = po.poll_id
        WHERE p.room_id = ? AND (p.suggestion = ? OR p.question = ?)
          AND LOWER(po.option_text) != 'other'
          AND LOWER(po.option_text) != 'keep discussing'
      `).all(roomId, topicKey, topicKey).map(r => r.option_text);

      // Filter out options already in finalOptions
      const currentLower = new Set(finalOptions.map(o => o.toLowerCase()));
      const candidates = previousOptions.filter(o => !currentLower.has(o.toLowerCase()));

      // Shuffle and pick enough to reach at least 3 options
      const needed = 3 - finalOptions.length;
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      const picked = candidates.slice(0, needed);
      finalOptions.push(...picked);

      logAgentEvent('agent3', 'Ranking poll padded', `Room ${roomId}. Current: ${finalOptions.length - picked.length}. Added ${picked.length} previous options: ${picked.join(', ')}`);
    }
  }
  const effectivePollTimerMinutes = getEffectivePollTimerMinutes(roomId, isGlobalQuestion);
  // Poll-length rules:
  //   • Live voting AND the final general-question vote use "Live voting duration".
  //   • Swipe and ranking polls on the topics use "Poll timer duration".
  const durationMinutes = (finalPollType === 'continuous' || isGlobalQuestion)
    ? (getDecisionSettings().live_voting_duration_minutes || 5)
    : effectivePollTimerMinutes;
  const announcementMinutes = durationMinutes;
  const finalExpiresAt = expiresAt !== null
    ? expiresAt
    : (room && room.room_type === 'personal')
      ? null
      : new Date(Date.now() + durationMinutes * 60 * 1000).toISOString();
  const pollRes = db
    .prepare(
      'INSERT INTO polls (room_id, question, show_results, is_closed, mandatory, expires_at, created_at, suggestion, replaces_option, poll_type, chain_stage, poll_stage, minimum_live_until) VALUES (?, ?, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      roomId,
      question,
      finalExpiresAt,
      nowIso(),
      finalSuggestion,
      replacesOption,
      finalPollType,
      chainStage,
      finalPollType === 'continuous' ? 'continuous' : 'standard',
      finalPollType === 'continuous'
        ? new Date(Date.now() + (getDecisionSettings().minimum_live_voting_duration_minutes || 0) * 60 * 1000).toISOString()
        : null
    );
  const pollId = Number(pollRes.lastInsertRowid);
  const insertOpt = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)');
  for (const option of finalOptions) insertOpt.run(pollId, option);
  if (!suppressMessage) {
    createBotMessage(roomId, renderTemplate('agent3-templates.md#Mandatory Poll Created Message', { minutes: announcementMinutes }));
  }
  upsertRoomMemoryEntry(roomId, finalSuggestion || question, {
    question,
    suggestion: finalSuggestion || question,
    poll_id: pollId,
    poll_type: finalPollType,
    chain_stage: chainStage,
    status: 'polling',
    options: finalOptions,
    reason,
    created_at: nowIso(),
    expires_at: finalExpiresAt
  });
  logAgentEvent('agent3', 'Created mandatory poll', `${reason} Question: ${question}. Options: ${finalOptions.join(', ')}`);
  emitPollsUpdated(roomId);
  emitRoomUpdated(roomId, true);
  schedulePollResolution(pollId, roomId, finalExpiresAt);

  let displayQuestion = finalSuggestion || question;
  if (isGlobalQuestion) {
    const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
    if (state?.global_question) {
      displayQuestion = state.global_question;
    } else {
      const generalQuestionRow = getGeneralQuestionRow();
      if (generalQuestionRow?.question_text) {
        displayQuestion = generalQuestionRow.question_text;
      }
    }
  }
  localUpdateRoomStatusText(roomId, `Voting on: ${displayQuestion}`);
  return pollId;
  } finally {
    mandatoryPollCreationLocks.delete(pollKey);
  }
}

async function generateGroupOpeningMessage(globalQuestion, decisionContext, roomId, roomPreferences, firstTopic) {
  const fallback = `Welcome everyone. The decision question is:\n\n**${globalQuestion}**\n\nAdditional context:\n${decisionContext || 'none'}\n\nTo begin, please discuss the first topic: ${firstTopic}`;
  if (!client) {
    return fallback;
  }
  try {
    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: renderTemplate('agent3-templates.md#Group Welcome', {
            global_question: globalQuestion,
            decision_context: decisionContext || 'None',
            general_description: getGeneralDescription(),
            room_preferences: roomPreferences || 'No preferences recorded.',
            first_topic: firstTopic || 'the main question'
          })
        }
      ],
      metadata: { roomId, caller: 'agent3-generateGroupOpeningMessage' }
    });
    return response.choices?.[0]?.message?.content?.trim() || fallback;
  } catch (error) {
    console.error('generateGroupOpeningMessage LLM call failed, using fallback:', error.message || error);
    return fallback;
  }
}

async function expandDeliberationOptionsWithUserAnswers() {
  const gatheringQuestions = db.prepare('SELECT id, topic, question_text, predefined_answers_json, is_general_question FROM gathering_questions ORDER BY question_order ASC, id ASC').all();
  const questions = gatheringQuestions.filter((q) => q.is_general_question !== 1);

  if (!client) return;

  for (const question of questions) {
    const predefined = parsePredefinedAnswers(question);

    // Fetch custom answers
    const customAnswers = db.prepare(`
      SELECT raw_answer_text
      FROM gathering_answers
      WHERE question_id = ?
        AND response_status = 'accepted'
        AND (matched_predefined_answer IS NULL OR matched_predefined_answer = '')
        AND TRIM(raw_answer_text) <> ''
    `).all(question.id).map(r => r.raw_answer_text);

    if (customAnswers.length === 0) continue;

    try {
      const response = await client.chat.completions.create({
        model: getConfiguredModels().primaryModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: renderTemplate('agent3-templates.md#Option Expansion System', {
              topic: question.topic,
              question: question.question_text,
              predefined_options: JSON.stringify(predefined),
              custom_answers: JSON.stringify(customAnswers)
            })
          }
        ]
      });

      const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
      const updatedOptions = Array.isArray(parsed.updated_options) ? parsed.updated_options.filter(o => typeof o === 'string' && o.trim() !== '') : [];

      if (updatedOptions.length > 0) {
        // Keep up to 8 total
        const combined = updatedOptions.slice(0, 8);

        db.prepare('UPDATE gathering_questions SET predefined_answers_json = ? WHERE id = ?').run(
          JSON.stringify(combined),
          question.id
        );
        logAgentEvent('agent3', 'Expanded options', `Updated options for topic "${question.topic}". Total options: ${combined.length}`);
      }
    } catch (err) {
      console.error('Error expanding deliberation options:', err);
    }
  }
}

let isAdvancingToGroupPhase = false;

function deactivateStagedDiscussionRooms(roomIds) {
  const ids = [...new Set((roomIds || []).map(Number).filter(Number.isInteger))];
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  // These are throwaway staging rooms that never activated (clustering failed or was deferred).
  // Fully delete them — not just deactivate — otherwise the leftover row keeps the clean name
  // ("Discussion Group 1") reserved, and the next clustering retry is forced to disambiguate to
  // "Discussion Group 1 (2)". Deleting is safe because no participant ever entered these rooms.
  db.transaction(() => {
    db.prepare(`DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE room_id IN (${placeholders}))`).run(...ids);
    db.prepare(`DELETE FROM swipe_votes WHERE poll_id IN (SELECT id FROM polls WHERE room_id IN (${placeholders}))`).run(...ids);
    db.prepare(`DELETE FROM poll_options WHERE poll_id IN (SELECT id FROM polls WHERE room_id IN (${placeholders}))`).run(...ids);
    db.prepare(`DELETE FROM polls WHERE room_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM messages WHERE room_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM room_members WHERE room_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM rooms WHERE id IN (${placeholders})`).run(...ids);
  })();
}

function ensureInitialGroupSwipePoll(roomId, firstTopic) {
  if (!firstTopic?.question) {
    throw new Error(`Cannot initialize Discussion Group ${roomId}: no deliberation topic is configured`);
  }

  const existing = db
    .prepare("SELECT id FROM polls WHERE room_id = ? AND poll_type = 'swipe' AND is_closed = 0 ORDER BY id DESC LIMIT 1")
    .get(roomId);
  if (existing) return existing.id;

  const configuredOptions = Array.isArray(firstTopic.options) ? firstTopic.options : [];
  const pollOptions = configuredOptions.length >= 2 ? configuredOptions : ['Keep discussing', 'Add a proposal'];
  const pollId = createMandatoryPoll(
    roomId,
    firstTopic.question,
    pollOptions,
    'Initial topic poll',
    firstTopic.suggestion || firstTopic.key,
    null,
    false,
    'swipe'
  );
  const persisted = db.prepare("SELECT id FROM polls WHERE id = ? AND room_id = ? AND poll_type = 'swipe' AND is_closed = 0").get(pollId, roomId);
  if (!persisted) throw new Error(`Initial swipe poll was not persisted for Discussion Group ${roomId}`);
  return persisted.id;
}

export async function maybeAdvanceToGroupPhase() {
  if (isAdvancingToGroupPhase) return;
  isAdvancingToGroupPhase = true;
  let stagedRoomIds = [];
  try {
    const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
    if (!state?.global_question || state.current_phase !== 'gathering') return;

    // Use the canonical username-personal room record rather than room_members
    // for the participant source. A timed-out personal poll may revoke the
    // user's membership from that room, but the participant must still be
    // routed into the group phase unless the user itself was explicitly
    // removed from users (for example, a "No" openness decision).
    const simulationParticipantIds = getSimulationParticipantIds();
    const participantScopeSql = simulationParticipantIds === null
      ? ''
      : simulationParticipantIds.length > 0
        ? `AND u.id IN (${simulationParticipantIds.map(() => '?').join(',')})`
        : 'AND 1 = 0';
    const participantScopeParams = simulationParticipantIds || [];

    const openPersonal = db.prepare(`
      SELECT COUNT(DISTINCT u.id) AS c
      FROM users u
      JOIN rooms r ON r.name = u.username || '-personal'
      WHERE u.is_admin = 0
        AND r.room_type = 'personal'
        AND r.is_active = 1
        AND COALESCE(r.collection_complete, 0) = 0
        ${participantScopeSql}
    `).get(...participantScopeParams)?.c || 0;
    if (openPersonal > 0) return;

    await expandDeliberationOptionsWithUserAnswers();

    const preferences = db.prepare(`
      SELECT u.id, u.username, u.extracted_preferences
      FROM users u
      JOIN rooms r ON r.name = u.username || '-personal'
      WHERE u.is_admin = 0
        AND r.room_type = 'personal'
        AND r.collection_complete = 1
        ${participantScopeSql}
      ORDER BY u.username ASC
    `).all(...participantScopeParams);
    let discussionRooms;
    try {
      discussionRooms = await createClusteredDiscussionRooms({
        globalQuestion: state.global_question,
        preferences,
        io: ioRef,
        deferActivation: true
      });
      stagedRoomIds = discussionRooms.map((room) => room.roomId);
    } catch (clusterErr) {
      console.error('[maybeAdvanceToGroupPhase] Failed to create discussion rooms, staying in gathering phase:', clusterErr.message || clusterErr);
      logAgentEvent('agent1', 'Group phase failed', `Could not create discussion rooms: ${clusterErr.message || clusterErr}`);
      return; // Stay in gathering phase — don't transition
    }

    // Never switch the global phase unless every completed participant has an
    // actual active group membership. A failed/partial clustering attempt used
    // to leave empty groups behind and then strand users in their personal rooms.
    const expectedUserIds = new Set(preferences.map((user) => user.id));
    const groupPlaceholders = stagedRoomIds.map(() => '?').join(',');
    const assignedUserIds = new Set(
      stagedRoomIds.length === 0
        ? []
        : db.prepare(`
        SELECT DISTINCT rm.user_id
        FROM room_members rm
        JOIN rooms r ON r.id = rm.room_id
        JOIN users u ON u.id = rm.user_id
        WHERE r.id IN (${groupPlaceholders})
          AND u.is_admin = 0
      `).all(...stagedRoomIds).map((row) => row.user_id)
    );
    const missingUserIds = [...expectedUserIds].filter((userId) => !assignedUserIds.has(userId));
    if (discussionRooms.length === 0 || missingUserIds.length > 0) {
      deactivateStagedDiscussionRooms(stagedRoomIds);
      logAgentEvent(
        'agent1',
        'Group phase deferred',
        `Clustering produced ${discussionRooms.length} room(s) but did not assign ${missingUserIds.length} participant(s). Retrying.`
      );
      return;
    }

    // Set up welcome messages and first polls for each group room.
    // Wrapped per-room so one room's failure doesn't block others.
    const getMembers = db.prepare(`
      SELECT u.extracted_preferences
      FROM users u
      JOIN room_members rm ON rm.user_id = u.id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
    `);

    for (const room of discussionRooms) {
      const memberPrefs = getMembers.all(room.roomId).map((m) => m.extracted_preferences || 'No preferences recorded.').join('\n');
      let firstTopic = getUnresolvedRoomMemoryTopics(room.roomId)[0];

      // A malformed/legacy room memory must not suppress the first poll. Rebuild
      // the first deliberation topic from the admin configuration when necessary.
      if (!firstTopic) {
        const configuredTopic = db
          .prepare('SELECT topic, question_text, predefined_answers_json FROM gathering_questions WHERE is_general_question = 0 ORDER BY question_order ASC, id ASC LIMIT 1')
          .get();
        if (configuredTopic) {
          let options = [];
          try { options = JSON.parse(configuredTopic.predefined_answers_json || '[]'); } catch { options = []; }
          firstTopic = {
            key: configuredTopic.topic || configuredTopic.question_text,
            suggestion: configuredTopic.topic || configuredTopic.question_text,
            question: configuredTopic.question_text,
            options,
            status: 'open'
          };
          upsertRoomMemoryEntry(room.roomId, firstTopic.key, firstTopic);
        }
      }

      // Opening prose is helpful but not a prerequisite for voting. If an LLM
      // call fails, still write a deterministic welcome and always create the
      // initial swipe poll in a separate protected step.
      let welcomeText = `Welcome everyone. The decision question is:\n\n**${state.global_question}**\n\nTo begin, please discuss the first topic: ${firstTopic?.question || state.global_question}`;
      try {
        welcomeText = await generateGroupOpeningMessage(
          state.global_question,
          state.decision_context,
          room.roomId,
          memberPrefs,
          firstTopic ? firstTopic.question : null
        );
      } catch (roomErr) {
        console.error(`[maybeAdvanceToGroupPhase] Group welcome failed for room ${room.roomId}:`, roomErr.message || roomErr);
      }
      try {
        createBotMessage(room.roomId, welcomeText);
      } catch (messageErr) {
        console.error(`[maybeAdvanceToGroupPhase] Failed to write group welcome for room ${room.roomId}:`, messageErr.message || messageErr);
      }

      // Every discussion group starts with a persisted swipe poll. Do not hide
      // a failure here: the outer handler deactivates the staged rooms and the
      // next sweep retries instead of publishing an empty group.
      ensureInitialGroupSwipePoll(room.roomId, firstTopic);
    }

    // Publish the transition only after every staged group has a welcome and an
    // initial swipe poll. This prevents clients from entering empty rooms while
    // asynchronous prompt generation or poll creation is still running.
    db.prepare(`UPDATE rooms SET is_active = 1 WHERE id IN (${groupPlaceholders})`).run(...stagedRoomIds);
    db.prepare('UPDATE system_state SET current_phase = ? WHERE id = 1').run('discussing');
    db.prepare("UPDATE rooms SET is_active = 0 WHERE room_type = 'personal'").run();
    logAgentEvent('agent1', 'Started group discussion', `Introduced ${discussionRooms.length} discussion room${discussionRooms.length === 1 ? '' : 's'}.`);
    // Always emit so clients discover the new rooms and transition away from personal rooms
    if (ioRef) ioRef.emit('rooms_updated');
    emitDecisionStatus(ioRef);
    // Arm the inactivity timer at room opening, even when nobody has written a
    // human message yet. The watchdog also repairs this after a process restart.
    for (const room of discussionRooms) scheduleGroupNudge(room.roomId);
  } catch (err) {
    console.error('[maybeAdvanceToGroupPhase] Unexpected error:', err.message || err);
    logAgentEvent('agent1', 'Group phase error', `Unexpected: ${err.message || err}`);
    if (stagedRoomIds.length > 0) deactivateStagedDiscussionRooms(stagedRoomIds);
    // Still emit updates so clients aren't stuck
    try { if (ioRef) ioRef.emit('rooms_updated'); emitDecisionStatus(ioRef); } catch (_e) { /* ignore */ }
  } finally {
    isAdvancingToGroupPhase = false;
  }
}

export async function checkPersonalRoom(roomId, userId) {
  if (personalRoomProgressLocks.has(roomId)) return false;
  personalRoomProgressLocks.add(roomId);
  try {
    const room = db.prepare('SELECT collection_complete FROM rooms WHERE id = ?').get(roomId);
    if (room?.collection_complete === 1) return false;

    const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
    if (!state?.global_question || state.current_phase !== 'gathering') {
      console.log(`[checkPersonalRoom] returning false because state is wrong: global_question=${!!state?.global_question}, phase=${state?.current_phase}`);
      return false;
    }

    const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId);
    if (openPoll) {
      console.log(`[checkPersonalRoom] returning false because openPoll exists: ${openPoll.id}`);
      return false;
    }


    const settings = getDecisionSettings();
    const isTopicPrefStrategy = settings.clustering_strategy === 'topic_preference';

    const expectedPrefQuestion = "Which of the following topics are most relevant or interesting to you? (Select all that apply)";
    const prefPollExists = db.prepare('SELECT id, is_closed FROM polls WHERE room_id = ? AND question = ?').get(roomId, expectedPrefQuestion);

    const generalQuestionRow = getGeneralQuestionRow();
    const expectedQuestionText = generalQuestionRow ? `How open are you to debate and changing your mind on the following topic?\n\n"${generalQuestionRow.question_text}"` : null;
    const opennessPollExists = db.prepare('SELECT id, is_closed FROM polls WHERE room_id = ? AND question = ?').get(roomId, expectedQuestionText);
    const gatheringQuestions = getAllDeliberationQuestions().filter((q) => q.is_general_question !== 1);
    const answeredQuestionIds = getAnsweredQuestionIds(userId);
    const allRequiredAnswered = gatheringQuestions.every((q) => answeredQuestionIds.has(q.id));

    // If topic preference strategy is enabled, wait until the user has answered all deliberation questions
    // before opening the routing poll. This keeps the final deliberation question available long enough to answer.
    if (isTopicPrefStrategy && !allRequiredAnswered) {
      if (!prefPollExists) {
        const transcript = getTranscript(roomId, 20);
        const latestHumanMessage = [...transcript].reverse().find(isHumanMessage);
        const currentQuestion = getCurrentGatheringQuestion(roomId) || gatheringQuestions.find((q) => !answeredQuestionIds.has(q.id));
        if (latestHumanMessage && currentQuestion) await captureSequentialAnswer(userId, latestHumanMessage.id, latestHumanMessage.text, roomId, currentQuestion);
        return false;
      }
      return false;
    }

    if (isTopicPrefStrategy && (!prefPollExists || prefPollExists.is_closed === 0)) {
      const transcript = getTranscript(roomId, 20);
      const latestHumanMessage = [...transcript].reverse().find(isHumanMessage);
      const currentQuestion = getCurrentGatheringQuestion(roomId) || gatheringQuestions.find((q) => !answeredQuestionIds.has(q.id));
      if (latestHumanMessage && currentQuestion) await captureSequentialAnswer(userId, latestHumanMessage.id, latestHumanMessage.text, roomId, currentQuestion);

      // Only needed once, right before the topic-preference poll is created. Once it exists we
      // are purely waiting for the user's vote (handled elsewhere on poll close); recomputing
      // this on every 5s sweep would fire a real LLM call with no new information to react to.
      if (!prefPollExists) {
        const analysis = await evaluateEnoughInfo(state.global_question, state.decision_context || '', transcript, roomId, userId);
        db.prepare('UPDATE users SET extracted_preferences = ? WHERE id = ?').run(
          analysis.preference_summary || 'Preferences captured.',
          userId
        );

        const deliberationTopics = db.prepare('SELECT topic FROM gathering_questions WHERE is_general_question = 0 ORDER BY question_order ASC, id ASC').all().map(t => t.topic);
        const prefOptions = [...deliberationTopics, 'All topics'];

        createBotMessage(roomId, "Thank you for expressing your opinions on the deliberation questions. Before we ask the final question, please tell us which topics you are most interested in discussing.");
        createMandatoryPoll(
          roomId,
          expectedPrefQuestion,
          prefOptions,
          'Please select the topics you are interested in discussing.',
          null,
          null,
          true,
          'plurality',
          'none',
          null
        );
      }
      return false;
    }

    // Next, handle the openness poll (which is the final question)
    if (!opennessPollExists) {
      // Some imported/legacy decisions have no explicit general question. In
      // that configuration there is no final openness poll to create, so the
      // deliberation questions themselves are the complete personal phase.
      if (!generalQuestionRow) {
        db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = 'Quality Agent has enough information and is waiting for the other participants.' WHERE id = ?").run(roomId);
        logAgentEvent('agent3', 'Closed personal chat', `Room ${roomId} completed without an explicit general question.`);
        createBotMessage(roomId, renderTemplate('agent3-templates.md#Personal Complete Message'));
        emitRoomUpdated(roomId, true);
        emitDecisionStatus(ioRef);
        return true;
      }

      if (!isTopicPrefStrategy) {
        // If we bypassed the preference step, we need to run capture and enough info checks here!
        const transcript = getTranscript(roomId, 20);
        const latestHumanMessage = [...transcript].reverse().find(isHumanMessage);
        const currentQuestion = getCurrentGatheringQuestion(roomId) || gatheringQuestions.find((q) => !answeredQuestionIds.has(q.id));
        if (latestHumanMessage && currentQuestion) await captureSequentialAnswer(userId, latestHumanMessage.id, latestHumanMessage.text, roomId, currentQuestion);

        const analysis = await evaluateEnoughInfo(state.global_question, state.decision_context || '', transcript, roomId, userId);
        if (!analysis.enough_info) return false;

        db.prepare('UPDATE users SET extracted_preferences = ? WHERE id = ?').run(
          analysis.preference_summary || 'Preferences captured.',
          userId
        );
      }

      console.log(`[checkPersonalRoom] generalQuestionRow = ${!!generalQuestionRow}`);
      if (generalQuestionRow) {
        createBotMessage(roomId, `Thank you for expressing your opinion. As last thing, vote on how open you are to the idea of: ${generalQuestionRow.question_text}.`);
        createMandatoryPoll(
          roomId,
          `How open are you to debate and changing your mind on the following topic?\n\n"${generalQuestionRow.question_text}"`,
          ['No', 'Probably no, but I can try', 'I am hesitant', 'Maybe', 'Yes, I am open', 'Yes, very open'],
          'Please indicate your openness to debate this topic.',
          null,
          null,
          true,
          'plurality'
        );
      }
      return false;
    } else if (opennessPollExists.is_closed === 0) {
      return false;
    }

    db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = ? WHERE id = ?").run(
      'Quality Agent has enough information and is waiting for the other participants.',
      roomId
    );
    logAgentEvent('agent3', 'Closed personal chat', `Room ${roomId} completed openness poll.`);
    createBotMessage(
      roomId,
      renderTemplate('agent3-templates.md#Personal Complete Message')
    );
    emitRoomUpdated(roomId, true);
    emitDecisionStatus(ioRef);
    return true;
  } finally {
    personalRoomProgressLocks.delete(roomId);
  }
}

function getPrimaryPersonalUserId(roomId) {
  return db
    .prepare(
      `
      SELECT u.id
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
      ORDER BY u.username ASC, u.id ASC
      LIMIT 1
    `
    )
    .get(roomId)?.id || null;
}

export async function forceCloseOpenPersonalChats(reason = 'Admin requested closing personal conversations.') {
  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
  if (!state?.global_question || state.current_phase !== 'gathering') {
    return { ok: false, closed: 0, message: 'Phase 1 gathering is not active.' };
  }

  const rooms = db
    .prepare(
      `
      SELECT r.id AS room_id, u.id AS user_id, u.username
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE u.is_admin = 0
        AND r.room_type = 'personal'
        AND r.name = u.username || '-personal'
        AND r.is_active = 1
      ORDER BY u.username ASC
    `
    )
    .all();

  let closed = 0;
  for (const room of rooms) {
    const transcript = getTranscript(room.room_id, 24);
    const summary = summarizeDeterministicPreference(transcript);
    db.prepare('UPDATE users SET extracted_preferences = ? WHERE id = ?').run(summary, room.user_id);

    db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = ? WHERE id = ?").run(
      'Quality Agent has enough information and is waiting for the other participants.',
      room.room_id
    );
    createBotMessage(room.room_id, renderTemplate('agent3-templates.md#Personal Complete Message'));
    emitRoomUpdated(room.room_id, true);
    closed += 1;
  }

  logAgentEvent('agent3', 'Admin forced personal-chat closure', `${reason} Closed ${closed} personal chats.`);
  emitDecisionStatus(ioRef);
  await maybeAdvanceToGroupPhase();
  return { ok: true, closed, message: `Closed ${closed} personal chat${closed === 1 ? '' : 's'}.` };
}

function schedulePollResolution(pollId, roomId, expiresAt) {
  if (!expiresAt) return;
  const delay = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const timer = setTimeout(() => {
    pollTimers.delete(pollId);
    resolvePoll(pollId, roomId).catch(() => { });
  }, delay);
  pollTimers.set(pollId, timer);
}

export async function handleExpiredPersonalRoom(room) {
  if (!room || room.room_type !== 'personal' || room.is_active !== 1) return { handled: false };
  const expiresAt = room.timer_expires_at ? new Date(room.timer_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now()) return { handled: false };

  let user = db
    .prepare(
      `
      SELECT u.id, u.username
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
      ORDER BY u.username ASC
      LIMIT 1
    `
    )
    .get(room.id);
  if (!user) return { handled: false };

  // The personal room timer is the hard deadline. A poll without an expires_at
  // (the normal personal-room case) used to remain open forever here: the timer
  // was cleared, but the poll was never resolved and collection_complete stayed 0.
  // Force-expire every currently open personal poll and let the normal resolver
  // apply its existing fallback/completion logic. The small guard also handles
  // the resolver creating the next personal poll while closing the previous one.
  db.prepare('UPDATE rooms SET timer_expires_at = NULL WHERE id = ?').run(room.id);
  for (let pass = 0; pass < 4; pass += 1) {
    const openPolls = db
      .prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0 ORDER BY id ASC')
      .all(room.id);
    if (!openPolls.length) break;
    for (const openPoll of openPolls) {
      db.prepare('UPDATE polls SET expires_at = ? WHERE id = ? AND is_closed = 0').run(nowIso(), openPoll.id);
      await resolvePoll(openPoll.id, room.id);
    }
    const currentRoom = db.prepare('SELECT collection_complete FROM rooms WHERE id = ?').get(room.id);
    if (currentRoom?.collection_complete === 1) {
      emitRoomUpdated(room.id, true);
      emitDecisionStatus(ioRef);
      await maybeAdvanceToGroupPhase();
      return { handled: true, created: 0 };
    }
  }

  // A resolver may remove the only non-admin participant from a timed-out
  // mandatory poll. Do not leave the orphaned room in an unfinished state.
  user = db
    .prepare(
      `
      SELECT u.id, u.username
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
      ORDER BY u.username ASC
      LIMIT 1
    `
    )
    .get(room.id);
  if (!user) {
    db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = 'Quality Agent has enough information and is waiting for the other participants.' WHERE id = ?").run(room.id);
    emitRoomUpdated(room.id, true);
    emitDecisionStatus(ioRef);
    await maybeAdvanceToGroupPhase();
    return { handled: true, created: 0 };
  }

  const questions = getRequiredDeliberationQuestions();
  const answeredIds = getAnsweredQuestionIds(user.id);
  const missingQuestions = questions.filter((question) => !answeredIds.has(question.id));
  const generalQuestion = getGeneralQuestionRow();
  const generalAnswered = generalQuestion
    ? !!db
      .prepare('SELECT 1 FROM gathering_answers WHERE question_id = ? AND user_id = ? AND response_status IN (\'accepted\', \'skipped_invalid\')')
      .get(generalQuestion.id, user.id)
    : true;
  const allMissing = [...missingQuestions];
  const hasOpennessPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND question LIKE ?').get(room.id, 'How open are you to debate%');
  if (!generalAnswered && generalQuestion && !hasOpennessPoll) {
    allMissing.push(generalQuestion);
  }
  if (!allMissing.length) {
    db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = 'Quality Agent has enough information and is waiting for the other participants.' WHERE id = ?").run(room.id);
    createBotMessage(room.id, renderTemplate('agent3-templates.md#Personal Complete Message'));
    emitRoomUpdated(room.id, true);
    emitDecisionStatus(ioRef);
    await maybeAdvanceToGroupPhase();
    return { handled: true, created: 0 };
  }

  let created = 0;
  for (const question of allMissing) {
    const options = parsePredefinedAnswers(question);
    const settings = getDecisionSettings();
    const pollTimerMinutes = settings.poll_timer_minutes || 2;
    const expiresAt = new Date(Date.now() + pollTimerMinutes * 60 * 1000).toISOString();
    createMandatoryPoll(
      room.id,
      question.question_text,
      options.length >= 2 ? options : ['Keep discussing'],
      'Personal room timer expired; user must vote to continue.',
      question.topic || question.question_text,
      null, // replacesOption
      true, // suppressMessage
      'plurality', // pollType
      'none', // chainStage
      expiresAt // expiresAt
    );
    created += 1;
  }
  createBotMessage(room.id, renderTemplate('agent3-templates.md#Personal Timer Poll Message', { count: created }));
  logAgentEvent('agent3', 'Personal room timer expired', `Room ${room.id}: created ${created} poll(s) for unanswered questions.`);
  emitDecisionStatus(ioRef);
  return { handled: true, created };
}

export async function handleExpiredGroupRoom(room) {
  // Sweep/callback snapshots may predate completion or an earlier timer handler.
  // Read persisted state so neither can reopen a finished room's final vote.
  room = room?.id ? db.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id) : null;
  if (!room || room.room_type !== 'group' || room.is_active !== 1) return { handled: false };
  if (room.collection_complete === 1) {
    db.prepare('UPDATE rooms SET timer_expires_at = NULL WHERE id = ?').run(room.id);
    return { handled: false };
  }
  const expiresAt = room.timer_expires_at ? new Date(room.timer_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt > Date.now()) return { handled: false };

  // A room timer ends topic discussion, not the entire room. The participants must still
  // receive the final general-question vote before the room is allowed to complete. This is
  // deliberately a direct state transition instead of calling resolvePoll(): resolving a
  // topic poll here would start another live/ranking round and could create several polls at once.
  const generalQuestion = getGeneralQuestionRow();
  const generalTopicKey = normalizeTopicKey(generalQuestion?.topic || 'general-question');
  const openPolls = db.prepare('SELECT * FROM polls WHERE room_id = ? AND is_closed = 0 ORDER BY id ASC').all(room.id);
  const isGeneralPoll = (poll) => {
    const suggestion = normalizeTopicKey(poll?.suggestion);
    const question = normalizeTopicKey(poll?.question);
    return suggestion === generalTopicKey
      || suggestion === 'general-question'
      || question === normalizeTopicKey(generalQuestion?.question_text);
  };

  // Make this handler one-shot before creating the final poll. On a restart or a concurrent
  // timer sweep, the cleared timer prevents another transition from racing with this one.
  db.prepare('UPDATE rooms SET timer_expires_at = NULL WHERE id = ?').run(room.id);

  const closedAt = nowIso();
  const closeTopicPoll = db.prepare(`
    UPDATE polls
    SET is_closed = 1,
        closed_at = ?,
        expires_at = COALESCE(expires_at, ?),
        closed_reason = 'room_timer_expired',
        review_until = NULL,
        transitioned_to_poll_id = COALESCE(transitioned_to_poll_id, -1)
    WHERE id = ? AND is_closed = 0
  `);
  for (const poll of openPolls) {
    if (isGeneralPoll(poll)) continue;
    closeTopicPoll.run(closedAt, closedAt, poll.id);
    const topicKey = poll.suggestion || poll.question;
    const current = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(room.id);
    const entry = findConvergenceTopicEntry(parseRoomMemory(current), topicKey);
    if (entry && !entry.is_general_question && String(entry.status || '').toLowerCase() !== 'resolved') {
      upsertRoomMemoryEntry(room.id, topicKey, {
        ...entry,
        status: 'timed_out',
        timer_expired: true,
        decision: null,
        summary: 'The room timer expired before this topic reached a decision.',
        poll_id: poll.id,
        updated_at: closedAt
      });
    }
  }

  // Mark every remaining non-final topic as timed out, including topics for which a poll had
  // not yet been opened. This prevents the normal scheduler from reopening them after the timer.
  const currentRoom = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(room.id);
  for (const entry of parseRoomMemory(currentRoom)) {
    if (entry.is_general_question || normalizeTopicKey(entry.key) === generalTopicKey) continue;
    if (String(entry.status || '').toLowerCase() === 'resolved') continue;
    upsertRoomMemoryEntry(room.id, entry.key || entry.question || entry.suggestion, {
      ...entry,
      status: 'timed_out',
      timer_expired: true,
      decision: null,
      summary: entry.summary || 'The room timer expired before this topic reached a decision.',
      updated_at: closedAt
    });
  }

  const finalPoll = openPolls.find(isGeneralPoll)
    || db.prepare('SELECT * FROM polls WHERE room_id = ? AND is_closed = 0 ORDER BY id DESC LIMIT 1').all(room.id).find(isGeneralPoll);
  let created = 0;
  if (!finalPoll) {
    const finalQuestion = generalQuestion?.question_text || db.prepare('SELECT global_question FROM system_state WHERE id = 1').get()?.global_question || 'What is your view on the main question?';
    createBotMessage(room.id, 'The discussion time is over, so the discussion of the individual topics is now closed. Please vote on the final question. You will move to the next room when the voting time is over or everyone has voted.');
    const options = parsePredefinedAnswers(generalQuestion);
    createMandatoryPoll(
      room.id,
      finalQuestion,
      options.length >= 2 ? options : ['Yes', 'No', 'Abstained'],
      'Group room timer expired; final question vote opened.',
      generalQuestion?.topic || 'general-question',
      null,
      false,
      'plurality',
      'none'
    );
    created = 1;
  } else {
    createBotMessage(room.id, 'The discussion time is over. Please complete the final-question vote; the room will move on when voting closes or everyone has voted.');
  }

  emitPollsUpdated(room.id);
  emitDecisionStatus(ioRef);
  logAgentEvent('agent3', 'Group room timer expired', `Room ${room.id}: closed topic discussion and opened the final question.`);
  return { handled: true, created, finalPollAlreadyOpen: !!finalPoll };
}

async function sweepRoomTimers() {
  const rooms = db
    .prepare(
      `
      SELECT id, room_type, is_active, timer_expires_at
      FROM rooms
      WHERE is_active = 1
        AND timer_expires_at IS NOT NULL
        AND timer_expires_at <= ?
    `
    )
    .all(nowIso());
  for (const room of rooms) {
    if (room.room_type === 'personal') {
      await handleExpiredPersonalRoom(room);
    } else if (room.room_type === 'group') {
      await handleExpiredGroupRoom(room);
    }
  }
}

export function maybeScheduleNextPoll(roomId) {
  const room = db.prepare('SELECT room_type, is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (!room || !['group', 'convergence'].includes(room.room_type) || room.is_active !== 1 || room.collection_complete === 1) return;
  // Convergence rooms remain locked until their summary review has finalized.
  if (isConvergenceReviewLocked(roomId)) return;

  const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId);
  if (openPoll) return;
  const activeTopic = getUnresolvedRoomMemoryTopics(roomId)[0];
  if (!activeTopic) return;

  // The normal flow creates the initial poll during group activation and creates
  // subsequent polls through the explicit topic/chain transitions. Keep this
  // watchdog limited to repairing a room that has no poll at all.
  const priorPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? LIMIT 1').get(roomId);
  if (priorPoll) return;
  createTopicPoll(roomId, activeTopic);
}

export function getAccumulatedDecisions(roomId) {
  const closedPolls = db.prepare('SELECT id, suggestion, poll_type, has_consensus FROM polls WHERE room_id = ? AND is_closed = 1 AND is_reopened = 0').all(roomId);
  const agreedOptions = [];

  const memberCount = db
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
    `
    )
    .get(roomId)?.c || 0;

  for (const poll of closedPolls) {
    const votesCount = poll.poll_type === 'swipe'
      ? (db
          .prepare(
            `
            SELECT COUNT(DISTINCT sv.user_id) AS c
            FROM swipe_votes sv
            JOIN users u ON u.id = sv.user_id
            WHERE sv.poll_id = ?
              AND u.is_admin = 0
          `
          )
          .get(poll.id)?.c || 0)
      : (db
          .prepare(
            `
            SELECT COUNT(*) AS c
            FROM poll_votes pv
            JOIN users u ON u.id = pv.user_id
            WHERE pv.poll_id = ?
              AND u.is_admin = 0
          `
          )
          .get(poll.id)?.c || 0);

    let rows = [];
    if (poll.poll_type === 'swipe') {
      rows = db
        .prepare(
          `
          SELECT po.option_text, COUNT(DISTINCT sv.user_id) AS votes
          FROM poll_options po
          LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right'
          LEFT JOIN users voter ON voter.id = sv.user_id AND voter.is_admin = 0
          WHERE po.poll_id = ?
          GROUP BY po.id
          ORDER BY votes DESC, po.id ASC
        `
        )
        .all(poll.id);
    } else if (poll.poll_type === 'ranking') {
      const totalOptions = db.prepare('SELECT COUNT(*) as c FROM poll_options WHERE poll_id = ?').get(poll.id)?.c || 1;
      rows = db
        .prepare(
          `
          SELECT po.option_text, SUM(? - pv.rank + 1) AS votes
          FROM poll_options po
          LEFT JOIN poll_votes pv ON pv.option_id = po.id
          LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
          WHERE po.poll_id = ? AND pv.rank IS NOT NULL
          GROUP BY po.id
          ORDER BY votes DESC, po.id ASC
        `
        )
        .all(totalOptions, poll.id);
    } else {
      rows = db
        .prepare(
          `
          SELECT po.option_text, COUNT(voter.id) AS votes
          FROM poll_options po
          LEFT JOIN poll_votes pv ON pv.option_id = po.id
          LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
          WHERE po.poll_id = ?
          GROUP BY po.id
          ORDER BY votes DESC, po.id ASC
        `
        )
        .all(poll.id);
    }

    if (rows.length > 0) {
      const top = rows[0];
      const settings = getDecisionSettings();
      const threshold = settings.poll_approval_threshold || 1;
      const allMembersVoted = memberCount > 0 && votesCount >= memberCount;
      let isAgreed = false;
      if (poll.poll_type === 'ranking') {
        isAgreed = true;
      } else if (poll.poll_type === 'swipe') {
        isAgreed = poll.has_consensus === 1;
      } else if (allMembersVoted) {
        if (threshold === 3) isAgreed = top.votes === votesCount;
        else if (threshold === 2) isAgreed = top.votes >= Math.ceil(votesCount * 0.75);
        else isAgreed = top.votes >= Math.ceil(votesCount * 0.51);
      }
      if (isAgreed) {
        let text = top.option_text;
        const lowerOpt = text.toLowerCase();
        if (lowerOpt === 'other') {
          const custom = db.prepare(`
            SELECT custom_option_text, COUNT(*) as c
            FROM poll_votes
            WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
            GROUP BY custom_option_text
            ORDER BY c DESC, custom_option_text ASC
            LIMIT 1
          `).get(poll.id);
          if (custom && custom.custom_option_text) {
            text = custom.custom_option_text.trim();
          }
        }
        
        const finalLowerOpt = text.toLowerCase();
        if (poll.suggestion && (finalLowerOpt === 'yes' || finalLowerOpt.startsWith('yes,') || finalLowerOpt.startsWith('yes '))) {
          text = poll.suggestion;
        }
        const lowerText = text.toLowerCase();
        if (lowerText !== 'keep discussing' && lowerText !== 'other' && lowerText !== 'yes' && lowerText !== 'no' && !lowerText.includes('reopen') && !lowerText.includes('keep current')) {
          agreedOptions.push(text);
        }
      }
    }
  }

  return Array.from(new Set(agreedOptions));
}

async function clusterOptionsWithLLM(roomId, topic, question, votedOptions, customOptions) {
  if (!client) {
    const combined = Array.from(new Set([...votedOptions, ...customOptions]));
    return combined.slice(0, 6);
  }

  try {
    const systemPrompt = renderTemplate('agent3-templates.md#Option Clustering System', {
      topic: topic || 'Current Topic',
      question: question || 'Choose an option',
      voted_options: votedOptions.map(o => `- ${o}`).join('\n') || 'None',
      custom_options: customOptions.map(o => `- ${o}`).join('\n') || 'None'
    });

    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: systemPrompt
        }
      ],
      metadata: { roomId, caller: 'agent3-clusterOptionsWithLLM' }
    });

    const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
    const options = Array.isArray(parsed.options)
      ? parsed.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 6)
      : [];

    if (options.length > 0) {
      return options;
    }
  } catch (err) {
    console.error('Agent 3 clusterOptionsWithLLM LLM error:', err);
    logAgentEvent('agent3', 'clusterOptionsWithLLM LLM error', err.message);
  }

  const combined = Array.from(new Set([...votedOptions, ...customOptions]));
  return combined.slice(0, 6);
}

export function createTopicPoll(roomId, activeTopic) {
  if (!activeTopic) return;
  const isGen = activeTopic.is_general_question ||
    activeTopic.suggestion === 'general-question' ||
    activeTopic.key === 'general-question';

  // Topic discussions start with swipe approval, but a failed swipe round is a
  // deliberate fallback into a single-choice poll. Preserve that state instead
  // of restarting the same swipe round every time the scheduler runs.
  const isSingleSelectFallback = activeTopic.chain_stage === 'single_select';
  let pType = isGen || isSingleSelectFallback ? 'plurality' : 'swipe';
  let pQuestion = activeTopic.question;
  let pOptions = activeTopic.options;

  if (isGen) {
    // Options for the final general question are resolved authoritatively in createMandatoryPoll
    // (admin-defined, with a scale fallback); here we only need the question text.
    pOptions = ['Yes', 'No', 'Abstained'];
    const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
    if (state && state.global_question) {
      pQuestion = state.global_question;
    }
  } else {
    if (!pOptions || pOptions.length < 2) {
      const qRow = db.prepare('SELECT question_text FROM gathering_questions WHERE topic = ?').get(activeTopic.suggestion || activeTopic.key);
      pQuestion = qRow?.question_text || activeTopic.question || `Discussion on ${activeTopic.suggestion || activeTopic.key}`;
      pOptions = activeTopic.options || ['Agree', 'Disagree', 'Keep discussing'];
    }
  }

  const suggestionKey = activeTopic.suggestion || activeTopic.key;
  createMandatoryPoll(roomId, pQuestion, pOptions, 'Automatic topic transition poll.', suggestionKey, activeTopic.replaces_decided_option, true, pType, 'none');
  
  if (ioRef) {
    ioRef.to(`room:${roomId}`).emit('polls_updated', { roomId });
  }
  createBotMessage(roomId, renderTemplate('agent3-templates.md#Mandatory Poll Created Message', {
    minutes: getEffectivePollTimerMinutes(roomId, isGen)
  }));
}

async function handleTopicTransition(roomId, decisionText) {
  const rs = db.prepare('SELECT agreed_points FROM room_status WHERE room_id = ?').get(roomId);
  const existingAgreed = rs && rs.agreed_points ? JSON.parse(rs.agreed_points) : [];
  if (decisionText && !existingAgreed.includes(decisionText)) {
    existingAgreed.push(decisionText);
  }

  const unresolved = getUnresolvedRoomMemoryTopics(roomId);
  if (unresolved.length > 0) {
    const nextTopic = unresolved[0];
    const nextTopicName = nextTopic.suggestion || nextTopic.key || 'the next topic';
    let questionText = `**${nextTopicName}**`;

    const isGen = nextTopic.is_general_question ||
      nextTopicName === 'general-question' ||
      nextTopic.key === 'general-question';

    if (isGen) {
      const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
      if (state && state.global_question) {
        questionText = `**${state.global_question}**`;
      }
    } else {
      const qRow = db.prepare('SELECT question_text FROM gathering_questions WHERE topic = ?').get(nextTopicName);
      if (qRow && qRow.question_text) {
        questionText = `**${qRow.question_text}**`;
      } else if (nextTopic.key) {
        const qRowKey = db.prepare('SELECT question_text FROM gathering_questions WHERE topic = ?').get(nextTopic.key);
        if (qRowKey && qRowKey.question_text) {
          questionText = `**${qRowKey.question_text}**`;
        }
      }
    }

    if (decisionText) {
      logAgentEvent('agent3', 'Topic resolved', `Agreed on: ${decisionText}. Moving to next topic: ${nextTopicName}`);
    }

    if (isGen) {
      const agreedList = getAccumulatedDecisions(roomId);
      const agreedText = agreedList.length > 0
        ? agreedList.map(item => `• ${item}`).join('\n')
        : '• None';
      
      const recapMsg = `We've resolved all the previous topics. Here is a quick recap of the decisions we have taken so far:\n${agreedText}\n\nWhat needs to be still decided:\n• The final general question: "${questionText.replace(/\*\*/g, '')}"`;
      createBotMessage(roomId, recapMsg);
    } else {
      createBotMessage(roomId, `We've resolved the previous topic. Let's move on and strictly discuss the next topic:\n\n${questionText}`);
    }

    localUpdateRoomStatusText(roomId, null, existingAgreed);
    emitDecisionStatus(ioRef);

    // After the announcement (next topic, or the final recap), wait the admin-configured
    // "Time before poll" and then open the next poll automatically: a fresh swipe for the next
    // topic, or the plurality vote for the final general question. This is the single, predictable
    // delay that governs every topic-to-topic hand-off.
    setTimeout(() => {
      const r = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
      if (!r || r.is_active !== 1 || r.collection_complete === 1) return;
      if (isConvergenceReviewLocked(roomId)) return;
      const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId);
      if (openPoll) return;

      const unresolvedNow = getUnresolvedRoomMemoryTopics(roomId);
      const nextNow = unresolvedNow[0];
      if (!nextNow) return;
      createTopicPoll(roomId, nextNow);
    }, settingToTimeBeforePollMs());
    return;
  }

  const cumulativeDecision = getAccumulatedDecisions(roomId).join(', ');
  completeDecision(roomId, cumulativeDecision, 'Consensus reached on all topics');
}

export async function resolvePoll(pollId, roomId) {
  const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(pollId);
  if (!poll || poll.room_id !== roomId || poll.is_closed === 1) return;
  const pollSettings = getDecisionSettings();
  const roomInfo = db.prepare('SELECT room_type, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (['group', 'convergence'].includes(roomInfo?.room_type) && roomInfo.collection_complete === 1) {
    // Legacy duplicate polls may survive completion or a restart. Retire them
    // without changing topic memory, the recorded decision, or convergence.
    db.prepare(`UPDATE polls SET is_closed = 1, closed_at = ?, closed_reason = 'room_already_complete',
      review_until = NULL, transitioned_to_poll_id = COALESCE(transitioned_to_poll_id, -1)
      WHERE id = ? AND is_closed = 0`).run(nowIso(), pollId);
    emitPollsUpdated(roomId);
    return;
  }

  const memberCount = db
    .prepare(
      `
      SELECT COUNT(*) AS c
      FROM room_members rm
      JOIN users u ON u.id = rm.user_id
      WHERE rm.room_id = ?
        AND u.is_admin = 0
    `
    )
    .get(roomId)?.c || 0;
  const votesCount = poll.poll_type === 'swipe'
    ? (db.prepare(
        `
        SELECT COUNT(*) AS c
        FROM (
          SELECT sv.user_id
          FROM swipe_votes sv
          JOIN users u ON u.id = sv.user_id
          JOIN poll_options po ON po.id = sv.option_id AND po.poll_id = ?
          WHERE sv.poll_id = ?
            AND u.is_admin = 0
            AND LOWER(TRIM(po.option_text)) NOT IN ('other', 'keep discussing')
          GROUP BY sv.user_id
          HAVING COUNT(DISTINCT sv.option_id) >= (
            SELECT COUNT(*)
            FROM poll_options
            WHERE poll_id = ?
              AND LOWER(TRIM(option_text)) NOT IN ('other', 'keep discussing')
          )
        )
        `
      ).get(pollId, pollId, pollId)?.c || 0)
    : (db.prepare(
        `
        SELECT COUNT(DISTINCT u.id) AS c
        FROM poll_votes pv
        JOIN users u ON u.id = pv.user_id
        WHERE pv.poll_id = ?
          AND u.is_admin = 0
        `
      ).get(pollId)?.c || 0);
  const isLegacyTopicPreferencePoll = !!(poll.question && poll.question.toLowerCase().includes('relevant or interesting to you'));
  const legacyGraceMs = (pollSettings.poll_timer_minutes || 2) * 60 * 1000;
  // Topic-preference polls in personal rooms are controlled by user completion
  // and the personal room timer, never by the group poll duration setting.
  const legacyExpired = !poll.expires_at && roomInfo?.room_type !== 'personal' && isLegacyTopicPreferencePoll && poll.created_at
    ? (Date.now() - new Date(poll.created_at).getTime() >= legacyGraceMs)
    : false;
  const expired = poll.expires_at ? poll.expires_at <= nowIso() : legacyExpired;
  // Continuous polls have their own state machine. They must not be closed merely
  // because all current voters have responded, and they must not be treated as a
  // normal plurality poll by the legacy resolver.
  if (poll.poll_type === 'continuous') {
    return resolveContinuousPoll(poll, roomId);
  }
  if (!expired && votesCount < memberCount) return;

  db.prepare('UPDATE polls SET is_closed = 1, closed_at = ? WHERE id = ?').run(nowIso(), pollId);
  logAgentEvent('agent3', 'Closed poll', `Poll ${pollId} closed in room ${roomId}.`);
  emitPollsUpdated(roomId);

  const room = db.prepare('SELECT room_type, topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  // A closed poll is the boundary after which a quiet-room nudge may become
  // eligible again. Re-arm it here instead of waiting for a later user message
  // or relying only on the periodic sweep.
  if (room?.room_type === 'group') scheduleGroupNudge(roomId);

  const memory = parseRoomMemory(room);
  const normalizedKey = normalizeTopicKey(poll.suggestion || poll.question);
  const entry = memory.find((item) => normalizeTopicKey(item.key || item.topic || item.question || item.suggestion || item.summary) === normalizedKey);
  let isGlobalQuestion = entry ? !!entry.is_general_question : false;
  if (!isGlobalQuestion && normalizeTopicKey(poll.suggestion) === 'general-question') {
    isGlobalQuestion = true;
  }
  if (!isGlobalQuestion) {
    const generalQuestionRow = getGeneralQuestionRow();
    if (generalQuestionRow && (poll.suggestion === generalQuestionRow.topic || poll.question === generalQuestionRow.question_text)) {
      isGlobalQuestion = true;
    }
  }

  // Check if this is the first poll on a topic (excluding global question, personal rooms)
  const isFirstPollOnTopic = !isGlobalQuestion && room?.room_type !== 'personal' && (poll.suggestion || poll.question) && (() => {
    const key = poll.suggestion || poll.question;
    const priorCount = db.prepare(
      'SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND id < ?'
    ).get(roomId, key, key, pollId)?.c || 0;
    return priorCount === 0;
  })();

  if (room?.room_type === 'personal' && poll.mandatory === 1) {
    const isTopicPreferencePoll = !!(poll.question && poll.question.toLowerCase().includes('relevant or interesting to you'));
    if (isTopicPreferencePoll) {
      const roomMembers = db
        .prepare(
          `
          SELECT u.id, u.username
          FROM room_members rm
          JOIN users u ON u.id = rm.user_id
          WHERE rm.room_id = ?
            AND u.is_admin = 0
          ORDER BY u.username ASC
        `
        )
        .all(roomId);

      const votedMemberIds = new Set(
        db
          .prepare('SELECT DISTINCT user_id FROM poll_votes WHERE poll_id = ?')
          .all(pollId)
          .map((row) => row.user_id)
      );
      const selectedRows = db
        .prepare(
          `
          SELECT pv.user_id, po.option_text
          FROM poll_votes pv
          JOIN poll_options po ON po.id = pv.option_id
          WHERE pv.poll_id = ?
          ORDER BY pv.user_id ASC, po.id ASC
        `
        )
        .all(pollId);
      const selectedByUser = new Map();
      for (const row of selectedRows) {
        if (!selectedByUser.has(row.user_id)) selectedByUser.set(row.user_id, []);
        selectedByUser.get(row.user_id).push(row.option_text);
      }

      const insertResponse = db.prepare(`
        INSERT INTO topic_preference_responses (user_id, room_id, poll_id, selected_topics_json, selected_all_topics, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(poll_id, user_id) DO UPDATE SET
          room_id = excluded.room_id,
          selected_topics_json = excluded.selected_topics_json,
          selected_all_topics = excluded.selected_all_topics,
          created_at = excluded.created_at
      `);
      const clearLegacy = db.prepare('DELETE FROM user_topic_preferences WHERE user_id = ?');
      const insertLegacy = db.prepare('INSERT INTO user_topic_preferences (user_id, topic) VALUES (?, ?)');

      for (const member of roomMembers) {
        const selections = selectedByUser.get(member.id) || [];
        const selectedTopics = selections.filter((topic) => topic && topic.toLowerCase() !== 'all topics');
        const selectedAllTopics = selections.some((topic) => topic && topic.toLowerCase() === 'all topics') || selectedTopics.length === 0;
        clearLegacy.run(member.id);
        insertResponse.run(member.id, roomId, pollId, JSON.stringify(selectedTopics), selectedAllTopics ? 1 : 0, nowIso());
        for (const topic of selectedTopics) {
          insertLegacy.run(member.id, topic);
        }
        if (selectedAllTopics) {
          insertLegacy.run(member.id, 'All topics');
        }
      }

      const primaryUserId = getPrimaryPersonalUserId(roomId);
      if (primaryUserId) {
        await checkPersonalRoom(roomId, primaryUserId);
        emitRoomUpdated(roomId, true);
        emitDecisionStatus(ioRef);
      }
      return;
    }

    const nonVoters = db
      .prepare(
        `
        SELECT u.id, u.username
        FROM room_members rm
        JOIN users u ON u.id = rm.user_id
        WHERE rm.room_id = ?
          AND u.is_admin = 0
          AND NOT EXISTS (
            SELECT 1
            FROM poll_votes pv
            WHERE pv.poll_id = ?
              AND pv.user_id = u.id
          )
      `
      )
      .all(roomId, pollId);
    if (nonVoters.length > 0) {
      const deleteMember = db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?');
      for (const voter of nonVoters) {
        deleteMember.run(roomId, voter.id);
        if (ioRef) ioRef.to(`user:${voter.id}`).emit('membership_revoked', { roomId });
      }
      logAgentEvent('agent3', 'Excluded inactive user from personal poll', `Room ${roomId}: removed ${nonVoters.map((voter) => voter.username).join(', ')}`);

      // A personal room normally has one non-admin participant. If that participant
      // did not vote before a mandatory poll expired, the old code removed the
      // membership and then called checkPersonalRoom with no user ID. That could
      // never complete the room, leaving collection_complete at 0 forever.
      const remainingParticipant = db
        .prepare(
          `
          SELECT 1
          FROM room_members rm
          JOIN users u ON u.id = rm.user_id
          WHERE rm.room_id = ? AND u.is_admin = 0
          LIMIT 1
        `
        )
        .get(roomId);
      if (!remainingParticipant) {
        db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = 'Quality Agent has enough information and is waiting for the other participants.' WHERE id = ?").run(roomId);
        createBotMessage(roomId, renderTemplate('agent3-templates.md#Personal Complete Message'));
        emitRoomUpdated(roomId, true);
        emitDecisionStatus(ioRef);
        await maybeAdvanceToGroupPhase();
        return;
      }
    }

    const generalQuestionRow = getGeneralQuestionRow();
    const expectedQuestionText = generalQuestionRow ? `How open are you to debate and changing your mind on the following topic?\n\n"${generalQuestionRow.question_text}"` : null;

    if (generalQuestionRow && poll.question === expectedQuestionText) {
      const votersNo = db.prepare(`
        SELECT u.id, u.username 
        FROM poll_votes pv 
        JOIN users u ON u.id = pv.user_id 
        JOIN poll_options po ON po.id = pv.option_id 
        WHERE pv.poll_id = ? AND (po.option_text LIKE '1%' OR po.option_text = 'No')
      `).all(pollId);
      const settings = getDecisionSettings();
      if (settings.kick_out_no_voters === 2 && votersNo.length > 0) {
        let excludedCount = 0;
        for (const user of votersNo) {
          const isSimulatedAgent = !!(global.isSimulationRunning && global.simulatedPersonas && global.simulatedPersonas[user.id]);
          if (isSimulatedAgent) continue;

          db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
          db.prepare('UPDATE rooms SET is_active = 0, collection_complete = 1, collection_banner = ? WHERE id = ?').run('Your participation has ended because you were not open to debate.', roomId);
          if (ioRef) ioRef.to(`user:${user.id}`).emit('process_ended_for_user', { roomId });
          logAgentEvent('agent3', 'Excluded user from process', `User ${user.username} answered No to the openness question via poll.`);
          createBotMessage(
            roomId,
            "Thank you. Your participation in the process ends here since you are not open to debate. The room will now be closed."
          );
          excludedCount++;
        }
        if (excludedCount > 0) {
          emitRoomUpdated(roomId, false);
          emitDecisionStatus(ioRef);
          await maybeAdvanceToGroupPhase();
          return;
        }
      }

      // Automatically complete the room once they vote on the openness poll
      const isTopicPrefStrategy = settings.clustering_strategy === 'topic_preference';
      if (isTopicPrefStrategy) {
      db.prepare("UPDATE rooms SET collection_complete = 1, collection_banner = ? WHERE id = ?").run(
        'Quality Agent has enough information and is waiting for the other participants.',
        roomId
      );
      logAgentEvent('agent3', 'Closed personal chat', `Room ${roomId} completed openness poll.`);
      
      // Schedule maybeAdvanceToGroupPhase since this user just finished collection
      setTimeout(() => {
        maybeAdvanceToGroupPhase().catch(console.error);
      }, 2000);
      
      } else {
        await checkPersonalRoom(roomId, getPrimaryPersonalUserId(roomId));
      }
      createBotMessage(
        roomId,
        renderTemplate('agent3-templates.md#Personal Complete Message')
      );
      emitRoomUpdated(roomId, true);
      emitDecisionStatus(ioRef);
      await maybeAdvanceToGroupPhase();
    } else {
      const updatedRoom = db.prepare('SELECT collection_complete FROM rooms WHERE id = ?').get(roomId);
      if (updatedRoom && updatedRoom.collection_complete === 0) {
        const primaryUserId = getPrimaryPersonalUserId(roomId);
        if (primaryUserId) {
          await checkPersonalRoom(roomId, primaryUserId);
          emitRoomUpdated(roomId, true);
          await maybeAdvanceToGroupPhase();
        }
      }
    }

    // In personal rooms, polls are just for gathering information/openness. They don't drive group consensus.
    return;
  }

  if (votesCount === 0) {
    // A swipe with no completed participant submissions is still a failed first
    // attempt, not an unresolved room. Treat it exactly like a non-consensus
    // swipe so the topic advances to Continuous voting instead of stopping in
    // the generic zero-vote fallback below.
    if (poll.poll_type === 'swipe') {
      const swipeRows = db
        .prepare(
          `
          SELECT po.option_text, COUNT(voter.id) AS votes
          FROM poll_options po
          LEFT JOIN swipe_votes sv
            ON sv.option_id = po.id AND sv.poll_id = ? AND sv.swipe_direction = 'right'
          LEFT JOIN users voter
            ON voter.id = sv.user_id AND voter.is_admin = 0
          WHERE po.poll_id = ?
          GROUP BY po.id
          ORDER BY votes DESC, po.id ASC
          `
        )
        .all(pollId, pollId);
      const meaningfulSwipeRows = swipeRows.filter((row) => {
        const text = String(row.option_text || '').trim().toLowerCase();
        return text !== 'other' && text !== 'keep discussing';
      });

      db.prepare("UPDATE polls SET has_consensus = 0, closed_reason = 'swipe_failed' WHERE id = ?").run(pollId);
      logAgentEvent('agent3', 'Swipe closed with zero votes', `Room ${roomId}, poll ${pollId}. Moving to continuous voting.`);
      createContinuousPollFromSwipe(poll, roomId, entry, meaningfulSwipeRows);
      localUpdateRoomStatusText(roomId, 'Live voting is open');
      emitDecisionStatus(ioRef);
      return;
    }

    // A ranking round with no votes is the final stage of the chain — leaving it disputed would
    // leave the topic unresolved (and could loop). Instead, approve the option that was leading
    // going into the ranking. The ranking's options are created leader-first from the live-vote
    // snapshot, so the first option (lowest id) is that leader.
    if (poll.poll_type === 'ranking') {
      const firstOption = db.prepare('SELECT option_text FROM poll_options WHERE poll_id = ? ORDER BY id ASC LIMIT 1').get(pollId);
      const decisionText = firstOption?.option_text
        || (Array.isArray(entry?.options) ? entry.options[0] : null)
        || 'the leading option';
      db.prepare("UPDATE polls SET has_consensus = 1, chain_stage = 'none' WHERE id = ?").run(pollId);
      upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
        ...entry,
        status: 'resolved',
        decision: decisionText,
        summary: `No ranking votes were cast; defaulted to the leading option: ${decisionText}`,
        chain_stage: null,
        poll_id: pollId,
        updated_at: nowIso()
      });
      createBotMessage(roomId, `No ranking votes were cast, so the topic defaults to the option that was leading: **${decisionText}** for "${poll.suggestion || poll.question}".`);
      localUpdateRoomStatusText(roomId, 'Agreed on: ' + decisionText);
      emitDecisionStatus(ioRef);
      await handleTopicTransition(roomId, decisionText);
      return;
    }

    // A timed-out final vote must still finish the room. Leaving the general
    // topic as `polling` causes the automatic scheduler to recreate the same
    // poll forever. No vote is recorded as a neutral/no-preference outcome.
    if (isGlobalQuestion) {
      const decisionString = 'No votes recorded; no preference was recorded.';
      db.prepare('UPDATE polls SET has_consensus = 1 WHERE id = ?').run(pollId);
      upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
        ...entry,
        status: 'resolved',
        summary: decisionString,
        decision: decisionString,
        poll_id: pollId,
        poll_type: poll.poll_type,
        updated_at: nowIso()
      });
      createBotMessage(roomId, 'The final poll closed with no votes. No preference was recorded, so this room will move forward.');
      if (room?.room_type === 'group') {
        createBotMessage(roomId, 'This group is complete. Please wait while the other rooms finish.');
      }
      completeDecision(roomId, decisionString, 'Final poll expired with no votes', true);
      return;
    }
    logAgentEvent('agent3', 'Poll closed with zero votes', `Room ${roomId}, poll ${pollId}. Skipping memory options update.`);
    createBotMessage(
      roomId,
      `The poll "${poll.question}" has closed with no votes.`
    );
    // Never demote a topic that was already resolved (e.g. a stale duplicate poll expiring
    // after the real poll on the same topic reached consensus).
    if (entry && String(entry.status || '').toLowerCase() !== 'resolved') {
      upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
        ...entry,
        status: 'disputed',
        poll_id: pollId,
        updated_at: nowIso()
      });
    }
    localUpdateRoomStatusText(roomId, 'Continuing discussion (poll closed with no votes)');
    emitDecisionStatus(ioRef);
    return;
  }

  const totalOptions = db.prepare('SELECT COUNT(*) as c FROM poll_options WHERE poll_id = ?').get(pollId)?.c || 1;

  let rows = [];
  if (poll.poll_type === 'ranking') {
    // Borda count: point = totalOptions - rank + 1
    // rank is 1-indexed. So if rank=1, points = totalOptions.
    rows = db
      .prepare(
        `
        SELECT po.option_text, SUM(? - pv.rank + 1) AS votes
        FROM poll_options po
        LEFT JOIN poll_votes pv ON pv.option_id = po.id
        LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ? AND pv.rank IS NOT NULL
        GROUP BY po.id
        ORDER BY votes DESC, po.id ASC
      `
      )
      .all(totalOptions, pollId);
  } else if (poll.poll_type === 'swipe') {
    rows = db
      .prepare(
        `
        SELECT po.option_text, COUNT(sv.user_id) AS votes
        FROM poll_options po
        LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right'
        LEFT JOIN users voter ON voter.id = sv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ?
        GROUP BY po.id
        ORDER BY votes DESC, po.id ASC
      `
      )
      .all(pollId);
  } else {
    rows = db
      .prepare(
        `
        SELECT po.option_text, COUNT(voter.id) AS votes
        FROM poll_options po
        LEFT JOIN poll_votes pv ON pv.option_id = po.id
        LEFT JOIN users voter ON voter.id = pv.user_id AND voter.is_admin = 0
        WHERE po.poll_id = ?
        GROUP BY po.id
        ORDER BY votes DESC, po.id ASC
      `
      )
      .all(pollId);
  }

  if (!rows.length) return;

  let resultsText = replaceOtherInRows(rows, pollId).map((r) => `${r.option_text}: ${r.votes}`).join('; ');

  // ===== SWIPE POLL CHAIN HANDLING =====
  // Only chain if consensus was NOT reached (has_consensus === 1 means agreement)
  const hasConsensus = poll.has_consensus === 1;

  if (hasConsensus) {
    // Consensus reached - mark resolved and skip chaining
    upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
      ...entry, status: 'resolved', decision: rows[0].option_text,
      summary: resultsText, chain_stage: null, updated_at: nowIso()
    });
    db.prepare("UPDATE polls SET chain_stage = 'none' WHERE id = ?").run(pollId);
        createBotMessage(roomId, `The group agreed on: **${rows[0].option_text}** for "${poll.suggestion || poll.question}".`);
    localUpdateRoomStatusText(roomId, "Agreed on: " + rows[0].option_text);
    emitDecisionStatus(ioRef);
    return;
  }

  if (poll.poll_type === 'swipe') {
    // `rows` holds the right-swipe count per option (ordered by votes desc).
    const meaningfulRows = rows.filter(r => {
      const t = String(r.option_text || '').toLowerCase();
      return t !== 'other' && t !== 'keep discussing';
    });

    // Swipe consensus honors the Poll approval threshold: an option is "settled" when the number
    // of right-swipes meets the required share of members (1 = 51% majority, 2 = 75%, 3 = 100%),
    // and it is the single clear leader. (Previously required unanimity regardless of the setting.)
    const swipeSettings = getDecisionSettings();
    const swipeThreshold = swipeSettings.poll_approval_threshold || 1;
    const requiredApprovals = memberCount > 0
      ? (swipeThreshold === 3
          ? memberCount
          : swipeThreshold === 2
            ? Math.ceil(memberCount * 0.75)
            : Math.ceil(memberCount * 0.51))
      : Infinity;
    const approvedEnough = meaningfulRows
      .filter(r => r.votes >= requiredApprovals)
      .sort((a, b) => b.votes - a.votes);
    const topApprovedVotes = approvedEnough[0]?.votes || 0;
    const clearLeader = approvedEnough.length >= 1 && approvedEnough.filter(r => r.votes === topApprovedVotes).length === 1;
    if (clearLeader) {
      const decisionText = approvedEnough[0].option_text;
      upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
        ...entry, status: 'resolved', decision: decisionText,
        summary: resultsText, chain_stage: null, updated_at: nowIso()
      });
      db.prepare("UPDATE polls SET has_consensus = 1, chain_stage = 'none' WHERE id = ?").run(pollId);
      const unanimous = topApprovedVotes >= memberCount;
      createBotMessage(roomId, `${unanimous ? 'Everyone agreed on' : 'The group agreed on'}: **${decisionText}** for "${poll.suggestion || poll.question}".`);
      await handleTopicTransition(roomId, decisionText);
      return;
    }

    // The failed swipe is a one-way transition into continuous voting. It is
    // intentionally not recreated by the scheduler and cannot loop back to swipe.
    db.prepare('UPDATE polls SET has_consensus = 0, closed_reason = \'swipe_failed\' WHERE id = ?').run(pollId);
    createContinuousPollFromSwipe(poll, roomId, entry, meaningfulRows);
    localUpdateRoomStatusText(roomId, 'Live voting is open');
    emitDecisionStatus(ioRef);
    return;
  }

  if (poll.chain_stage === 'single_select') {
    // Single-select is the final stage of swipe chain - no more chaining needed
    // Fall through to normal consensus logic
    // Clear chain_stage so we don't re-chain
    db.prepare("UPDATE polls SET chain_stage = 'none' WHERE id = ?").run(pollId);
    if (entry) {
      upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
        ...entry,
        chain_stage: null,
        updated_at: nowIso()
      });
    }
  }

  const maxVotes = rows[0]?.votes || 0;
  const tiedRows = rows.filter(r => r.votes === maxVotes);
  const isTie = maxVotes > 0 && tiedRows.length > 1;

  let actualTiedOptions = [];
  if (isTie) {
    for (const r of tiedRows) {
      const optText = r.option_text;
      if (optText.toLowerCase() === 'keep discussing') {
        continue;
      }
      if (optText.toLowerCase() === 'other') {
        const customOptions = db.prepare(`
          SELECT DISTINCT custom_option_text
          FROM poll_votes
          WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
        `).all(pollId).map(row => row.custom_option_text.trim());

        if (customOptions.length > 0) {
          actualTiedOptions.push(...customOptions);
        } else {
          actualTiedOptions.push('Other');
        }
      } else {
        actualTiedOptions.push(optText);
      }
    }
  }

  const maybeSendTieProCon = async () => {
    if (votesCount >= 2 && !isGlobalQuestion && isTie && actualTiedOptions.length > 0) {
      await handleTieProCon(roomId, actualTiedOptions);
    }
  };

  const top = rows[0];
  if (top.option_text && top.option_text.toLowerCase() === 'keep discussing') {
    db.prepare('UPDATE polls SET has_consensus = 0 WHERE id = ?').run(pollId);

    // Only carry forward options that actually received votes (excluding meta-options)
    const votedOptions = rows
      .filter(r => r.votes > 0 && r.option_text.toLowerCase() !== 'other' && r.option_text.toLowerCase() !== 'keep discussing')
      .map(r => r.option_text);

    const customOptions = db.prepare(`
      SELECT DISTINCT custom_option_text
      FROM poll_votes
      WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
    `).all(pollId).map(row => row.custom_option_text.trim());

    logAgentEvent('agent3', 'Keep discussing clustering options', `Room ${roomId}, poll ${pollId}. Voted options: ${votedOptions.join(', ')}. Custom options: ${customOptions.join(', ')}`);
    const clusteredOptions = await clusterOptionsWithLLM(roomId, poll.suggestion || poll.question, poll.question, votedOptions, customOptions);
    logAgentEvent('agent3', 'Clustered options output', `Room ${roomId}, poll ${pollId}. Clustered: ${clusteredOptions.join(', ')}`);

    upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
      status: 'disputed',
      summary: 'Keep discussing',
      poll_id: pollId,
      poll_type: poll.poll_type,
      options: clusteredOptions.length > 0 ? clusteredOptions : ['Keep discussing'],
      updated_at: nowIso()
    });
    createBotMessage(roomId, renderTemplate('agent3-templates.md#Keep Discussing Message'));
    localUpdateRoomStatusText(roomId, 'Continuing discussion (decided to keep discussing)');
    emitDecisionStatus(ioRef);
    return;
  }

  const allMembersVoted = memberCount > 0 && votesCount >= memberCount;
  const settings = getDecisionSettings();
  const threshold = settings.poll_approval_threshold || 1;
  let isAgreed = false;
  if (poll.poll_type === 'ranking') {
    isAgreed = true;
  } else if (allMembersVoted) {
    if (threshold === 3) isAgreed = top.votes === votesCount;
    else if (threshold === 2) isAgreed = top.votes >= Math.ceil(votesCount * 0.75);
    else isAgreed = top.votes >= Math.ceil(votesCount * 0.51);
  }

  const isOther = isAgreed && top.option_text && top.option_text.toLowerCase() === 'other';

  if (isFirstPollOnTopic && (!isAgreed || isOther)) {
    db.prepare('UPDATE polls SET has_consensus = 0 WHERE id = ?').run(pollId);
    // 1. Count votes to display in message
    resultsText = rows.map((r) => `${r.option_text}: ${r.votes}`).join('; ');

    // 2. Get only options that received at least 1 vote (excluding meta-options)
    const votedOptions = db.prepare(`
      SELECT DISTINCT po.option_text
      FROM poll_votes pv
      JOIN poll_options po ON po.id = pv.option_id
      WHERE pv.poll_id = ?
        AND LOWER(po.option_text) != 'other'
        AND LOWER(po.option_text) != 'keep discussing'
    `).all(pollId).map(row => row.option_text);

    // 3. Get custom options
    const customOptions = db.prepare(`
      SELECT DISTINCT custom_option_text
      FROM poll_votes
      WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
    `).all(pollId).map(row => row.custom_option_text.trim());

    // 4. Cluster options with LLM
    logAgentEvent('agent3', 'First poll clustering options', `Room ${roomId}, poll ${pollId}. Voted options: ${votedOptions.join(', ')}. Custom options: ${customOptions.join(', ')}`);
    const clusteredOptions = await clusterOptionsWithLLM(roomId, poll.suggestion || poll.question, poll.question, votedOptions, customOptions);
    logAgentEvent('agent3', 'Clustered options output', `Room ${roomId}, poll ${pollId}. Clustered: ${clusteredOptions.join(', ')}`);

    // 5. Update the topic's memory entry in the database with the clustered options
    // This stores them so that subsequent polls on this topic will read them.
    upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
      status: 'disputed',
      summary: resultsText,
      poll_id: pollId,
      poll_type: poll.poll_type,
      options: clusteredOptions.length > 0 ? clusteredOptions : ['Keep discussing'],
      updated_at: nowIso()
    });

    // 6. Send bot message explaining the result in a short message without details
    const topVotes = rows[0]?.votes || 0;
    const isTie = topVotes > 0 && rows.filter((r) => r.votes === topVotes).length > 1;
    const statusPhrase = isTie ? " It is a tie." : " There is no consensus.";

    createBotMessage(
      roomId,
      `The first vote for "${poll.suggestion || poll.question}" has completed.${statusPhrase} We will continue our discussion. You can ask me to vote again when you are ready.`
    );

    await maybeSendTieProCon();

    localUpdateRoomStatusText(roomId, 'Continuing discussion (first vote complete)');
    emitDecisionStatus(ioRef);
    return;
  }

  db.prepare('UPDATE polls SET has_consensus = ? WHERE id = ?').run(isAgreed && !isOther ? 1 : 0, pollId);
  resultsText = replaceOtherInRows(rows, pollId).map((r) => `${r.option_text}: ${r.votes}`).join('; ');

  if (isGlobalQuestion) {
    db.prepare('UPDATE polls SET has_consensus = 1 WHERE id = ?').run(pollId);

    // Report the breakdown across the ACTUAL options for this question. The general question now
    // uses admin-defined options (not necessarily Yes/No/Abstained), so bucketing into yes/no/
    // abstained produced "abstained: 100%" for any custom option set. Show each option's share.
    const totalVotes = rows.reduce((sum, r) => sum + Number(r.votes || 0), 0);
    let decisionString;
    if (totalVotes > 0) {
      decisionString = rows
        .map((r) => `${r.option_text}: ${Math.round((Number(r.votes || 0) / totalVotes) * 100)}%`)
        .join(', ');
    } else {
      decisionString = 'No votes recorded';
    }

    upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
      status: 'resolved',
      summary: decisionString,
      decision: decisionString,
      poll_id: pollId,
      poll_type: poll.poll_type,
      updated_at: nowIso()
    });

    createBotMessage(roomId, `Thank you for voting. The result of the vote is: ${decisionString}`);

    if (room.room_type === 'group') {
      createBotMessage(roomId, "Thanks — this group is done. Please wait for the other rooms to finish; the full results will be presented together in the final report.");
    }

    completeDecision(roomId, decisionString, 'Final vote taken', true);
    return;
  }

  if (isAgreed) {
    let winningOption = top.option_text;
    if (winningOption && winningOption.toLowerCase() === 'other') {
      const custom = db.prepare(`
        SELECT custom_option_text, COUNT(*) as c
        FROM poll_votes
        WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
        GROUP BY custom_option_text
        ORDER BY c DESC, custom_option_text ASC
        LIMIT 1
      `).get(pollId);
      if (custom && custom.custom_option_text) {
        winningOption = custom.custom_option_text.trim();
      }
    }
    const lowerWinning = winningOption.toLowerCase();

    if (poll.replaces_option) {
      const isMatch = await evaluateOptionMatch(winningOption, poll.replaces_option);
      if (lowerWinning.includes('keep current') || isMatch) {
        createBotMessage(roomId, `The group decided to keep the current decision on: ${poll.replaces_option}.`);
        localUpdateRoomStatusText(roomId, `Continuing discussion (decided to keep current: ${poll.replaces_option})`);
        emitDecisionStatus(ioRef);
        return;
      }

      if (lowerWinning !== 'other' && lowerWinning !== 'keep discussing') {
        const targetOptionText = poll.replaces_option.toLowerCase().trim();
        const closedPolls = db.prepare('SELECT id, suggestion FROM polls WHERE room_id = ? AND is_closed = 1 AND is_reopened = 0').all(roomId);
        let matchedCount = 0;
        for (const cp of closedPolls) {
          if (cp.id === pollId) continue;

          const winningOpt = db.prepare(`
            SELECT po.option_text, COUNT(pv.user_id) as votes
            FROM poll_options po
            LEFT JOIN poll_votes pv ON pv.option_id = po.id
            WHERE po.poll_id = ?
            GROUP BY po.id
            ORDER BY votes DESC, po.id ASC
            LIMIT 1
          `).get(cp.id);

          let matched = false;
          const sugLower = (cp.suggestion || '').toLowerCase().trim();
          const winLower = winningOpt && winningOpt.option_text ? winningOpt.option_text.toLowerCase().trim() : '';

          if (sugLower && (sugLower === targetOptionText || targetOptionText.includes(sugLower) || sugLower.includes(targetOptionText))) {
            matched = true;
          } else if (winLower && winLower !== 'yes' && (winLower === targetOptionText || targetOptionText.includes(winLower) || winLower.includes(targetOptionText))) {
            matched = true;
          }

          if (matched) {
            db.prepare('UPDATE polls SET is_reopened = 1 WHERE id = ?').run(cp.id);
            logAgentEvent('agent3', 'Replaced decided topic successfully', `Marked poll ${cp.id} (${cp.suggestion}) as reopened/replaced.`);
            matchedCount++;
          }
        }
        if (matchedCount > 0) {
          // No need to output "Discussion reopened" since we are replacing it with a new decision
          // We will just let the normal winning Option message handle it.
        }
      }
    }

    if (lowerWinning.includes('reopen')) {
      const topic = (poll.suggestion || '').trim();
      const questionLower = poll.question.toLowerCase();
      const topicLower = topic.toLowerCase();

      const closedPolls = db.prepare('SELECT id, suggestion FROM polls WHERE room_id = ? AND is_closed = 1 AND is_reopened = 0').all(roomId);
      for (const cp of closedPolls) {
        let matched = false;

        // Check 1: Is the decided poll's suggestion mentioned in the reopen poll's question or suggestion?
        if (cp.suggestion) {
          const sugLower = cp.suggestion.trim().toLowerCase();
          if (
            questionLower.includes(sugLower) ||
            (topicLower && (topicLower.includes(sugLower) || sugLower.includes(topicLower)))
          ) {
            matched = true;
          }
        }

        // Check 2: Is the decided poll's winning option text mentioned in the reopen poll's question?
        if (!matched) {
          const winningOpt = db.prepare(`
            SELECT po.option_text, COUNT(pv.user_id) as votes
            FROM poll_options po
            LEFT JOIN poll_votes pv ON pv.option_id = po.id
            WHERE po.poll_id = ?
            GROUP BY po.id
            ORDER BY votes DESC, po.id ASC
            LIMIT 1
          `).get(cp.id);

          if (winningOpt && winningOpt.option_text) {
            const optText = winningOpt.option_text.trim().toLowerCase();
            const cleanOptText = optText.replace(/^yes,?\s*/i, '').trim();
            if (questionLower.includes(optText) || questionLower.includes(cleanOptText)) {
              matched = true;
            }
          }
        }

        if (matched) {
          db.prepare('UPDATE polls SET is_reopened = 1 WHERE id = ?').run(cp.id);
          logAgentEvent('agent3', 'Reopened topic successfully', `Marked poll ${cp.id} (${cp.suggestion}) as reopened.`);
        }
      }

      // Try to find the clean topic name to announce
      let announceTopic = topic;
      const topicMatch = poll.question.match(/(?:reopen the topic|reopen):\s*([^?]+)/i);
      if (topicMatch && topicMatch[1]) {
        announceTopic = topicMatch[1].trim();
      }

      createBotMessage(roomId, `Discussion reopened for topic: ${announceTopic}. Let's discuss it further.`);
      logAgentEvent('agent3', 'Reopened topic', `Reopened topic "${announceTopic}" in room ${roomId}.`);
      localUpdateRoomStatusText(roomId, `Discussion reopened for: ${announceTopic}`);
      emitDecisionStatus(ioRef);
      return;
    }

    if (lowerWinning.includes('keep current')) {
      createBotMessage(roomId, `The group decided to keep the current decision on: ${poll.suggestion || ''}.`);
      localUpdateRoomStatusText(roomId, `Continuing discussion (decided to keep current: ${poll.suggestion || ''})`);
      emitDecisionStatus(ioRef);
      return;
    }



    const state = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get();

    const agreedOptions = getAccumulatedDecisions(roomId);
    const cumulativeDecision = agreedOptions.join(', ');

    let decisionText = winningOption;
    const lowerWin = decisionText.toLowerCase();
    if (poll.suggestion && (lowerWin === 'yes' || lowerWin.startsWith('yes,') || lowerWin.startsWith('yes '))) {
      decisionText = poll.suggestion;
    }
    upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
      status: 'resolved',
      summary: resultsText,
      decision: decisionText,
      poll_id: pollId,
      poll_type: poll.poll_type,
      updated_at: nowIso()
    });

    if (poll.poll_type === 'ranking') {
      const rankingResultsText = replaceOtherInRows(rows, pollId).map(r => `${r.option_text} (${r.votes} pts)`).join(', ');
      createBotMessage(roomId, `The ranking poll has concluded. **${decisionText}** won with the highest score! Here are the full results: ${rankingResultsText}.`);
      await maybeSendTieProCon();
    }

    const rs = db.prepare('SELECT agreed_points FROM room_status WHERE room_id = ?').get(roomId);
    const existingAgreed = rs && rs.agreed_points ? JSON.parse(rs.agreed_points) : [];
    if (!existingAgreed.includes(decisionText)) {
      existingAgreed.push(decisionText);
    }

    const otherOpenPollsCount = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId).c;

    if (otherOpenPollsCount > 0) {
      logAgentEvent('agent3', 'Partial decision confirmed (silenced)', `Agreed on: ${decisionText}. Waiting for ${otherOpenPollsCount} other poll(s) to close before proceeding.`);
      localUpdateRoomStatusText(roomId, null, existingAgreed);
      emitDecisionStatus(ioRef);
      return;
    }

    const systemState = db.prepare('SELECT showdown_initiated FROM system_state WHERE id = 1').get();
    if (systemState?.showdown_initiated === 1) {
      const unresolved = getUnresolvedRoomMemoryTopics(roomId);
      const nonGeneralUnresolved = unresolved.filter(topic => {
        const isGen = topic.is_general_question ||
          topic.key === 'general-question' ||
          topic.topic === 'general-question' ||
          topic.suggestion === 'general-question';
        return !isGen;
      });

      if (nonGeneralUnresolved.length === 0) {
        const generalQuestionRow = getGeneralQuestionRow();
        const questionText = generalQuestionRow?.question_text || 'Do you agree on the final question?';
        const topicName = generalQuestionRow?.topic || 'general-question';

        const finalPollExists = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND is_closed = 0').get(roomId, topicName, questionText)?.c > 0;
        if (!finalPollExists) {
          createMandatoryPoll(roomId, questionText, ['Yes', 'No', 'Abstained'], 'Showdown final poll initiated by Admin.', topicName, null, false, 'plurality');
          createBotMessage(roomId, `All previous topics have been resolved. Now it is time to vote on the final question:\n\n**${questionText}**`);
        }
        return;
      }
    }

    await handleTopicTransition(roomId, decisionText);
    return;
  }

  const splitResultsText = rows.map((r) => `${r.option_text}: ${r.votes}`).join('; ');

  // Only carry forward options that actually received votes (excluding meta-options)
  const votedOptions = rows
    .filter(r => r.votes > 0 && r.option_text.toLowerCase() !== 'other' && r.option_text.toLowerCase() !== 'keep discussing')
    .map(r => r.option_text);

  const customOptions = db.prepare(`
    SELECT DISTINCT custom_option_text
    FROM poll_votes
    WHERE poll_id = ? AND custom_option_text IS NOT NULL AND TRIM(custom_option_text) != ''
  `).all(pollId).map(row => row.custom_option_text.trim());

  logAgentEvent('agent3', 'Subsequent poll clustering options', `Room ${roomId}, poll ${pollId}. Voted options: ${votedOptions.join(', ')}. Custom options: ${customOptions.join(', ')}`);
  const clusteredOptions = await clusterOptionsWithLLM(roomId, poll.suggestion || poll.question, poll.question, votedOptions, customOptions);
  logAgentEvent('agent3', 'Clustered options output', `Room ${roomId}, poll ${pollId}. Clustered: ${clusteredOptions.join(', ')}`);

  upsertRoomMemoryEntry(roomId, poll.suggestion || poll.question, {
    status: 'disputed',
    summary: splitResultsText,
    poll_id: pollId,
    poll_type: poll.poll_type,
    options: clusteredOptions.length > 0 ? clusteredOptions : ['Keep discussing'],
    updated_at: nowIso()
  });

  const best = rows[0]?.option_text || 'Option A';
  const second = rows[1]?.option_text || 'Option B';
  const otherVotes = rows.find((r) => r.option_text.toLowerCase() === 'other')?.votes || 0;
  appendDisagreementNudge(
    roomId,
    renderTemplate('agent2-templates.md#Split Vote Nudge', {
      results: splitResultsText,
      other_instruction: otherVotes > 0 ? `${renderTemplate('agent2-templates.md#Other Vote Instruction')} ` : '',
      best_option: best,
      second_option: second
    })
  );
  logAgentEvent('agent2', 'Adjusted mediator prompt after split vote', resultsText);
  if (!allMembersVoted) {
    createBotMessage(roomId, renderTemplate('agent2-templates.md#Partial Vote Message', { votes_count: votesCount, member_count: memberCount }));
  } else if (otherVotes > 0) {
    createBotMessage(roomId, renderTemplate('agent2-templates.md#Other Disagreement Message'));
  } else {
    createBotMessage(roomId, renderTemplate('agent2-templates.md#Split Disagreement Message'));
  }

  await maybeSendTieProCon();

  localUpdateRoomStatusText(roomId, 'Continuing discussion (disagreement on last poll)');

  const systemState = db.prepare('SELECT showdown_initiated FROM system_state WHERE id = 1').get();
  if (systemState?.showdown_initiated === 1) {
    const otherOpenPollsCount = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId).c;
    if (otherOpenPollsCount === 0) {
      const unresolved = getUnresolvedRoomMemoryTopics(roomId);
      const nonGeneralUnresolved = unresolved.filter(topic => {
        const isGen = topic.is_general_question ||
          topic.key === 'general-question' ||
          topic.topic === 'general-question' ||
          topic.suggestion === 'general-question';
        return !isGen;
      });
      if (nonGeneralUnresolved.length === 0) {
        const generalQuestionRow = getGeneralQuestionRow();
        const questionText = generalQuestionRow?.question_text || 'Do you agree on the final question?';
        const topicName = generalQuestionRow?.topic || 'general-question';

        const finalPollExists = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND is_closed = 0').get(roomId, topicName, questionText)?.c > 0;
        if (!finalPollExists) {
          createMandatoryPoll(roomId, questionText, ['Yes', 'No', 'Abstained'], 'Showdown final poll initiated by Admin.', topicName, null, false, 'plurality');
          createBotMessage(roomId, `All previous topics have been resolved. Now it is time to vote on the final question:\n\n**${questionText}**`);
        }
      }
    }
  }
}

// Repair a process that was already running the old zero-vote behavior when
// the backend is deployed. A closed final poll otherwise remains disputed.
function recoverStalledFinalPolls() {
  const candidates = db.prepare("SELECT p.id, p.room_id, p.poll_type, p.suggestion, p.question, r.room_type, r.topic_memory_json FROM polls p JOIN rooms r ON r.id = p.room_id WHERE p.id = (SELECT MAX(previous.id) FROM polls previous WHERE previous.room_id = p.room_id AND previous.is_closed = 1 AND LOWER(COALESCE(previous.suggestion, '')) = 'general-question') AND p.is_closed = 1 AND LOWER(COALESCE(p.suggestion, '')) = 'general-question' AND r.room_type IN ('group', 'convergence') AND r.is_active = 1 AND r.collection_complete = 0").all();
  for (const poll of candidates) {
    const votes = db.prepare("SELECT COUNT(DISTINCT pv.user_id) AS c FROM poll_votes pv JOIN users u ON u.id = pv.user_id WHERE pv.poll_id = ? AND u.is_admin = 0").get(poll.id)?.c || 0;
    if (votes > 0) continue;
    const memory = parseRoomMemory(poll);
    const entry = memory.find((item) => normalizeTopicKey(item.key || item.topic || item.question || item.suggestion) === 'general-question');
    if (entry && String(entry.status || '').toLowerCase() === 'resolved') continue;
    const decisionString = 'No votes recorded; no preference was recorded.';
    db.prepare('UPDATE polls SET has_consensus = 1 WHERE id = ?').run(poll.id);
    upsertRoomMemoryEntry(poll.room_id, 'general-question', { ...entry, status: 'resolved', summary: decisionString, decision: decisionString, poll_id: poll.id, poll_type: poll.poll_type, updated_at: nowIso() });
    createBotMessage(poll.room_id, 'The final poll closed with no votes. No preference was recorded, so this room will move forward.');
    if (poll.room_type === 'group') createBotMessage(poll.room_id, 'This group is complete. Please wait while the other rooms finish.');
    completeDecision(poll.room_id, decisionString, 'Recovered final poll that expired with no votes', true);
    logAgentEvent('agent3', 'Recovered stalled final poll', 'Room ' + poll.room_id + ', poll ' + poll.id + '.');
  }
}

async function checkGroupRoomForPoll(roomId) {
  const room = db.prepare('SELECT room_type, is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (!room || !['group', 'convergence'].includes(room.room_type) || room.is_active !== 1 || room.collection_complete === 1) return;
  // No discussion-driven polls during the convergence summary review window.
  if (isConvergenceReviewLocked(roomId)) return;

  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
  if (!state?.global_question || state.current_phase !== 'discussing') return;

  const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId);
  if (openPoll) return;

  const transcript = getTranscript(roomId, 20);
  const humanMessages = transcript.filter((m) => m.sender_name !== 'Bot');
  const distinctHumans = new Set(humanMessages.map((m) => m.sender_name));
  const voteRequestedBeforeGate = isVoteIntentText(humanMessages[humanMessages.length - 1]?.text);
  // A direct request to vote must reach the readiness gate even when only one
  // participant has spoken, so the bot can explain what is still required.
  // Ordinary one-person messages should not trigger an LLM readiness check.
  if (distinctHumans.size < 2 && !voteRequestedBeforeGate) return;

  const unresolved = getUnresolvedRoomMemoryTopics(roomId);
  const activeTopic = unresolved[0];

  const lastBotAnnouncementIndex = transcript.map(m => m.sender_name === 'Bot' && (
    m.text.includes('mandatory poll') ||
    m.text.includes('we agreed on:') ||
    m.text.includes('agreement was reached on:') ||
    m.text.includes('Discussion reopened')
  )).lastIndexOf(true);

  const activeTurnMessages = lastBotAnnouncementIndex >= 0 ? transcript.slice(lastBotAnnouncementIndex + 1) : transcript;
  const humanMessagesInActiveTurn = activeTurnMessages.filter(m => m.sender_name !== 'Bot');

  if (humanMessagesInActiveTurn.length === 0) {
    return;
  }

  const decisionSettings = getDecisionSettings();
  const lastHumanMessage = humanMessagesInActiveTurn[humanMessagesInActiveTurn.length - 1];
  const voteRequested = isVoteIntentText(lastHumanMessage?.text);
  const readinessGate = getReadinessParticipantGate(
    roomId,
    activeTurnMessages,
    decisionSettings.consensus_sensitivity
  );

  // A timed-out continuous poll owns its review-to-ranking transition. Resolve
  // that state before applying the participant gate so a vote request receives
  // the specific transition message rather than a generic readiness warning.
  const topicKey = activeTopic?.suggestion || activeTopic?.key;
  const pendingContinuousReview = activeTopic
    ? db.prepare(`
      SELECT id, review_until
      FROM polls
      WHERE room_id = ?
        AND poll_type = 'continuous'
        AND is_closed = 1
        AND transitioned_to_poll_id IS NULL
        AND review_until IS NOT NULL
        AND (suggestion = ? OR question = ?)
      ORDER BY id DESC
      LIMIT 1
    `).get(roomId, topicKey, activeTopic.question || topicKey)
    : null;

  if (!readinessGate.enoughDistinctParticipants) {
    if (voteRequested) {
      if (pendingContinuousReview) {
        emitVoteReadinessNotice(
          roomId,
          'The live voting phase has ended and the final ranking vote is being prepared. Please wait for that ranking poll instead of opening another live vote.'
        );
        return { voteRequestHandled: true, pollCreated: false, blockedReason: 'ranking_transition' };
      }
      emitVoteReadinessNotice(
        roomId,
        `I hear that you want to vote, but I cannot open the poll yet. I need at least **${readinessGate.requiredUsers} different participant(s)** to contribute to this discussion first. So far, **${readinessGate.activeUsers.size}/${readinessGate.requiredUsers}** have contributed. Please continue discussing and state your position or main concern.`
      );
      return { voteRequestHandled: true, pollCreated: false, blockedReason: 'distinct_participants' };
    }
    return;
  }

  // A timed-out continuous poll owns its review-to-ranking transition. A new
  // chat message must not reopen live voting while that transition is pending.
  if (pendingContinuousReview) {
    if (voteRequested) {
      emitVoteReadinessNotice(
        roomId,
        'The live voting phase has ended and the final ranking vote is being prepared. Please wait for that ranking poll instead of opening another live vote.'
      );
      return { voteRequestHandled: true, pollCreated: false, blockedReason: 'ranking_transition' };
    }
    return;
  }

  const analysis = await evaluateReadyToVote(roomId, state.global_question, state.decision_context || '', transcript);

  let pollsToCreate = [];
  if (analysis.ready_to_vote && analysis.ready_polls && analysis.ready_polls.length > 0) {
    pollsToCreate = analysis.ready_polls;
  }

  if (pollsToCreate.length === 0) {
    if (voteRequested) {
      const readyUsers = Array.isArray(analysis.ready_users) ? analysis.ready_users : [];
      const requiredUsers = Math.min(
        Math.max(1, Number(analysis.required_ready_users) || getRequiredReadinessParticipants(
          readinessGate.memberCount,
          decisionSettings.consensus_sensitivity
        )),
        Math.max(1, readinessGate.memberCount)
      );
      if (readyUsers.length < requiredUsers) {
        emitVoteReadinessNotice(
          roomId,
          `I hear that you want to vote, but the discussion does not yet contain clear positions from enough participants. I need **${requiredUsers} different participant(s)** to clearly signal readiness; the readiness check currently found **${readyUsers.length}/${requiredUsers}**. Please state your position and the main reason or trade-off.`
        );
      } else {
        emitVoteReadinessNotice(
          roomId,
          'I hear that you want to vote, but the current discussion is not yet clear enough to frame a meaningful poll. Please clarify the proposal, your position, or the main trade-off, and I will check again.'
        );
      }
      return { voteRequestHandled: true, pollCreated: false, blockedReason: 'readiness_llm' };
    }
    return;
  }

  if (pendingPollTimeouts.has(roomId)) {
    clearTimeout(pendingPollTimeouts.get(roomId));
    pendingPollTimeouts.delete(roomId);
  }

  logAgentEvent('agent3', 'Automatic poll creation', `Creating ${pollsToCreate.length} poll(s) for room ${roomId}.`);
  let anyPollCreated = false;
  let createdContinuous = false;
  for (const poll of pollsToCreate) {
    let pType = poll.poll_type || 'plurality';
    let cStage = 'none';
    let pOptions = poll.options;
    let pQuestion = poll.question;

    if (activeTopic && !activeTopic.is_general_question) {
      const topicKey = activeTopic.suggestion || activeTopic.key;
      const topicPolls = db.prepare('SELECT poll_type, is_closed, transitioned_to_poll_id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) ORDER BY id ASC')
        .all(roomId, topicKey, activeTopic.question || topicKey);
      if (topicPolls.length === 0) {
        pType = 'swipe';
      } else if (!topicPolls.some((item) => item.poll_type === 'ranking') && !topicPolls.some((item) => item.poll_type === 'continuous' && item.is_closed === 0)) {
        pType = 'continuous';
        cStage = 'continuous';
        pOptions = activeTopic.options && activeTopic.options.length > 1 ? activeTopic.options : pOptions;
        pQuestion = activeTopic.question || pQuestion;
      }
    }

    if (pOptions && pOptions.length >= 2) {
      if (activeTopic && activeTopic.is_general_question) {
        pOptions = ['Yes', 'No', 'Abstained'];
      }
      const expiresAt = pType === 'continuous'
        ? new Date(Date.now() + decisionSettings.live_voting_duration_minutes * 60 * 1000).toISOString()
        : null;
      const createdPollId = createMandatoryPoll(roomId, pQuestion, pOptions, 'Detected possible agreement.', poll.suggestion || (activeTopic && (activeTopic.suggestion || activeTopic.key)), poll.replaces_decided_option, true, pType, cStage, expiresAt);
      if (createdPollId) {
        anyPollCreated = true;
        createdContinuous = createdContinuous || pType === 'continuous';
      }
    }
  }
  // Only announce a poll when one was actually created (otherwise users were told to vote
  // but saw nothing).
  if (anyPollCreated) {
    createBotMessage(roomId, renderTemplate('agent3-templates.md#Mandatory Poll Created Message', {
      minutes: createdContinuous
        ? decisionSettings.live_voting_duration_minutes
        : getEffectivePollTimerMinutes(roomId, !!activeTopic?.is_general_question)
    }));
  }
  return { voteRequestHandled: voteRequested, pollCreated: anyPollCreated };
}


function buildDecisionRecapEntry({ topic, question, decision, pollType, totalVotes, totalMembers, options, allOptions }) {
  const sorted = Array.isArray(options) ? options.filter(Boolean) : [];
  const normalizedTotal = Math.max(Number(totalMembers) || 0, 0);
  const topOneVotes = Number(sorted[0]?.votes || 0);
  const topTwoVotes = topOneVotes + Number(sorted[1]?.votes || 0);
  const topOnePct = normalizedTotal > 0 ? Math.round((topOneVotes / normalizedTotal) * 100) : 0;
  const topTwoPct = normalizedTotal > 0 ? Math.round((topTwoVotes / normalizedTotal) * 100) : 0;
  const showThird = sorted.length > 2 && topTwoPct < 50;
  const shownOptions = sorted.slice(0, showThird ? 3 : Math.min(sorted.length, 2));
  const leadingOption = shownOptions[0]?.text || decision || 'No decision yet';

  const optionLabel = (opt) => (opt ? `${opt.text} (${opt.votes})` : null);
  const consensusArguments = [];

  if (topOnePct >= 90) {
    consensusArguments.push(`Most participants are overwhelmingly leaning toward ${leadingOption}, so the other option(s) should be treated as secondary or complementary.`);
  } else if (topOnePct >= 75) {
    consensusArguments.push(`Most participants are leaning toward ${leadingOption}, but the runner-up remains relevant.`);
  } else {
    consensusArguments.push(`The group is still somewhat split, with ${leadingOption} only modestly ahead.`);
  }

  if (shownOptions.length >= 2) {
    consensusArguments.push(`The leading options are ${optionLabel(shownOptions[0])} and ${optionLabel(shownOptions[1])}.`);
  }

  if (shownOptions.length === 3) {
    consensusArguments.push(`A third option remains relevant, which is why the summary includes the top three.`);
  }

  if (topTwoPct >= 50) {
    consensusArguments.push(`Together, the top two options account for ${topTwoPct}% of the votes, which suggests they may be feasible as a combined or staged approach if they do not directly conflict.`);
  } else {
    consensusArguments.push(`The top two options account for only ${topTwoPct}% of the votes together, so the topic remains broadly open and the third option is still worth considering.`);
  }

  const summary = consensusArguments.join(' ');

  return {
    topic,
    question,
    decision: leadingOption,
    poll_type: pollType,
    total_votes: totalVotes,
    total_members: totalMembers,
    options: shownOptions,
    all_options: Array.isArray(allOptions) ? allOptions : [],
    winner_percentage: topOnePct,
    top_combined_percentage: topTwoPct,
    summary,
    consensus_arguments: consensusArguments
  };
}

export function getConvergenceSummaryData(round = 1) {
  const groupRooms = db.prepare(`SELECT id, name, topic_memory_json FROM rooms WHERE room_type = 'group' AND decision_round = ?`).all(round);
  
  const decisions = db.prepare('SELECT room_id, decision_text FROM room_decisions WHERE decision_round = ?').all(round);
  const generalResults = groupRooms.map(r => {
    const d = decisions.find(dec => dec.room_id === r.id);
    return { roomName: r.name, decision: d ? d.decision_text : 'No decision' };
  });

  const topicsMap = {};
  for (const room of groupRooms) {
    let memory = [];
    try { memory = JSON.parse(room.topic_memory_json || '[]'); } catch (e) {}
    for (const entry of memory) {
      if (!topicsMap[entry.key]) {
        topicsMap[entry.key] = {
           question: entry.question,
           resolutions: [],
           is_general_question: entry.is_general_question
        };
      }
      // Use the actual DECISION reached (not the topic key stored in `suggestion`).
      const decisionText = entry.decision || entry.summary || null;
      if (entry.status === 'resolved' && decisionText) {
         topicsMap[entry.key].resolutions.push({
           roomId: room.id,
           roomName: room.name,
           decision: String(decisionText).trim()
         });
      }
    }
  }

  const summary = [];
  for (const [key, data] of Object.entries(topicsMap)) {
    if (data.is_general_question) continue; // Skip general question from the topics list
    if (data.resolutions.length === 0) continue; // No room resolved this topic; nothing to summarize

    // Collapse to the distinct decisions actually chosen (case-insensitive), keeping first-seen casing.
    const seen = new Map();
    for (const r of data.resolutions) {
      const norm = r.decision.toLowerCase();
      if (!seen.has(norm)) seen.set(norm, r.decision);
    }
    const uniqueDecisions = [...seen.values()];

    if (uniqueDecisions.length === 1) {
       // Either a single room discussed it, or every room that discussed it agreed:
       // show the solution with an exclamation mark so users can reopen it.
       summary.push({
         key: key,
         question: data.question,
         status: 'agreed',
         solution: uniqueDecisions[0]
       });
    } else {
       // More than one room discussed it and they disagreed: still open between the
       // conflicting options, no approve/disapprove ticks.
       summary.push({
         key: key,
         question: data.question,
         status: 'disagreed',
         options: uniqueDecisions
       });
    }
  }
  return { generalResults, topics: summary };
}

export function getConvergenceRecapData(round = 2) {
const room = db
    .prepare(`
      SELECT DISTINCT r.id, r.topic_memory_json
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE r.room_type = 'convergence'
        AND r.decision_round = ?
        AND u.is_admin = 0
      LIMIT 1
    `)
    .get(round);
  if (!room) return [];
  try {
    const memory = JSON.parse(room.topic_memory_json || '[]');
    return memory.map((entry) => ({
      topic: entry.key,
      question: entry.question || entry.key,
      decision: entry.decision || entry.summary || 'No decision'
    }));
  } catch (err) {
    console.error('Error parsing topic memory for recap:', err);
    return [];
  }
}

export async function getDetailedConvergenceRecap(round = 2) {
  const room = db
    .prepare(`
      SELECT DISTINCT r.id, r.topic_memory_json
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE r.room_type = 'convergence'
        AND r.decision_round = ?
        AND u.is_admin = 0
      LIMIT 1
    `)
    .get(round);
  if (!room) return [];

  try {
    const memory = JSON.parse(room.topic_memory_json || '[]');
    const totalMembers = db
      .prepare('SELECT COUNT(*) AS c FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0')
      .get(room.id)?.c || 0;

    const result = [];

    for (const entry of memory) {
      const topic = entry.key || '';
      const question = entry.question || entry.key;
      const decision = entry.decision || entry.summary || 'No decision';
      const pollId = entry.poll_id;
      const pollType = entry.poll_type || 'plurality';

      if (!pollId) {
        result.push({
          topic,
          question,
          decision,
          poll_type: null,
          total_votes: 0,
          options: [],
          winner_percentage: 0,
          compatibility: null
        });
        continue;
      }

      const poll = db.prepare('SELECT id, suggestion, question, poll_type, is_closed FROM polls WHERE id = ?').get(pollId);
      if (!poll) {
        result.push({
          topic,
          question,
          decision,
          poll_type: pollType,
          total_votes: 0,
          options: [],
          winner_percentage: 0,
          compatibility: null
        });
        continue;
      }

      const actualType = poll.poll_type || pollType;
      const optionsWithVotes = db.prepare(
        `SELECT po.option_text, COUNT(pv.user_id) AS votes
         FROM poll_options po
         LEFT JOIN poll_votes pv ON pv.option_id = po.id
         WHERE po.poll_id = ?
         GROUP BY po.id
         ORDER BY votes DESC, po.id ASC`
      ).all(pollId);

      const totalVotes = db.prepare(
        `SELECT COUNT(DISTINCT user_id) AS c FROM poll_votes WHERE poll_id = ? AND user_id NOT IN (SELECT id FROM users WHERE is_admin = 1)`
      ).get(pollId)?.c || 0;

      const sorted = replaceOtherInRows(optionsWithVotes, pollId).map((opt) => ({ ...opt }));
      if (actualType === 'ranking') {
        const maxRank = sorted.length > 0 ? sorted.reduce((max, o) => Math.max(max, o.votes), 0) : 0;
        for (const o of sorted) {
          o.votes = maxRank - o.votes + 1;
        }
        sorted.sort((a, b) => b.votes - a.votes || a.option_text.localeCompare(b.option_text));
      }

      const topTwoVotes = sorted.slice(0, 2).reduce((sum, opt) => sum + (opt?.votes || 0), 0);
      const topCombinedPercentage = totalMembers > 0 ? Math.round((topTwoVotes / totalMembers) * 100) : 0;
      const includeTopThree = sorted.length > 2 && topCombinedPercentage < 50;
      const shownOptions = sorted.slice(0, includeTopThree ? 3 : Math.max(2, Math.min(sorted.length, 2)));

      let compatibility = null;
      if (shownOptions[1] && client && shownOptions[0]?.option_text && shownOptions[1]?.option_text && shownOptions[0].option_text.toLowerCase() !== shownOptions[1].option_text.toLowerCase()) {
        try {
          const response = await client.chat.completions.create({
            model: env.cheapModel,
            temperature: 0.1,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: `You analyze two options from a group decision to determine if they are opposing/conflicting or can both be implemented together.

Option A (leading option): "{{A}}"
Option B (runner-up): "{{B}}"

Return strict JSON with these keys: {"assessment": "compatible" | "opposing" | "partial", "explanation": "Brief 1-sentence explanation."}

Rules:
1. "compatible" means both can be implemented together without conflict, or they are complementary.
2. "opposing" means they are mutually exclusive or directly conflict.
3. "partial" means they can partially overlap but have notable tension.
4. Be honest and direct.`
              }
            ]
          });
          const parsed = JSON.parse(response.choices?.[0]?.message?.content || '{}');
          compatibility = {
            assessment: parsed.assessment || 'partial',
            explanation: parsed.explanation || ''
          };
        } catch (err) {
          console.error('Error assessing compatibility:', err.message);
        }
      }
      const compatibilitySummary = compatibility
        ? (compatibility.assessment === 'compatible'
          ? `These leading options appear compatible and could likely be implemented together.`
          : compatibility.assessment === 'partial'
            ? `These leading options overlap in part, but there is some tension between them.`
            : `These leading options appear to be in conflict and likely represent an either/or trade-off.`)
        : null;

      const recap = buildDecisionRecapEntry({
        topic,
        question,
        decision,
        pollType: actualType,
        totalVotes,
        totalMembers,
        options: shownOptions.map((o) => ({ text: o.option_text, votes: o.votes })),
        allOptions: sorted.map((o) => ({ text: o.option_text, votes: o.votes })),
      });

      result.push({
        ...recap,
        compatibility
      });
    }

    return result;
  } catch (err) {
    console.error('Error building detailed recap:', err);
    return [];
  }
}

export async function forceCreatePollForRoom(roomId, reason = 'Users requested a vote.') {
  const parsedRoomId = Number(roomId);
  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
  const room = db.prepare("SELECT id FROM rooms WHERE id = ? AND room_type IN ('group', 'convergence') AND is_active = 1").get(parsedRoomId);
  if (!room || !state?.global_question || state.current_phase !== 'discussing') {
    return { ok: false, message: 'No active discussion room is available for voting.' };
  }
  if (isConvergenceReviewLocked(parsedRoomId)) {
    return { ok: false, message: 'Please review the summary first — voting opens once the review window ends.' };
  }
  const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(parsedRoomId);
  // The message pipeline runs the readiness check before it handles an
  // explicit "can we vote?" request. If that check opened the poll first,
  // the request has already succeeded and must not produce a false error.
  if (openPoll) return { ok: true, pollId: openPoll.id, existing: true };
  const transcript = getTranscript(parsedRoomId, 20);
  const readiness = await evaluateReadyToVote(parsedRoomId, state.global_question, state.decision_context || '', transcript);
  const unresolved = getUnresolvedRoomMemoryTopics(parsedRoomId);
  const activeTopicObj = unresolved[0];
  const roomRow = db.prepare('SELECT topic_memory_json FROM rooms WHERE id = ?').get(parsedRoomId);
  let memoryChainStage = 'none';

  if (activeTopicObj) {
    try {
      const mem = Array.isArray(roomRow?.topic_memory_json) ? roomRow.topic_memory_json : JSON.parse(roomRow?.topic_memory_json || '[]');
      const entry = mem.find(e => (e.key || e.suggestion || e.topic) === (activeTopicObj.suggestion || activeTopicObj.key));
      if (entry && entry.chain_stage && entry.chain_stage !== 'none') {
        memoryChainStage = entry.chain_stage;
      }
    } catch { }
  }

  let pollDrafts = [];
  if (readiness.ready_polls && readiness.ready_polls.length > 0) {
    pollDrafts = readiness.ready_polls;
  } else {
    if (!activeTopicObj) return { ok: false, message: 'No active topic to vote on.' };

    let opt = Array.isArray(activeTopicObj.options) ? [...activeTopicObj.options] : [];
    if (opt.length === 0) {
      opt.push(activeTopicObj.suggestion || activeTopicObj.key || 'Keep discussing');
    }
    if (!opt.some(o => typeof o === 'string' && o.toLowerCase() === 'keep discussing')) {
      opt.push('Keep discussing');
    }

    const priorPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) LIMIT 1')
      .get(parsedRoomId, activeTopicObj.suggestion || activeTopicObj.key, activeTopicObj.question || activeTopicObj.key);
    const pollType = priorPoll ? 'continuous' : 'swipe';

    pollDrafts = [{
      question: activeTopicObj.question || `Vote on: ${activeTopicObj.suggestion || activeTopicObj.key}`,
      options: opt,
      suggestion: activeTopicObj.suggestion || activeTopicObj.key,
      replaces_decided_option: null,
      poll_type: pollType
    }];
  }

  if (pendingPollTimeouts.has(parsedRoomId)) {
    clearTimeout(pendingPollTimeouts.get(parsedRoomId));
    pendingPollTimeouts.delete(parsedRoomId);
  }

  const createdPollIds = [];
  for (const draft of pollDrafts) {
    let pType = draft.poll_type || 'plurality';
    if (activeTopicObj) {
      const topicKey = activeTopicObj.suggestion || activeTopicObj.key;
      const hasPriorPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) LIMIT 1')
        .get(parsedRoomId, topicKey, activeTopicObj.question || topicKey);
      if (!activeTopicObj.is_general_question) pType = hasPriorPoll ? 'continuous' : 'swipe';
    }

    const replacesOption = draft.replaces_decided_option || null;
    const expiresAt = pType === 'continuous'
      ? new Date(Date.now() + getDecisionSettings().live_voting_duration_minutes * 60 * 1000).toISOString()
      : null;
    const pollId = createMandatoryPoll(
      parsedRoomId,
      draft.question || `Vote for final decision: ${state.global_question}`,
      draft.options,
      reason,
      draft.suggestion || null,
      replacesOption,
      true,
      pType,
      pType === 'continuous' ? 'continuous' : memoryChainStage,
      expiresAt
    );
    createdPollIds.push(pollId);
  }
  if (createdPollIds.length > 0) {
    const isGeneralQuestion = !!activeTopicObj?.is_general_question
      || activeTopicObj?.key === 'general-question'
      || activeTopicObj?.suggestion === 'general-question';
    createBotMessage(parsedRoomId, renderTemplate('agent3-templates.md#Mandatory Poll Created Message', {
      minutes: getEffectivePollTimerMinutes(parsedRoomId, isGeneralQuestion)
    }));
  }
  emitDecisionStatus(ioRef);
  return { ok: true, pollId: createdPollIds[0], options: normalizePollOptions(parsedRoomId, pollDrafts[0].options) };
}

export async function forceCreatePollFromDiscussion(reason = 'Admin requested a vote.', requestedRoomId = null) {
  const state = db.prepare('SELECT global_question, decision_context, general_description, current_phase FROM system_state WHERE id = 1').get();
  const room = requestedRoomId
    ? db.prepare("SELECT id, name FROM rooms WHERE id = ? AND room_type IN ('group', 'convergence') AND is_active = 1").get(Number(requestedRoomId))
    : db.prepare(
      `
      SELECT r.id, r.name, COUNT(CASE WHEN m.sender_id IS NOT NULL THEN 1 END) AS human_messages, MAX(m.id) AS latest_message_id
      FROM rooms r
      LEFT JOIN messages m ON m.room_id = r.id
      WHERE r.room_type IN ('group', 'convergence')
        AND r.is_active = 1
      GROUP BY r.id
      ORDER BY human_messages DESC, latest_message_id DESC, r.id ASC
      LIMIT 1
      `
    ).get();
  if (!room || !state?.global_question) return { ok: false, message: 'No active discussion room is available yet.' };
  const openPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(room.id);
  if (openPoll) return { ok: false, message: `There is already an open poll in ${room.name || `room ${room.id}`}.` };
  const transcript = getTranscript(room.id, 20);
  const humanMessages = transcript.filter((message) => message.sender_name !== 'Bot');
  const participants = new Set(humanMessages.map((message) => message.sender_name));
  if (humanMessages.length < 2 || participants.size < 2) {
    return { ok: false, message: `${room.name || `Room ${room.id}`} does not have enough participant discussion for a meaningful vote yet.` };
  }
  const readiness = await evaluateReadyToVote(room.id, state.global_question, state.decision_context || '', transcript);

  let pollDrafts = [];
  if (readiness.ready_polls && readiness.ready_polls.length > 0) {
    pollDrafts = readiness.ready_polls;
  } else {
    let singleDraft;
    if (readiness.options && readiness.options.length >= 2) {
      singleDraft = {
        question: readiness.question,
        options: readiness.options,
        suggestion: readiness.suggestion,
        replaces_decided_option: readiness.replaces_decided_option
      };
    } else {
      singleDraft = await inferPollOptions(room.id, state.global_question, state.decision_context || '', transcript, readiness.suggestion);
    }
    pollDrafts = [singleDraft];
  }

  const createdPollIds = [];
  for (const draft of pollDrafts) {
    const replacesOption = draft.replaces_decided_option || null;
    const pollId = createMandatoryPoll(
      room.id,
      draft.question || `Vote for final decision: ${state.global_question}`,
      draft.options,
      reason,
      draft.suggestion || null,
      replacesOption,
      true,
      draft.poll_type || 'plurality'
    );
    createdPollIds.push(pollId);
  }
  if (createdPollIds.length > 0) {
    const generalQuestion = getGeneralQuestionRow();
    const isGeneralQuestion = !!generalQuestion && (
      pollDrafts[0]?.suggestion === generalQuestion.topic
      || pollDrafts[0]?.question === generalQuestion.question_text
    );
    createBotMessage(room.id, renderTemplate('agent3-templates.md#Mandatory Poll Created Message', {
      minutes: getEffectivePollTimerMinutes(room.id, isGeneralQuestion)
    }));
  }
  emitDecisionStatus(ioRef);
  return { ok: true, pollId: createdPollIds[0], roomId: room.id, roomName: room.name, options: normalizePollOptions(room.id, pollDrafts[0].options) };
}

export function scheduleGroupNudge(roomId) {
  const room = db.prepare('SELECT room_type, is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.room_type !== 'group' || room.is_active !== 1 || room.collection_complete === 1) return;

  // The map entry is a lock: if a nudge is already scheduled OR its async callback is still
  // running, do not arm another. This is critical — the callback below makes a slow LLM call,
  // and without this guard the 5-second watchdog interval (and per-message re-arming) would
  // stack up dozens of concurrent nudges, flooding the room with near-identical messages.
  if (groupNudgeTimers.has(roomId)) return;

  const anchor = getGroupInactivityAnchor(roomId);
  if (!anchor) return;

  const delayMs = settingToNudgeDelayMs();
  const elapsedMs = Date.now() - new Date(anchor.timestamp).getTime();
  const retryDelayMs = Math.max(0, (groupNudgeLastAttemptAt.get(roomId) || 0) + delayMs - Date.now());
  const initialDelayMs = Math.max(retryDelayMs, delayMs - Math.max(0, elapsedMs));
  const run = async () => {
    try {
      const stillActive = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
      if (!stillActive || stillActive.is_active !== 1 || stillActive.collection_complete === 1) return;

      // Stay silent only during a SWIPE round: swipe is a quick approve/reject pass where a
      // facilitation nudge just gets in the way. During live (continuous) and ranking voting the
      // bot still facilitates per the Group proactivity cadence, and so does an open discussion
      // with no poll — those are longer phases where a nudge is useful.
      const openSwipePoll = db.prepare("SELECT id FROM polls WHERE room_id = ? AND is_closed = 0 AND poll_type = 'swipe'").get(roomId);
      if (openSwipePoll) return;

      // Use the latest human or substantive bot message. Poll lifecycle
      // messages are intentionally excluded from this anchor.
      const latestAnchor = getGroupInactivityAnchor(roomId);
      if (!latestAnchor) return;
      const silenceMs = Date.now() - new Date(latestAnchor.timestamp).getTime();
      if (silenceMs < delayMs) return;

      groupNudgeLastAttemptAt.set(roomId, Date.now());

      const unresolved = getUnresolvedRoomMemoryTopics(roomId);
      const activeTopicObj = unresolved[0];
      const activeTopic = activeTopicObj ? (activeTopicObj.suggestion || activeTopicObj.key) : 'the decision';
      const activeTopicOptions = activeTopicObj && activeTopicObj.options ? activeTopicObj.options.join(', ') : '';
      const minutes = Math.round(delayMs / 1000 / 60);

      const reply = await generateAgent1Reply({
        roomId,
        // Polls and chat run in parallel. A silent group still needs a
        // facilitator message while participants have a vote open.
        allowDuringPoll: true,
        triggerText: renderTemplate('agent1-templates.md#Group Quiet Trigger', {
          minutes,
          active_topic: activeTopic,
          active_topic_options: activeTopicOptions
        })
      });
      if (reply) {
        if (ioRef) ioRef.to(`room:${roomId}`).emit('receive_message', reply);
      }
    } catch (err) {
      console.error('Group nudge failed:', err.message);
    } finally {
      // Release the lock only once the whole operation (including the LLM call) is done. The
      // 5-second watchdog interval is the sole re-armer, so nudges never run concurrently.
      groupNudgeTimers.delete(roomId);
    }
  };

  // Use the remaining silence time from the latest meaningful message. Poll
  // lifecycle messages do not move this anchor, so a silent room receives its
  // first nudge X minutes after opening and another nudge every X minutes.
  const timer = setTimeout(run, initialDelayMs);
  groupNudgeTimers.set(roomId, timer);
}

async function sweepPersonalRoomsForProgress() {
  const activePersonalRooms = db
    .prepare(
      `
      SELECT DISTINCT r.id AS room_id
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      JOIN users u ON u.id = rm.user_id
      WHERE r.room_type = 'personal'
        AND COALESCE(r.collection_complete, 0) = 0
        AND u.is_admin = 0
        AND r.name = u.username || '-personal'
    `
    )
    .all();

  let completedAny = false;
  for (const row of activePersonalRooms) {
    const primaryUserId = getPrimaryPersonalUserId(row.room_id);
    if (!primaryUserId) continue;
    try {
      const completed = await checkPersonalRoom(row.room_id, primaryUserId);
      if (completed) completedAny = true;
    } catch (error) {
      console.error('[sweepPersonalRoomsForProgress] Failed for room', row.room_id, error);
    }
  }

  // Re-run the transition check on every sweep, not only on the sweep that
  // completed a room. If clustering or group initialization failed after all
  // personal rooms had already completed, the old condition caused a permanent
  // gathering-phase deadlock with no later retry.
  await maybeAdvanceToGroupPhase().catch((error) => {
    console.error('[sweepPersonalRoomsForProgress] maybeAdvanceToGroupPhase failed:', error);
  });
}

// Duration of the convergence summary review window, configurable by the admin
// ("Convergence summary timer", 1-10 minutes).
export function getConvergenceReviewWindowMs() {
  const minutes = getDecisionSettings().convergence_summary_minutes || 1;
  return minutes * 60 * 1000;
}

// When the review window elapses (or all participants agree), turn any reopened topics
// back into open votable topics, announce what still needs to be discussed, and unlock voting.
export function finalizeConvergenceReviewWindow(roomId) {
  const room = db
    .prepare("SELECT id, topic_memory_json, convergence_finalized FROM rooms WHERE id = ? AND room_type = 'convergence'")
    .get(roomId);
  if (!room || room.convergence_finalized === 1) return;

  let memory = [];
  try { memory = JSON.parse(room.topic_memory_json || '[]'); } catch (e) { memory = []; }

  const reopenedTopics = [];
  const openTopics = [];
  for (const entry of memory) {
    if (entry.is_general_question) continue;
    const status = String(entry.status || '').toLowerCase();
    if (entry.reopened === true && status === 'resolved') {
      // A participant reopened this agreed topic -> put it back up for a fresh vote.
      entry.status = 'open';
      entry.decision = null;
      delete entry.poll_id;
      reopenedTopics.push(entry.question || entry.key);
    } else if (status !== 'resolved') {
      openTopics.push(entry.question || entry.key);
    }
  }

  db.prepare('UPDATE rooms SET topic_memory_json = ?, convergence_finalized = 1 WHERE id = ?')
    .run(JSON.stringify(memory), roomId);

  const toDiscuss = [];
  for (const t of [...openTopics, ...reopenedTopics]) if (t && !toDiscuss.includes(t)) toDiscuss.push(t);

  let msg = 'The review time is over. ';
  if (toDiscuss.length > 0) {
    msg += `We now need to discuss and vote on the following ${toDiscuss.length === 1 ? 'point that was' : 'points that were'} not fully agreed across the previous rooms${reopenedTopics.length ? ' (including the ones you reopened)' : ''}:\n`;
    msg += toDiscuss.map((t) => `• ${t}`).join('\n');
    msg += `\n\nOnce these are settled, we will hold the final vote on the main question.`;
  } else {
    msg += 'Every sub-topic was agreed across the previous rooms, so we will go straight to the final vote on the main question.';
  }
  createBotMessage(roomId, msg);

  logAgentEvent(
    'agent3',
    'Convergence review window finalized',
    `Room ${roomId}: ${reopenedTopics.length} reopened, ${openTopics.length} already open.`
  );
  emitDecisionStatus(ioRef);
  if (ioRef) ioRef.to(`room:${roomId}`).emit('room_status_updated', { roomId });

  // After the announcement, wait the configured "Time before poll" and then open the first
  // poll automatically — the swipe on the first reopened/open topic, or (if everything was
  // already agreed) the final general-question vote. Without this the convergence room used to
  // rely on the old readiness scheduler and could sit doing nothing.
  const previousTimer = convergenceReviewTimers.get(roomId);
  if (previousTimer) clearTimeout(previousTimer);
  const reviewTimer = setTimeout(() => {
    convergenceReviewTimers.delete(roomId);
    const r = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
    if (!r || r.is_active !== 1 || r.collection_complete === 1) return;
    if (db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(roomId)) return;
    const nextNow = getUnresolvedRoomMemoryTopics(roomId)[0];
    if (!nextNow) return;
    createTopicPoll(roomId, nextNow);
  }, settingToTimeBeforePollMs());
  convergenceReviewTimers.set(roomId, reviewTimer);
}

function sweepConvergenceReviewWindows() {
  const rooms = db
    .prepare(
      `
      SELECT id, convergence_summary_at
      FROM rooms
      WHERE room_type = 'convergence'
        AND is_active = 1
        AND collection_complete = 0
        AND convergence_finalized = 0
        AND convergence_summary_at IS NOT NULL
    `
    )
    .all();
  for (const room of rooms) {
    const startedAt = new Date(room.convergence_summary_at).getTime();
    if (Number.isNaN(startedAt)) continue;
    if (Date.now() - startedAt < getConvergenceReviewWindowMs()) continue;
    try {
      finalizeConvergenceReviewWindow(room.id);
    } catch (error) {
      console.error('Failed to finalize convergence review window for room', room.id, error);
    }
  }
}

// Restart-safe recovery for the deterministic poll hand-off. The next poll after a topic
// resolution (and after a finalized convergence review) is normally opened by an in-memory
// "Time before poll" timer. If that timer is lost — a process restart, or any transient failure —
// the room would otherwise sit forever with unresolved topics and no open poll. This sweep re-opens
// the next poll purely from persisted state once the delay has elapsed, so nothing gets stuck.
export function recoverStuckTopicPolls() {
  const rooms = db.prepare(`
    SELECT id, room_type, convergence_finalized, convergence_summary_at
    FROM rooms
    WHERE room_type IN ('group', 'convergence') AND is_active = 1 AND collection_complete = 0
  `).all();
  const timeBeforePollMs = settingToTimeBeforePollMs();
  for (const room of rooms) {
    // A convergence room must have finished its interactive summary review first.
    if (room.room_type === 'convergence' && room.convergence_finalized !== 1) continue;
    if (isConvergenceReviewLocked(room.id)) continue;
    // Never interfere while a poll is already open.
    if (db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(room.id)) continue;
    const nextTopic = getUnresolvedRoomMemoryTopics(room.id)[0];
    if (!nextTopic) continue;
    const nextTopicKey = nextTopic.suggestion || nextTopic.key;
    const pendingContinuousReview = db.prepare(`
      SELECT id FROM polls
      WHERE room_id = ?
        AND poll_type = 'continuous'
        AND transitioned_to_poll_id IS NULL
        AND review_until IS NOT NULL
        AND (suggestion = ? OR question = ?)
      ORDER BY id DESC LIMIT 1
    `).get(room.id, nextTopicKey, nextTopic.question || nextTopicKey);
    if (pendingContinuousReview) continue;

    // Reference time after which the next poll is due to open.
    let referenceMs;
    if (room.room_type === 'convergence' && room.convergence_summary_at) {
      // Finalization happens at summary_at + review window; the poll opens after that + delay.
      referenceMs = new Date(room.convergence_summary_at).getTime() + getConvergenceReviewWindowMs();
    } else {
      const lastClosed = db.prepare('SELECT closed_at, created_at FROM polls WHERE room_id = ? AND is_closed = 1 ORDER BY id DESC LIMIT 1').get(room.id);
      if (!lastClosed) continue; // No prior poll -> the initial group swipe path handles the first poll.
      referenceMs = new Date(lastClosed.closed_at || lastClosed.created_at).getTime();
    }
    if (Number.isNaN(referenceMs) || Date.now() < referenceMs + timeBeforePollMs) continue;

    try {
      createTopicPoll(room.id, nextTopic);
    } catch (error) {
      console.error('Failed to recover next topic poll for room', room.id, error);
    }
  }
}

export function initAgent3(io) {
  ioRef = io;
  setTimeout(() => {
    try {
      recoverStalledFinalPolls();
    } catch (error) {
      console.error('Failed to recover stalled final polls:', error);
    }
  }, 0);

  const openExpiringPolls = db
    .prepare('SELECT id, room_id, expires_at FROM polls WHERE is_closed = 0 AND expires_at IS NOT NULL')
    .all();
  for (const poll of openExpiringPolls) {
    schedulePollResolution(poll.id, poll.room_id, poll.expires_at);
  }

  setInterval(() => {
    const duePolls = db
      .prepare(
        'SELECT id, room_id FROM polls WHERE is_closed = 0 AND expires_at IS NOT NULL AND expires_at <= ?'
      )
      .all(nowIso());
    for (const poll of duePolls) resolvePoll(poll.id, poll.room_id).catch(() => { });
  }, 5000);

  // Reconcile continuous polls and their one-minute review windows after a
  // process restart. Timers are only an optimization; the persisted columns
  // remain the source of truth.
  setInterval(() => {
    const openContinuous = db.prepare("SELECT id, room_id FROM polls WHERE poll_type = 'continuous' AND is_closed = 0").all();
    for (const poll of openContinuous) resolvePoll(poll.id, poll.room_id).catch(() => { });
    const reviews = db.prepare("SELECT id, room_id, review_until FROM polls WHERE poll_type = 'continuous' AND is_closed = 1 AND review_until IS NOT NULL AND transitioned_to_poll_id IS NULL").all();
    for (const poll of reviews) {
      if (new Date(poll.review_until).getTime() <= Date.now()) {
        finalizeContinuousReview(poll.id, poll.room_id).catch(() => { });
      }
    }
  }, 5000);

  setInterval(() => {
    sweepRoomTimers().catch((error) => {
      console.error('Room timer sweep failed:', error);
    });
  }, 5000);

  setInterval(() => {
    try {
      sweepConvergenceReviewWindows();
    } catch (error) {
      console.error('Convergence review window sweep failed:', error);
    }
    try {
      recoverStuckTopicPolls();
    } catch (error) {
      console.error('Stuck topic poll recovery failed:', error);
    }
  }, 5000);

  setInterval(() => {
    const activeGroupRooms = db
      .prepare("SELECT id FROM rooms WHERE room_type IN ('group', 'convergence') AND is_active = 1")
      .all();
    for (const room of activeGroupRooms) maybeScheduleNextPoll(room.id);
  }, 15000);

  setInterval(() => {
    const activeGroupRooms = db
      .prepare("SELECT id FROM rooms WHERE room_type = 'group' AND is_active = 1 AND collection_complete = 0")
      .all();
    for (const room of activeGroupRooms) {
      if (!groupNudgeTimers.has(room.id)) scheduleGroupNudge(room.id);
    }
  }, 5000);

  setInterval(() => {
    sweepPersonalRoomsForProgress().catch((error) => {
      console.error('Personal room sweep failed:', error);
    });
  }, 5000);
}

const roomTimers = new Map();
const roomScheduledRunLimit = new Map();
const personalRoomProgressLocks = new Set();
const mandatoryPollCreationLocks = new Set();
const personalRoomReplyActions = new Map();

export function consumePersonalRoomReplyAction(roomId) {
  const action = personalRoomReplyActions.get(roomId) || null;
  personalRoomReplyActions.delete(roomId);
  return action;
}

export function triggerAgent3AfterMessage({ roomId, userId }) {
  const now = Date.now();

  let scheduledLimit = roomScheduledRunLimit.get(roomId);
  if (!scheduledLimit) {
    scheduledLimit = now + 15000;
    roomScheduledRunLimit.set(roomId, scheduledLimit);
  }

  const existing = roomTimers.get(roomId);
  if (existing) clearTimeout(existing);

  let delay = 2000;
  if (now + delay > scheduledLimit) {
    delay = Math.max(0, scheduledLimit - now);
  }

  const timer = setTimeout(async () => {
    roomTimers.delete(roomId);
    roomScheduledRunLimit.delete(roomId);
    await processAgent3AfterMessage({ roomId, userId }).catch(() => { });
  }, delay);

  roomTimers.set(roomId, timer);
}

const pendingRooms = new Set();

export async function processAgent3AfterMessage({ roomId, userId }) {
  if (!getWorkContext()?.isCurrent) {
    const work = createDecisionWorkContext({ workType: 'message-processing' });
    if (!work.isCurrent()) return { closedRoom: false };
    return runWithWorkContext(work, () => processAgent3AfterMessage({ roomId, userId }));
  }
  throwIfWorkCancelled();
  const room = db.prepare('SELECT is_active FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.is_active !== 1) {
    return { closedRoom: false };
  }

  if (processingRooms.has(roomId)) {
    pendingRooms.add(roomId);
    return { closedRoom: false };
  }

  processingRooms.add(roomId);
  let closedRoom = false;
  let voteCheck = null;
  try {
    while (true) {
      pendingRooms.delete(roomId);



      closedRoom = await checkPersonalRoom(roomId, userId);
      await maybeAdvanceToGroupPhase();
      const currentVoteCheck = await checkGroupRoomForPoll(roomId);
      if (currentVoteCheck) voteCheck = currentVoteCheck;
      scheduleGroupNudge(roomId);
      maybeScheduleNextPoll(roomId);

      if (!pendingRooms.has(roomId)) {
        break;
      }
    }
    return { closedRoom, ...(voteCheck || {}) };
  } finally {
    processingRooms.delete(roomId);
  }
}

export async function maybeResolvePollEarlyForVote(pollId, roomId) {
  const openPoll = db
    .prepare('SELECT id FROM polls WHERE id = ? AND room_id = ? AND is_closed = 0')
    .get(pollId, roomId);
  if (!openPoll) return;
  await resolvePoll(openPoll.id, roomId);
}

export async function forceShowdownForRoom(roomId) {
  const state = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get();

  // 1. Resolve any active open poll in this room first
  const openPolls = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').all(roomId);
  for (const op of openPolls) {
    await resolvePoll(op.id, roomId);
  }

  // 2. Find all unresolved topics in the room memory (excluding the general-question)
  const unresolved = getUnresolvedRoomMemoryTopics(roomId);
  const nonGeneralUnresolved = unresolved.filter(topic => {
    const isGen = topic.is_general_question ||
      topic.key === 'general-question' ||
      topic.topic === 'general-question' ||
      topic.suggestion === 'general-question';
    return !isGen;
  });

  if (nonGeneralUnresolved.length > 0) {
    // Create a ranking poll for the FIRST unresolved topic
    const topic = nonGeneralUnresolved[0];
    const topicKey = topic.suggestion || topic.key;
    const lastPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) ORDER BY id DESC LIMIT 1').get(roomId, topicKey, topic.question);
    
    let validOptions = [];
    if (lastPoll) {
      const options = db.prepare('SELECT option_text FROM poll_options WHERE poll_id = ?').all(lastPoll.id).map(o => o.option_text);
      validOptions = options.filter(o => o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
    }

    if (validOptions.length < 2 && topic.options) {
      validOptions = topic.options.filter(o => typeof o === 'string' && o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
    }

    if (validOptions.length < 2) {
      const questionRow = db.prepare('SELECT question_text, predefined_answers_json FROM gathering_questions WHERE topic = ?').get(topic.key);
      if (questionRow) {
        try {
          const parsed = JSON.parse(questionRow.predefined_answers_json);
          if (Array.isArray(parsed)) {
            validOptions = parsed.filter(o => typeof o === 'string' && o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
          }
        } catch (e) { }
      }
    }

    if (validOptions.length < 2) {
      validOptions = ['Yes', 'No', 'Abstain'];
    }

    createMandatoryPoll(roomId, topic.question || `Do you agree to resolve: ${topicKey}?`, validOptions, 'Showdown initiated by Admin.', topicKey, null, false, 'ranking');
    createBotMessage(roomId, `Admin initiated a Showdown for topic: ${topicKey || topic.question}. Please rank the options.`);
  } else {
    // Immediately create the final plurality poll on general-question
    const generalQuestionRow = getGeneralQuestionRow();
    const questionText = generalQuestionRow?.question_text || state?.global_question || 'Do you agree on the final question?';
    const topicName = generalQuestionRow?.topic || 'general-question';

    const finalPollExists = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND is_closed = 0').get(roomId, topicName, questionText)?.c > 0;
    if (!finalPollExists) {
      createMandatoryPoll(roomId, questionText, ['Yes', 'No', 'Abstained'], 'Showdown final poll initiated by Admin.', topicName, null, false, 'plurality');
      createBotMessage(roomId, `All previous topics have been resolved. Now it is time to vote on the final question:\n\n**${questionText}**`);
    }
  }
}

export async function forceShowdown() {
  const activeRooms = db.prepare("SELECT id, room_type FROM rooms WHERE is_active = 1 AND room_type IN ('group', 'convergence')").all();
  const state = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get();

  for (const { id: roomId } of activeRooms) {
    // 1. Resolve any active open poll first
    const openPolls = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').all(roomId);
    for (const op of openPolls) {
      await resolvePoll(op.id, roomId);
    }

    // 2. Find all unresolved topics in the room memory (excluding the general-question)
    const unresolved = getUnresolvedRoomMemoryTopics(roomId);
    const nonGeneralUnresolved = unresolved.filter(topic => {
      const isGen = topic.is_general_question ||
        topic.key === 'general-question' ||
        topic.topic === 'general-question' ||
        topic.suggestion === 'general-question';
      return !isGen;
    });

    if (nonGeneralUnresolved.length > 0) {
      // Create a ranking poll for each unresolved topic
      for (const topic of nonGeneralUnresolved) {
        const topicKey = topic.suggestion || topic.key;
        const lastPoll = db.prepare('SELECT id FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) ORDER BY id DESC LIMIT 1').get(roomId, topicKey, topic.question);
        
        let validOptions = [];
        if (lastPoll) {
          const options = db.prepare('SELECT option_text FROM poll_options WHERE poll_id = ?').all(lastPoll.id).map(o => o.option_text);
          validOptions = options.filter(o => o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
        }

        if (validOptions.length < 2 && topic.options) {
          validOptions = topic.options.filter(o => typeof o === 'string' && o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
        }

        if (validOptions.length < 2) {
          const questionRow = db.prepare('SELECT question_text, predefined_answers_json FROM gathering_questions WHERE topic = ?').get(topic.key);
          if (questionRow) {
            try {
              const parsed = JSON.parse(questionRow.predefined_answers_json);
              if (Array.isArray(parsed)) {
                validOptions = parsed.filter(o => typeof o === 'string' && o.toLowerCase() !== 'other' && o.toLowerCase() !== 'keep discussing');
              }
            } catch (e) { }
          }
        }

        if (validOptions.length < 2) {
          validOptions = ['Yes', 'No', 'Abstain'];
        }

        createMandatoryPoll(roomId, topic.question || `Do you agree to resolve: ${topicKey}?`, validOptions, 'Showdown initiated by Admin.', topicKey, null, false, 'ranking');
        createBotMessage(roomId, `Admin initiated a Showdown for topic: ${topicKey || topic.question}. Please rank the options.`);
      }
    } else {
      // Immediately create the final plurality poll on general-question
      const generalQuestionRow = getGeneralQuestionRow();
      const questionText = generalQuestionRow?.question_text || state?.global_question || 'Do you agree on the final question?';
      const topicName = generalQuestionRow?.topic || 'general-question';

      const finalPollExists = db.prepare('SELECT COUNT(*) as c FROM polls WHERE room_id = ? AND (suggestion = ? OR question = ?) AND is_closed = 0').get(roomId, topicName, questionText)?.c > 0;
      if (!finalPollExists) {
        createMandatoryPoll(roomId, questionText, ['Yes', 'No', 'Abstained'], 'Showdown final poll initiated by Admin.', topicName, null, false, 'plurality');
        createBotMessage(roomId, `All previous topics have been resolved. Now it is time to vote on the final question:\n\n**${questionText}**`);
      }
    }
  }
}

export async function handleTieProCon(roomId, tiedOptions) {
  if (!client) return;
  try {
    const state = db.prepare('SELECT decision_context, general_description FROM system_state WHERE id = 1').get();
    const decision_context = state?.decision_context || '';
    const general_description = state?.general_description || '';

    const systemPrompt = renderTemplate('agent3-templates.md#Tie Pro Con System');
    const userPrompt = renderTemplate('agent3-templates.md#Tie Pro Con User', {
      tied_options: tiedOptions.map(opt => `- "${opt}"`).join('\n'),
      general_description,
      decision_context
    });

    const response = await client.chat.completions.create({
      model: getConfiguredModels().primaryModel,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      metadata: { roomId, caller: 'agent3-handleTieProCon' }
    });

    const content = response.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.message === 'string' && parsed.message.trim() !== '') {
      const messageText = parsed.message.trim();
      const lowerMsg = messageText.toLowerCase();
      if (
        !lowerMsg.includes('does not mention') &&
        !lowerMsg.includes('no specific arguments') &&
        !lowerMsg.includes('not mentioned') &&
        !lowerMsg.includes('is not mentioned') &&
        !lowerMsg.includes('no information') &&
        !lowerMsg.includes('not discuss')
      ) {
        createBotMessage(roomId, messageText);
      }
    }
  } catch (err) {
    console.error('Failed to generate tie pro-con message:', err);
  }
}

export function cancelDecisionWork() {
  invalidateDecisionWork();
  // 1. Clear all active timeouts/timers
  for (const timer of pollTimers.values()) clearTimeout(timer);
  pollTimers.clear();

  for (const timer of pendingPollTimeouts.values()) clearTimeout(timer);
  pendingPollTimeouts.clear();

  for (const timer of groupNudgeTimers.values()) clearTimeout(timer);
  groupNudgeTimers.clear();
  groupNudgeLastAttemptAt.clear();
  for (const timer of convergenceReviewTimers.values()) clearTimeout(timer);
  convergenceReviewTimers.clear();
  for (const timer of roomTimers.values()) clearTimeout(timer);
  roomTimers.clear();
  roomScheduledRunLimit.clear();
  personalRoomReplyActions.clear();

  processingRooms.clear();
  pendingRooms.clear();
}

export function interruptDecisionProcess(isCompletion = false) {
  cancelDecisionWork();
  const stoppedRunId = db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id;

  // 2. Close all open polls in the database
  db.prepare('UPDATE polls SET is_closed = 1, closed_at = ? WHERE is_closed = 0').run(nowIso());

  // 3. Deactivate all rooms
  db.prepare('UPDATE rooms SET is_active = 0').run();

  // 4. Deactivate the simulation if active
  import('./simulationService.js')
    .then(({ stopSimulation }) => {
      if (db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id === stoppedRunId) {
        stopSimulation(false);
      }
    })
    .catch((err) => {
      console.error('Failed to import and stop simulation:', err);
    });

  if (isCompletion) {
    // 5. Set system state to completed
    db.prepare("UPDATE system_state SET current_phase = 'completed', showdown_initiated = 0 WHERE id = 1").run();

    // 5. Emit updates
    if (ioRef) {
      emitDecisionStatus(ioRef);
      const rooms = db.prepare('SELECT id FROM rooms').all();
      for (const r of rooms) {
        emitRoomUpdated(r.id, false);
      }
    }
    logAgentEvent('system', 'Process completed', 'All timers cleared, polls closed, and rooms deactivated.');
  } else {
    // 4. Set system state to idle/interrupted
    db.prepare("UPDATE system_state SET current_phase = 'idle', showdown_initiated = 0 WHERE id = 1").run();

    // 5. Emit updates
    if (ioRef) {
      emitDecisionStatus(ioRef);
      ioRef.emit('process_interrupted');
      const rooms = db.prepare('SELECT id FROM rooms').all();
      for (const r of rooms) {
        emitRoomUpdated(r.id, false);
      }
    }
    logAgentEvent('system', 'Process interrupted by Admin', 'All timers cleared, polls closed, and rooms deactivated.');
  }
}

function formatRecapMetricLabel(pollType) {
  if (pollType === 'ranking') return 'score';
  if (pollType === 'swipe') return 'approvals';
  return 'votes';
}

function buildDeterministicRoomReport({ room, state, topicData }) {
  const regularTopics = topicData.filter((t) => !t.is_general_question);
  const generalTopics = topicData.filter((t) => t.is_general_question);
  const reportLines = [
    `# Group Results — ${room.name}`,
    '',
    `**Global Question:** ${state?.global_question || 'N/A'}`,
    ''
  ];

  if (regularTopics.length > 0) {
    reportLines.push('## Topic Decisions', '');
    for (const topic of regularTopics) {
      const metric = formatRecapMetricLabel(topic.poll_type);
      reportLines.push(`### ${topic.question || topic.topic}`);
      reportLines.push(`**Decision:** ${topic.decision || 'No decision recorded yet.'}`);
      reportLines.push(`**Poll type:** ${topic.poll_type}`);
      reportLines.push(`**Participation:** ${topic.total_votes}/${topic.total_members} members voted`);
      reportLines.push('');
      reportLines.push('**Top results:**');
      for (const option of topic.options || []) {
        reportLines.push(`- ${option.text}: ${option.scoreOrVotes} ${metric} (${option.percentage}%)`);
      }
      reportLines.push('');
    }
  } else {
    reportLines.push('## Topic Decisions', '');
    reportLines.push('No topic-level decisions were recorded for this room yet.', '');
  }

  if (generalTopics.length > 0) {
    reportLines.push('## Final General Vote', '');
    for (const topic of generalTopics) {
      const metric = formatRecapMetricLabel(topic.poll_type);
      reportLines.push(`### ${topic.question || state?.global_question || 'General question'}`);
      reportLines.push(`**Decision:** ${topic.decision || 'No final decision recorded yet.'}`);
      reportLines.push(`**Participation:** ${topic.total_votes}/${topic.total_members} members voted`);
      reportLines.push('');
      reportLines.push('**Results:**');
      for (const option of topic.options || []) {
        reportLines.push(`- ${option.text}: ${option.scoreOrVotes} ${metric} (${option.percentage}%)`);
      }
      reportLines.push('');
    }
  }

  return reportLines.join('\n').trim();
}

// Aggregate the discussion-group vote data for a topic that was decided in the groups (and so has
// no convergence poll). Used to include pre-agreed topics in the Final Analysis Report.
function aggregateGroupTopicVotes(topicKey, round) {
  const normalized = String(topicKey || '').trim().toLowerCase();
  const groupRooms = db.prepare("SELECT id FROM rooms WHERE room_type = 'group' AND decision_round = ?").all(round);
  const totals = {};
  let totalVoters = 0;
  let pollType = 'plurality';
  for (const gr of groupRooms) {
    const poll = db
      .prepare("SELECT id, poll_type FROM polls WHERE room_id = ? AND LOWER(suggestion) = ? AND is_closed = 1 AND is_reopened = 0 ORDER BY id DESC LIMIT 1")
      .get(gr.id, normalized);
    if (!poll) continue;
    pollType = poll.poll_type;
    let rows;
    let voters;
    if (poll.poll_type === 'swipe') {
      rows = db.prepare(`SELECT po.option_text, COUNT(DISTINCT sv.user_id) v FROM poll_options po LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right' LEFT JOIN users u ON u.id = sv.user_id AND u.is_admin = 0 WHERE po.poll_id = ? GROUP BY po.id`).all(poll.id);
      voters = db.prepare("SELECT COUNT(DISTINCT sv.user_id) c FROM swipe_votes sv JOIN users u ON u.id = sv.user_id WHERE sv.poll_id = ? AND u.is_admin = 0").get(poll.id)?.c || 0;
    } else if (poll.poll_type === 'ranking') {
      rows = db.prepare(`SELECT po.option_text, COUNT(CASE WHEN pv.rank = 1 THEN 1 END) v FROM poll_options po LEFT JOIN poll_votes pv ON pv.option_id = po.id LEFT JOIN users u ON u.id = pv.user_id AND u.is_admin = 0 WHERE po.poll_id = ? GROUP BY po.id`).all(poll.id);
      voters = db.prepare("SELECT COUNT(DISTINCT pv.user_id) c FROM poll_votes pv JOIN users u ON u.id = pv.user_id WHERE pv.poll_id = ? AND u.is_admin = 0").get(poll.id)?.c || 0;
    } else {
      rows = db.prepare(`SELECT po.option_text, COUNT(pv.user_id) v FROM poll_options po LEFT JOIN poll_votes pv ON pv.option_id = po.id LEFT JOIN users u ON u.id = pv.user_id AND u.is_admin = 0 WHERE po.poll_id = ? GROUP BY po.id`).all(poll.id);
      voters = db.prepare("SELECT COUNT(DISTINCT pv.user_id) c FROM poll_votes pv JOIN users u ON u.id = pv.user_id WHERE pv.poll_id = ? AND u.is_admin = 0").get(poll.id)?.c || 0;
    }
    totalVoters += voters;
    for (const r of replaceOtherInRows(rows, poll.id)) {
      const t = String(r.option_text || '').trim();
      const l = t.toLowerCase();
      if (!t || l === 'keep discussing' || l === 'other') continue;
      totals[t] = (totals[t] || 0) + (r.v || 0);
    }
  }
  const options = Object.entries(totals)
    .map(([option_text, votes]) => ({ option_text, votes }))
    .sort((a, b) => b.votes - a.votes);
  return { pollType, options, totalVoters };
}

// Preserve the provenance of a topic decision before the convergence room removes group
// memberships. Group room messages and votes remain available as the historical record.
function getDiscussionGroupTopicEvidence(topicKey, round) {
  const normalized = normalizeTopicKey(topicKey);
  const groupRooms = db
    .prepare("SELECT id, name, topic_memory_json FROM rooms WHERE room_type = 'group' AND decision_round = ? ORDER BY id ASC")
    .all(round);
  const discussedRooms = [];
  const decidedRooms = [];

  const participantCount = db.prepare(`
    SELECT COUNT(DISTINCT user_id) AS c
    FROM (
      SELECT m.sender_id AS user_id
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      WHERE m.room_id = ? AND u.is_admin = 0
      UNION
      SELECT pv.user_id AS user_id
      FROM poll_votes pv
      JOIN users u ON u.id = pv.user_id
      JOIN polls p ON p.id = pv.poll_id
      WHERE p.room_id = ? AND u.is_admin = 0
      UNION
      SELECT sv.user_id AS user_id
      FROM swipe_votes sv
      JOIN users u ON u.id = sv.user_id
      JOIN polls p ON p.id = sv.poll_id
      WHERE p.room_id = ? AND u.is_admin = 0
    )
    WHERE user_id IS NOT NULL
  `);

  for (const room of groupRooms) {
    let memory = [];
    try { memory = JSON.parse(room.topic_memory_json || '[]'); } catch { memory = []; }
    const entry = memory.find((item) => normalizeTopicKey(item.key || item.topic || item.question || item.suggestion) === normalized);
    if (!entry) continue;

    const group = {
      room_name: room.name,
      participant_count: participantCount.get(room.id, room.id, room.id)?.c || 0,
      decision: entry.decision || entry.summary || null
    };
    discussedRooms.push(group);
    if (String(entry.status || '').toLowerCase() === 'resolved' && group.decision) {
      decidedRooms.push(group);
    }
  }

  return {
    discussed_in_discussion_groups: discussedRooms.length > 0,
    decided_in_discussion_groups: decidedRooms.length > 0,
    discussed_room_count: discussedRooms.length,
    decided_room_count: decidedRooms.length,
    discussion_groups: discussedRooms,
    discussion_group_decisions: decidedRooms
  };
}

export function buildDecisionProvenance({ entry, isGeneralQuestion, pollId, groupEvidence, totalMembers, finalReviewAgreedCount = 0 }) {
  if (isGeneralQuestion) {
    return {
      code: 'final_global_vote',
      label: `The global question was voted on in the final room by ${totalMembers} participants.`
    };
  }

  if (groupEvidence.decided_in_discussion_groups && pollId) {
    return {
      code: entry.reopened === true
        ? 'discussion_groups_then_reopened_and_final_round_vote'
        : 'discussion_groups_then_final_round_vote',
      label: entry.reopened === true
        ? 'This topic was decided by a subset of participants in the discussion groups, then reopened and voted again by the full final-room group.'
        : 'This topic was discussed and decided in the discussion groups, then voted again by the full final-room group.'
    };
  }

  if (groupEvidence.decided_in_discussion_groups) {
    const fullyApproved = totalMembers > 0 && finalReviewAgreedCount >= totalMembers;
    return {
      code: fullyApproved
        ? 'discussion_groups_then_final_review_approval'
        : 'discussion_groups_then_final_review_carried_forward',
      label: fullyApproved
        ? 'This topic was decided by a subset of participants in the discussion groups, then approved by all participants during the final review without another topic vote.'
        : 'This topic was decided by a subset of participants in the discussion groups, then carried into the final room without another topic vote and was not reopened during the final review.'
    };
  }

  if (pollId) {
    return {
      code: 'final_round_topic_vote',
      label: groupEvidence.discussed_in_discussion_groups
        ? 'This topic was discussed in the discussion groups but no resolved group decision was recorded; it was then voted on in the final room by the full final-room group.'
        : 'This topic was discussed and voted on in the final room by the full final-room group.'
    };
  }

  return {
    code: 'no_recorded_topic_vote',
    label: 'No recorded topic vote or resolved discussion-group decision was found for this topic.'
  };
}

export async function generateRoomAnalysisReport(roomId) {
  const room = db.prepare('SELECT id, name, room_type, decision_round, topic_memory_json FROM rooms WHERE id = ?').get(roomId);
  if (!room) return null;

  const state = db.prepare('SELECT global_question, decision_context, general_description FROM system_state WHERE id = 1').get();

  const currentMemberCount = db
    .prepare('SELECT COUNT(*) AS c FROM room_members rm JOIN users u ON u.id = rm.user_id WHERE rm.room_id = ? AND u.is_admin = 0')
    .get(roomId)?.c || 0;
  const historicalParticipantCount = db
    .prepare(
      `
      SELECT COUNT(DISTINCT user_id) AS c
      FROM (
        SELECT m.sender_id AS user_id
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.room_id = ? AND u.is_admin = 0

        UNION

        SELECT pv.user_id AS user_id
        FROM poll_votes pv
        JOIN polls p ON p.id = pv.poll_id
        JOIN users u ON u.id = pv.user_id
        WHERE p.room_id = ? AND u.is_admin = 0

        UNION

        SELECT sv.user_id AS user_id
        FROM swipe_votes sv
        JOIN polls p ON p.id = sv.poll_id
        JOIN users u ON u.id = sv.user_id
        WHERE p.room_id = ? AND u.is_admin = 0
      )
      WHERE user_id IS NOT NULL
      `
    )
    .get(roomId, roomId, roomId)?.c || 0;
  const totalMembers = Math.max(currentMemberCount, historicalParticipantCount);
  const finalReviewAgreedCount = room.room_type === 'convergence'
    ? (db.prepare('SELECT COUNT(*) AS c FROM convergence_agreements WHERE room_id = ?').get(roomId)?.c || 0)
    : 0;

  let memory = [];
  try {
    memory = JSON.parse(room.topic_memory_json || '[]');
  } catch (err) {
    console.error('Error parsing memory for report:', err);
  }

  const topicDataForLLM = [];

  for (const entry of memory) {
    let topic = entry.key || '';
    const isGeneralQuestion = entry.key === 'general-question';
    if (isGeneralQuestion && state?.global_question) {
      topic = state.global_question;
    }
    const question = entry.question || entry.key;
    const decision = entry.decision || entry.summary || 'No decision';
    const pollId = entry.poll_id;
    const pollType = entry.poll_type || 'plurality';
    const previousRound = Math.max(1, (room.decision_round || 2) - 1);
    const groupEvidence = room.room_type === 'convergence' && !isGeneralQuestion
      ? getDiscussionGroupTopicEvidence(entry.key, previousRound)
      : {
          discussed_in_discussion_groups: false,
          decided_in_discussion_groups: false,
          discussed_room_count: 0,
          decided_room_count: 0,
          discussion_groups: [],
          discussion_group_decisions: []
        };
    const provenance = buildDecisionProvenance({
      entry,
      isGeneralQuestion,
      pollId,
      groupEvidence,
      totalMembers,
      finalReviewAgreedCount
    });

    if (!pollId) {
      // Topics resolved in the discussion groups and pre-agreed at the start of the convergence
      // round have no convergence poll. Include them in the Final Analysis Report using the
      // aggregated discussion-group vote data, so EVERY topic is reported.
      if (room.room_type === 'convergence' && String(entry.status || '').toLowerCase() === 'resolved' && (entry.decision || entry.summary)) {
        const agg = aggregateGroupTopicVotes(entry.key, previousRound);
        const sorted = agg.options;
        if (sorted.length > 0) {
          const denom = Math.max(1, agg.totalVoters || totalMembers);
          const top2 = sorted.slice(0, 2).reduce((s, o) => s + (o.votes || 0), 0);
          const includeTopThree = sorted.length > 2 && (top2 / denom) < 0.5;
          const shownOptions = sorted.slice(0, includeTopThree ? 3 : Math.max(2, Math.min(sorted.length, 2)));
          topicDataForLLM.push({
            topic,
            question,
            decision: entry.decision || entry.summary,
            poll_type: agg.pollType,
            is_general_question: isGeneralQuestion,
            decided_in_discussion_groups: true,
            decision_provenance_code: provenance.code,
            decision_provenance: provenance.label,
            discussion_group_evidence: groupEvidence,
            final_room_vote: null,
            total_votes: agg.totalVoters,
            total_members: denom,
            options: shownOptions.map((o) => ({ text: o.option_text, scoreOrVotes: o.votes, percentage: Math.round((o.votes / denom) * 100) })),
            all_options: sorted.map((o) => ({ text: o.option_text, scoreOrVotes: o.votes, percentage: Math.round((o.votes / denom) * 100) }))
          });
        } else {
          // No group vote data recoverable — still list the topic and its agreed decision.
          topicDataForLLM.push({
            topic,
            question,
            decision: entry.decision || entry.summary,
            poll_type: 'plurality',
            is_general_question: isGeneralQuestion,
            decided_in_discussion_groups: true,
            decision_provenance_code: provenance.code,
            decision_provenance: provenance.label,
            discussion_group_evidence: groupEvidence,
            final_room_vote: null,
            total_votes: 0,
            total_members: totalMembers,
            options: [],
            all_options: []
          });
        }
      }
      continue;
    }

    const poll = db.prepare('SELECT id, suggestion, question, poll_type FROM polls WHERE id = ?').get(pollId);
    if (!poll) continue;

    const actualType = poll.poll_type || pollType;

    const optionsWithVotes = actualType === 'swipe'
      ? db.prepare(
          `SELECT po.option_text, COUNT(sv.user_id) AS votes
           FROM poll_options po
           LEFT JOIN swipe_votes sv ON sv.option_id = po.id AND sv.swipe_direction = 'right'
           WHERE po.poll_id = ?
           GROUP BY po.id
           ORDER BY votes DESC, po.id ASC`
        ).all(pollId)
      : actualType === 'ranking'
      ? db.prepare(
          `WITH option_count AS (
             SELECT COUNT(*) AS n FROM poll_options WHERE poll_id = ?
           )
           SELECT po.option_text, COALESCE(SUM((SELECT n FROM option_count) - pv.rank + 1), 0) AS votes
           FROM poll_options po
           LEFT JOIN poll_votes pv ON pv.option_id = po.id
           WHERE po.poll_id = ?
           GROUP BY po.id
           ORDER BY votes DESC, po.id ASC`
        ).all(pollId, pollId)
      : db.prepare(
          `SELECT po.option_text, COUNT(pv.user_id) AS votes
           FROM poll_options po
           LEFT JOIN poll_votes pv ON pv.option_id = po.id
           WHERE po.poll_id = ?
           GROUP BY po.id
           ORDER BY votes DESC, po.id ASC`
        ).all(pollId);

    const totalVotes = actualType === 'swipe'
      ? (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM swipe_votes WHERE poll_id = ?').get(pollId)?.c || 0)
      : (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM poll_votes WHERE poll_id = ?').get(pollId)?.c || 0);

    const sorted = replaceOtherInRows(optionsWithVotes, pollId).map((opt) => ({ ...opt }));

    // Always report at least 2 options.
    // If the top 2 combined got less than 50% of the votes together, report the top 3 options.
    const scoreDenominator = actualType === 'ranking'
      ? Math.max(1, totalMembers * Math.max(sorted.length, 1))
      : Math.max(1, totalMembers);
    const top2Votes = sorted.slice(0, 2).reduce((sum, opt) => sum + (opt?.votes || 0), 0);
    const top2Percentage = totalMembers > 0 ? (top2Votes / scoreDenominator) : 0;
    const includeTopThree = sorted.length > 2 && top2Percentage < 0.5;
    const shownOptions = sorted.slice(0, includeTopThree ? 3 : Math.max(2, Math.min(sorted.length, 2)));

    topicDataForLLM.push({
      topic,
      question,
      decision,
      poll_type: actualType,
      is_general_question: isGeneralQuestion,
      decision_provenance_code: provenance.code,
      decision_provenance: provenance.label,
      discussion_group_evidence: groupEvidence,
      final_room_vote: {
        poll_id: pollId,
        participant_count: totalMembers,
        voter_count: totalVotes
      },
      total_votes: totalVotes,
      total_members: totalMembers,
      options: shownOptions.map((o) => {
        const pct = totalMembers > 0 ? Math.round((o.votes / scoreDenominator) * 100) : 0;
        return { text: o.option_text, scoreOrVotes: o.votes, percentage: pct };
      }),
      all_options: sorted.map((o) => {
        const pct = totalMembers > 0 ? Math.round((o.votes / scoreDenominator) * 100) : 0;
        return { text: o.option_text, scoreOrVotes: o.votes, percentage: pct };
      })
    });
  }

  if (topicDataForLLM.length === 0) {
    const defaultMsg = "No decisions have been recorded for this room yet.";
    db.prepare('UPDATE rooms SET recap_report = ? WHERE id = ?').run(defaultMsg, roomId);
    return defaultMsg;
  }

  if (room.room_type === 'group') {
    const report = buildDeterministicRoomReport({ room, state, topicData: topicDataForLLM });
    db.prepare('UPDATE rooms SET recap_report = ? WHERE id = ?').run(report, roomId);
    return report;
  }

  if (!client) {
    // Fallback static report generation if client is null
    let report = `# Discussion Summary - ${room.name}\n\n`;
    report += `**Global Question:** ${state?.global_question || 'N/A'}\n\n`;
    for (const t of topicDataForLLM) {
      report += `## Topic: ${t.topic}\n**Question:** ${t.question}\n**Decision:** ${t.decision}\n**Decision provenance:** ${t.decision_provenance || 'Not recorded'}\n\n`;
      report += `### Standings:\n`;
      for (const o of t.options) {
        report += `- ${o.text}: ${o.scoreOrVotes} votes/score (${o.percentage}%)\n`;
      }
      report += `\n`;
    }
    return report;
  }

  const isPreliminary = room.room_type === 'group';
  const prompt = `You are a professional analysis assistant. Your task is to write a ${isPreliminary ? 'brief, concise results summary for one discussion group' : 'comprehensive, written narrative analysis report of the ENTIRE collaborative decision-making process'}.
${isPreliminary ? 'This shows only the results for this single discussion group room. Keep it short, concise, and direct.' : 'The report must cover EVERY topic in the data — including topics that were decided earlier in the discussion groups (marked "decided_in_discussion_groups": true) and pre-agreed at the start of the final round, as well as any topics voted on in the final round. Use the explicit "decision_provenance" field as the source of truth: do not infer or blur whether a topic was carried forward from a subset discussion group or re-voted by the full final-room group. Describe with words whether participants really approved each outcome, analyze the level of consensus, and assess compatibility/co-implementation of the top options.'}

Decision Context:
- Global Question: ${state?.global_question || 'N/A'}
- Context Description: ${state?.decision_context || 'N/A'}

Recorded Decisions and Vote Data (every topic of the whole process):
${JSON.stringify(topicDataForLLM, null, 2)}

Instructions for Writing the Report:
${isPreliminary ? `1. Write a brief, concise results summary in Markdown format.
2. For each Topic in the data:
   - Present the topic, final decision, and top options with percentages.
   - Summarize the level of consensus in 1-2 sentences.
3. Keep the report short, direct, and concise.` : `1. Begin the report with exactly this title line and nothing before it: "# Final Analysis Report".
2. Do NOT mention the words "convergence", "Convergence Round", or any room name anywhere in the report. Refer to earlier stages neutrally as "the discussion groups" and the last stage as "the final round".
3. Write a cohesive, narrative report in Markdown format that covers ALL topics in the data (do not skip any), in the order given.
4. For each Topic in the data:
   - Present the topic and its final decision.
   - Explicitly report the exact "decision_provenance" in natural language. Distinguish between a topic decided by a subset in the discussion groups and merely approved during the final review, versus a topic discussed and voted again by the full final-room group.
   - List the top options (at least the top 2; if the top 2 got less than 50% combined, list the top 3 options). For each option, clearly report its votes/scores and percentage. Do NOT truncate option names.
   - Write a detailed analysis of the consensus reached. Explain if the participants really approve the outcome (e.g. if 90%+ support it, say they overwhelmingly lean towards it; if it is a narrow majority or a tie, explain that the group is split or has slight preference).
   - Assess compatibility of the top options. Describe in words if the top options are complementary/compatible and can be implemented together, or if they represent an either/or trade-off (conflict).
5. For the General Question / Global Proposal (the "is_general_question": true entry):
   - Analyze the voting results. Discuss if the users approve the outcome, the arguments for/against based on the consensus levels, and what this means for the global proposal. Use the actual question text as the section title instead of "General Question".
6. Keep the report formal, analytical, and well-written. Do NOT present simple raw tables or lists of winners, but instead a narrative essay-like report that integrates the vote data into the paragraphs.
7. Provide a summary section at the end detailing the overall health of the collaboration and key takeaways.`}`;

  try {
    const response = await client.chat.completions.create({
      model: env.cheapModel,
      messages: [{ role: 'user', content: prompt }],
      metadata: { roomId, caller: 'agent3-recap' }
    });
    const reportText = response.choices?.[0]?.message?.content || 'No report generated.';
    
    // Store in DB
    db.prepare('UPDATE rooms SET recap_report = ? WHERE id = ?').run(reportText, roomId);
    return reportText;
  } catch (err) {
    console.error('Error generating room analysis report:', err);
    return "Error generating analysis report: " + err.message;
  }
}
