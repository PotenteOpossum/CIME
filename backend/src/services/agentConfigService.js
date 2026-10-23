import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendSettingUpdate } from './decisionLogService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Default to the real agent-config dir, but allow tests to point at an isolated
// copy via CIME_CONFIG_DIR so settings writes never touch the shared config.
const configDir = process.env.CIME_CONFIG_DIR || path.join(__dirname, '../../agent-config');
const templatesDir = path.join(configDir, 'templates');
const settingsPath = path.join(configDir, 'settings.json');
// Admin-defined "default" snapshot used by the Decision Settings "Set default" / "Reset to
// default" buttons. Separate from settingsPath (the live/current settings) and from the
// hardcoded `defaultSettings` fallback below (used until an admin ever saves one).
const defaultSettingsOverridePath = path.join(configDir, 'default-settings.json');

const defaultSettings = {
  group_proactivity: 4,
  consensus_sensitivity: 4,
  poll_approval_threshold: 1,
  minimum_votes_for_approval: 50,
  minimum_live_voting_duration_minutes: 1,
  consensus_stability_duration_seconds: 20,
  live_voting_duration_minutes: 5,
  suggestion_cooldown_seconds: 30,
  maximum_visible_options: 8,
  room_timer_minutes: 3,
  poll_timer_minutes: 2,
  convergence_summary_minutes: 1,
  time_before_poll_seconds: 10,
  time_before_final_vote_seconds: null,
  check_response_validity: false,
  clustering_strategy: 'topic_preference',
  clustering_min_users_per_room: 2,
  clustering_min_rooms: 2,
  kick_out_no_voters: 2,
  user_poll_rate_limit: 11,
  user_inactivity_timeout_minutes: 5,
  primary_model: '',
  cheap_model: ''
};

function ensureConfig() {
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, `${JSON.stringify(defaultSettings, null, 2)}\n`, 'utf-8');
  }
}

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.min(6, Math.max(1, Math.round(n)));
}

function clampConsensusSensitivity(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 4;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function clampPollApprovalThreshold(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, Math.round(n)));
}

function clampPercentage(value, fallback = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function clampPositiveInt(value, fallback, min = 1, max = 50) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeClusteringStrategy(value) {
  return ['random', 'homophilic', 'heterophilic', 'mixed', 'topic_preference'].includes(value) ? value : 'topic_preference';
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1') return true;
  if (value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'on'].includes(normalized)) return true;
    if (['false', 'no', 'off'].includes(normalized)) return false;
  }
  return fallback;
}

export function getAgentPrompt(agentKey) {
  ensureConfig();
  const safe = ['agent1', 'agent2', 'agent3'].includes(agentKey) ? agentKey : 'agent1';
  return fs.readFileSync(path.join(configDir, `${safe}.md`), 'utf-8');
}

export function getTemplate(templateName) {
  ensureConfig();
  const safe = String(templateName || '').trim();
  const [filePart] = safe.split('#');
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(filePart)) throw new Error('Invalid template filename');
  const target = path.join(templatesDir, filePart);
  if (!fs.existsSync(target)) throw new Error(`Template not found: ${filePart}`);
  return fs.readFileSync(target, 'utf-8');
}

export function renderTemplate(templateName, values = {}) {
  const safeName = String(templateName || '').trim();
  const [filePart, sectionPart] = safeName.split('#');
  let content = getTemplate(filePart);
  
  if (sectionPart) {
    const regex = new RegExp(`(?:^|\\n)##\\s*${sectionPart.trim()}\\s*\\n([\\s\\S]*?)(?:\\n##|$)`, 'i');
    const match = content.match(regex);
    if (!match) throw new Error(`Section "${sectionPart}" not found in template file: ${filePart}`);
    content = match[1].trim();
  }
  
  return content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = values[key];
    if (value === undefined || value === null) return '';
    return String(value);
  }).trim();
}

export function getDecisionSettings() {
  ensureConfig();
  const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  const merged = { ...defaultSettings, ...parsed };
  return {
    group_proactivity: clampScale(merged.group_proactivity),
    consensus_sensitivity: clampConsensusSensitivity(merged.consensus_sensitivity),
    poll_approval_threshold: clampPollApprovalThreshold(merged.poll_approval_threshold),
    minimum_votes_for_approval: clampPercentage(merged.minimum_votes_for_approval, 50),
    minimum_live_voting_duration_minutes: clampPositiveInt(merged.minimum_live_voting_duration_minutes, 1, 0, 30),
    consensus_stability_duration_seconds: clampPositiveInt(merged.consensus_stability_duration_seconds, 20, 0, 300),
    live_voting_duration_minutes: clampPositiveInt(merged.live_voting_duration_minutes, 5, 1, 120),
    suggestion_cooldown_seconds: clampPositiveInt(merged.suggestion_cooldown_seconds, 30, 0, 3600),
    maximum_visible_options: clampPositiveInt(merged.maximum_visible_options, 8, 2, 20),
    room_timer_minutes: clampPositiveInt(merged.room_timer_minutes, 3, 1, 30),
    poll_timer_minutes: clampPositiveInt(merged.poll_timer_minutes, 2, 1, 30),
    convergence_summary_minutes: clampPositiveInt(merged.convergence_summary_minutes, 1, 1, 10),
    time_before_poll_seconds: clampPositiveInt(merged.time_before_poll_seconds, 10, 0, 120),
    time_before_final_vote_seconds: clampPositiveInt(merged.time_before_final_vote_seconds ?? merged.time_before_poll_seconds, 10, 0, 1800),
    check_response_validity: normalizeBoolean(merged.check_response_validity, false),
    clustering_strategy: normalizeClusteringStrategy(merged.clustering_strategy),
    clustering_min_users_per_room: clampPositiveInt(merged.clustering_min_users_per_room, 2, 2, 50),
    clustering_min_rooms: clampPositiveInt(merged.clustering_min_rooms, 2, 1, 50),
    kick_out_no_voters: clampPositiveInt(merged.kick_out_no_voters, 2, 1, 2),
    user_poll_rate_limit: clampPositiveInt(merged.user_poll_rate_limit, 11, 0, 11),
    user_inactivity_timeout_minutes: clampPositiveInt(merged.user_inactivity_timeout_minutes, 5, 3, 15),
    primary_model: String(merged.primary_model || ''),
    cheap_model: String(merged.cheap_model || '')
  };
}

export function updateDecisionSettings(patch) {
  const current = getDecisionSettings();
  const next = { ...current };
  if (patch.group_proactivity !== undefined) next.group_proactivity = clampScale(patch.group_proactivity);
  if (patch.room_timer_minutes !== undefined) next.room_timer_minutes = clampPositiveInt(patch.room_timer_minutes, 3, 1, 30);
  if (patch.poll_timer_minutes !== undefined) next.poll_timer_minutes = clampPositiveInt(patch.poll_timer_minutes, 2, 1, 30);
  if (patch.convergence_summary_minutes !== undefined) next.convergence_summary_minutes = clampPositiveInt(patch.convergence_summary_minutes, 1, 1, 10);
  if (patch.time_before_final_vote_seconds !== undefined) next.time_before_final_vote_seconds = clampPositiveInt(patch.time_before_final_vote_seconds, 10, 0, 1800);
  if (patch.time_before_poll_seconds !== undefined) next.time_before_poll_seconds = clampPositiveInt(patch.time_before_poll_seconds, 10, 0, 120);
  if (patch.check_response_validity !== undefined) next.check_response_validity = normalizeBoolean(patch.check_response_validity, false);
  if (patch.consensus_sensitivity !== undefined) next.consensus_sensitivity = clampConsensusSensitivity(patch.consensus_sensitivity);
  if (patch.poll_approval_threshold !== undefined) next.poll_approval_threshold = clampPollApprovalThreshold(patch.poll_approval_threshold);
  if (patch.minimum_votes_for_approval !== undefined) next.minimum_votes_for_approval = clampPercentage(patch.minimum_votes_for_approval, 50);
  if (patch.minimum_live_voting_duration_minutes !== undefined) next.minimum_live_voting_duration_minutes = clampPositiveInt(patch.minimum_live_voting_duration_minutes, 1, 0, 30);
  if (patch.consensus_stability_duration_seconds !== undefined) next.consensus_stability_duration_seconds = clampPositiveInt(patch.consensus_stability_duration_seconds, 20, 0, 300);
  if (patch.live_voting_duration_minutes !== undefined) next.live_voting_duration_minutes = clampPositiveInt(patch.live_voting_duration_minutes, 5, 1, 120);
  if (patch.suggestion_cooldown_seconds !== undefined) next.suggestion_cooldown_seconds = clampPositiveInt(patch.suggestion_cooldown_seconds, 30, 0, 3600);
  if (patch.maximum_visible_options !== undefined) next.maximum_visible_options = clampPositiveInt(patch.maximum_visible_options, 8, 2, 20);

  if (patch.clustering_strategy !== undefined) next.clustering_strategy = normalizeClusteringStrategy(patch.clustering_strategy);
  if (patch.clustering_min_users_per_room !== undefined) {
    next.clustering_min_users_per_room = clampPositiveInt(patch.clustering_min_users_per_room, current.clustering_min_users_per_room, 2, 50);
  }
  if (patch.clustering_min_rooms !== undefined) {
    next.clustering_min_rooms = clampPositiveInt(patch.clustering_min_rooms, current.clustering_min_rooms, 1, 50);
  }
  if (patch.kick_out_no_voters !== undefined) {
    next.kick_out_no_voters = clampPositiveInt(patch.kick_out_no_voters, 2, 1, 2);
  }
  if (patch.user_poll_rate_limit !== undefined) {
    next.user_poll_rate_limit = clampPositiveInt(patch.user_poll_rate_limit, 11, 0, 11);
  }
  if (patch.user_inactivity_timeout_minutes !== undefined) {
    next.user_inactivity_timeout_minutes = clampPositiveInt(patch.user_inactivity_timeout_minutes, 5, 3, 15);
  }
  if (patch.primary_model !== undefined) next.primary_model = String(patch.primary_model || '');
  if (patch.cheap_model !== undefined) next.cheap_model = String(patch.cheap_model || '');
  fs.writeFileSync(settingsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
  appendSettingUpdate(next);
  return next;
}

// Returns the admin-saved default snapshot, or the hardcoded factory defaults if the admin has
// never pressed "Set default".
export function getSavedDefaultSettings() {
  ensureConfig();
  if (!fs.existsSync(defaultSettingsOverridePath)) return { ...defaultSettings };
  try {
    const parsed = JSON.parse(fs.readFileSync(defaultSettingsOverridePath, 'utf-8'));
    return Object.fromEntries(Object.keys(defaultSettings).map((key) => [key, parsed[key] ?? defaultSettings[key]]));
  } catch {
    return { ...defaultSettings };
  }
}

// "Set default": snapshot the current live settings as the new default baseline.
export function saveCurrentSettingsAsDefault() {
  ensureConfig();
  const current = getDecisionSettings();
  fs.writeFileSync(defaultSettingsOverridePath, `${JSON.stringify(current, null, 2)}\n`, 'utf-8');
  return current;
}

// "Reset to default": apply the saved default snapshot as the current live settings. Routed
// through updateDecisionSettings so every value is clamped/normalized exactly like a normal
// PATCH, even if the saved snapshot predates a since-changed valid range.
export function resetSettingsToDefault() {
  return updateDecisionSettings(getSavedDefaultSettings());
}

import { env } from '../config/env.js';

export function getConfiguredModels() {
  const settings = getDecisionSettings();
  return {
    primaryModel: settings.primary_model || env.openaiModel,
    cheapModel: settings.cheap_model || env.cheapModel || env.openaiModel
  };
}

export function describeDecisionSettings(settings = getDecisionSettings()) {
  return [
    `group_proactivity=${settings.group_proactivity}/5`,
    `consensus_sensitivity=${settings.consensus_sensitivity}/10 (percentage of distinct participants)`,
    `poll_approval_threshold=${settings.poll_approval_threshold}/3`,
    `minimum_votes_for_approval=${settings.minimum_votes_for_approval}%`,
    `minimum_live_voting_duration_minutes=${settings.minimum_live_voting_duration_minutes}`,
    `consensus_stability_duration_seconds=${settings.consensus_stability_duration_seconds}`,
    `live_voting_duration_minutes=${settings.live_voting_duration_minutes}`,
    `suggestion_cooldown_seconds=${settings.suggestion_cooldown_seconds}`,
    `maximum_visible_options=${settings.maximum_visible_options}`,
    `check_response_validity=${settings.check_response_validity ? 'on' : 'off'}`,
    `room_timer_minutes=${settings.room_timer_minutes}`,
    `poll_timer_minutes=${settings.poll_timer_minutes}`,
    `clustering_strategy=${settings.clustering_strategy}`,
    `clustering_min_users_per_room=${settings.clustering_min_users_per_room}`,
    `clustering_min_rooms=${settings.clustering_min_rooms}`
  ].join(', ');
}

export function clusteringPublicReason(strategy = getDecisionSettings().clustering_strategy) {
  const reasons = {
    random: 'Users are distributed across discussion rooms without using their answers.',
    homophilic: 'Users are grouped with others who appear to have broadly similar perspectives.',
    heterophilic: 'Users are grouped to promote constructive confrontation between different perspectives.',
    mixed: 'Users are grouped to balance shared ground and different perspectives.',
    topic_preference: 'Users are grouped based on their indicated topic preferences.'
  };
  return reasons[strategy] || reasons.mixed;
}

export function settingToNudgeDelayMs(settings = getDecisionSettings()) {
  // The setting value is the number of minutes of silence to wait before nudging.
  // 1 = 1 minute (nudges soonest), 5 = 5 minutes (most patient).
  const val = Math.min(5, Math.max(1, settings.group_proactivity || 3));
  return val * 60 * 1000;
}

// "Time before poll": the pause between the bot announcing the next topic (or the final recap) and
// the poll actually opening. 0 means open immediately.
export function settingToTimeBeforePollMs(settings = getDecisionSettings()) {
  const seconds = Number(settings.time_before_poll_seconds);
  return (Number.isFinite(seconds) ? Math.max(0, seconds) : 10) * 1000;
}

export function settingToFinalVoteMs(settings = getDecisionSettings()) {
  return Math.max(0, Number(settings.time_before_final_vote_seconds ?? settings.time_before_poll_seconds) || 0) * 1000;
}

export function settingToRoomTimerMinutes(settings = getDecisionSettings()) {
  return settings.room_timer_minutes || 5;
}
