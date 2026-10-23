import { storage, runId } from '../platform/context.js';
import { useEffect, useMemo, useState } from 'react';
import { apiRequest } from '../api/client.js';
import { parseSimulationSettingsJson, simulationSettingsToJson } from '../utils/adminJsonConfig.js';
import { randomizeActiveOcean } from '../utils/simulationPersonality.js';

// Big Five / OCEAN traits. Each maps to a concrete behavioral hook in the agent model
// (see backend simulationAgentModel.js).
const OCEAN_TRAITS = [
  { key: 'O', label: 'Openness', hint: 'Willingness to consider new options / be moved by arguments (ω, propose rate).' },
  { key: 'C', label: 'Conscientiousness', hint: 'Decisiveness/consistency (λ softmax temperature) and low abstention.' },
  { key: 'E', label: 'Extraversion', hint: 'How often and how much the agent speaks (p_speak, verbosity).' },
  { key: 'A', label: 'Agreeableness', hint: 'Susceptibility to the majority (conformity γ).' },
  { key: 'N', label: 'Neuroticism', hint: 'Choice volatility: higher values lower softmax precision (λ).' }
];

const DEFAULT_OCEAN = { O: 0.5, C: 0.5, E: 0.5, A: 0.5, N: 0.3 };

// Bulk autofill cycles through these lenses so a simulation starts with
// structured disagreement instead of five near-identical neutral personas.
const PERSONA_PERSPECTIVES = [
  'supportive',
  'skeptical',
  'cost_focused',
  'accessibility_focused',
  'implementation_focused'
];

const PERSONA_AUTOFILL_MODES = [
  {
    value: 'mixed_perspectives',
    label: 'Mixed perspectives',
    description: 'Different priorities with overlapping interests and moderate, revisable positions.'
  },
  {
    value: 'strong_disagreement',
    label: 'Strong disagreement',
    description: 'A balanced, respectful split between strong support and strong opposition, varying by topic.'
  }
];

const PERSONA_INFO = {
  title: 'Agent Personalities & Stances',
  description: 'Each simulated participant has an identity layer and a decision-behavior layer. The identity layer provides the backstory, OCEAN traits, and initial position on each deliberation topic. The behavior layer uses those values to decide when the agent speaks and how it votes; the LLM generates the natural-language messages.',
  sections: [
    {
      title: 'Randomize OCEAN',
      items: [
        'Randomize OCEAN changes the five trait sliders for active agents only. It runs locally, costs no API calls, and keeps backstories, topic stances, and advanced overrides unchanged.',
        'Each trait is sampled independently from a normal distribution centered at 0.50 with a standard deviation of 0.18. Draws outside 0.15 to 0.85 are resampled, and values are rounded to the sliders\' 0.05 steps. Moderate values are more common than extremes; a small group is not guaranteed an exact balance.',
        'This is a synthetic population for software experiments. The sampling parameters are modeling choices, not measured human norms. The generator does not reproduce correlations between traits or differences between demographic groups, and it does not establish that the agents behave like real people.',
        'Values are saved in this browser and included in the simulation configuration JSON. Changing the run seed or using either AI autofill mode does not regenerate them. Click Randomize OCEAN only once if you want the same personalities across all runs.',
        'Leave advanced coefficient overrides blank to let the behavior model derive them from OCEAN. Existing overrides take precedence over their corresponding traits.'
      ]
    },
    {
      title: 'Identity and behavior',
      items: [
        'Backstory / personality context gives the agent a coherent social and practical perspective. It is included in the agent prompt, but it does not override the decision process rules.',
        'OCEAN values range from 0 to 1. Openness affects willingness to consider new arguments, conscientiousness affects consistency and abstention, extraversion affects participation, agreeableness affects conformity, and neuroticism affects vote volatility.',
        'Each topic has an initial stance and an intensity. The stance seeds disagreement; it is not a fixed answer. Agents can still change their position after arguments and group discussion.',
        'The simulation policy controls participation gates and vote choice. A deterministic seed makes routing and random behavioral draws reproducible, while LLM wording can still vary.'
      ]
    },
    {
      title: 'Autofill with AI',
      items: [
        'Autofill uses the saved Global Question, Additional Context, General Description, deliberation topics, predefined options, and any stored participant profile information.',
        'The LLM returns a backstory plus one position and intensity value for every configured topic. Results are merged into the selected persona without replacing OCEAN values, advanced coefficient overrides, or other manual settings.',
        'Bulk autofill supports Mixed perspectives and Strong disagreement. Both modes assign five lenses in order: supportive, skeptical, cost-focused, accessibility-focused, and implementation-focused. Strong disagreement additionally asks for a balanced split between strong support and strong opposition, varying by topic.',
        'Each agent is generated through a separate primary-model call. If some calls fail, successful personas are retained and the failed count is reported.'
      ]
    },
    {
      title: 'How to use it',
      items: [
        'Activate the agents you want to simulate and click Randomize OCEAN once. Then choose an autofill mode and use Autofill with AI to generate their backstories and stances. You can edit every generated field afterward.',
        'For a comparison of Mixed perspectives and Strong disagreement, retain the same OCEAN values and active users. Save each condition using Edit JSON and change only the run seed between repetitions. Import the saved JSON when using another browser or computer.',
        'Use the individual Autofill with AI button when you want to regenerate only one agent. The bulk lens assignment is based on the active-agent order shown in this list.'
      ]
    }
  ]
};

const SIMULATION_INFO = {
  title: 'How the Agent Simulation Works',
  description:
    'Each simulated participant is an LLM agent with two layers. An IDENTITY layer — a free-text backstory, a Big Five (OCEAN) personality vector, and a per-topic initial stance — makes each agent a distinct person with its own opinions and is injected into the language prompt. A POLICY layer decides, with explicit mathematics, when the agent speaks (Bernoulli participation gates derived from OCEAN) and how it votes (a random-utility / softmax discrete-choice model). The LLM writes the words; the vote is computed from the model, so every persona knob is an auditable coefficient.',
  notes: [
    'Persona/backstory conditioning follows the "silicon sampling" approach of Argyle et al. (2023), "Out of One, Many", Political Analysis, and the generative-agent design of Park et al. (2023) (arXiv:2304.03442).',
    'The vote model is a random-utility (softmax / conditional-logit) discrete choice: U(option) = β_pref·(own stance alignment) + β_soc·γ·(current majority share) + β_arg·ω·(argument alignment), with P(option) ∝ exp(λ·U). This is the McFadden (1974) discrete-choice framework.',
    'The current-support term is an explicit social-influence/conformity mechanism. It is not a bounded-confidence model because it does not impose a confidence radius; low γ limits majority influence and helps counter documented LLM agreement bias.',
    'Participation gates: p_speak = σ(k·(Extraversion−½)); propose-new-option = c·Openness; abstention = d·(1−Conscientiousness); decisiveness λ scales with Conscientiousness.',
    'A run seed reproduces routing and behavioral random draws. LLM-generated wording can still vary, so the seed, model, prompts, settings, and outputs must all be retained in an experiment manifest.',
    'Simulated agents are more coherent and compliant than real participants; a passing simulation validates process mechanics, not human behavior.'
  ]
};

function normalizeConfig(saved, running, isRunning, index) {
  const src = isRunning ? running : (saved || running);
  const ocean = { ...DEFAULT_OCEAN, ...(src?.ocean || {}) };
  return {
    active: isRunning ? !!running : (saved ? saved.active : index < 4),
    ocean,
    backstory: src?.backstory || '',
    stances: src?.stances || {},
    gamma: src?.gamma ?? '',
    omega: src?.omega ?? '',
    lambda: src?.lambda ?? '',
    noOpinionProbability: src?.noOpinionProbability ?? ''
  };
}

export default function SimulationTab({
  token,
  users = [],
  deliberationQuestions = [],
  globalQuestion = '',
  decisionContext = '',
  generalDescription = '',
  generalQuestionAnswers = []
}) {
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoff, setHandoff] = useState(null);
  const [handoffError, setHandoffError] = useState('');
  const [topics, setTopics] = useState([]);
  const [status, setStatus] = useState({ isRunning: false, stopAt: 'personal', model: 'gpt-5.6-luna', seed: 20260720, personas: {}, preferences: {} });

  const [model, setModel] = useState('gpt-5.6-luna');
  const [seed, setSeed] = useState(20260720);
  const [stopAt, setStopAt] = useState('personal');
  const [agentPersonas, setAgentPersonas] = useState({});
  const [showInfo, setShowInfo] = useState(false);
  const [showPersonaInfo, setShowPersonaInfo] = useState(false);
  const [oceanNotice, setOceanNotice] = useState('');
  const [expanded, setExpanded] = useState(null); // userId whose editor is open
  const [autofillingUserId, setAutofillingUserId] = useState(null);
  const [autofillingAll, setAutofillingAll] = useState(false);
  const [autofillMode, setAutofillMode] = useState(() => storage.getItem('sim_autofill_mode') || 'mixed_perspectives');
  const [preferences, setPreferences] = useState({});
  const [simulationUsers, setSimulationUsers] = useState([]);
  const [newParticipantNames, setNewParticipantNames] = useState('');
  const [newParticipantPassword, setNewParticipantPassword] = useState('');
  const [addingParticipants, setAddingParticipants] = useState(false);
  const [isJsonMode, setIsJsonMode] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');
  const participantUsers = useMemo(() => {
    const merged = new Map();
    users.filter((user) => !user.is_admin).forEach((user) => merged.set(String(user.id), user));
    simulationUsers.forEach((user) => merged.set(String(user.id), user));
    return [...merged.values()].sort((a, b) => a.username.localeCompare(b.username));
  }, [users, simulationUsers]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [decisionData, statusData, userData] = await Promise.all([
        apiRequest('/admin/decision-process', {}, token),
        apiRequest('/admin/simulation/status', {}, token),
        apiRequest('/admin/simulation/users', {}, token)
      ]);
      const fetchedUsers = userData.users || [];
      setSimulationUsers(fetchedUsers);

      const isRunning = statusData.isRunning || statusData.canResume;
      setStatus(statusData);

      const deliberationQ = deliberationQuestions.length > 0 ? deliberationQuestions : (decisionData.deliberation_questions || []);
      const uniqueTopics = [...new Set(deliberationQ.filter(q => !q.is_general_question).map(q => q.topic))];
      setTopics(uniqueTopics);

      const savedModel = storage.getItem('sim_model');
      const savedSeed = storage.getItem('sim_seed');
      const savedStopAt = storage.getItem('sim_stopAt');
      const savedPersonasRaw = storage.getItem('sim_personas');
      const savedPrefsRaw = storage.getItem('sim_preferences');

      const legacySimulationModels = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-5.4', 'gpt-5.4-mini']);
      const usableSavedModel = legacySimulationModels.has(savedModel) ? 'gpt-5.6-luna' : savedModel;
      setModel(isRunning ? (statusData.model || 'gpt-5.6-luna') : (usableSavedModel || statusData.model || 'gpt-5.6-luna'));
      setSeed(Number(isRunning ? statusData.seed : (savedSeed || statusData.seed || 20260720)));
      setStopAt(isRunning ? (statusData.stopAt || 'personal') : (savedStopAt || statusData.stopAt || 'personal'));

      let savedPersonas = {};
      if (savedPersonasRaw) { try { savedPersonas = JSON.parse(savedPersonasRaw); } catch (e) {} }

      const initialPersonas = {};
      const loadedParticipantUsers = [...new Map([
        ...users.filter((user) => !user.is_admin),
        ...fetchedUsers
      ].map((user) => [String(user.id), user])).values()]
        .sort((a, b) => a.username.localeCompare(b.username));
      loadedParticipantUsers.forEach((u, index) => {
        initialPersonas[u.id] = normalizeConfig(savedPersonas[u.id], statusData.personas?.[u.id], isRunning, index);
      });
      setAgentPersonas(initialPersonas);

      let savedPrefs = {};
      if (savedPrefsRaw) { try { savedPrefs = JSON.parse(savedPrefsRaw); } catch (e) {} }
      const initialPrefs = {};
      uniqueTopics.forEach(topic => {
        const runningPrefs = statusData.preferences?.[topic] || [];
        const savedTopicPrefs = savedPrefs[topic] || [];
        const source = isRunning ? runningPrefs : (savedTopicPrefs.length > 0 ? savedTopicPrefs : runningPrefs);
        const padded = [...source];
        while (padded.length < 8) padded.push('');
        initialPrefs[topic] = padded;
      });
      setPreferences(initialPrefs);
    } catch (e) {
      console.error('Failed to load simulation settings:', e);
    } finally {
      setLoading(false);
    }
  };

  const checkStatus = async () => {
    try {
      setStatus(await apiRequest('/admin/simulation/status', {}, token));
    } catch (e) {
      console.error('Error checking simulation status:', e);
    }
  };

  useEffect(() => { loadData(); }, [token, users]);
  useEffect(() => {
    const interval = setInterval(checkStatus, 3000);
    return () => clearInterval(interval);
  }, [token]);

  useEffect(() => {
    if (deliberationQuestions.length > 0) {
      const uniqueTopics = [...new Set(deliberationQuestions.filter(q => !q.is_general_question).map(q => q.topic))];
      setTopics(uniqueTopics);
      setPreferences(prev => {
        const next = { ...prev };
        let modified = false;
        uniqueTopics.forEach(topic => {
          if (!next[topic]) { next[topic] = ['', '', '', '', '', '', '', '']; modified = true; }
        });
        if (modified) { storage.setItem('sim_preferences', JSON.stringify(next)); return next; }
        return prev;
      });
    }
  }, [deliberationQuestions]);

  const handleModelChange = (val) => { setModel(val); storage.setItem('sim_model', val); };
  const handleSeedChange = (val) => {
    const next = Number.isFinite(Number(val)) ? Math.trunc(Number(val)) : 20260720;
    setSeed(next);
    storage.setItem('sim_seed', String(next));
  };
  const handleStopAtChange = (val) => { setStopAt(val); storage.setItem('sim_stopAt', val); };

  const persist = (next) => { storage.setItem('sim_personas', JSON.stringify(next)); return next; };

  const handleRandomizeOcean = () => {
    if (status.isRunning || isJsonMode || autofillingAll || autofillingUserId !== null) return;
    // Draw once in the event handler, not inside a React state updater that can replay.
    const next = randomizeActiveOcean(agentPersonas, participantUsers);
    const count = participantUsers.filter((user) => next[user.id] !== agentPersonas[user.id]).length;
    if (!count) return;
    setAgentPersonas(persist(next));
    setOceanNotice(`Randomized OCEAN for ${count} active agent${count === 1 ? '' : 's'} and saved in this browser. Keep these values for all runs; AI autofill and run-seed changes preserve them.`);
  };

  const handlePersonaChange = (userId, key, val) => {
    setAgentPersonas(prev => persist({ ...prev, [userId]: { ...prev[userId], [key]: val } }));
  };
  const handleOceanChange = (userId, trait, val) => {
    setAgentPersonas(prev => persist({
      ...prev,
      [userId]: { ...prev[userId], ocean: { ...prev[userId].ocean, [trait]: val } }
    }));
  };
  const handleStanceChange = (userId, topic, field, val) => {
    setAgentPersonas(prev => {
      const cur = prev[userId].stances?.[topic] || { position: '', intensity: 0.5 };
      return persist({
        ...prev,
        [userId]: { ...prev[userId], stances: { ...prev[userId].stances, [topic]: { ...cur, [field]: val } } }
      });
    });
  };

  const handleAutofillModeChange = (value) => {
    setAutofillMode(value);
    storage.setItem('sim_autofill_mode', value);
  };

  const requestPersonaAutofill = (user, { perspective, assignmentIndex, populationSize }) => apiRequest('/admin/simulation/generate-persona', {
        method: 'POST',
        body: JSON.stringify({
          username: user.username,
          perspective,
          autofillMode,
          assignmentIndex,
          populationSize,
          userProfile: {
            profile_info: user.profile_info || '',
            extracted_preferences: user.extracted_preferences || ''
          },
          globalQuestion,
          decisionContext,
          generalDescription,
          deliberationQuestions
        })
      }, token);

  const mergePersonaAutofill = (previous, user, result) => ({
    ...previous,
    [user.id]: {
      ...previous[user.id],
      backstory: result.backstory || previous[user.id]?.backstory || '',
      stances: { ...(previous[user.id]?.stances || {}), ...(result.stances || {}) }
    }
  });

  const handleAutofillPersona = async (user) => {
    setAutofillingUserId(user.id);
    try {
      const userIndex = Math.max(0, participantUsers.findIndex((candidate) => candidate.id === user.id));
      const perspective = PERSONA_PERSPECTIVES[userIndex % PERSONA_PERSPECTIVES.length];
      const result = await requestPersonaAutofill(user, {
        perspective,
        assignmentIndex: userIndex,
        populationSize: participantUsers.length
      });
      setAgentPersonas(prev => persist(mergePersonaAutofill(prev, user, result)));
    } catch (error) {
      alert(`Could not generate persona: ${error.message}`);
    } finally {
      setAutofillingUserId(null);
    }
  };

  const handleAutofillAll = async () => {
    const selectedUsers = participantUsers.filter((user) => agentPersonas[user.id]?.active);
    if (selectedUsers.length === 0) {
      alert('Activate at least one agent before using Autofill with AI.');
      return;
    }

    setAutofillingAll(true);
    try {
      const results = await Promise.allSettled(
        selectedUsers.map(async (user, index) => ({
          user,
          perspective: PERSONA_PERSPECTIVES[index % PERSONA_PERSPECTIVES.length],
          result: await requestPersonaAutofill(user, {
            perspective: PERSONA_PERSPECTIVES[index % PERSONA_PERSPECTIVES.length],
            assignmentIndex: index,
            populationSize: selectedUsers.length
          })
        }))
      );
      const successful = results.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
      if (successful.length > 0) {
        setAgentPersonas(prev => {
          const next = successful.reduce((accumulator, entry) => mergePersonaAutofill(accumulator, entry.user, entry.result), { ...prev });
          return persist(next);
        });
      }
      const failed = results.filter((entry) => entry.status === 'rejected');
      if (failed.length > 0) {
        alert(`Generated ${successful.length} of ${selectedUsers.length} personas. ${failed.length} failed; successful results were kept.`);
      }
    } finally {
      setAutofillingAll(false);
    }
  };

  const handlePreferenceOptionChange = (topic, index, val) => {
    setPreferences(prev => {
      const topicPrefs = [...(prev[topic] || [])];
      topicPrefs[index] = val;
      const next = { ...prev, [topic]: topicPrefs };
      storage.setItem('sim_preferences', JSON.stringify(next));
      return next;
    });
  };

  const handleStartSimulation = async () => {
    const activePersonas = {};
    Object.entries(agentPersonas).forEach(([userId, config]) => {
      if (!config.active) return;
      const ocean = {};
      OCEAN_TRAITS.forEach(t => { ocean[t.key] = Number(config.ocean?.[t.key] ?? DEFAULT_OCEAN[t.key]); });
      const stances = {};
      Object.entries(config.stances || {}).forEach(([topic, s]) => {
        if (s && String(s.position || '').trim()) {
          stances[topic] = { position: String(s.position).trim(), intensity: Number(s.intensity ?? 0.5) };
        }
      });
      const num = (v) => (v !== '' && v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : undefined);
      activePersonas[userId] = {
        ocean,
        backstory: String(config.backstory || '').trim(),
        stances,
        ...(num(config.gamma) !== undefined ? { gamma: num(config.gamma) } : {}),
        ...(num(config.omega) !== undefined ? { omega: num(config.omega) } : {}),
        ...(num(config.lambda) !== undefined ? { lambda: num(config.lambda) } : {}),
        ...(num(config.noOpinionProbability) !== undefined ? { noOpinionProbability: num(config.noOpinionProbability) } : {})
      };
    });

    const cleanPreferences = {};
    Object.entries(preferences).forEach(([topic, opts]) => {
      const filtered = opts.map(o => o.trim()).filter(Boolean);
      if (filtered.length > 0) cleanPreferences[topic] = filtered;
    });

    try {
      setStarting(true);
      await apiRequest(status.canResume ? '/admin/simulation/resume' : '/admin/simulation/start', {
        method: 'POST',
        body: JSON.stringify({
          stopAt, model, seed, personas: activePersonas, preferences: cleanPreferences,
          globalQuestion, decisionContext, generalDescription, deliberationQuestions, generalQuestionAnswers
        })
      }, token);
      await checkStatus();
    } catch (e) {
      alert(`Failed to start simulation: ${e.message}`);
    } finally { setStarting(false); }
  };

  const handleAddParticipants = async () => {
    const names = [...new Set(newParticipantNames.split(/[\n,]+/).map(name => name.trim()).filter(Boolean))];
    if (!names.length) return alert('Enter at least one username.');
    if (newParticipantPassword.length < 6) return alert('The shared password must be at least 6 characters.');
    setAddingParticipants(true);
    try {
      await apiRequest('/admin/simulation/users', {
        method: 'POST',
        body: JSON.stringify({ usernames: names, password: newParticipantPassword })
      }, token);
      setNewParticipantNames('');
      setNewParticipantPassword('');
      await loadData();
    } catch (error) {
      alert(`Could not add participants: ${error.message}`);
    } finally {
      setAddingParticipants(false);
    }
  };

  const setAllParticipantsActive = (active) => {
    setAgentPersonas(prev => {
      const next = { ...prev };
      participantUsers.forEach((user, index) => {
        next[user.id] = {
          ...(next[user.id] || normalizeConfig(null, null, false, index)),
          active
        };
      });
      return persist(next);
    });
  };

  const openJsonEditor = () => {
    setJsonDraft(simulationSettingsToJson({ model, seed, stopAt, participantUsers, agentPersonas, preferences }));
    setIsJsonMode(true);
  };

  const applyJsonEditor = () => {
    try {
      const next = parseSimulationSettingsJson(jsonDraft, {
        participantUsers,
        topics,
        currentPersonas: agentPersonas,
        normalizeConfig
      });
      setModel(next.model);
      setSeed(next.seed);
      setStopAt(next.stopAt);
      setAgentPersonas(next.personas);
      setPreferences(next.preferences);
      storage.setItem('sim_model', next.model);
      storage.setItem('sim_seed', String(next.seed));
      storage.setItem('sim_stopAt', next.stopAt);
      storage.setItem('sim_personas', JSON.stringify(next.personas));
      storage.setItem('sim_preferences', JSON.stringify(next.preferences));
      setIsJsonMode(false);
    } catch (error) {
      alert(`Invalid simulation JSON: ${error.message}`);
    }
  };

  const handleManualHandoff = async () => {
    setHandoffBusy(true);
    setHandoffError('');
    try {
      const response = await fetch(`/api/platform/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load the invitation link.');
      const result = await apiRequest('/admin/simulation/handoff', { method: 'POST' }, token);
      setHandoff({ ...result, inviteUrl: data.run.invite_url });
      setStatus(result.status);
    } catch (error) {
      setHandoffError(error.message);
    } finally {
      setHandoffBusy(false);
    }
  };

  const handleStopSimulation = async () => {
    try { await apiRequest('/admin/simulation/stop', { method: 'POST' }, token); await checkStatus(); }
    catch (e) { alert(`Failed to stop simulation: ${e.message}`); }
  };


  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent"></div>
        <span className="ml-3 text-slate-400">Loading simulation settings...</span>
      </div>
    );
  }

  const totalActiveAgents = Object.values(agentPersonas).filter(p => p.active).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-bold tracking-tight text-slate-100 font-sans">Agent Simulation Dashboard</h2>
            <button
              type="button"
              onClick={() => setShowInfo(true)}
              className="flex h-6 w-6 items-center justify-center rounded-full border border-slate-600 text-xs font-bold text-slate-400 hover:border-blue-500 hover:text-blue-400 transition-colors"
              title="How the simulation works and which literature it follows"
            >
              i
            </button>
          </div>
          <p className="text-sm text-slate-400 mt-1">Configure Big Five personalities and per-topic stances, then launch a reproducible agent deliberation.</p>
        </div>
        <div className="flex items-center gap-3">
          {!status.isRunning && (
            <button
              type="button"
              onClick={isJsonMode ? applyJsonEditor : openJsonEditor}
              className={`rounded-lg border px-4 py-2 text-sm font-semibold transition-colors ${isJsonMode ? 'border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500' : 'border-slate-700 bg-slate-800 text-slate-300 hover:border-blue-500 hover:text-blue-300'}`}
            >
              {isJsonMode ? 'Apply JSON' : 'Edit JSON'}
            </button>
          )}
      {isJsonMode && !status.isRunning && (
            <button type="button" onClick={() => setIsJsonMode(false)} className="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-400 hover:text-white">
              Cancel
            </button>
          )}
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border ${status.isRunning ? 'bg-emerald-950/45 text-emerald-400 border-emerald-800/40 animate-pulse' : 'bg-slate-800/45 text-slate-400 border-slate-700/50'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${status.isRunning ? 'bg-emerald-500' : 'bg-slate-500'}`} />
            {status.isRunning ? 'Simulation Running' : status.canResume ? 'Simulation Paused' : 'Simulation Stopped'}
          </span>
          {status.isRunning ? (
            <button onClick={handleStopSimulation} className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-red-500 transition-colors">
              Stop Simulation
            </button>
          ) : (
            <button onClick={handleStartSimulation} disabled={handoffBusy || starting || totalActiveAgents === 0 || (status.hasStarted && !status.canResume)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-500 transition-colors disabled:opacity-40">
              {starting ? 'Starting…' : status.canResume ? 'Resume Simulation' : 'Start Simulation'}
            </button>
          )}
        </div>
      </div>

          {(status.isRunning || status.canResume) && (
        <div className="rounded-xl border border-slate-300 p-5 space-y-3">
          <h3 className="font-semibold">Continue manually</h3>
          <p className="text-sm text-slate-500">Pause all AI participants and get recovery codes to take over their existing rooms. Decision timers continue running. Stop Simulation ends the decision.</p>
          <button type="button" disabled={handoffBusy || starting} onClick={handleManualHandoff} className="platform-button secondary disabled:opacity-50">
            {handoffBusy ? 'Preparing recovery codes…' : handoff ? 'Replace recovery codes' : 'Pause agents & get recovery codes'}
          </button>
          {handoffError && <p role="alert" className="text-sm text-red-600">{handoffError}</p>}
          {handoff && <div className="space-y-3">
            <p className="text-sm">Save these codes now; only their hashes are stored. Replacing them invalidates the previous codes. Open the invitation in a separate browser profile or private window for each participant, and choose recovery code access.</p>
            <a className="platform-button secondary" href={handoff.inviteUrl} target="_blank" rel="noreferrer">Open invitation</a>
            {handoff.participants.map((participant) => <div key={participant.id} className="flex flex-wrap items-center gap-3">
              <strong>{participant.username}</strong>
              <input aria-label={`Recovery code for ${participant.username}`} readOnly value={participant.recoveryCode} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm" onFocus={(event) => event.target.select()} />
              <button type="button" className="platform-button secondary" onClick={async () => { try { await navigator.clipboard.writeText(participant.recoveryCode); } catch { setHandoffError('Copy failed. Select the code and copy it manually.'); } }}>Copy code</button>
            </div>)}
          </div>}
        </div>
      )}

      {status.lastError && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-700">Simulation error: {status.lastError}</p>}
      {status.hasStarted && !status.isRunning && !status.canResume && <p className="rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">This run has ended. Use Create another run on the decision setup page to run a new simulation.</p>}

      {isJsonMode && !status.isRunning && (
        <div className="rounded-xl border border-emerald-700/50 bg-slate-900/60 p-5">
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-emerald-300">Simulation configuration JSON</h3>
            <p className="mt-1 text-xs text-slate-400">Personas are keyed by username, so this configuration remains portable when database user IDs change.</p>
          </div>
          <textarea
            value={jsonDraft}
            onChange={(event) => setJsonDraft(event.target.value)}
            spellCheck={false}
            className="min-h-[36rem] w-full rounded-xl border border-emerald-500/30 bg-slate-950 p-4 font-mono text-xs leading-5 text-emerald-100 focus:border-emerald-400 focus:outline-none"
          />
          <p className="mt-2 text-[11px] text-slate-500">All named personas must already exist as participant accounts. OCEAN values, stance intensity, gamma, omega, and abstention probability use the 0 to 1 range.</p>
        </div>
      )}

      {/* Global Config cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-4">
          <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800/60 pb-2">Simulation Engine Settings</h3>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-400 block mb-1">Agent Model</label>
              <select value={model} onChange={(e) => handleModelChange(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 focus:border-blue-500 focus:outline-none">
                <option value="gpt-5.6-luna">GPT 5.6 Luna (Fast)</option>
                <option value="gpt-5.6-terra">GPT 5.6 Terra (Balanced)</option>
                <option value="gpt-5.6-sol">GPT 5.6 Sol (Highest quality)</option>
                <option value="gpt-5.4-mini">GPT 5.4 Mini (Legacy)</option>
                <option value="gpt-4o-mini">GPT 4o Mini (Legacy)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Run seed</label>
              <input
                type="number"
                step="1"
                value={seed}
                disabled={status.isRunning || status.hasStarted}
                onChange={(event) => handleSeedChange(event.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 focus:border-blue-500 focus:outline-none disabled:opacity-50"
              />
              <p className="text-[10px] text-slate-500 mt-1 leading-normal">Reproduces routing and behavioral random draws; generated wording may still vary.</p>
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1">Stop Simulation Phase</label>
              <select value={stopAt} disabled={status.isRunning} onChange={(e) => handleStopAtChange(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-200 focus:border-blue-500 focus:outline-none">
                <option value="personal">Pause before the personal openness vote</option>
                <option value="discussing">Pause before the group final vote</option>
                <option value="convergence">Run through Convergence (Full complete)</option>
              </select>
              <p className="text-[10px] text-slate-500 mt-1 leading-normal">Pausing stops the agents while decision timers continue. Select a later phase and Resume Simulation to continue. Stop Simulation ends the run.</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800/60 pb-2 mb-3">Personality Model (OCEAN)</h3>
            <ul className="space-y-1.5 text-[11px] text-slate-400">
              {OCEAN_TRAITS.map(t => (
                <li key={t.key} className="flex gap-2">
                  <span className="font-bold text-blue-400 w-4">{t.key}</span>
                  <span><strong className="text-slate-300">{t.label}.</strong> {t.hint}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="text-[11px] text-slate-500 border-t border-slate-800/60 pt-2.5 mt-3 flex justify-between items-center">
            <span>Active Agents: <strong className="text-slate-300">{totalActiveAgents}</strong></span>
            <span>Available Users: <strong className="text-slate-300">{participantUsers.length}</strong></span>
          </div>
        </div>
      </div>

      {/* Persona Assignment */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="border-b border-slate-800/60 pb-4 mb-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-200">Agent Personalities & Stances</h3>
              <button
                type="button"
                onClick={() => setShowPersonaInfo(true)}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-600 text-[10px] font-bold text-slate-400 transition-colors hover:border-blue-500 hover:text-blue-400"
                title="How simulated agents, OCEAN randomization, and AI autofill work"
                aria-label="About Agent Personalities & Stances"
              >
                i
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <label className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/60 px-2.5 py-1 text-[11px] text-slate-400">
                <span className="whitespace-nowrap">Autofill mode</span>
                <select
                  value={autofillMode}
                  disabled={status.isRunning || participantUsers.length === 0 || autofillingAll}
                  onChange={(event) => handleAutofillModeChange(event.target.value)}
                  title={PERSONA_AUTOFILL_MODES.find((mode) => mode.value === autofillMode)?.description}
                  className="max-w-[10rem] bg-transparent text-[11px] font-semibold text-slate-200 outline-none disabled:opacity-50"
                >
                  {PERSONA_AUTOFILL_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value} className="bg-slate-900">
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                disabled={status.isRunning || participantUsers.length === 0}
                onClick={() => setAllParticipantsActive(true)}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-blue-500 hover:text-blue-300 disabled:opacity-40"
              >
                Activate all
              </button>
              <button
                type="button"
                disabled={status.isRunning || participantUsers.length === 0}
                onClick={() => setAllParticipantsActive(false)}
                className="rounded-md border border-slate-700 px-2.5 py-1 text-[11px] font-semibold text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40"
              >
                Deactivate all
              </button>
              <button
                type="button"
                disabled={status.isRunning || isJsonMode || totalActiveAgents === 0 || autofillingAll || autofillingUserId !== null}
                onClick={handleRandomizeOcean}
                title="Generate moderate, varied OCEAN traits for active agents. Saved locally; no AI calls."
                className="rounded-md border border-blue-700/70 bg-blue-950/30 px-2.5 py-1 text-[11px] font-semibold text-blue-300 hover:border-blue-500 hover:text-blue-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Randomize OCEAN
              </button>
              <button
                type="button"
                disabled={status.isRunning || participantUsers.length === 0 || autofillingAll}
                onClick={handleAutofillAll}
                className="rounded-md border border-emerald-700/70 bg-emerald-950/30 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 hover:border-emerald-500 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-40"
              >
                {autofillingAll ? 'Autofilling...' : 'Autofill with AI'}
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] leading-5 text-slate-400">
            Every simulated agent uses a non-admin participant account. Mixed perspectives creates overlapping priorities; Strong disagreement creates a balanced, respectful split in starting positions while keeping the same personality and behavior model.
          </p>
          {oceanNotice && (
            <p role="status" className="mt-2 text-[11px] leading-5 text-blue-300">{oceanNotice}</p>
          )}
          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-[minmax(0,1fr)_14rem_auto]">
            <textarea
              rows={2}
              value={newParticipantNames}
              disabled={status.isRunning || addingParticipants}
              onChange={(event) => setNewParticipantNames(event.target.value)}
              placeholder="Usernames separated by commas or new lines"
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
            <input
              type="password"
              value={newParticipantPassword}
              disabled={status.isRunning || addingParticipants}
              onChange={(event) => setNewParticipantPassword(event.target.value)}
              placeholder="Shared password (6+ characters)"
              className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleAddParticipants}
              disabled={status.isRunning || addingParticipants || !newParticipantNames.trim()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {addingParticipants ? 'Adding...' : 'Add participants'}
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">
            These are persistent accounts and also appear in Users. Existing usernames are never replaced.
          </p>
        </div>
        <div className="space-y-2">
          {participantUsers.map(u => {
            const config = agentPersonas[u.id] || normalizeConfig(null, null, false, 99);
            const isOpen = expanded === u.id;
            return (
              <div key={u.id} className={`rounded-lg border ${config.active ? 'border-slate-700 bg-slate-900/40' : 'border-slate-800/60 bg-slate-950/20'}`}>
                <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <input type="checkbox" checked={config.active}
                    onChange={(e) => handlePersonaChange(u.id, 'active', e.target.checked)}
                    className="rounded border-slate-700 bg-slate-800 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer" />
                  <span className={`font-mono text-xs font-semibold w-28 ${config.active ? 'text-slate-200' : 'text-slate-500'}`}>{u.username}</span>
                  <div className="flex items-center gap-3 flex-1 flex-wrap">
                    {OCEAN_TRAITS.map(t => (
                      <label key={t.key} className={`flex items-center gap-1.5 ${config.active ? '' : 'opacity-40'}`} title={`${t.label}: ${t.hint}`}>
                        <span className="text-[10px] font-bold text-slate-400">{t.key}</span>
                        <input type="range" min="0" max="1" step="0.05" disabled={!config.active}
                          value={config.ocean?.[t.key] ?? DEFAULT_OCEAN[t.key]}
                          onChange={(e) => handleOceanChange(u.id, t.key, Number(e.target.value))}
                          className="w-16 accent-blue-500 cursor-pointer" />
                        <span className="text-[10px] text-slate-500 w-6 tabular-nums">{Number(config.ocean?.[t.key] ?? DEFAULT_OCEAN[t.key]).toFixed(2)}</span>
                      </label>
                    ))}
                  </div>
                  <button type="button" disabled={!config.active} onClick={() => setExpanded(isOpen ? null : u.id)}
                    className="text-[11px] rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-blue-500 hover:text-blue-400 disabled:opacity-40">
                    {isOpen ? 'Close' : 'Backstory & stances'}
                  </button>
                </div>

                {isOpen && config.active && (
                  <div className="border-t border-slate-800/60 px-3 py-3 space-y-4">
                    <div>
                      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                        <label className="text-[11px] text-slate-400">Backstory / personality context (injected into the agent's prompt)</label>
                        <button
                          type="button"
                          disabled={autofillingUserId === u.id || autofillingAll}
                          onClick={() => handleAutofillPersona(u)}
                          className="rounded-md border border-emerald-700/70 bg-emerald-950/30 px-2.5 py-1 text-[10px] font-semibold text-emerald-300 hover:border-emerald-500 hover:text-emerald-200 disabled:cursor-wait disabled:opacity-50"
                        >
                          {autofillingUserId === u.id ? 'Generating...' : 'Autofill with AI'}
                        </button>
                      </div>
                      <textarea rows={3} value={config.backstory}
                        onChange={(e) => handlePersonaChange(u.id, 'backstory', e.target.value)}
                        placeholder="e.g. A night-shift nurse who values accessibility and cost; skeptical of flashy options, warms up when given concrete reasons."
                        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2 text-xs text-slate-200 focus:border-blue-500 focus:outline-none placeholder:text-slate-600" />
                    </div>

                    {topics.length > 0 && (
                      <div>
                        <label className="text-[11px] text-slate-400 block mb-1.5">Initial stance per topic (seed of disagreement)</label>
                        <div className="space-y-2">
                          {topics.map(topic => {
                            const s = config.stances?.[topic] || { position: '', intensity: 0.5 };
                            return (
                              <div key={topic} className="flex flex-wrap items-center gap-2">
                                <span className="text-[10px] font-bold text-blue-400 uppercase tracking-wider w-24 truncate" title={topic}>{topic}</span>
                                <input type="text" value={s.position}
                                  onChange={(e) => handleStanceChange(u.id, topic, 'position', e.target.value)}
                                  placeholder="Their position on this topic (free text)"
                                  className="flex-1 min-w-[180px] rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none placeholder:text-slate-600" />
                                <label className="flex items-center gap-1.5" title="Intensity: how strongly they hold this stance">
                                  <span className="text-[10px] text-slate-500">Intensity</span>
                                  <input type="range" min="0" max="1" step="0.05" value={s.intensity}
                                    onChange={(e) => handleStanceChange(u.id, topic, 'intensity', Number(e.target.value))}
                                    className="w-20 accent-emerald-500 cursor-pointer" />
                                  <span className="text-[10px] text-slate-500 w-6 tabular-nums">{Number(s.intensity).toFixed(2)}</span>
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    <details className="text-[11px]">
                      <summary className="cursor-pointer text-slate-400 hover:text-slate-200">Advanced coefficient overrides (leave blank to derive from OCEAN)</summary>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2.5">
                        {[
                          { k: 'gamma', label: 'Conformity γ', ph: '=A' },
                          { k: 'omega', label: 'Openness ω', ph: '=O' },
                          { k: 'lambda', label: 'Decisiveness λ', ph: '2..8' },
                          { k: 'noOpinionProbability', label: 'Abstention', ph: '=d(1−C)' }
                        ].map(f => (
                          <div key={f.k}>
                            <label className="text-[10px] text-slate-500 block mb-1">{f.label}</label>
                            <input type="number" step="0.05" value={config[f.k]}
                              onChange={(e) => handlePersonaChange(u.id, f.k, e.target.value)}
                              placeholder={f.ph}
                              className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-2 py-1 text-xs text-slate-200 focus:border-blue-500 focus:outline-none placeholder:text-slate-600" />
                          </div>
                        ))}
                      </div>
                    </details>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Preference Settings per Topic */}
      {topics.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h3 className="text-sm font-semibold text-slate-200 border-b border-slate-800/60 pb-2 mb-4">Agent Preference Seeding (Topic Options)</h3>
          <div className="space-y-6">
            {topics.map(topic => (
              <div key={topic} className="bg-slate-950/20 border border-slate-800/40 rounded-xl p-4">
                <h4 className="text-xs font-bold text-blue-400 uppercase tracking-wider mb-3">Topic: {topic}</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div key={idx}>
                      <label className="text-[10px] text-slate-500 block mb-1">Option {idx + 1}</label>
                      <input type="text" placeholder="Default LLM preference"
                        value={preferences[topic]?.[idx] || ''}
                        onChange={(e) => handlePreferenceOptionChange(topic, idx, e.target.value)}
                        className="w-full rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none placeholder:text-slate-600" />
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-slate-500 mt-2 leading-relaxed">Leave fields empty to let simulated agents dynamically generate custom preferences during the personal gathering phase.</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {showInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setShowInfo(false)}>
          <div className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-3 mb-4">
              <div>
                <h2 className="text-xl font-bold text-white">{SIMULATION_INFO.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-300">{SIMULATION_INFO.description}</p>
              </div>
              <button type="button" onClick={() => setShowInfo(false)}
                className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white">
                Close
              </button>
            </div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Model &amp; References</h3>
            <ul className="space-y-2 text-sm leading-6 text-slate-300">
              {SIMULATION_INFO.notes.map((note, index) => (
                <li key={index} className="flex gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400"></span>
                  <span>{note}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {showPersonaInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={() => setShowPersonaInfo(false)}>
          <div className="max-h-[85vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-800 bg-slate-950 p-6 text-slate-100 shadow-2xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-5 flex items-start justify-between gap-4 border-b border-slate-800 pb-3">
              <div>
                <h2 className="text-xl font-bold text-white">{PERSONA_INFO.title}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-300">{PERSONA_INFO.description}</p>
              </div>
              <button type="button" onClick={() => setShowPersonaInfo(false)} className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white">
                Close
              </button>
            </div>
            <div className="space-y-5">
              {PERSONA_INFO.sections.map((section) => (
                <section key={section.title}>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{section.title}</h3>
                  <ul className="space-y-2 text-sm leading-6 text-slate-300">
                    {section.items.map((item) => (
                      <li key={item} className="flex gap-2">
                        <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
