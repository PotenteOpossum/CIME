const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const DECISION_SETTING_RULES = {
  group_proactivity: { type: 'number', min: 1, max: 5 },
  consensus_sensitivity: { type: 'number', min: 1, max: 10 },
  check_response_validity: { type: 'boolean' },
  room_timer_minutes: { type: 'number', min: 1, max: 30 },
  poll_approval_threshold: { type: 'number', min: 1, max: 3 },
  minimum_votes_for_approval: { type: 'number', min: 1, max: 100 },
  minimum_live_voting_duration_minutes: { type: 'number', min: 0, max: 30 },
  consensus_stability_duration_seconds: { type: 'number', min: 0, max: 300 },
  live_voting_duration_minutes: { type: 'number', min: 1, max: 120 },
  suggestion_cooldown_seconds: { type: 'number', min: 0, max: 3600 },
  maximum_visible_options: { type: 'number', min: 2, max: 20 },
  poll_timer_minutes: { type: 'number', min: 1, max: 30 },
  convergence_summary_minutes: { type: 'number', min: 1, max: 10 },
  time_before_poll_seconds: { type: 'number', min: 0, max: 120 },
  user_poll_rate_limit: { type: 'number', min: 0, max: 11 },
  user_inactivity_timeout_minutes: { type: 'number', min: 3, max: 15 },
  clustering_strategy: { type: 'enum', values: ['random', 'homophilic', 'heterophilic', 'mixed', 'topic_preference'] },
  clustering_min_users_per_room: { type: 'number', min: 2, max: 50 },
  clustering_min_rooms: { type: 'number', min: 1, max: 50 },
  primary_model: { type: 'string' },
  cheap_model: { type: 'string' }
};

export const DECISION_SETTING_KEYS = Object.keys(DECISION_SETTING_RULES);

export function decisionSettingsToJson(settings = {}) {
  return JSON.stringify(
    Object.fromEntries(DECISION_SETTING_KEYS.map((key) => [key, settings[key]]).filter(([, value]) => value !== undefined)),
    null,
    2
  );
}

export function parseDecisionSettingsJson(text) {
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('The JSON root must be an object.');
  const unknownKeys = Object.keys(parsed).filter((key) => !DECISION_SETTING_RULES[key]);
  if (unknownKeys.length) throw new Error(`Unknown setting${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}.`);
  if (!Object.keys(parsed).length) throw new Error('Include at least one setting.');

  for (const [key, value] of Object.entries(parsed)) {
    const rule = DECISION_SETTING_RULES[key];
    if (rule.type === 'boolean' && typeof value !== 'boolean') throw new Error(`"${key}" must be true or false.`);
    if (rule.type === 'string' && typeof value !== 'string') throw new Error(`"${key}" must be a string.`);
    if (rule.type === 'enum' && !rule.values.includes(value)) {
      throw new Error(`"${key}" must be one of: ${rule.values.join(', ')}.`);
    }
    if (rule.type === 'number') {
      if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`"${key}" must be a whole number.`);
      if (value < rule.min || value > rule.max) throw new Error(`"${key}" must be between ${rule.min} and ${rule.max}.`);
    }
  }
  return parsed;
}

const optionalNumber = (value, path, min, max) => {
  if (value === undefined || value === null || value === '') return '';
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`"${path}" must be between ${min} and ${max}, or null.`);
  return value;
};

const unitValue = (value, path) => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`"${path}" must be a number from 0 to 1.`);
  return value;
};

export function simulationSettingsToJson({ model, seed, stopAt, participantUsers, agentPersonas, preferences }) {
  const personas = {};
  participantUsers.forEach((user) => {
    const config = agentPersonas[user.id];
    if (!config) return;
    personas[user.username] = {
      active: !!config.active,
      ocean: { ...config.ocean },
      backstory: config.backstory || '',
      stances: config.stances || {},
      gamma: config.gamma === '' ? null : config.gamma,
      omega: config.omega === '' ? null : config.omega,
      lambda: config.lambda === '' ? null : config.lambda,
      noOpinionProbability: config.noOpinionProbability === '' ? null : config.noOpinionProbability
    };
  });
  return JSON.stringify({ model, seed, stopAt, personas, preferences }, null, 2);
}

export function parseSimulationSettingsJson(text, { participantUsers, topics, currentPersonas, normalizeConfig }) {
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed)) throw new Error('The JSON root must be an object.');
  const allowedRootKeys = new Set(['model', 'seed', 'stopAt', 'personas', 'preferences']);
  const unknownRootKeys = Object.keys(parsed).filter((key) => !allowedRootKeys.has(key));
  if (unknownRootKeys.length) throw new Error(`Unknown top-level field${unknownRootKeys.length === 1 ? '' : 's'}: ${unknownRootKeys.join(', ')}.`);

  if (typeof parsed.model !== 'string' || !parsed.model.trim()) throw new Error('"model" must be a non-empty string.');
  if (!Number.isInteger(parsed.seed)) throw new Error('"seed" must be a whole number.');
  if (!['personal', 'discussing', 'convergence'].includes(parsed.stopAt)) {
    throw new Error('"stopAt" must be personal, discussing, or convergence.');
  }
  if (!isPlainObject(parsed.personas)) throw new Error('"personas" must be an object keyed by username.');
  if (!isPlainObject(parsed.preferences)) throw new Error('"preferences" must be an object keyed by topic.');

  const usersByName = new Map(participantUsers.map((user) => [user.username.toLowerCase(), user]));
  const topicSet = new Set(topics);
  const nextPersonas = { ...currentPersonas };

  for (const [username, raw] of Object.entries(parsed.personas)) {
    const user = usersByName.get(username.toLowerCase());
    if (!user) throw new Error(`No participant account exists for username "${username}".`);
    if (!isPlainObject(raw)) throw new Error(`Persona "${username}" must be an object.`);
    const allowedPersonaKeys = new Set(['active', 'ocean', 'backstory', 'stances', 'gamma', 'omega', 'lambda', 'noOpinionProbability']);
    const unknownPersonaKeys = Object.keys(raw).filter((key) => !allowedPersonaKeys.has(key));
    if (unknownPersonaKeys.length) throw new Error(`Unknown field in persona "${username}": ${unknownPersonaKeys.join(', ')}.`);
    if (typeof raw.active !== 'boolean') throw new Error(`"personas.${username}.active" must be true or false.`);
    if (!isPlainObject(raw.ocean)) throw new Error(`"personas.${username}.ocean" must be an object.`);
    const unknownTraits = Object.keys(raw.ocean).filter((trait) => !['O', 'C', 'E', 'A', 'N'].includes(trait));
    if (unknownTraits.length) throw new Error(`Unknown OCEAN trait for "${username}": ${unknownTraits.join(', ')}.`);
    const ocean = {};
    for (const trait of ['O', 'C', 'E', 'A', 'N']) ocean[trait] = unitValue(raw.ocean[trait], `personas.${username}.ocean.${trait}`);
    if (raw.backstory !== undefined && typeof raw.backstory !== 'string') throw new Error(`"personas.${username}.backstory" must be a string.`);
    if (raw.stances !== undefined && !isPlainObject(raw.stances)) throw new Error(`"personas.${username}.stances" must be an object.`);

    const stances = {};
    for (const [topic, stance] of Object.entries(raw.stances || {})) {
      if (!topicSet.has(topic)) throw new Error(`Unknown topic "${topic}" in persona "${username}".`);
      if (!isPlainObject(stance) || typeof stance.position !== 'string') {
        throw new Error(`Stance "${topic}" for "${username}" needs a text position and numeric intensity.`);
      }
      stances[topic] = {
        position: stance.position,
        intensity: unitValue(stance.intensity, `personas.${username}.stances.${topic}.intensity`)
      };
    }

    nextPersonas[user.id] = {
      ...normalizeConfig(currentPersonas[user.id], null, false, participantUsers.indexOf(user)),
      active: raw.active,
      ocean,
      backstory: raw.backstory || '',
      stances,
      gamma: optionalNumber(raw.gamma, `personas.${username}.gamma`, 0, 1),
      omega: optionalNumber(raw.omega, `personas.${username}.omega`, 0, 1),
      lambda: optionalNumber(raw.lambda, `personas.${username}.lambda`, 0, 100),
      noOpinionProbability: optionalNumber(raw.noOpinionProbability, `personas.${username}.noOpinionProbability`, 0, 1)
    };
  }

  const nextPreferences = {};
  for (const [topic, options] of Object.entries(parsed.preferences)) {
    if (!topicSet.has(topic)) throw new Error(`Unknown preference topic "${topic}".`);
    if (!Array.isArray(options) || options.some((option) => typeof option !== 'string')) {
      throw new Error(`Preferences for "${topic}" must be an array of strings.`);
    }
    if (options.length > 8) throw new Error(`Preferences for "${topic}" can contain at most 8 options.`);
    nextPreferences[topic] = [...options, ...Array(Math.max(0, 8 - options.length)).fill('')];
  }
  topics.forEach((topic) => {
    if (!nextPreferences[topic]) nextPreferences[topic] = ['', '', '', '', '', '', '', ''];
  });

  return {
    model: parsed.model.trim(),
    seed: parsed.seed,
    stopAt: parsed.stopAt,
    personas: nextPersonas,
    preferences: nextPreferences
  };
}
