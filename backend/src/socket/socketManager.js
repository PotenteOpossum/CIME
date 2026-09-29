import { db } from '../config/db.js';
import { env } from '../config/env.js';
import { verifySocketToken } from '../middleware/auth.js';
import { maybeGenerateBotReply, roomShouldAutoBot } from '../services/openaiService.js';
import { consumePersonalRoomReplyAction, processAgent3AfterMessage } from '../services/agent3Service.js';
import { getDecisionSettings, renderTemplate } from '../services/agentConfigService.js';

function nowIso() {
  return new Date().toISOString();
}

function canAccessRoom(userId, roomId) {
  return !!db
    .prepare('SELECT 1 FROM room_members WHERE user_id = ? AND room_id = ?')
    .get(userId, roomId);
}

function roomIsActive(roomId) {
  const room = db.prepare('SELECT is_active, collection_complete FROM rooms WHERE id = ?').get(roomId);
  return !!room && (room.is_active === 1 || room.collection_complete === 1);
}

export function attachSocketHandlers(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const user = verifySocketToken(token);
      socket.data.user = user;
      return next();
    } catch {
      return next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    let user = socket.data.user;
    const on = (event, handler) => socket.on(event, (payload) => {
      Promise.resolve().then(() => {
        try {
          user = verifySocketToken(socket.handshake.auth?.token);
        } catch {
          socket.emit('error_message', { error: 'Unauthorized' });
          socket.disconnect(true);
          return;
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          socket.emit('error_message', { error: 'Invalid event payload' });
          return;
        }
        return handler(payload);
      }).catch((error) => {
        console.error(`Socket ${event} failed:`, error.message);
        socket.emit('error_message', { error: 'Unable to process this event' });
      });
    });
    socket.join(`user:${user.id}`);

    on('join_room', ({ roomId }) => {
      const parsedRoomId = Number(roomId);
      if (!Number.isInteger(parsedRoomId)) return;

      if (!canAccessRoom(user.id, parsedRoomId)) {
        socket.emit('error_message', { error: 'Room access denied' });
        socket.emit('membership_revoked', { roomId: parsedRoomId });
        return;
      }
      if (!roomIsActive(parsedRoomId)) {
        socket.emit('error_message', { error: 'Room is closed by Quality Agent.' });
        return;
      }

      socket.join(`room:${parsedRoomId}`);
      socket.emit('joined_room', { roomId: parsedRoomId });
    });

    on('send_message', async ({ roomId, text }) => {
      const parsedRoomId = Number(roomId);
      if (!Number.isInteger(parsedRoomId) || typeof text !== 'string') return;

      const trimmed = text.trim();
      if (!trimmed) return;

      if (user.is_admin) {
        socket.emit('error_message', { error: 'Admins are ghost observers in user rooms and cannot send chat messages.' });
        return;
      }

      if (!canAccessRoom(user.id, parsedRoomId)) {
        socket.emit('error_message', { error: 'Room access denied' });
        socket.emit('membership_revoked', { roomId: parsedRoomId });
        return;
      }

      // Polls are a parallel interaction, not a chat lock. Participants must be able to
      // ask clarifying questions, explain their vote, and respond to the facilitator while
      // a mandatory poll is open; the vote endpoint independently validates poll expiry.
      const timestamp = new Date().toISOString();
      const insert = db
        .prepare(
          'INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, ?, ?, ?)'
        )
        .run(parsedRoomId, user.id, trimmed, timestamp);

      const payload = {
        id: insert.lastInsertRowid,
        room_id: parsedRoomId,
        sender_id: user.id,
        sender_name: user.username,
        text: trimmed,
        timestamp,
        is_bot: false
      };

      io.to(`room:${parsedRoomId}`).emit('receive_message', payload);
      const qualityResult = await processAgent3AfterMessage({ roomId: parsedRoomId, userId: user.id });
      if (qualityResult.closedRoom || !roomIsActive(parsedRoomId)) return;
      // Agent 3 may have already explained why a vote request cannot proceed
      // (for example, not enough distinct participants or a pending ranking
      // transition). Do not append the older generic readiness message.
      if (qualityResult.voteRequestHandled) return;
      const personalReplyAction = consumePersonalRoomReplyAction(parsedRoomId);

      const botHandle = env.botTriggerHandle.toLowerCase();
      const mentionTrigger = trimmed.toLowerCase().includes(botHandle);

      // A vote request is a natural-language ask addressed to the bot, e.g. "@bot can we vote?".
      // There is no slash command — chat should feel like a normal conversation. A request does
      // NOT force a poll: it is governed by the rate limit and Consensus sensitivity. The
      // readiness check opens the poll once enough participants agree.
      const isVoteRequestText = (t) => {
        if (!t || !t.toLowerCase().includes(botHandle)) return false;
        return /\b(can|could|shall|should|let(?:'s| us)|time to)\b[\s\S]*\b(vote|poll)\b/i.test(t)
          || /\b(vote|poll)\b[\s\S]*\b(now|ready|please|yet)\b/i.test(t)
          || /\b(?:we(?:'re| are)|everyone is|all(?: of us)? are|i(?:'m| am))\s+ready\s+(?:to\s+vote)?\b/i.test(t);
      };
      const userAskedToVote = isVoteRequestText(trimmed);

      if (userAskedToVote) {
        const settings = getDecisionSettings();
        const emitBot = (msgText) => {
          const ts = new Date().toISOString();
          const res = db
            .prepare('INSERT INTO messages (room_id, sender_id, text, timestamp) VALUES (?, NULL, ?, ?)')
            .run(parsedRoomId, msgText, ts);
          io.to(`room:${parsedRoomId}`).emit('receive_message', {
            id: Number(res.lastInsertRowid),
            room_id: parsedRoomId,
            sender_id: null,
            sender_name: 'Bot',
            text: msgText,
            timestamp: ts,
            is_bot: true
          });
        };

        // The readiness check already ran above and respects Consensus sensitivity. If it just
        // opened a poll (e.g. the threshold is low enough that this request alone was enough),
        // there is nothing more to do.
        const openNow = db.prepare('SELECT id FROM polls WHERE room_id = ? AND is_closed = 0').get(parsedRoomId);
        if (openNow) return;

        // Rate limit: cap how often a single user can request a vote.
        const limit = settings.user_poll_rate_limit !== undefined ? settings.user_poll_rate_limit : 11;
        if (limit === 0) {
          emitBot("Manual vote requests are turned off in this room. I'll open a poll automatically once the discussion is ready.");
          return;
        }
        if (limit <= 10) {
          const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
          const recentMessages = db.prepare('SELECT text FROM messages WHERE sender_id = ? AND room_id = ? AND timestamp >= ?')
            .all(user.id, parsedRoomId, fiveMinutesAgo);
          const voteRequestsCount = recentMessages.filter((m) => isVoteRequestText(m.text)).length;
          if (voteRequestsCount > limit) {
            emitBot(`You've asked to vote a few times already — let's give others a chance to weigh in before requesting again (limit: ${limit} per 5 minutes).`);
            return;
          }
        }

        // The readiness check is the source of truth for a new vote request.
        // Enough time has passed (or the minimum is Immediate). Don't force a poll: ask the group.
        // Once enough participants agree — they can simply say "yes", no @bot needed — the
        // readiness check opens the poll automatically according to Consensus sensitivity.
        emitBot(`${user.username} would like to move to a vote. Does everyone else feel ready to vote? If you agree, just say so and I'll open the poll.`);
        return;
      }

      const autoTrigger = roomShouldAutoBot(parsedRoomId);
      if (personalReplyAction?.suppressAutoReply) return;
      if (!mentionTrigger && !autoTrigger) return;

      const roomRecord = db.prepare('SELECT room_type, collection_complete FROM rooms WHERE id = ?').get(parsedRoomId);
      if (roomRecord?.room_type === 'personal' && roomRecord?.collection_complete !== 1) {
        // Agent 3 emits deterministic personal-room prompts; skipping Agent 1 here
        // prevents duplicate or stale follow-up questions after each user answer.
        // Once collection is complete the bot has invited the user to keep asking
        // questions while waiting, so Agent 1 must answer them (handled below).
        return;
      }

      try {
        const latestHumanMessage = db.prepare(
          'SELECT id FROM messages WHERE room_id = ? AND sender_id IS NOT NULL ORDER BY id DESC LIMIT 1'
        ).get(parsedRoomId);
        const latestBotMessage = db.prepare(
          'SELECT id FROM messages WHERE room_id = ? AND sender_id IS NULL ORDER BY id DESC LIMIT 1'
        ).get(parsedRoomId);
        if (latestHumanMessage && latestBotMessage && Number(latestBotMessage.id) > Number(latestHumanMessage.id)) {
          return;
        }

        const botReply = await maybeGenerateBotReply({
          roomId: parsedRoomId,
          // A direct @bot question is answered even while a poll is open; automatic 1:1 replies
          // stay silent during a poll so they don't distract from voting.
          allowDuringPoll: mentionTrigger,
          triggerText: mentionTrigger
            ? renderTemplate('agent1-templates.md#Socket Mention Trigger', { username: user.username, bot_handle: env.botTriggerHandle })
            : renderTemplate('agent1-templates.md#Socket Auto Trigger')
        });

        if (botReply) {
          io.to(`room:${parsedRoomId}`).emit('receive_message', botReply);
        }
      } catch (err) {
        socket.emit('error_message', { error: `Bot failed: ${err.message}` });
      }
    });
  });
}
