import { randomUUID } from 'node:crypto';
import { db } from '../config/db.js';
import { runWithWorkContext } from './workContext.js';

let generation = 0;
let groupingSeed = null;
export function getDecisionWorkVersion() { return generation; }
export function getGroupingSeed() { return groupingSeed; }

export function invalidateDecisionWork() {
  generation++;
}

export function beginDecisionRun({ participantIds = null, mode = 'human', seed = null } = {}) {
  invalidateDecisionWork();
  groupingSeed = mode === 'simulation' && Number.isInteger(seed) ? seed : null;
  const id = randomUUID();
  const scopedIds = Array.isArray(participantIds)
    ? [...new Set(participantIds.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value > 0))]
    : [];
  db.prepare(`
    UPDATE system_state
    SET decision_run_id = ?,
        decision_run_started_at = ?,
        decision_run_mode = ?,
        decision_run_participant_ids_json = ?
    WHERE id = 1
  `).run(id, new Date().toISOString(), mode === 'simulation' ? 'simulation' : 'human', JSON.stringify(scopedIds));
  return id;
}

export function createDecisionWorkContext({ roomId, workType = 'scheduled', allowCompleted = false } = {}) {
  const sessionId = db.prepare('SELECT decision_run_id FROM system_state WHERE id = 1').get()?.decision_run_id;
  const version = generation;
  return {
    sessionId,
    workType,
    isCurrent() {
      if (version !== generation) return false;
      const state = db.prepare('SELECT decision_run_id, current_phase FROM system_state WHERE id = 1').get();
      const allowedPhases = allowCompleted ? ['gathering', 'discussing', 'completed'] : ['gathering', 'discussing'];
      if (!state || state.decision_run_id !== sessionId || !allowedPhases.includes(state.current_phase)) return false;
      return roomId === undefined || db.prepare('SELECT is_active FROM rooms WHERE id = ?').get(roomId)?.is_active === 1;
    }
  };
}

function invoke(context, callback) {
  if (!context.isCurrent()) return;
  return runWithWorkContext(context, async () => {
    try {
      return await callback();
    } catch (error) {
      if (error.name !== 'AbortError') console.error('Scheduled decision work failed:', error);
    }
  });
}

export function setDecisionTimeout(callback, delay) {
  const context = createDecisionWorkContext();
  return globalThis.setTimeout(() => invoke(context, callback), delay);
}

export function setDecisionInterval(callback, delay) {
  // Watchdogs survive restarts of a decision; each tick captures the current run.
  return globalThis.setInterval(() => invoke(createDecisionWorkContext(), callback), delay);
}
