import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Tests can redirect logs alongside their isolated database so an audit run
// never changes the real decision history.
const logsDir = process.env.CIME_LOG_DIR || path.join(__dirname, '../../logs');
const logPath = path.join(logsDir, 'current_decision_log.json');

function ensureLogDir() {
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

export function initializeLog(settings, globalQuestion, decisionContext) {
  ensureLogDir();
  const initialLog = {
    started_at: new Date().toISOString(),
    global_question: globalQuestion,
    decision_context: decisionContext,
    initial_settings: settings,
    setting_updates: [],
    agent_events: []
  };
  fs.writeFileSync(logPath, JSON.stringify(initialLog, null, 2), 'utf-8');
}

export function appendSettingUpdate(settings) {
  ensureLogDir();
  if (!fs.existsSync(logPath)) return;
  try {
    const logData = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    logData.setting_updates.push({
      updated_at: new Date().toISOString(),
      settings
    });
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to append setting update to decision log:', e.message);
  }
}

export function appendAgentEvent(agentKey, summary, detail) {
  ensureLogDir();
  if (!fs.existsSync(logPath)) return;
  try {
    const logData = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    logData.agent_events.push({
      created_at: new Date().toISOString(),
      agent: agentKey,
      summary,
      detail
    });
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to append agent event to decision log:', e.message);
  }
}

export function readLog() {
  ensureLogDir();
  if (!fs.existsSync(logPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf-8'));
  } catch (e) {
    console.error('Failed to read decision log:', e.message);
    return null;
  }
}
