import { env } from '../config/env.js';
import { db } from '../config/db.js';
import client from './llm.js';

// client imported from llm.js

export async function updateRoomStatus(roomId, io = null) {
  if (!client) return;

  const state = db.prepare('SELECT global_question FROM system_state WHERE id = 1').get();
  const globalQuestion = state?.global_question || 'A decision';

  const messages = db
    .prepare(
      `SELECT m.text, u.username AS sender_name
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = ?
       ORDER BY m.id DESC LIMIT 40`
    )
    .all(roomId)
    .reverse();

  if (!messages || messages.length === 0) return;

  const messagesText = messages.map((m) => `${m.sender_name || 'Bot'}: ${m.text}`).join('\n');

  const systemPrompt = `You are a group discussion tracker. Your job is to analyze the conversation and extract its current status.
The group is discussing: "${globalQuestion}".

Analyze the transcript and output a JSON object with the following fields:
- "status_text": A concise 1-sentence summary of what the group is currently doing (e.g., "Waiting for feedback on proposed consensus", "Discussing schedule", "Voting on a proposal").
- "agreed_points": An array of strings describing points the group has reached a general agreement on. Keep them brief.
- "discussion_points": An array of strings describing points that are actively being debated or still need resolution.

Respond strictly with valid JSON. Do not include markdown formatting like \`\`\`json.`;

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Transcript:\n\n${messagesText}` }
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
      metadata: { roomId, caller: 'room-status' }
    });

    const result = JSON.parse(completion.choices[0].message.content);
    
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
      result.status_text || 'Waiting for discussion',
      JSON.stringify(result.agreed_points || []),
      JSON.stringify(result.discussion_points || []),
      new Date().toISOString()
    );

    if (io) {
      io.to(`room_${roomId}`).emit('room_status_updated', { roomId });
    }

    return result;
  } catch (error) {
    console.error(`Failed to update room status for room ${roomId}:`, error);
  }
}
