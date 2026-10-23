import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../storage/postgres.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_CHEAP_MODEL, DEFAULT_PRIMARY_MODEL, SUPPORTED_CHAT_MODELS, env } from './env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Default to the real dev/prod database, but allow tests to point at a fresh,
// isolated SQLite file via CIME_DB_PATH so they never touch chat.db.
const dbPath = process.env.CIME_DB_PATH || path.join(__dirname, '../../chat.db');

export const db = process.env.DATABASE_URL && process.env.CIME_RUN_SCHEMA
  ? new PostgresDatabase({ url: process.env.DATABASE_URL, schema: process.env.CIME_RUN_SCHEMA })
  : new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function hasColumn(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some((col) => col.name === columnName);
}

export function ensurePersonalRoomsForAllUsers() {
  const users = db.prepare('SELECT id, username, is_admin FROM users').all();
  const admins = users.filter((user) => user.is_admin === 1 || user.is_admin === true);
  const upsertRoom = db.prepare(
    'INSERT INTO rooms (name, prompt_file, system_prompt, room_type, is_active) VALUES (?, ?, ?, ?, 1) ON CONFLICT(name) DO NOTHING'
  );
  const findRoom = db.prepare('SELECT id FROM rooms WHERE name = ?');
  const assignRoom = db.prepare(
    'INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING'
  );

  const tx = db.transaction(() => {
    for (const user of users) {
      const roomName = `${user.username}-personal`;
      upsertRoom.run(roomName, 'default.md', 'You are a helpful assistant.', 'personal');
      const room = findRoom.get(roomName);
      if (room) {
        assignRoom.run(user.id, room.id);
        for (const admin of admins) assignRoom.run(admin.id, room.id);
      }
    }
  });

  tx();
}

export function ensureAdminsInRoom(roomId) {
  const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
  const assignRoom = db.prepare(
    'INSERT INTO room_members (user_id, room_id) VALUES (?, ?) ON CONFLICT(user_id, room_id) DO NOTHING'
  );
  for (const admin of admins) assignRoom.run(admin.id, roomId);
}

export function ensureAdminsInAllRooms() {
  const rooms = db.prepare('SELECT id FROM rooms').all();
  const tx = db.transaction(() => {
    for (const room of rooms) ensureAdminsInRoom(room.id);
  });
  tx();
}

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS room_members (
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      PRIMARY KEY (user_id, room_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      sender_id INTEGER,
      text TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS polls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      show_results INTEGER NOT NULL DEFAULT 0,
      is_closed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      replaces_option TEXT,
      poll_type TEXT NOT NULL DEFAULT 'plurality',
      closed_at TEXT,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      option_text TEXT NOT NULL,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      rank INTEGER NOT NULL DEFAULT 1,
      custom_option_text TEXT,
      PRIMARY KEY (poll_id, user_id, option_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS system_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      global_question TEXT,
      decision_context TEXT NOT NULL DEFAULT '',
      general_description TEXT NOT NULL DEFAULT '',
      current_phase TEXT NOT NULL DEFAULT 'idle',
      showdown_initiated INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS app_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_topic_preferences (
      user_id INTEGER NOT NULL,
      topic TEXT NOT NULL,
      PRIMARY KEY (user_id, topic),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS topic_preference_responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      poll_id INTEGER NOT NULL,
      selected_topics_json TEXT NOT NULL DEFAULT '[]',
      selected_all_topics INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (poll_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_instructions (
      agent_key TEXT PRIMARY KEY,
      instructions TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS room_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      decision_round INTEGER NOT NULL DEFAULT 1,
      decision_text TEXT NOT NULL,
      normalized_decision TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(room_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS room_status (
      room_id INTEGER PRIMARY KEY,
      status_text TEXT NOT NULL DEFAULT 'Waiting for discussion',
      agreed_points TEXT NOT NULL DEFAULT '[]',
      discussion_points TEXT NOT NULL DEFAULT '[]',
      last_updated_at TEXT NOT NULL,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      room_id INTEGER,
      caller TEXT NOT NULL DEFAULT 'unknown',
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      tokens_used INTEGER,
      model TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gathering_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      question_text TEXT NOT NULL,
      question_order INTEGER NOT NULL DEFAULT 0,
      predefined_answers_json TEXT NOT NULL DEFAULT '[]',
      is_general_question INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gathering_answers (
      question_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      answer_text TEXT NOT NULL,
      raw_answer_text TEXT NOT NULL DEFAULT '',
      matched_predefined_answer TEXT NOT NULL DEFAULT '',
      answer_source TEXT NOT NULL DEFAULT 'chat',
      response_status TEXT NOT NULL DEFAULT 'accepted',
      validation_attempts INTEGER NOT NULL DEFAULT 1,
      source_message_id INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      PRIMARY KEY (question_id, user_id),
      FOREIGN KEY (question_id) REFERENCES gathering_questions(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS custom_option_analyses (
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      custom_option_text TEXT NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, user_id, option_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_proactiveness_analyses (
      message_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      analysis_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS message_deliberative_quality_analyses (
      message_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      analysis_json TEXT NOT NULL,
      embedding_json TEXT NOT NULL DEFAULT '[]',
      context_hash TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      embedding_model_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS swipe_votes (
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      swipe_direction TEXT NOT NULL DEFAULT 'right',
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, user_id, option_id),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Continuous voting keeps the current selection in poll_votes and records every
    -- replacement in this append-only audit table.
    CREATE TABLE IF NOT EXISTS poll_vote_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      option_id INTEGER NOT NULL,
      action TEXT NOT NULL DEFAULT 'replace',
      custom_option_text TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS poll_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      poll_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      source_text TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      canonical_option_id INTEGER,
      analysis_json TEXT NOT NULL DEFAULT '{}',
      request_id TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (canonical_option_id) REFERENCES poll_options(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS poll_announcements (
      poll_id INTEGER NOT NULL,
      event_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (poll_id, event_key),
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_call_models (
      call_key TEXT PRIMARY KEY,
      model_name TEXT NOT NULL
    );
  `);

  // Tracks which participants pressed "I agree" on a convergence summary card, so the review
  // window can close early once everyone agrees.
  db.exec(`
    CREATE TABLE IF NOT EXISTS convergence_agreements (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS convergence_review_actions (
      room_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('agree', 'reopen')),
      topic_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, user_id, action, topic_key),
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  try {
    const count = db.prepare('SELECT COUNT(*) as c FROM llm_call_models').get()?.c || 0;
    if (count === 0) {
      const stmt = db.prepare('INSERT INTO llm_call_models (call_key, model_name) VALUES (?, ?)');
      const defaults = [
        ['admin_suggest_reopen', env.openaiModel],
        ['admin_generate_report', env.openaiModel],
        ['admin_reconcile_members', env.openaiModel],
        ['admin_generate_questions', env.cheapModel],
        ['admin_generate_description', env.cheapModel],
        ['decision_suggest', env.openaiModel],
        ['agent1_reply', env.openaiModel],
        ['preference_prompt', env.openaiModel],
        ['personal_room_prompt', env.openaiModel],
        ['convergence_room_prompt', env.openaiModel],
        ['room_report', env.openaiModel],
        ['agent3-evaluateReadyToVote', env.cheapModel],
        ['draft_poll', env.openaiModel],
        ['infer_poll', env.openaiModel],
        ['recap_report', env.openaiModel],
        ['room_completion', env.openaiModel],
        ['suggest_reopen_topic', env.openaiModel],
        ['classify_custom_option', env.openaiModel],
        ['proactiveness', env.openaiModel],
        ['deliberative_quality', env.openaiModel],
        ['deliberative_quality_embedding', env.embeddingModel],
        ['simulation_persona_autofill', env.openaiModel],
        ['room_status', env.openaiModel],
        ['simulation', env.cheapModel]
      ];
      const allowed = [...SUPPORTED_CHAT_MODELS, env.embeddingModel];
      db.transaction(() => {
        for (const [key, model] of defaults) {
          let chosen = model;
          if (!allowed.includes(chosen)) chosen = env.cheapModel;
          stmt.run(key, chosen);
        }
      })();
    }
    const ensureStmt = db.prepare('INSERT INTO llm_call_models (call_key, model_name) VALUES (?, ?) ON CONFLICT(call_key) DO NOTHING');
    ensureStmt.run('deliberative_quality', env.openaiModel);
    ensureStmt.run('deliberative_quality_embedding', env.embeddingModel);
    ensureStmt.run('simulation_persona_autofill', env.openaiModel);

    // Upgrade only the old built-in defaults once. A migration marker means an admin
    // can intentionally choose an older model later without it being overwritten on
    // every server restart.
    const modelUpgrade = 'upgrade-llm-defaults-to-gpt-5.6-v1';
    if (!db.prepare('SELECT 1 FROM app_migrations WHERE migration_key = ?').get(modelUpgrade)) {
      const primaryLegacy = ['gpt-4o', 'gpt-5.4'];
      const cheapLegacy = ['gpt-4o-mini', 'gpt-5.4-mini'];
      const upgrade = db.transaction(() => {
        for (const model of primaryLegacy) {
          db.prepare('UPDATE llm_call_models SET model_name = ? WHERE model_name = ?').run(DEFAULT_PRIMARY_MODEL, model);
        }
        for (const model of cheapLegacy) {
          db.prepare('UPDATE llm_call_models SET model_name = ? WHERE model_name = ?').run(DEFAULT_CHEAP_MODEL, model);
        }
        db.prepare('INSERT INTO app_migrations (migration_key, applied_at) VALUES (?, ?)').run(modelUpgrade, new Date().toISOString());
      });
      upgrade();
    }

    const modelPurposeUpgrade = 'assign-llm-models-by-purpose-gpt-5.6-v2';
    if (!db.prepare('SELECT 1 FROM app_migrations WHERE migration_key = ?').get(modelPurposeUpgrade)) {
      const primaryCallKeys = [
        'admin_suggest_reopen', 'admin_generate_report', 'admin_reconcile_members',
        'decision_suggest', 'agent1_reply', 'preference_prompt', 'personal_room_prompt',
        'convergence_room_prompt', 'room_report', 'draft_poll', 'infer_poll', 'recap_report',
        'room_completion', 'suggest_reopen_topic', 'classify_custom_option', 'proactiveness',
        'deliberative_quality', 'simulation_persona_autofill', 'room_status'
      ];
      const cheapCallKeys = [
        'admin_generate_questions', 'admin_generate_description',
        'agent3-evaluateReadyToVote', 'simulation'
      ];
      const upgradeByPurpose = db.transaction(() => {
        const update = db.prepare('UPDATE llm_call_models SET model_name = ? WHERE call_key = ?');
        for (const key of primaryCallKeys) update.run(DEFAULT_PRIMARY_MODEL, key);
        for (const key of cheapCallKeys) update.run(DEFAULT_CHEAP_MODEL, key);
        db.prepare('INSERT INTO app_migrations (migration_key, applied_at) VALUES (?, ?)').run(modelPurposeUpgrade, new Date().toISOString());
      });
      upgradeByPurpose();
    }
  } catch (err) {
    console.error('Failed to initialize llm_call_models defaults:', err);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS survey_definitions (
      stage TEXT PRIMARY KEY CHECK (stage IN ('pre', 'post')),
      definition_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS survey_responses (
      stage TEXT NOT NULL REFERENCES survey_definitions(stage),
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      answers_json TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      PRIMARY KEY (stage, user_id, run_id)
    );
  `);
  if (!hasColumn('users', 'is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('users', 'profile_info')) db.exec("ALTER TABLE users ADD COLUMN profile_info TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('users', 'extracted_preferences')) db.exec("ALTER TABLE users ADD COLUMN extracted_preferences TEXT NOT NULL DEFAULT ''");

  if (!hasColumn('rooms', 'prompt_file')) db.exec("ALTER TABLE rooms ADD COLUMN prompt_file TEXT NOT NULL DEFAULT 'default.md'");
  if (!hasColumn('rooms', 'system_prompt')) db.exec("ALTER TABLE rooms ADD COLUMN system_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.'");
  if (!hasColumn('rooms', 'is_active')) db.exec('ALTER TABLE rooms ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  if (!hasColumn('rooms', 'room_type')) db.exec("ALTER TABLE rooms ADD COLUMN room_type TEXT NOT NULL DEFAULT 'group'");
  if (!hasColumn('rooms', 'decision_round')) db.exec('ALTER TABLE rooms ADD COLUMN decision_round INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('rooms', 'room_timer_minutes')) db.exec('ALTER TABLE rooms ADD COLUMN room_timer_minutes INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('rooms', 'timer_expires_at')) db.exec('ALTER TABLE rooms ADD COLUMN timer_expires_at TEXT');
  if (!hasColumn('rooms', 'room_timer_expired_at')) db.exec('ALTER TABLE rooms ADD COLUMN room_timer_expired_at TEXT');
  if (!hasColumn('rooms', 'collection_complete')) db.exec('ALTER TABLE rooms ADD COLUMN collection_complete INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('rooms', 'collection_banner')) db.exec("ALTER TABLE rooms ADD COLUMN collection_banner TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('rooms', 'topic_memory_json')) db.exec("ALTER TABLE rooms ADD COLUMN topic_memory_json TEXT NOT NULL DEFAULT '[]'");
  if (!hasColumn('rooms', 'recap_report')) db.exec('ALTER TABLE rooms ADD COLUMN recap_report TEXT');
  if (!hasColumn('rooms', 'final_vote_not_before')) db.exec('ALTER TABLE rooms ADD COLUMN final_vote_not_before TEXT');
  if (!hasColumn('rooms', 'personal_poll_mode')) db.exec('ALTER TABLE rooms ADD COLUMN personal_poll_mode INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('rooms', 'current_gathering_question_id')) db.exec('ALTER TABLE rooms ADD COLUMN current_gathering_question_id INTEGER');
  if (!hasColumn('rooms', 'gathering_retry_count')) db.exec('ALTER TABLE rooms ADD COLUMN gathering_retry_count INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('rooms', 'opened_at')) db.exec('ALTER TABLE rooms ADD COLUMN opened_at TEXT');
  // Convergence summary review window: when the interactive summary card was posted, and
  // whether the configured review window has closed (topics reopened, voting allowed to begin).
  if (!hasColumn('rooms', 'convergence_summary_at')) db.exec('ALTER TABLE rooms ADD COLUMN convergence_summary_at TEXT');
  if (!hasColumn('rooms', 'convergence_finalized')) db.exec('ALTER TABLE rooms ADD COLUMN convergence_finalized INTEGER NOT NULL DEFAULT 0');

  if (!hasColumn('polls', 'mandatory')) db.exec('ALTER TABLE polls ADD COLUMN mandatory INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('polls', 'expires_at')) db.exec('ALTER TABLE polls ADD COLUMN expires_at TEXT');
  if (!hasColumn('polls', 'suggestion')) db.exec('ALTER TABLE polls ADD COLUMN suggestion TEXT');
  if (!hasColumn('polls', 'is_reopened')) db.exec('ALTER TABLE polls ADD COLUMN is_reopened INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('polls', 'replaces_option')) db.exec('ALTER TABLE polls ADD COLUMN replaces_option TEXT');
  if (!hasColumn('polls', 'poll_type')) db.exec("ALTER TABLE polls ADD COLUMN poll_type TEXT NOT NULL DEFAULT 'plurality'");
  if (!hasColumn('polls', 'has_consensus')) db.exec('ALTER TABLE polls ADD COLUMN has_consensus INTEGER DEFAULT NULL');
  if (!hasColumn('polls', 'chain_stage')) db.exec("ALTER TABLE polls ADD COLUMN chain_stage TEXT NOT NULL DEFAULT 'none'");
  if (!hasColumn('polls', 'closed_at')) db.exec('ALTER TABLE polls ADD COLUMN closed_at TEXT');
  if (!hasColumn('polls', 'poll_stage')) db.exec("ALTER TABLE polls ADD COLUMN poll_stage TEXT NOT NULL DEFAULT 'standard'");
  if (!hasColumn('polls', 'minimum_live_until')) db.exec('ALTER TABLE polls ADD COLUMN minimum_live_until TEXT');
  if (!hasColumn('polls', 'stability_leader_key')) db.exec('ALTER TABLE polls ADD COLUMN stability_leader_key TEXT');
  if (!hasColumn('polls', 'stability_started_at')) db.exec('ALTER TABLE polls ADD COLUMN stability_started_at TEXT');
  if (!hasColumn('polls', 'review_until')) db.exec('ALTER TABLE polls ADD COLUMN review_until TEXT');
  if (!hasColumn('polls', 'timeout_snapshot_json')) db.exec("ALTER TABLE polls ADD COLUMN timeout_snapshot_json TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('polls', 'closed_reason')) db.exec("ALTER TABLE polls ADD COLUMN closed_reason TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('polls', 'transitioned_to_poll_id')) db.exec('ALTER TABLE polls ADD COLUMN transitioned_to_poll_id INTEGER');

  if (!hasColumn('poll_votes', 'rank')) {
    db.exec('ALTER TABLE poll_votes ADD COLUMN rank INTEGER NOT NULL DEFAULT 1');
    // Drop primary key and recreate to include option_id is not easily done in SQLite without recreating the table.
    // However, SQLite ignores duplicate inserts if we don't change the primary key?
    // Wait, poll_votes PRIMARY KEY is (poll_id, user_id). A user can't vote for multiple options unless we change the PK!
    // Since we can't easily alter the PK, let's just recreate the table if necessary, or rename and copy.
    db.exec(`
      CREATE TABLE IF NOT EXISTS poll_votes_new (
        poll_id INTEGER NOT NULL,
        option_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (poll_id, user_id, option_id),
        FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE,
        FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      INSERT INTO poll_votes_new SELECT poll_id, option_id, user_id, created_at, 1 FROM poll_votes;
      DROP TABLE poll_votes;
      ALTER TABLE poll_votes_new RENAME TO poll_votes;
    `);
  }

  if (!hasColumn('system_state', 'discussion_round')) db.exec('ALTER TABLE system_state ADD COLUMN discussion_round INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('system_state', 'decision_context')) db.exec("ALTER TABLE system_state ADD COLUMN decision_context TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('system_state', 'general_description')) db.exec("ALTER TABLE system_state ADD COLUMN general_description TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('system_state', 'room_timer_minutes')) db.exec('ALTER TABLE system_state ADD COLUMN room_timer_minutes INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('system_state', 'deliberation_config_json')) db.exec("ALTER TABLE system_state ADD COLUMN deliberation_config_json TEXT NOT NULL DEFAULT '[]'");
  if (!hasColumn('system_state', 'active_topic_index')) db.exec('ALTER TABLE system_state ADD COLUMN active_topic_index INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('system_state', 'showdown_initiated')) db.exec('ALTER TABLE system_state ADD COLUMN showdown_initiated INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('system_state', 'decision_run_id')) db.exec("ALTER TABLE system_state ADD COLUMN decision_run_id TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('system_state', 'decision_run_started_at')) db.exec("ALTER TABLE system_state ADD COLUMN decision_run_started_at TEXT");
  if (!hasColumn('system_state', 'decision_run_mode')) db.exec("ALTER TABLE system_state ADD COLUMN decision_run_mode TEXT NOT NULL DEFAULT 'human'");
  if (!hasColumn('system_state', 'decision_run_participant_ids_json')) db.exec("ALTER TABLE system_state ADD COLUMN decision_run_participant_ids_json TEXT NOT NULL DEFAULT '[]'");
  for (const column of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_tokens']) {
    if (!hasColumn('llm_logs', column)) db.exec(`ALTER TABLE llm_logs ADD COLUMN ${column} INTEGER`);
  }
  for (const column of ['session_id', 'work_type']) {
    if (!hasColumn('llm_logs', column)) db.exec(`ALTER TABLE llm_logs ADD COLUMN ${column} TEXT`);
  }

  if (!hasColumn('gathering_questions', 'question_order')) db.exec('ALTER TABLE gathering_questions ADD COLUMN question_order INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('gathering_questions', 'predefined_answers_json')) db.exec("ALTER TABLE gathering_questions ADD COLUMN predefined_answers_json TEXT NOT NULL DEFAULT '[]'");
  if (!hasColumn('gathering_questions', 'is_general_question')) db.exec('ALTER TABLE gathering_questions ADD COLUMN is_general_question INTEGER NOT NULL DEFAULT 0');

  if (!hasColumn('gathering_answers', 'raw_answer_text')) db.exec("ALTER TABLE gathering_answers ADD COLUMN raw_answer_text TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('gathering_answers', 'matched_predefined_answer')) db.exec("ALTER TABLE gathering_answers ADD COLUMN matched_predefined_answer TEXT NOT NULL DEFAULT ''");
  if (!hasColumn('gathering_answers', 'answer_source')) db.exec("ALTER TABLE gathering_answers ADD COLUMN answer_source TEXT NOT NULL DEFAULT 'chat'");
  if (!hasColumn('gathering_answers', 'response_status')) db.exec("ALTER TABLE gathering_answers ADD COLUMN response_status TEXT NOT NULL DEFAULT 'accepted'");
  if (!hasColumn('gathering_answers', 'validation_attempts')) db.exec('ALTER TABLE gathering_answers ADD COLUMN validation_attempts INTEGER NOT NULL DEFAULT 1');
  if (!hasColumn('gathering_answers', 'source_message_id')) db.exec('ALTER TABLE gathering_answers ADD COLUMN source_message_id INTEGER NOT NULL DEFAULT 0');
  if (!hasColumn('poll_votes', 'custom_option_text')) db.exec("ALTER TABLE poll_votes ADD COLUMN custom_option_text TEXT");

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_suggestions_request
      ON poll_suggestions(poll_id, user_id, request_id)
      WHERE request_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_suggestions_one_pending
      ON poll_suggestions(poll_id, user_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_poll_suggestions_pending
      ON poll_suggestions(poll_id, user_id, status);
    CREATE INDEX IF NOT EXISTS idx_poll_vote_history_poll
      ON poll_vote_history(poll_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_poll_vote_history_request
      ON poll_vote_history(poll_id, user_id, request_id)
      WHERE request_id IS NOT NULL;
  `);

  // Backfill the opening anchor for older group rooms. Prefer the first stored
  // message, then the room timer, and finally the migration time.
  db.prepare(`
    UPDATE rooms
    SET opened_at = COALESCE(
      (SELECT MIN(m.timestamp) FROM messages m WHERE m.room_id = rooms.id),
      timer_expires_at,
      ?
    )
    WHERE opened_at IS NULL AND room_type IN ('group', 'convergence')
  `).run(new Date().toISOString());

  db.exec(`
    CREATE TABLE IF NOT EXISTS topic_preference_responses_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      poll_id INTEGER NOT NULL,
      selected_topics_json TEXT NOT NULL DEFAULT '[]',
      selected_all_topics INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (poll_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (poll_id) REFERENCES polls(id) ON DELETE CASCADE
    );
  `);
  if (!hasColumn('topic_preference_responses_new', 'id')) {
    // noop: defensive branch for older SQLite versions if the temp table already exists.
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='topic_preference_responses'").get()) {
    const hasResponseColumns =
      hasColumn('topic_preference_responses', 'room_id') &&
      hasColumn('topic_preference_responses', 'poll_id') &&
      hasColumn('topic_preference_responses', 'selected_topics_json') &&
      hasColumn('topic_preference_responses', 'selected_all_topics');
    if (!hasResponseColumns) {
      db.exec(`
        DROP TABLE IF EXISTS topic_preference_responses;
        ALTER TABLE topic_preference_responses_new RENAME TO topic_preference_responses;
      `);
    } else {
      db.exec('DROP TABLE IF EXISTS topic_preference_responses_new');
    }
  } else {
    db.exec('ALTER TABLE topic_preference_responses_new RENAME TO topic_preference_responses');
  }

  db.prepare("INSERT INTO system_state (id, global_question, current_phase) VALUES (1, NULL, 'idle') ON CONFLICT(id) DO NOTHING").run();
  db.prepare("UPDATE system_state SET decision_run_id = ? WHERE decision_run_id = ''").run(randomUUID());

  ensurePersonalRoomsForAllUsers();
  ensureAdminsInAllRooms();
}
