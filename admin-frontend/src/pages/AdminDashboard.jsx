import { runId, storage, transientStorage } from '../platform/context.js';
import { useEffect, useMemo, useRef, useState, Fragment, lazy, Suspense } from 'react';
import { io } from 'socket.io-client';
import { apiRequest } from '../api/client.js';
import { useAdminAuth } from '../contexts/AdminAuthContext.jsx';
import cimeLogo from '../img/CIME_LOGO.png';
import { wikiDocs } from '../docs/wikiContent.js';
import { decisionSettingsToJson, parseDecisionSettingsJson } from '../utils/adminJsonConfig.js';
import { decisionDraftFromServer, hasDecisionDraft } from '../utils/decisionDraft.js';
import SurveysTab from '../components/SurveysTab.jsx';

const SimulationTab = lazy(() => import('../components/SimulationTab.jsx'));

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || window.location.origin;
const MENU = ['decision', 'surveys', 'settings', 'rooms', 'polls', 'simulation', 'documentation', 'llm logs'];

export default function AdminDashboard() {
  const { token, user, logout } = useAdminAuth();
  const [activeMenu, setActiveMenu] = useState('decision');
  const [users, setUsers] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [selectedRoomId, setSelectedRoomId] = useState(null);
  const [newUser, setNewUser] = useState({ username: '', password: '', is_admin: false });
  const [newRoom, setNewRoom] = useState({ name: '' });
  const [newPoll, setNewPoll] = useState({ question: '', options: ['', ''], mandatory: false, timer_minutes: '' });
  const [decisionAgentChat, setDecisionAgentChat] = useState([]);
  const [decision, setDecision] = useState({ global_question: '', decision_context: '', current_phase: 'idle', discussion_round: 0, phase1: { completed: 0, total: 0 }, deliberation_questions: [], settings: {} });
  const [globalQuestion, setGlobalQuestion] = useState(() => storage.getItem('cime_draft_global_question') || '');
  const [decisionContext, setDecisionContext] = useState(() => storage.getItem('cime_draft_decision_context') || '');
  const [generalDescription, setGeneralDescription] = useState(() => storage.getItem('cime_draft_general_description') || '');
  const [deliberationQuestions, setDeliberationQuestions] = useState(() => {
    try {
      const saved = storage.getItem('cime_draft_deliberation_questions');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  // Admin-defined answer options for the FINAL general question. Empty entries are ignored; if
  // fewer than two remain, the backend falls back to a default openness scale.
  const [generalQuestionAnswers, setGeneralQuestionAnswers] = useState(() => {
    try {
      const saved = storage.getItem('cime_draft_general_question_answers');
      return saved ? JSON.parse(saved) : ['', ''];
    } catch {
      return ['', ''];
    }
  });
  const [cachedUsers, setCachedUsers] = useState(() => {
    try {
      const saved = storage.getItem('admin_users_cache') || transientStorage.getItem('admin_users_cache');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [cachedRooms, setCachedRooms] = useState(() => {
    try {
      const saved = storage.getItem('admin_rooms_cache') || transientStorage.getItem('admin_rooms_cache');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    storage.setItem('cime_draft_global_question', globalQuestion || '');
    storage.setItem('cime_draft_decision_context', decisionContext || '');
    storage.setItem('cime_draft_general_description', generalDescription || '');
    storage.setItem('cime_draft_deliberation_questions', JSON.stringify(deliberationQuestions || []));
    storage.setItem('cime_draft_general_question_answers', JSON.stringify(generalQuestionAnswers || []));
  }, [globalQuestion, decisionContext, generalDescription, deliberationQuestions, generalQuestionAnswers]);

  useEffect(() => {
    if ((users || []).length > 0) {
      try {
        storage.setItem('admin_users_cache', JSON.stringify(users));
      } catch {
        // Ignore storage failures.
      }
      transientStorage.setItem('admin_users_cache', JSON.stringify(users));
    }
  }, [users]);

  useEffect(() => {
    if ((rooms || []).length > 0) {
      try {
        storage.setItem('admin_rooms_cache', JSON.stringify(rooms));
      } catch {
        // Ignore storage failures.
      }
      transientStorage.setItem('admin_rooms_cache', JSON.stringify(rooms));
    }
  }, [rooms]);

  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  const selectedRoom = useMemo(() => rooms.find((r) => r.id === selectedRoomId) || null, [rooms, selectedRoomId]);

  const draftInitialized = useRef(false);
  const restoreSavedDecision = (savedDecision) => {
    if (draftInitialized.current) return;
    draftInitialized.current = true;
    // Empty arrays are written on mount; their serialized form is not a draft.
    // Hydrate once so later room events cannot overwrite an administrator's edits.
    if (hasDecisionDraft(storage)) return;
    const restored = decisionDraftFromServer(savedDecision);
    setGlobalQuestion(restored.globalQuestion);
    setDecisionContext(restored.decisionContext);
    setGeneralDescription(restored.generalDescription);
    setDeliberationQuestions(restored.deliberationQuestions);
    setGeneralQuestionAnswers(restored.generalQuestionAnswers);
  };

  const loadData = async () => {
    const [usersResult, roomsResult, decisionResult] = await Promise.allSettled([
      apiRequest('/admin/users', {}, token),
      apiRequest('/admin/rooms', {}, token),
      apiRequest('/admin/decision-process', {}, token)
    ]);
    if (usersResult.status === 'fulfilled') {
      const nextUsers = usersResult.value.users || [];
      if (nextUsers.length > 0) {
        setUsers(nextUsers);
        setCachedUsers(nextUsers);
      } else if (users.length === 0 && cachedUsers.length > 0) {
        setUsers(cachedUsers);
      }
    } else if (users.length === 0 && cachedUsers.length > 0) {
      setUsers(cachedUsers);
    }
    if (decisionResult.status === 'fulfilled') {
      const nextDecision = decisionResult.value || { global_question: '', decision_context: '', general_description: '', current_phase: 'idle', phase1: { completed: 0, total: 0 }, deliberation_questions: [] };
      setDecision(nextDecision);
      restoreSavedDecision(nextDecision);
    }
    if (usersResult.status === 'rejected' && roomsResult.status === 'rejected') {
      throw new Error(usersResult.reason?.message || roomsResult.reason?.message || 'Failed to load admin data');
    }

    if (roomsResult.status === 'fulfilled') {
      const rs = roomsResult.value.rooms || [];
      setRooms(rs);
      setCachedRooms(rs);
      try {
        storage.setItem('admin_rooms_cache', JSON.stringify(rs));
      } catch {
        // Ignore storage failures.
      }
      transientStorage.setItem('admin_rooms_cache', JSON.stringify(rs));
      if (rs.length > 0 && (!selectedRoomId || !rs.some((room) => room.id === selectedRoomId))) {
        setSelectedRoomId(rs[0].id);
      } else if (rs.length === 0) {
        setSelectedRoomId(null);
      }
    } else if (rooms.length === 0 && cachedRooms.length > 0) {
      setRooms(cachedRooms);
      if (!selectedRoomId && cachedRooms.length) setSelectedRoomId(cachedRooms[0].id);
    }
  };

  useEffect(() => { loadData().catch((e) => setError(e.message)); }, [token]);
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      path: import.meta.env.VITE_SOCKET_PATH || '/socket.io/',
      auth: { token, runId, admin: true },
      transports: ['websocket', 'polling']
    });
    socket.on('polls_updated', () => loadData().catch(() => { }));
    socket.on('rooms_updated', () => loadData().catch(() => { }));
    socket.on('users_updated', () => loadData().catch(() => { }));
    socket.on('decision_process_updated', (nextDecision) => {
      const cleanDecision = nextDecision || { global_question: '', decision_context: '', general_description: '', current_phase: 'idle', phase1: { completed: 0, total: 0 }, deliberation_questions: [] };
      setDecision(cleanDecision);
      restoreSavedDecision(cleanDecision);
      loadData().catch(() => { });
    });
    return () => socket.disconnect();
  }, [token]);

  const ok = async (msg) => { setInfo(msg); setError(''); await loadData(); };

  const createUser = async () => { try { await apiRequest('/admin/users', { method: 'POST', body: JSON.stringify(newUser) }, token); setNewUser({ username: '', password: '', is_admin: false }); await ok('User created'); } catch (e) { setError(e.message); } };
  const deleteUser = async (u) => { if (!await window.confirmAsync(`Delete ${u.username}?`)) return; try { await apiRequest(`/admin/users/${u.id}`, { method: 'DELETE' }, token); await ok('User deleted'); } catch (e) { setError(e.message); } };

  const createRoom = async () => { try { await apiRequest('/admin/rooms', { method: 'POST', body: JSON.stringify({ name: newRoom.name, userIds: [] }) }, token); setNewRoom({ name: '' }); await ok('Room created'); } catch (e) { setError(e.message); } };
  const deleteRoom = async (room) => { if (!await window.confirmAsync(`Delete room ${room.name}?`)) return; try { await apiRequest(`/admin/rooms/${room.id}`, { method: 'DELETE' }, token); await ok('Room deleted'); } catch (e) { setError(e.message); } };
  const deleteAllDiscussionGroups = async () => {
    if (!await window.confirmAsync('Delete all Discussion Groups? This removes their messages, polls, memberships, and room records. Personal and Convergence rooms will not be affected.')) return;
    try {
      const result = await apiRequest('/admin/rooms/discussion-groups', { method: 'DELETE' }, token);
      await ok(`${result.deleted || 0} Discussion Group${result.deleted === 1 ? '' : 's'} deleted`);
    } catch (e) {
      setError(e.message);
    }
  };
  const restorePersonalMemberships = async () => {
    if (!await window.confirmAsync('Restore every participant to their matching personal room? Existing messages, polls, and room state will be preserved.')) return;
    try {
      const result = await apiRequest('/admin/rooms/restore-personal-memberships', { method: 'POST' }, token);
      await ok(`${result.restored || 0} personal room membership${result.restored === 1 ? '' : 's'} restored${result.remaining ? `; ${result.remaining} still missing` : ''}`);
    } catch (e) {
      setError(e.message);
    }
  };
  const clearRoom = async (room) => { if (!await window.confirmAsync(`Clear chat in ${room.name}?`)) return; try { await apiRequest(`/admin/rooms/${room.id}/messages`, { method: 'DELETE' }, token); await ok('Room history cleared'); } catch (e) { setError(e.message); } };
  const saveMembers = async (roomId, userIds) => { try { await apiRequest(`/admin/rooms/${roomId}/members`, { method: 'PUT', body: JSON.stringify({ userIds }) }, token); await ok('Members updated'); } catch (e) { setError(e.message); } };

  const createPoll = async () => { try { await apiRequest(`/admin/rooms/${selectedRoom.id}/polls`, { method: 'POST', body: JSON.stringify({ question: newPoll.question, options: newPoll.options.filter(Boolean), mandatory: newPoll.mandatory, timer_minutes: newPoll.timer_minutes === '' ? null : Number(newPoll.timer_minutes) }) }, token); setNewPoll({ question: '', options: ['', ''], mandatory: false, timer_minutes: '' }); await ok('Poll created'); } catch (e) { setError(e.message); } };
  const patchPoll = async (pollId, patch) => { try { await apiRequest(`/admin/polls/${pollId}`, { method: 'PATCH', body: JSON.stringify(patch) }, token); await ok('Poll updated'); } catch (e) { setError(e.message); } };
  const deletePoll = async (pollId) => { if (!await window.confirmAsync('Delete poll?')) return; try { await apiRequest(`/admin/polls/${pollId}`, { method: 'DELETE' }, token); await ok('Poll deleted'); } catch (e) { setError(e.message); } };

  const sendDecisionAgentMessage = async (message, target = 'agents') => {
    if (!message.trim()) return;
    if (target === 'agents') {
      setDecisionAgentChat((prev) => [...prev, { role: 'admin', content: message.trim() }]);
      try {
        const result = await apiRequest('/admin/decision-process/agent-chat', { method: 'POST', body: JSON.stringify({ message }) }, token);
        const replies = result.replies || [];
        setDecisionAgentChat((prev) => [
          ...prev,
          ...replies.map((reply) => ({ role: reply.agentName, content: reply.reply }))
        ]);
        await loadData();
      } catch (e) {
        setError(e.message);
      }
    } else if (target.startsWith('room_')) {
      const roomId = Number(target.split('_')[1]);
      const room = rooms.find((r) => r.id === roomId);
      const roomName = room ? room.name : `Room #${roomId}`;
      setDecisionAgentChat((prev) => [...prev, { role: 'admin', content: `[To ${roomName} as Bot]: ${message.trim()}` }]);
      try {
        await apiRequest(`/admin/rooms/${roomId}/messages/send-bot`, {
          method: 'POST',
          body: JSON.stringify({ text: message })
        }, token);
        setDecisionAgentChat((prev) => [...prev, { role: 'system', content: `Message successfully delivered to ${roomName}.` }]);
        await loadData();
      } catch (e) {
        setError(e.message);
      }
    }
  };
  const updateDecisionSetting = async (key, value) => {
    try {
      const numericSettings = new Set([
        'group_proactivity',
        'consensus_sensitivity',
        'room_timer_minutes',
        'poll_timer_minutes',
        'convergence_summary_minutes',
        'time_before_poll_seconds',
        'clustering_min_users_per_room',
        'clustering_min_rooms'
      ]);
      const booleanSettings = new Set(['check_response_validity']);
      const normalizedValue = numericSettings.has(key) ? Number(value) : (booleanSettings.has(key) ? !!value : value);
      const result = await apiRequest('/admin/decision-process/settings', { method: 'PATCH', body: JSON.stringify({ [key]: normalizedValue }) }, token);
      setDecision((prev) => ({ ...prev, settings: result.settings || prev.settings }));
      await loadData();
    } catch (e) {
      setError(e.message);
    }
  };

  const updateDecisionSettings = async (settings) => {
    try {
      const result = await apiRequest('/admin/decision-process/settings', {
        method: 'PATCH',
        body: JSON.stringify(settings)
      }, token);
      setDecision((prev) => ({ ...prev, settings: result.settings || prev.settings }));
      await loadData();
      setInfo('Decision settings updated from JSON');
      setError('');
      return result.settings;
    } catch (e) {
      setError(e.message);
      throw e;
    }
  };

  const setCurrentSettingsAsDefault = async () => {
    if (!await window.confirmAsync('Save the current Decision Settings as the new default? "Reset to default" will apply these values from now on.')) return;
    try {
      await apiRequest('/admin/decision-process/settings/set-default', { method: 'POST' }, token);
      await ok('Current settings saved as default');
    } catch (e) {
      setError(e.message);
    }
  };

  const resetSettingsToDefault = async () => {
    if (!await window.confirmAsync('Reset all Decision Settings to the saved default values?')) return;
    try {
      const result = await apiRequest('/admin/decision-process/settings/reset-default', { method: 'POST' }, token);
      setDecision((prev) => ({ ...prev, settings: result.settings || prev.settings }));
      await loadData();
      setInfo('Settings reset to default');
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex font-sans">
      <aside className="m-3 min-h-[calc(100vh-24px)] w-64 rounded-[2rem] border border-white/5 bg-slate-900/50 p-6 flex-shrink-0 backdrop-blur shadow-xl flex flex-col">
        <div className="mb-8 flex items-center gap-3">
          <div className="bg-slate-900/50 p-2 rounded-2xl border border-white/5 backdrop-blur shadow-inner">
            <img src={cimeLogo} alt="CIME Logo" className="h-8 w-auto object-contain opacity-90" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight">Admin</h1>
        </div>
        <div className="mb-6 px-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Logged in as</p>
          <p className="font-medium text-slate-300 mt-1">{user?.username}</p>
        </div>
        
        <nav className="flex-1 space-y-2 mt-4">
          {MENU.map((menu) => (
            <button
              key={menu}
              onClick={() => setActiveMenu(menu)}
              className={`w-full rounded-2xl px-4 py-3 text-left font-medium capitalize transition-all ${
                activeMenu === menu
                  ? 'bg-indigo-500/10 text-indigo-400 shadow-sm shadow-indigo-500/5'
                  : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
              }`}
            >
              {menu}
            </button>
          ))}
        </nav>

        <div className="mt-auto">
          <button onClick={logout} className="w-full rounded-full border border-slate-700/50 bg-slate-900/50 px-4 py-2.5 text-sm font-semibold text-slate-300 transition-all hover:bg-slate-800 hover:text-white active:scale-95 shadow-sm">
            Sign Out
          </button>
        </div>
      </aside>

      <main className="flex-1 p-3 pl-0 h-screen overflow-y-auto scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
        <div className="mx-auto max-w-7xl w-full h-full pb-10">
          {error ? <p className="mb-4 rounded-2xl bg-red-500/10 border border-red-500/20 p-3 text-red-400 text-sm font-medium">{error}</p> : null}
          {info ? <p className="mb-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-emerald-400 text-sm font-medium">{info}</p> : null}

          {activeMenu === 'decision' ? <DecisionTab decision={decision} globalQuestion={globalQuestion} setGlobalQuestion={setGlobalQuestion} decisionContext={decisionContext} setDecisionContext={setDecisionContext} generalDescription={generalDescription} setGeneralDescription={setGeneralDescription} deliberationQuestions={deliberationQuestions} setDeliberationQuestions={setDeliberationQuestions} generalQuestionAnswers={generalQuestionAnswers} setGeneralQuestionAnswers={setGeneralQuestionAnswers} chat={decisionAgentChat} sendMessage={sendDecisionAgentMessage} updateSetting={updateDecisionSetting} updateSettings={updateDecisionSettings} setCurrentSettingsAsDefault={setCurrentSettingsAsDefault} resetSettingsToDefault={resetSettingsToDefault} rooms={rooms} token={token} /> : null}
          {activeMenu === 'settings' ? <SettingsTab token={token} /> : null}
          {activeMenu === 'surveys' ? <SurveysTab token={token} /> : null}
          {activeMenu === 'users' ? <UsersTab users={users} newUser={newUser} setNewUser={setNewUser} createUser={createUser} deleteUser={deleteUser} /> : null}
          {activeMenu === 'rooms' ? <RoomsTab rooms={rooms} users={users} newRoom={newRoom} setNewRoom={setNewRoom} createRoom={createRoom} deleteRoom={deleteRoom} deleteAllDiscussionGroups={deleteAllDiscussionGroups} restorePersonalMemberships={restorePersonalMemberships} clearRoom={clearRoom} saveMembers={saveMembers} /> : null}
          {activeMenu === 'polls' ? <PollsTab rooms={rooms} selectedRoom={selectedRoom} selectedRoomId={selectedRoomId} setSelectedRoomId={setSelectedRoomId} newPoll={newPoll} setNewPoll={setNewPoll} createPoll={createPoll} patchPoll={patchPoll} deletePoll={deletePoll} /> : null}
          {activeMenu === 'simulation' ? (
            <Suspense fallback={<p>Loading simulation controls…</p>}><SimulationTab
              token={token}
              users={users}
              globalQuestion={globalQuestion}
              decisionContext={decisionContext}
              generalDescription={generalDescription}
              generalQuestionAnswers={generalQuestionAnswers}
              deliberationQuestions={deliberationQuestions}
            /></Suspense>
          ) : null}
          {activeMenu === 'documentation' ? <DocumentationTab /> : null}
          {activeMenu === 'database' ? <DatabaseTab token={token} /> : null}
          {activeMenu === 'llm logs' ? <LlmLogsTab token={token} /> : null}
        </div>
      </main>
    </div>
  );
}

const SETTING_LABELS = {

  group_proactivity: {
    label: 'Group proactivity',
    help: 'Minutes of silence before the bot nudges a quiet group. 1 = 1 minute (soonest), 5 = 5 minutes (most patient).',
    description: 'Controls how quickly the conversational agent intervenes with a nudge when discussion in a room stalls.',
    notes: [
      'The value is the number of minutes of silence to wait: 1/5 nudges after ~1 minute (soonest), 5/5 waits ~5 minutes (most patient).',
      'The silence timer is measured from the last meaningful message (a participant message, or a substantive bot message — poll announcements do not reset it).',
      'When the room stays quiet past the target duration and no poll is open, the bot sends one concise (max 2 sentences) nudge to restart the discussion.'
    ]
  },
  consensus_sensitivity: {
    label: 'Consensus sensitivity',
    help: 'Percentage of different participants who must contribute before the readiness check can open a poll. 1 = 10%, 5 = 50%, 10 = 100%.',
    description: 'Controls the minimum percentage of distinct participants required in the current discussion turn before Agent 3 asks the readiness LLM whether a poll is appropriate.',
    notes: [
      'This counts distinct non-admin participants, not raw messages.',
      'The value is a percentage scale: 1 = 10%, 5 = 50%, and 10 = 100%.',
      'The required participant count is rounded up. For example, 5/10 in a 3-person room requires 2 participants.',
      'The readiness LLM still checks whether their messages contain clear positions, reasons, or willingness to vote.',
      'This setting is separate from Poll approval threshold and Minimum votes for approval, which apply after a poll opens.'
    ]
  },
  check_response_validity: {
    label: 'Check response validity',
    help: 'When on, the bot asks again once if a personal answer is nonsense, and ignores nonsense custom options.',
    description: 'Adds a lightweight validity check to personal-room answers and custom poll text so obvious nonsense is not treated as real input.',
    notes: [
      'The first nonsense answer is re-asked once in personal rooms.',
      'If the user gives nonsense again, the flow moves on instead of getting stuck.',
      'Invalid custom "Other" text is ignored so it is never promoted into a new option.'
    ]
  },
  room_timer_minutes: {
    label: 'Room timer',
    help: 'Controls the discussion countdown. Remaining topic votes finish before the final question.',
    description: 'Sets the duration of the countdown timer allocated to discussion room phases.',
    notes: [
      'Displayed in the header top bar of the chat.',
      'When the group countdown expires, existing ballots continue using their own timers. Every remaining topic is voted on before the final question and convergence.'
    ]
  },
  poll_approval_threshold: {
    label: 'Poll approval threshold',
    help: '1: 51% (Majority), 2: 75% (Supermajority), 3: 100% (Unanimous) of users needed to accept a preference.',
    description: 'Defines the consensus requirement (majority/supermajority/unanimity) needed for a poll option to be confirmed.',
    notes: [
      'Level 1: 51% (Simple Majority)',
      'Level 2: 75% (Supermajority)',
      'Level 3: 100% (Unanimity)',
      'If no option meets the threshold, the poll fails and the topic remains open.'
    ]
  },
  minimum_votes_for_approval: {
    label: 'Minimum votes for approval',
    help: 'Quorum: the minimum percentage of eligible participants who must have a current vote before consensus can close.',
    description: 'Separates participation quorum from the approval threshold. A live vote cannot close until this percentage of eligible members has selected an option.',
    notes: [
      'This is a percentage of eligible non-admin room members.',
      'A participant has at most one current selection in the live phase.',
      'The approval threshold still determines how much support the leading option needs.'
    ]
  },
  minimum_live_voting_duration_minutes: {
    label: 'Minimum live voting duration',
    help: 'The live vote cannot close early before this many minutes have elapsed.',
    description: 'Prevents a fast early majority from ending the asynchronous voting phase before everyone has had a reasonable opportunity to participate.',
    notes: ['The timer starts when continuous voting opens.', 'This is independent from the normal poll timer.']
  },
  consensus_stability_duration_seconds: {
    label: 'Consensus stability duration',
    help: 'How long quorum and approval must remain satisfied before live voting closes.',
    description: 'Requires the leading option to remain above both thresholds continuously, so a transient lead cannot close the poll.',
    notes: ['Changing a vote so the thresholds are no longer satisfied resets the stability clock.', 'The server, not the browser, owns this timer.']
  },
  live_voting_duration_minutes: {
    label: 'Live voting duration',
    help: 'Length (minutes) of the live single-select phase AND of the final general-question vote.',
    description: 'Sets how long live voting stays open before current votes are frozen and the one-minute ranking review begins. The same duration is used for the final vote on the main (general) question.',
    notes: [
      'Governs both the topic live-voting phase and the final general-question poll.',
      'At timeout of a live vote, the server stores an immutable snapshot of current votes and the bot announces the top options before ranking opens.',
      'Swipe and ranking polls on the topics use "Poll timer duration" instead.'
    ]
  },
  suggestion_cooldown_seconds: {
    label: 'Suggestion cooldown',
    help: 'Seconds a participant must wait before submitting another live-vote suggestion.',
    description: 'Limits suggestion spam while allowing meaningful asynchronous participation.',
    notes: ['Only one pending suggestion per participant is allowed.', 'Suggestions are validated by the configured LLM and semantically compared with existing options.']
  },
  maximum_visible_options: {
    label: 'Maximum visible options',
    help: 'Global maximum number of live-vote options shown, plus any option currently selected by a participant.',
    description: 'Keeps the live voting interface usable while preserving every historical option and every participant’s current selection.',
    notes: [
      'The top options are ranked by current selections.',
      'An option selected by at least one participant stays visible even when it is outside the global top list.',
      'Stable option IDs are used throughout; labels are never used as identifiers.'
    ]
  },
  poll_timer_minutes: {
    label: 'Poll timer duration',
    help: 'Length (minutes) of the swipe and ranking polls on the topics (default 2).',
    description: 'Specifies how long a swipe or ranking poll on a topic stays open for votes. (Live voting and the final general-question vote use "Live voting duration" instead.)',
    notes: [
      'Applies to the swipe round and the final ranking vote on each topic.',
      'When the timer expires, the server automatically closes the poll, counts votes, and determines the outcome.'
    ]
  },
  convergence_summary_minutes: {
    label: 'Convergence summary timer',
    help: 'Minutes participants have to review the convergence summary and reopen points before voting starts (1 to 10, default 1).',
    description: 'Controls the length of the interactive review window that opens the final convergence round, during which participants read the summary of the discussion-group decisions and can flag agreed points to reopen.',
    notes: [
      'When the final convergence room opens, participants see a summary card of what the discussion groups decided.',
      'During this window they can click "reopen!" on any agreed point they disagree with, and voting is locked.',
      'When the timer ends (or everyone presses "I agree" early), reopened and still-open points are put to a vote, followed by the final question.'
    ]
  },
  time_before_poll_seconds: {
    label: 'Time before poll',
    help: 'Seconds the bot waits after announcing the next discussion topic before it opens the poll (0 to 120, default 10).',
    description: 'The single pause that governs every topic hand-off. When a topic is resolved, the bot announces the next topic and, after this delay, automatically opens its swipe poll. The pause before the final vote is controlled separately by Time before final vote.',
    notes: [
      'Applies to opening the next discussion topic\'s swipe poll, including after convergence review.',
      '0 opens the next poll immediately after the announcement.',
      'This replaces the old "Time between automatic polls" and "Minimum time before a poll" for the group discussion flow.'
    ]
  },
  time_before_final_vote_seconds: {
    label: 'Time before final vote',
    help: 'Discussion time after the topic recap, before the final decision vote (0–1800 seconds).',
    description: 'Gives participants time to review the topic decisions and discuss the main question before its final vote opens. Applies in discussion groups and convergence rooms. Chat stays available; voting waits for this period to end.',
    notes: ['Separate from Time before poll, which controls transitions between discussion topics.', '300 seconds gives five minutes of final discussion. 0 opens the final vote immediately.', 'For existing configurations, initially uses the previous Time before poll value.']
  },
  user_poll_rate_limit: {
    label: 'User poll rate limit',
    help: 'Max user-triggered polls per 5 minutes. 0 = disabled, 1 to 10 = limit, 11 = endless.',
    description: 'Enforces a rate limit on the number of times a single user can command the bot to trigger a poll via chat (e.g. using "@bot we want to vote" or "/vote").',
    notes: [
      '0: Completely disables user-triggered polls via chat commands.',
      '1 to 10: Restricts the user to at most N poll calls per 5 minutes per room.',
      '11: Endless (no limit, default behavior).'
    ]
  },
  user_inactivity_timeout_minutes: {
    label: 'User inactivity timeout',
    help: 'Minutes of inactivity before warning a user about being kicked out (3 to 15, default 5).',
    description: 'Enforces an inactivity check for participants. If they do not post messages or vote for X minutes, they receive a warning modal. If they do not interact within 1 minute, they are kicked out.',
    notes: [
      'A user is considered inactive if they have not sent any chat messages or cast any votes in their active room.',
      'If a user is kicked out, they are removed from the room members list, allowing other processes to resume.'
    ]
  }
};

// Simple slugify for markdown rendering
function slugifyAdmin(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

// Inline markdown helper for react render
function inlineMarkdownAdmin(text) {
  const parts = [];
  let remaining = String(text || '');
  let index = 0;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)]+)\))/;
  while (remaining.length) {
    const match = remaining.match(pattern);
    if (!match) {
      parts.push(remaining);
      break;
    }
    if (match.index > 0) parts.push(remaining.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`code-${index}`} className="rounded bg-slate-800 px-1 py-0.5 text-cyan-200">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<a key={`link-${index}`} href={match[3]} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline decoration-cyan-500/60 hover:text-cyan-100">{match[2]}</a>);
    }
    remaining = remaining.slice((match.index || 0) + token.length);
    index += 1;
  }
  return parts;
}

// Block markdown helper for react render
function renderMarkdownAdmin(markdown) {
  const blocks = [];
  const lines = String(markdown || '').split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`pre-${key++}`} className="my-4 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-100">
          {language ? <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">{language}</div> : null}
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slugifyAdmin(text);
      const className = level === 1
        ? 'mb-5 mt-1 text-3xl font-black tracking-tight text-white'
        : level === 2
          ? 'mb-3 mt-8 border-t border-slate-800 pt-6 text-xl font-bold text-white'
          : level === 3
            ? 'mb-2 mt-6 text-lg font-semibold text-cyan-100'
            : 'mb-2 mt-4 text-base font-semibold text-slate-100';
      const Tag = `h${Math.min(level, 4)}`;
      blocks.push(<Tag key={`h-${key++}`} id={id} className={className}>{text}</Tag>);
      i += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="my-4 list-disc space-y-2 pl-6 text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdownAdmin(item)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="my-4 list-decimal space-y-2 pl-6 text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdownAdmin(item)}</li>)}
        </ol>
      );
      continue;
    }

    if (line.trim() === '---') {
      blocks.push(<hr key={`hr-${key++}`} className="my-6 border-slate-800" />);
      i += 1;
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('```') &&
      lines[i].trim() !== '---'
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p-${key++}`} className="my-3 leading-7 text-slate-300">{inlineMarkdownAdmin(paragraph.join(' '))}</p>);
  }

  return blocks;
}

function convertMarkdownToHtml(markdown) {
  const lines = String(markdown || '').split('\n');
  let i = 0;
  let html = '';

  const inline = (text) => {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  };

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      html += `<pre><code>${code.join('\n')}</code></pre>\n`;
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      html += `<h${level}>${inline(text)}</h${level}>\n`;
      i += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      html += '<ul>\n';
      while (i < lines.length && lines[i].startsWith('- ')) {
        html += `  <li>${inline(lines[i].slice(2))}</li>\n`;
        i += 1;
      }
      html += '</ul>\n';
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      html += '<ol>\n';
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        html += `  <li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>\n`;
        i += 1;
      }
      html += '</ol>\n';
      continue;
    }

    if (line.trim() === '---') {
      html += '<hr />\n';
      i += 1;
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('```') &&
      lines[i].trim() !== '---'
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    html += `<p>${inline(paragraph.join(' '))}</p>\n`;
  }
  return html;
}

function downloadReportAsPdf(title, markdownText) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to download the PDF.');
    return;
  }

  const htmlContent = convertMarkdownToHtml(markdownText);

  printWindow.document.write(`
    <html>
      <head>
        <title>${title}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            color: #1e293b;
            max-width: 800px;
            margin: 40px auto;
            padding: 0 20px;
          }
          h1 {
            font-size: 28px;
            font-weight: 800;
            color: #0f172a;
            border-bottom: 2px solid #e2e8f0;
            padding-bottom: 12px;
            margin-top: 0;
          }
          h2 {
            font-size: 20px;
            font-weight: 700;
            color: #1e293b;
            margin-top: 32px;
            border-bottom: 1px solid #f1f5f9;
            padding-bottom: 6px;
          }
          h3 {
            font-size: 16px;
            font-weight: 600;
            color: #475569;
            margin-top: 24px;
          }
          p {
            margin: 12px 0;
          }
          ul, ol {
            padding-left: 24px;
            margin: 12px 0;
          }
          li {
            margin-bottom: 6px;
          }
          code {
            background-color: #f1f5f9;
            color: #0f172a;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
            font-size: 14px;
          }
          pre {
            background-color: #f8fafc;
            border: 1px solid #e2e8f0;
            padding: 16px;
            border-radius: 8px;
            overflow-x: auto;
            font-family: monospace;
            font-size: 14px;
          }
          hr {
            border: 0;
            border-top: 1px solid #e2e8f0;
            margin: 24px 0;
          }
          @media print {
            body {
              margin: 20px;
              font-size: 12pt;
            }
          }
        </style>
      </head>
      <body>
        ${htmlContent}
        <script>
          window.onload = function() {
            window.print();
            setTimeout(function() { window.close(); }, 500);
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function DecisionTab({
  decision,
  globalQuestion,
  setGlobalQuestion,
  decisionContext,
  setDecisionContext,
  generalDescription,
  setGeneralDescription,
  deliberationQuestions,
  setDeliberationQuestions,
  generalQuestionAnswers = ['', ''],
  setGeneralQuestionAnswers,
  chat,
  sendMessage,
  updateSetting,
  updateSettings,
  setCurrentSettingsAsDefault,
  resetSettingsToDefault,
  rooms = [],
  token
}) {
  const [input, setInput] = useState('');
  const [consoleTarget, setConsoleTarget] = useState('agents');
  const [localSettings, setLocalSettings] = useState(decision.settings || {});
  const [isJsonMode, setIsJsonMode] = useState(false);
  const [jsonDraft, setJsonDraft] = useState('');
  const [isSettingsJsonMode, setIsSettingsJsonMode] = useState(false);
  const [settingsJsonDraft, setSettingsJsonDraft] = useState('');
  const [savingSettingsJson, setSavingSettingsJson] = useState(false);
  const [showRecapModal, setShowRecapModal] = useState(false);
  const [recapReport, setRecapReport] = useState(null);
  const [loadingReport, setLoadingReport] = useState(false);

  const [infoModal, setInfoModal] = useState(null);
  const [generatingQuestions, setGeneratingQuestions] = useState(false);
  const [genCount, setGenCount] = useState(5);
  const [generatingDescription, setGeneratingDescription] = useState(false);
  useEffect(() => {
    if (!infoModal) return undefined;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') closeInfoModal();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [infoModal]);

  const handleGenerateQuestions = async () => {
    if (!globalQuestion.trim()) {
      alert('Global question must not be empty.');
      return;
    }
    setGeneratingQuestions(true);
    try {
      const data = await apiRequest('/admin/decision-process/generate-questions', {
        method: 'POST',
        body: JSON.stringify({
          globalQuestion,
          generalDescription,
          count: genCount
        })
      }, token);
      if (data && data.questions) {
        setDeliberationQuestions(data.questions);
      }
    } catch (err) {
      alert('Failed to generate deliberation questions: ' + err.message);
    } finally {
      setGeneratingQuestions(false);
    }
  };

  const handleGenerateDescription = async () => {
    if (!globalQuestion.trim()) {
      alert('Global question must not be empty.');
      return;
    }
    setGeneratingDescription(true);
    try {
      const data = await apiRequest('/admin/decision-process/generate-description', {
        method: 'POST',
        body: JSON.stringify({
          globalQuestion
        })
      }, token);
      if (data && data.description) {
        setGeneralDescription(data.description);
      }
    } catch (err) {
      alert('Failed to generate user description: ' + err.message);
    } finally {
      setGeneratingDescription(false);
    }
  };

  const openInfoModal = (title, description, notes = []) => {
    setInfoModal({ title, description, notes });
  };

  const closeInfoModal = () => setInfoModal(null);

  const InfoButton = ({ onClick, label = 'More info' }) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-700 bg-slate-950/80 text-[10px] font-bold text-slate-300 transition-colors hover:border-blue-500 hover:text-blue-200 hover:bg-blue-500/10"
    >
      i
    </button>
  );

  const InfoModal = () => {
    if (!infoModal) return null;
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 py-6 backdrop-blur-sm"
        onClick={closeInfoModal}
        role="presentation"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="decision-info-modal-title"
          className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-950 p-6 shadow-2xl shadow-black/40 text-slate-100"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id="decision-info-modal-title" className="text-lg font-semibold text-slate-100 font-bold">
                {infoModal.title}
              </h2>
              <p className="mt-2 text-sm leading-6 text-slate-300">
                {infoModal.description}
              </p>
            </div>
            <button
              type="button"
              onClick={closeInfoModal}
              className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs font-semibold text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              Close
            </button>
          </div>
          {infoModal.notes?.length > 0 && (
            <div className="mt-5 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 font-bold">Implementation Details</h3>
              <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-300">
                {infoModal.notes.map((note, index) => (
                  <li key={index} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400"></span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  };

  const completedConvergenceRoom = rooms.find(
    (r) => r.room_type === 'convergence' && r.collection_complete === 1
  );

  const viewReport = async () => {
    if (!completedConvergenceRoom) return;
    setLoadingReport(true);
    try {
      const data = await apiRequest(`/rooms/${completedConvergenceRoom.id}/recap`, {}, token);
      if (data && data.report) {
        setRecapReport(data.report);
        setShowRecapModal(true);
      }
    } catch (err) {
      alert('Failed to load recap report: ' + err.message);
    } finally {
      setLoadingReport(false);
    }
  };

  useEffect(() => {
    setLocalSettings(decision.settings || {});
  }, [decision.settings]);

  const submit = () => {
    const message = input.trim();
    if (!message) return;
    setInput('');
    sendMessage(message, consoleTarget);
  };

  const saveSetting = (key, value) => {
    const defaultVal = key === 'poll_approval_threshold' ? 1 : (key === 'minimum_votes_for_approval' ? 50 : (key === 'minimum_live_voting_duration_minutes' ? 1 : (key === 'consensus_stability_duration_seconds' ? 20 : (key === 'live_voting_duration_minutes' ? 5 : (key === 'suggestion_cooldown_seconds' ? 30 : (key === 'maximum_visible_options' ? 8 : (key === 'poll_timer_minutes' ? 2 : (key === 'convergence_summary_minutes' ? 1 : (key === 'user_poll_rate_limit' ? 11 : (key === 'user_inactivity_timeout_minutes' ? 5 : 3))))))))));
    const val = value !== undefined ? value : (localSettings?.[key] !== undefined ? localSettings[key] : defaultVal);
    if (val !== decision.settings?.[key]) updateSetting(key, val);
  };

  const saveImmediateSetting = (key, value) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    if (value !== decision.settings?.[key]) updateSetting(key, value);
  };

  const addQuestion = () => {
    setDeliberationQuestions((prev) => ([
      ...prev,
      {
        topic: `topic-${prev.length + 1}`,
        question_text: '',
        predefined_answers: ['', '', ''],
        question_order: prev.length + 1
      }
    ]));
  };

  const updateQuestion = (index, patch) => {
    setDeliberationQuestions((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const updateQuestionAnswer = (questionIndex, answerIndex, value) => {
    setDeliberationQuestions((prev) => prev.map((item, i) => {
      if (i !== questionIndex) return item;
      const nextAnswers = [...(item.predefined_answers || [])];
      nextAnswers[answerIndex] = value;
      return { ...item, predefined_answers: nextAnswers };
    }));
  };

  const removeQuestion = (index) => {
    setDeliberationQuestions((prev) => prev.filter((_item, i) => i !== index));
  };


  return <div className="space-y-4">
    <InfoModal />
    {showRecapModal && recapReport && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
        <div className="w-full max-w-3xl rounded-2xl bg-slate-950 p-8 shadow-2xl border border-slate-800 flex flex-col max-h-[85vh] text-slate-100">
          <div className="flex items-center gap-3 mb-6 border-b border-slate-800 pb-4 shrink-0">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-950/60 text-emerald-400 border border-emerald-800/40 font-bold text-lg">
              ✓
            </span>
            <div>
              <h2 className="text-2xl font-bold text-white">Process Completed</h2>
              <p className="text-sm text-slate-400">Consensus Analysis & Compatibility Report</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto pr-2 mb-6 space-y-4 text-slate-300 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
            <div className="markdown-body">
              {renderMarkdownAdmin(recapReport)}
            </div>
          </div>

          <div className="flex justify-between items-center pt-4 border-t border-slate-800 shrink-0">
            <button
              onClick={() => downloadReportAsPdf(decision.global_question || 'Report', recapReport)}
              className="rounded-xl border border-slate-800 bg-slate-900/60 px-5 py-3 text-slate-300 font-semibold transition-all hover:bg-slate-800 active:scale-95 flex items-center gap-2 hover:text-white"
            >
              <span>📥</span> Save as PDF
            </button>
            <button
              onClick={() => setShowRecapModal(false)}
              className="rounded-xl bg-indigo-600 px-6 py-3 text-white font-semibold transition-all hover:bg-indigo-500 shadow-md hover:shadow-lg active:scale-95"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    )}

    <div className="glass-panel rounded-3xl p-6">
      <h2 className="mb-5 text-xl font-semibold tracking-tight text-white">Decision Process</h2>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border border-white/5 bg-slate-900/50 p-4 shadow-inner"><p className="text-xs uppercase font-bold tracking-wider text-slate-500 mb-1">Phase</p><p className="font-medium text-lg capitalize">{decision.current_phase}</p></div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/50 p-4 shadow-inner"><p className="text-xs uppercase font-bold tracking-wider text-slate-500 mb-1">Phase 1</p><p className="font-medium text-lg">{decision.phase1?.completed || 0}/{decision.phase1?.total || 0} complete</p></div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/50 p-4 shadow-inner"><p className="text-xs uppercase font-bold tracking-wider text-slate-500 mb-1">Question</p><p className="truncate font-medium text-lg">{decision.global_question || 'Not started'}</p></div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/50 p-4 shadow-inner"><p className="text-xs uppercase font-bold tracking-wider text-slate-500 mb-1">Discussion Round</p><p className="font-medium text-lg">{decision.discussion_round || 0}</p></div>
      </div>

      {completedConvergenceRoom && (
        <div className="mt-6 rounded-3xl border border-emerald-500/30 bg-emerald-950/30 p-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 shadow-lg shadow-emerald-900/10 backdrop-blur-sm">
          <div>
            <h3 className="text-lg font-bold text-emerald-400">Process Completed Successfully</h3>
            <p className="text-sm text-emerald-200/70 mt-1">The convergence round has finalized. You can view the dynamic report or download it as a PDF.</p>
          </div>
          <div>
            <button
              onClick={viewReport}
              disabled={loadingReport}
              className="rounded-full bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800/50 px-6 py-3 text-sm font-semibold text-white transition-all hover:scale-[1.02] active:scale-95 flex items-center gap-2 shadow-md shadow-emerald-900/20"
            >
              {loadingReport ? 'Loading...' : '📄 View & Download Report'}
            </button>
          </div>
        </div>
      )}
      
      {decision.decision_context ? (
        <div className="mt-6 rounded-2xl border border-white/5 bg-slate-900/40 p-5 shadow-inner">
          <p className="mb-2 text-xs uppercase font-bold tracking-wider text-slate-500">Additional Context</p>
          <p className="whitespace-pre-wrap text-sm text-slate-300 leading-relaxed">{decision.decision_context}</p>
        </div>
      ) : null}
      
      <div className="mt-8 grid gap-6">
        <div className="flex flex-col gap-2">
          <label className="text-xs uppercase font-bold tracking-wider text-slate-400 ml-1">Global Question * (Mandatory)</label>
          <input value={globalQuestion} onChange={(e) => setGlobalQuestion(e.target.value)} placeholder="Global question (e.g. Which option should we choose?)" className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 hover:bg-slate-900/80 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10" />
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <label className="text-xs uppercase font-bold tracking-wider text-slate-400">General description for users</label>
            <button
              type="button"
              onClick={handleGenerateDescription}
              disabled={generatingDescription}
              className="rounded-full bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500 hover:text-white border border-indigo-500/20 disabled:opacity-40 px-3 py-1 text-xs font-semibold transition-all active:scale-95 flex items-center gap-1"
            >
              {generatingDescription ? 'Generating...' : '⚡ Auto-Generate'}
            </button>
          </div>
          <textarea
            value={generalDescription}
            onChange={(e) => setGeneralDescription(e.target.value)}
            placeholder="General description for users. This will be shown to users when the process starts."
            className="min-h-[128px] rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 leading-relaxed text-white transition-all placeholder:text-slate-500 hover:bg-slate-900/80 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 resize-y"
          />
        </div>
        <div className="flex flex-col gap-2">
          <label className="text-xs uppercase font-bold tracking-wider text-slate-400 ml-1">Additional context for the agents * (Mandatory)</label>
          <textarea
            value={decisionContext}
            onChange={(e) => setDecisionContext(e.target.value)}
            placeholder="Additional context for the agents. Example: explain what information matters, what is out of scope, constraints to collect, or what level of detail is enough."
            className="min-h-[128px] rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 leading-relaxed text-white transition-all placeholder:text-slate-500 hover:bg-slate-900/80 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 resize-y"
          />
        </div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-5 shadow-inner">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase text-slate-400 font-bold">Deliberation Questions</p>
              <p className="text-xs text-slate-400">Up to 10 questions. Each question can have up to 6 predefined answers. The bot will ask them one by one in personal chats.</p>
            </div>
            <div className="flex items-center gap-3">
              {!isJsonMode && (
                <div className="flex items-center gap-2 mr-2">
                  <select
                    value={genCount}
                    onChange={(e) => setGenCount(Number(e.target.value))}
                    className="rounded-full bg-slate-900/80 px-3 py-1.5 text-xs text-slate-100 font-semibold focus:outline-none border border-white/10"
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                      <option key={n} value={n}>{n} Qs</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleGenerateQuestions}
                    disabled={generatingQuestions}
                    className="rounded-full bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500 hover:text-white border border-indigo-500/20 disabled:opacity-40 px-4 py-1.5 text-xs font-semibold transition-all active:scale-95 flex items-center gap-1.5"
                  >
                    {generatingQuestions ? 'Generating...' : '⚡ AI Generate'}
                  </button>
                </div>
              )}
              <button
                onClick={() => {
                  if (isJsonMode) {
                    try {
                      const parsed = JSON.parse(jsonDraft);
                      if (!Array.isArray(parsed)) throw new Error('Root must be an array.');
                      setDeliberationQuestions(parsed);
                      setIsJsonMode(false);
                    } catch (err) {
                      alert('Invalid JSON: ' + err.message);
                    }
                  } else {
                    setJsonDraft(JSON.stringify(deliberationQuestions, null, 2));
                    setIsJsonMode(true);
                  }
                }}
                className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all shadow-sm active:scale-95 ${
                  isJsonMode 
                    ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-900/20' 
                    : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border border-white/5'
                }`}
              >
                {isJsonMode ? 'Save JSON' : 'Edit JSON'}
              </button>
              {!isJsonMode && (
                <button onClick={addQuestion} className="rounded-full bg-slate-800 hover:bg-slate-700 border border-white/5 px-4 py-1.5 text-xs font-semibold text-slate-300 transition-all active:scale-95 shadow-sm">
                  Add Question
                </button>
              )}
            </div>
          </div>
          <div className="space-y-3">
            {isJsonMode ? (
              <textarea
                value={jsonDraft}
                onChange={(e) => setJsonDraft(e.target.value)}
                className="min-h-[384px] w-full rounded-2xl border border-white/10 bg-slate-900/60 font-mono text-sm px-4 py-3 leading-relaxed text-slate-300 transition-all focus:border-indigo-500 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 resize-y"
                placeholder={`[\n  {\n    "topic": "Location",\n    "question_text": "Where should we go?",\n    "predefined_answers": ["Park", "Museum"]\n  }\n]`}
              />
            ) : deliberationQuestions.map((question, index) => (
              <div key={`${question.topic || 'q'}-${index}`} className="rounded-2xl border border-white/5 bg-slate-900/50 p-4 shadow-inner relative group">
                <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => removeQuestion(index)} className="rounded-full bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/20 px-3 py-1 text-xs font-semibold transition-all">Remove</button>
                </div>
                <div className="mb-4">
                  <input
                    value={question.topic || ''}
                    onChange={(e) => updateQuestion(index, { topic: e.target.value })}
                    placeholder={`Topic ${index + 1}`}
                    className="w-1/3 rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                  />
                </div>
                <input
                  value={question.question_text || ''}
                  onChange={(e) => updateQuestion(index, { question_text: e.target.value })}
                  placeholder="Question text"
                  className="mb-4 w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
                />
                <div className="grid gap-3 md:grid-cols-2">
                  {Array.from({ length: 6 }).map((_unused, answerIndex) => (
                    <input
                      key={answerIndex}
                      value={(question.predefined_answers || [])[answerIndex] || ''}
                      onChange={(e) => updateQuestionAnswer(index, answerIndex, e.target.value)}
                      placeholder={`Predefined answer ${answerIndex + 1}`}
                      className="rounded-xl border border-white/5 bg-slate-800/50 px-4 py-2.5 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none transition-all"
                    />
                  ))}
                </div>
              </div>
            ))}
            {!deliberationQuestions.length ? (
              <p className="rounded-2xl border border-dashed border-white/10 p-6 text-center text-sm text-slate-400 bg-slate-900/20">
                Add your deliberation questions here. These are the questions users will answer in the personal chat.
              </p>
            ) : null}
          </div>
        </div>
        <div className="mt-6 rounded-2xl border border-white/10 bg-slate-900/40 p-5">
          <p className="mb-1 text-sm font-semibold text-white">Final general-question options</p>
          <p className="mb-3 text-xs text-slate-400">The answer options participants choose from in the final vote on the global question{globalQuestion?.trim() ? <>: <span className="italic text-slate-300">"{globalQuestion.trim()}"</span></> : ''}. Leave blank to use the default openness scale; provide at least two to override it.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {Array.from({ length: 6 }).map((_unused, optIndex) => (
              <input
                key={optIndex}
                value={(generalQuestionAnswers || [])[optIndex] || ''}
                onChange={(e) => {
                  const next = [...(generalQuestionAnswers || [])];
                  while (next.length <= optIndex) next.push('');
                  next[optIndex] = e.target.value;
                  setGeneralQuestionAnswers(next);
                }}
                placeholder={`Option ${optIndex + 1}`}
                className="rounded-xl border border-white/5 bg-slate-800/50 px-4 py-2.5 text-sm text-slate-300 focus:border-indigo-500 focus:outline-none transition-all"
              />
            ))}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-slate-800/50 pt-6 mt-2">
          <p className="text-xs text-slate-500 max-w-lg leading-relaxed">This context is used by all agents when collecting information, guiding discussion, evaluating vote readiness, and drafting polls.</p>
          <a href={`/#/runs/${runId}`} className="rounded-xl border border-slate-700 px-5 py-3 text-sm font-semibold">Open decision setup</a>
        </div>
      </div>
    </div>

    <section className="glass-panel rounded-3xl p-6 mt-8">
      <div className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-xl font-semibold tracking-tight text-white">Decision Settings</h3>
        <div className="flex items-center gap-2">
          {isSettingsJsonMode && (
            <button
              type="button"
              onClick={() => setIsSettingsJsonMode(false)}
              className="rounded-full border border-white/5 bg-slate-800 px-4 py-1.5 text-xs font-semibold text-slate-300 transition-all hover:bg-slate-700"
            >
              Cancel JSON
            </button>
          )}
          <button
            type="button"
            disabled={savingSettingsJson}
            onClick={async () => {
              if (!isSettingsJsonMode) {
                setSettingsJsonDraft(decisionSettingsToJson(localSettings));
                setIsSettingsJsonMode(true);
                return;
              }
              try {
                const parsed = parseDecisionSettingsJson(settingsJsonDraft);
                setSavingSettingsJson(true);
                const saved = await updateSettings(parsed);
                setLocalSettings(saved || parsed);
                setIsSettingsJsonMode(false);
              } catch (err) {
                alert('Invalid settings JSON: ' + err.message);
              } finally {
                setSavingSettingsJson(false);
              }
            }}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-all disabled:opacity-50 ${isSettingsJsonMode ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'border border-white/5 bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {savingSettingsJson ? 'Saving...' : (isSettingsJsonMode ? 'Apply JSON' : 'Edit JSON')}
          </button>
          <button
            onClick={resetSettingsToDefault}
            title="Apply the saved default values to all settings below"
            className="rounded-full bg-slate-800 hover:bg-slate-700 border border-white/5 px-4 py-1.5 text-xs font-semibold text-slate-300 transition-all active:scale-95 shadow-sm"
          >
            Reset to default
          </button>
          <button
            onClick={setCurrentSettingsAsDefault}
            title="Save the current values below as the new default"
            className="rounded-full bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500 hover:text-white border border-indigo-500/20 px-4 py-1.5 text-xs font-semibold transition-all active:scale-95"
          >
            Set default
          </button>
        </div>
      </div>
      <p className="mb-6 text-sm text-slate-400 font-inter">Use the controls below or edit all active settings as one JSON object.</p>
      {isSettingsJsonMode ? (
        <div>
          <textarea
            value={settingsJsonDraft}
            onChange={(event) => setSettingsJsonDraft(event.target.value)}
            spellCheck={false}
            className="min-h-[32rem] w-full rounded-2xl border border-emerald-500/30 bg-slate-950 p-5 font-mono text-sm leading-6 text-emerald-100 focus:border-emerald-400 focus:outline-none"
          />
          <p className="mt-2 text-xs text-slate-500">You may paste a complete configuration or only the settings you want to change. Unknown fields and invalid ranges are rejected.</p>
        </div>
      ) : <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 w-full">
        {Object.entries(SETTING_LABELS).map(([key, meta]) => {
          const maxVals = {
            poll_approval_threshold: 3,
            minimum_votes_for_approval: 100,
            minimum_live_voting_duration_minutes: 30,
            consensus_stability_duration_seconds: 300,
            live_voting_duration_minutes: 120,
            suggestion_cooldown_seconds: 3600,
            time_before_poll_seconds: 120,
            time_before_final_vote_seconds: 1800,
            maximum_visible_options: 20,
            consensus_sensitivity: 10,
            room_timer_minutes: 30,
            poll_timer_minutes: 30,
            convergence_summary_minutes: 10,
            group_proactivity: 5,
            user_poll_rate_limit: 11,
            user_inactivity_timeout_minutes: 15
          };
          const maxVal = maxVals[key] || 5;
          const defaultVal = key === 'consensus_sensitivity' ? 4 : (key === 'poll_approval_threshold' ? 1 : (key === 'minimum_votes_for_approval' ? 50 : (key === 'minimum_live_voting_duration_minutes' ? 1 : (key === 'consensus_stability_duration_seconds' ? 20 : (key === 'live_voting_duration_minutes' ? 5 : (key === 'suggestion_cooldown_seconds' ? 30 : ((key === 'time_before_poll_seconds' || key === 'time_before_final_vote_seconds') ? 10 : (key === 'maximum_visible_options' ? 8 : (key === 'poll_timer_minutes' ? 2 : (key === 'convergence_summary_minutes' ? 1 : (key === 'user_poll_rate_limit' ? 11 : (key === 'user_inactivity_timeout_minutes' ? 5 : 3))))))))))));
          const currentVal = localSettings?.[key] !== undefined ? localSettings[key] : defaultVal;
          const currentToggleVal = !!(localSettings?.[key] ?? decision.settings?.[key] ?? false);
          const displayVal = (key === 'consensus_sensitivity')
            ? `${currentVal}/10 (${currentVal * 10}%)`
            : (key === 'minimum_votes_for_approval')
            ? `${currentVal}%`
            : (key === 'consensus_stability_duration_seconds' || key === 'suggestion_cooldown_seconds' || (key === 'time_before_poll_seconds' || key === 'time_before_final_vote_seconds'))
              ? ((key === 'time_before_poll_seconds' || key === 'time_before_final_vote_seconds') && currentVal === 0 ? 'Immediate' : `${currentVal} sec`)
              : (key === 'live_voting_duration_minutes' || key === 'minimum_live_voting_duration_minutes' || key === 'user_inactivity_timeout_minutes' || key === 'convergence_summary_minutes')
                ? `${currentVal} min`
                : (key === 'maximum_visible_options')
                  ? `${currentVal} options`
                  : (key === 'user_poll_rate_limit')
            ? (currentVal === 0 ? 'Disabled' : (currentVal === 11 ? 'Endless' : `${currentVal}/10`))
                : `${currentVal}/${maxVal}`;
          if (key === 'check_response_validity') {
            return <div key={key} className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm flex flex-col justify-between">
              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-200">{meta.label}</span>
                  <InfoButton onClick={() => openInfoModal(meta.label, meta.description, meta.notes)} />
                </div>
                <p className="mb-4 text-xs leading-relaxed text-slate-400">{meta.help}</p>
              </div>
              <ToggleSwitch
                checked={currentToggleVal}
                onChange={(checked) => saveImmediateSetting(key, checked)}
                label={currentToggleVal ? 'On' : 'Off'}
              />
            </div>;
          }
          return <div key={key} className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm flex flex-col justify-between">
            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-200">{meta.label}</span>
                <div className="flex items-center gap-1.5">
                  <span className="font-bold text-indigo-400">{displayVal}</span>
                  <InfoButton onClick={() => openInfoModal(meta.label, meta.description, meta.notes)} />
                </div>
              </div>
              <p className="mb-4 text-xs leading-relaxed text-slate-400">{meta.help}</p>
            </div>
            <input type="range" min={(key === 'user_poll_rate_limit' || key === 'minimum_live_voting_duration_minutes' || (key === 'time_before_poll_seconds' || key === 'time_before_final_vote_seconds')) ? 0 : (key === 'user_inactivity_timeout_minutes' ? 3 : 1)} max={maxVal} value={currentVal} onChange={(e) => setLocalSettings((prev) => ({ ...prev, [key]: Number(e.target.value) }))} onPointerUp={(e) => saveSetting(key, Number(e.target.value))} onKeyUp={(e) => saveSetting(key, Number(e.target.value))} onBlur={(e) => saveSetting(key, Number(e.target.value))} className="w-full cursor-pointer accent-indigo-500 h-1.5 bg-slate-800 rounded-lg appearance-none" />
          </div>;
        })}
      </div>}
    </section>

    <section className="glass-panel rounded-3xl p-6 mt-8">
      <h3 className="mb-2 text-xl font-semibold tracking-tight text-white">LLM Models</h3>
      <p className="mb-6 text-sm text-slate-400 font-inter">Select models for automated tasks. If empty, backend env variables are used.</p>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-semibold text-slate-200">Primary Model</span>
            <InfoButton onClick={() => openInfoModal('Primary Model', 'Main reasoning model used for deep evaluation.', [])} />
          </div>
          <select value={localSettings.primary_model || ''} onChange={(e) => saveImmediateSetting('primary_model', e.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-2.5 text-white shadow-sm focus:border-indigo-500 focus:outline-none transition-all">
            <option value="">Default (from .env)</option>
            <option value="gpt-5.6-sol">gpt-5.6-sol</option>
            <option value="gpt-5.6-terra">gpt-5.6-terra</option>
            <option value="gpt-5.6-luna">gpt-5.6-luna</option>
            <option value="gpt-5.4">gpt-5.4 (legacy)</option>
            <option value="gpt-5.4-mini">gpt-5.4-mini (legacy)</option>
            <option value="gpt-4o-mini">gpt-4o-mini (legacy)</option>
          </select>
        </div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-semibold text-slate-200">Cheap Model</span>
            <InfoButton onClick={() => openInfoModal('Cheap Model', 'Model used for fast simple tasks like validity checking.', [])} />
          </div>
          <select value={localSettings.cheap_model || ''} onChange={(e) => saveImmediateSetting('cheap_model', e.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-2.5 text-white shadow-sm focus:border-indigo-500 focus:outline-none transition-all">
            <option value="">Default (from .env)</option>
            <option value="gpt-5.6-luna">gpt-5.6-luna</option>
            <option value="gpt-5.6-terra">gpt-5.6-terra</option>
            <option value="gpt-5.6-sol">gpt-5.6-sol</option>
            <option value="gpt-5.4-mini">gpt-5.4-mini (legacy)</option>
            <option value="gpt-4o-mini">gpt-4o-mini (legacy)</option>
          </select>
        </div>
      </div>
    </section>


    <section className="glass-panel rounded-3xl p-6 mt-8">
      <h3 className="mb-2 text-xl font-semibold tracking-tight text-white">Discussion Room Clustering</h3>
      <p className="mb-6 text-sm text-slate-400 font-inter">After personal chats close, Agent 2 creates discussion rooms using this strategy.</p>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm">
          <div className="mb-3 flex items-center justify-between">
            <span className="font-semibold text-slate-200">Strategy</span>
            <InfoButton onClick={() => openInfoModal('Clustering Strategy', 'Algorithm used to group users into different discussion rooms based on their answers collected in personal chats.', [
              'Random: Groups users completely at random.',
              'Homophilic: Groups users with similar opinions to foster high-consensus environments.',
              'Heterophilic: Groups users with contrasting opinions to encourage debate.',
              'Mixed: Combines both to achieve balanced representative groups.',
              'Topic Preference: Groups users based on the discussion topics they are most interested in.'
            ])} />
          </div>
          <select value={localSettings.clustering_strategy || 'topic_preference'} onChange={(e) => saveImmediateSetting('clustering_strategy', e.target.value)} className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-2.5 text-white shadow-sm focus:border-indigo-500 focus:outline-none transition-all">
            <option value="random">Random</option>
            <option value="homophilic">Homophilic</option>
            <option value="heterophilic">Heterophilic</option>
            <option value="mixed">Mixed</option>
            <option value="topic_preference">Ask for topic preferences</option>
          </select>
          <p className="mt-3 text-xs leading-relaxed text-slate-400">Random ignores answers; homophilic groups similar answers; heterophilic mixes different answers; mixed balances both; topic preference groups users by topic interests.</p>
        </div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm flex flex-col justify-between">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold text-slate-200">Minimum users per room</span>
              <InfoButton onClick={() => openInfoModal('Minimum Users Per Room', 'Minimum participant threshold allowed when partitioning users into discussion rooms.', [
                'Ensures that Agent 2 does not create micro-rooms with too few participants, which limits conversation richness.'
              ])} />
            </div>
            <input type="number" min="2" value={localSettings.clustering_min_users_per_room || 2} onChange={(e) => setLocalSettings((prev) => ({ ...prev, clustering_min_users_per_room: Number(e.target.value) }))} onBlur={(e) => saveSetting('clustering_min_users_per_room', Number(e.target.value))} className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-2 text-white shadow-sm focus:border-indigo-500 focus:outline-none transition-all" />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-slate-400">Agent 2 will not intentionally create rooms smaller than this unless there are too few users.</p>
        </div>
        <div className="rounded-2xl border border-white/5 bg-slate-900/40 p-4 shadow-inner text-sm flex flex-col justify-between">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold text-slate-200">Minimum rooms</span>
              <InfoButton onClick={() => openInfoModal('Minimum Rooms', 'Minimum number of discussion rooms that Agent 2 should attempt to create.', [
                'Ensures the process scales across multiple concurrent group tracks when there are many participants.'
              ])} />
            </div>
            <input type="number" min="1" value={localSettings.clustering_min_rooms || 2} onChange={(e) => setLocalSettings((prev) => ({ ...prev, clustering_min_rooms: Number(e.target.value) }))} onBlur={(e) => saveSetting('clustering_min_rooms', Number(e.target.value))} className="w-full rounded-xl border border-white/10 bg-slate-900/60 px-4 py-2 text-white shadow-sm focus:border-indigo-500 focus:outline-none transition-all" />
          </div>
          <p className="mt-4 text-xs leading-relaxed text-slate-400">If enough users exist, Agent 2 creates at least this many discussion rooms.</p>
        </div>
      </div>
    </section>

    <section className="glass-panel rounded-3xl p-6 mt-8">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h3 className="text-xl font-semibold tracking-tight text-white">Agent Console</h3>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-slate-400 font-medium">Send message to:</span>
          <select
            value={consoleTarget}
            onChange={(e) => setConsoleTarget(e.target.value)}
            className="rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-slate-100 shadow-sm focus:border-indigo-500 focus:outline-none transition-all"
          >
            <option value="agents">Decision Agents Chat</option>
            {rooms.map((room) => (
              <option key={room.id} value={`room_${room.id}`}>
                Room: {room.name} ({room.room_type})
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mb-4 h-96 overflow-y-auto rounded-2xl border border-white/5 bg-slate-900/30 p-4 shadow-inner text-sm scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
        {chat.map((message, index) => (
          <p key={index} className="mb-3 leading-relaxed">
            <span className={`font-bold mr-2 ${message.role === 'admin' ? 'text-indigo-400' : 'text-emerald-400'}`}>{message.role}:</span> 
            <span className="text-slate-200">{message.content}</span>
          </p>
        ))}
        {!chat.length ? (
          <div className="flex h-full items-center justify-center text-center">
            <p className="text-slate-500 max-w-sm leading-relaxed">
              Use @agent1, @agent2, or @agent3 to target one agent. Without @, all agents answer. Select a room from the dropdown to send a message as the bot.
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder={
            consoleTarget === 'agents'
              ? '@agent3 close the personal conversations'
              : 'Message to send to the room as the bot...'
          }
          className="min-w-0 flex-1 rounded-full border border-white/10 bg-slate-900/60 px-5 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10 shadow-sm"
        />
        <button onClick={submit} className="rounded-full bg-indigo-600 hover:bg-indigo-500 px-6 py-3 font-semibold text-white transition-all active:scale-95 shadow-md shadow-indigo-900/20">
          Send
        </button>
      </div>
    </section>

    <div className="grid gap-6 mt-6 xl:grid-cols-3">{(decision.agents || []).map((agent) => <AgentPanel key={agent.key} agent={agent} />)}</div>


  </div>;
}

function AgentPanel({ agent }) {
  return <section className="glass-panel rounded-3xl p-5 shadow-lg flex flex-col"><div className="mb-4 border-b border-white/5 pb-3"><h3 className="font-semibold text-lg text-slate-100">{agent.name}</h3><p className="text-xs uppercase tracking-widest font-bold text-slate-500 mt-0.5">{agent.role}</p></div><div className="mb-4 rounded-2xl border border-white/5 bg-slate-900/40 p-4 text-sm shadow-inner"><p className="mb-2 text-slate-300"><span className="font-bold text-indigo-400 mr-2">Doing:</span> {agent.doing}</p><p className="text-slate-300"><span className="font-bold text-emerald-400 mr-2">Why:</span> {agent.why}</p></div>{agent.instructions ? <div className="mb-4 rounded-2xl border border-white/5 bg-slate-900/40 p-4 text-xs text-slate-300 whitespace-pre-wrap shadow-inner leading-relaxed">{agent.instructions}</div> : null}<div className="h-80 overflow-y-auto rounded-2xl border border-white/5 bg-slate-900/30 p-4 text-xs shadow-inner scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent flex-1">{(agent.events || []).map((event, index) => <div key={`${event.created_at}-${index}`} className="mb-4 border-b border-slate-800/50 pb-3 last:border-0 last:mb-0 last:pb-0"><p className="font-semibold text-slate-200 mb-1 leading-snug">{event.summary}</p><p className="text-slate-400 leading-relaxed">{event.detail}</p></div>)}{!(agent.events || []).length ? <div className="flex h-full items-center justify-center text-slate-500">No actions logged yet.</div> : null}</div></section>;
}

function ToggleSwitch({ checked, onChange, label }) {
  return <label className="inline-flex items-center gap-3 cursor-pointer"><button type="button" onClick={() => onChange(!checked)} className={`relative h-6 w-11 rounded-full transition-colors shadow-inner ${checked ? 'bg-indigo-500' : 'bg-slate-700'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-md transition-all ${checked ? 'left-5' : 'left-0.5'}`} /></button><span className="text-sm font-medium text-slate-300 select-none">{label}</span></label>;
}

function UsersTab({ users, newUser, setNewUser, createUser, deleteUser }) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredUsers = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q));
  }, [users, searchQuery]);

  return (
    <div className="space-y-6">
      <div className="glass-panel rounded-3xl p-6 shadow-xl">
        <div className="grid gap-4 md:grid-cols-4 items-center">
          <input
            value={newUser.username}
            onChange={(e) => setNewUser((s) => ({ ...s, username: e.target.value }))}
            placeholder="Username"
            className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <input
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser((s) => ({ ...s, password: e.target.value }))}
            placeholder="Password"
            className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
          />
          <ToggleSwitch checked={newUser.is_admin} onChange={(v) => setNewUser((s) => ({ ...s, is_admin: v }))} label="Admin Privileges" />
          <button onClick={createUser} className="w-full rounded-full bg-emerald-600 px-4 py-3 font-semibold text-white hover:bg-emerald-500 transition-all active:scale-95 shadow-md shadow-emerald-900/20">
            Create User
          </button>
        </div>
      </div>

      <div className="glass-panel rounded-3xl p-6 shadow-xl space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/5 pb-4">
          <h3 className="text-xl font-semibold tracking-tight text-white">System Users</h3>
          <input
            type="text"
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full sm:w-64 rounded-full border border-white/10 bg-slate-900/60 px-4 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition-all shadow-inner"
          />
        </div>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent">
          {filteredUsers.map((u) => (
            <div key={u.id} className="flex items-center justify-between rounded-2xl bg-slate-900/40 border border-white/5 px-4 py-3 shadow-sm hover:border-indigo-500/30 transition-all">
              <span className="font-medium text-slate-200 flex items-center">
                {u.username}
                {u.is_admin ? <span className="ml-3 rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-400 border border-indigo-500/20">admin ghost</span> : null}
              </span>
              <button onClick={() => deleteUser(u)} className="rounded-full bg-red-500/10 hover:bg-red-500 hover:text-white border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400 transition-all active:scale-95 shadow-sm">
                Delete
              </button>
            </div>
          ))}
          {filteredUsers.length === 0 ? <div className="p-6 text-center text-sm text-slate-500 bg-slate-900/20 rounded-2xl border border-dashed border-white/10">No matching users found.</div> : null}
        </div>
      </div>
    </div>
  );
}

function RoomsTab({ rooms, users, newRoom, setNewRoom, createRoom, deleteRoom, deleteAllDiscussionGroups, restorePersonalMemberships, clearRoom, saveMembers }) {
  const discussionGroupCount = rooms.filter((room) => room.room_type === 'group').length;
  return <div className="space-y-6"><div className="glass-panel rounded-3xl p-6 shadow-xl"><div className="grid gap-3 sm:grid-cols-[1fr_auto] items-center"><input value={newRoom.name} onChange={(e) => setNewRoom((s) => ({ ...s, name: e.target.value }))} placeholder="Enter a new room name" className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none" /><button onClick={createRoom} className="w-full sm:w-auto rounded-full bg-emerald-600 px-6 py-3 font-semibold text-white hover:bg-emerald-500 transition-all active:scale-95 shadow-md shadow-emerald-900/20">Create Room</button></div><p className="mt-4 text-xs font-medium text-slate-400 font-inter">Admins are added automatically as ghost observers and are not counted as participants.</p></div><div className="glass-panel rounded-3xl border border-amber-500/20 bg-amber-500/5 p-5 shadow-xl"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-semibold uppercase tracking-wider text-amber-300">Personal Room Repair</h3><p className="mt-1 text-xs text-slate-400">Restore every participant to the personal room named after their username. Existing messages, polls, and room state are preserved.</p></div><button onClick={restorePersonalMemberships} className="w-full shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-5 py-2.5 text-sm font-semibold text-amber-300 transition-all hover:bg-amber-500 hover:text-white sm:w-auto">Restore Personal Memberships</button></div></div><div className="glass-panel rounded-3xl border border-red-500/20 bg-red-500/5 p-5 shadow-xl"><div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"><div><h3 className="text-sm font-semibold uppercase tracking-wider text-red-300">Discussion Group Cleanup</h3><p className="mt-1 text-xs text-slate-400">Delete all generated Discussion Groups, including their messages, polls, and memberships. Personal and Convergence rooms are preserved.</p></div><button onClick={deleteAllDiscussionGroups} disabled={discussionGroupCount === 0} className="w-full shrink-0 rounded-full border border-red-500/30 bg-red-500/10 px-5 py-2.5 text-sm font-semibold text-red-300 transition-all hover:bg-red-500 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto">Delete All Discussion Groups ({discussionGroupCount})</button></div></div><div className="grid gap-6 md:grid-cols-2">{rooms.map((room) => <RoomCard key={room.id} room={room} users={users} saveMembers={saveMembers} deleteRoom={deleteRoom} clearRoom={clearRoom} />)}</div></div>;
}

function RoomCard({ room, users, saveMembers, deleteRoom, clearRoom }) {
  const selectableUsers = users.filter((user) => !user.is_admin);
  const ghostAdmins = (room.members || []).filter((member) => member.is_admin);
  const [selected, setSelected] = useState((room.members || []).filter((member) => !member.is_admin).map((m) => m.id));
  useEffect(() => setSelected((room.members || []).filter((member) => !member.is_admin).map((m) => m.id)), [room.id, room.members]);
  return <div className="glass-panel rounded-3xl p-5 shadow-lg flex flex-col justify-between"><div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-3"><div><strong className="text-lg text-white block tracking-wide">{room.name}</strong><p className="text-xs text-slate-400 mt-1">{room.participant_count || 0} participant{room.participant_count === 1 ? '' : 's'} · {ghostAdmins.length} admin ghost{ghostAdmins.length === 1 ? '' : 's'}</p></div><div className="flex gap-2"><button onClick={() => clearRoom(room)} className="rounded-full bg-amber-500/10 hover:bg-amber-500 hover:text-white border border-amber-500/20 px-3 py-1.5 text-xs font-semibold text-amber-400 transition-all active:scale-95 shadow-sm">Clear</button><button onClick={() => deleteRoom(room)} className="rounded-full bg-red-500/10 hover:bg-red-500 hover:text-white border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400 transition-all active:scale-95 shadow-sm">Delete</button></div></div><div className="mb-4 max-h-48 overflow-y-auto grid grid-cols-2 gap-2 scrollbar-thin scrollbar-thumb-slate-800 scrollbar-track-transparent pr-1">{selectableUsers.map((u) => <label key={u.id} className={`rounded-xl px-3 py-2 text-xs flex items-center gap-2 cursor-pointer transition-colors border ${selected.includes(u.id) ? 'bg-indigo-500/10 border-indigo-500/30 text-indigo-200' : 'bg-slate-900/40 border-white/5 text-slate-300 hover:bg-slate-800'}`}><input type="checkbox" className="accent-indigo-500" checked={selected.includes(u.id)} onChange={() => setSelected((prev) => prev.includes(u.id) ? prev.filter((x) => x !== u.id) : [...prev, u.id])} /> {u.username}</label>)}</div>{ghostAdmins.length ? <p className="mb-4 text-[10px] font-bold uppercase tracking-wider text-indigo-400">Ghost admins: <span className="text-slate-300 font-medium normal-case">{ghostAdmins.map((admin) => admin.username).join(', ')}</span></p> : null}<button onClick={() => saveMembers(room.id, selected)} className="w-full rounded-full bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-all active:scale-95 shadow-md shadow-indigo-900/20 mt-auto">Save Participants</button></div>;
}

function PollsTab({ rooms, selectedRoom, selectedRoomId, setSelectedRoomId, newPoll, setNewPoll, createPoll, patchPoll, deletePoll }) {
  return <div className="space-y-6"><select value={selectedRoomId || ''} onChange={(e) => setSelectedRoomId(Number(e.target.value))} className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-slate-100 shadow-sm focus:border-indigo-500 focus:outline-none transition-all">{rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><div className="glass-panel rounded-3xl p-6 shadow-xl"><input value={newPoll.question} onChange={(e) => setNewPoll((s) => ({ ...s, question: e.target.value }))} placeholder="Poll question" className="mb-3 w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3 text-white transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none" />{newPoll.options.map((o, i) => <input key={i} value={o} onChange={(e) => { const n = [...newPoll.options]; n[i] = e.target.value; setNewPoll((s) => ({ ...s, options: n })); }} placeholder={`Option ${i + 1}`} className="mb-3 w-full rounded-xl border border-white/5 bg-slate-800/50 px-4 py-2 text-sm text-slate-300 transition-all placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none" />)}<div className="mb-4 flex items-center gap-3"><button onClick={() => setNewPoll((s) => ({ ...s, options: [...s.options, ''] }))} className="rounded-full border border-white/10 bg-slate-800/50 hover:bg-slate-700 px-4 py-2 text-xs font-semibold text-slate-300 transition-all active:scale-95 shadow-sm">Add Option</button><input type="number" min="1" value={newPoll.timer_minutes} onChange={(e) => setNewPoll((s) => ({ ...s, timer_minutes: e.target.value }))} placeholder="Timer min" className="w-24 rounded-xl border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500" /></div><div className="flex items-center justify-between border-t border-white/5 pt-4 mt-2"><ToggleSwitch checked={newPoll.mandatory} onChange={(v) => setNewPoll((s) => ({ ...s, mandatory: v }))} label="Mandatory" /><button onClick={createPoll} className="rounded-full bg-emerald-600 px-6 py-2.5 font-semibold text-white hover:bg-emerald-500 transition-all active:scale-95 shadow-md shadow-emerald-900/20">Create Poll</button></div></div><div className="space-y-4">{(selectedRoom?.polls || []).map((p) => <div key={p.id} className="rounded-2xl border border-white/5 bg-slate-900/40 p-5 shadow-inner"><div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-white/5 pb-3"><strong className="text-lg text-slate-100">{p.question}</strong><button onClick={() => deletePoll(p.id)} className="rounded-full bg-red-500/10 hover:bg-red-500 hover:text-white border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-400 transition-all active:scale-95 shadow-sm">Delete</button></div><div className="mb-5 grid gap-3 md:grid-cols-2">{(p.options || []).map((option) => <div key={option.id} className="rounded-xl bg-slate-900/60 border border-white/5 px-4 py-3 text-sm shadow-sm"><div className="flex items-center justify-between gap-3"><span className="text-slate-200">{option.option_text}</span><span className="text-xs font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded-full">{option.votes ?? 0} votes</span></div></div>)}</div><div className="flex flex-wrap gap-6 pt-2 border-t border-white/5"><ToggleSwitch checked={p.show_results} onChange={(v) => patchPoll(p.id, { show_results: v })} label="Show Results" /><ToggleSwitch checked={p.is_closed} onChange={(v) => patchPoll(p.id, { is_closed: v })} label="Closed" /><ToggleSwitch checked={p.mandatory} onChange={(v) => patchPoll(p.id, { mandatory: v })} label="Mandatory" /></div></div>)}</div></div>;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function inlineMarkdown(text, onDocLink) {
  const parts = [];
  let remaining = text;
  let index = 0;
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\(([^)]+)\))/;
  while (remaining.length) {
    const match = remaining.match(pattern);
    if (!match) {
      parts.push(remaining);
      break;
    }
    if (match.index > 0) parts.push(remaining.slice(0, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={`code-${index}`} className="rounded bg-slate-800 px-1 py-0.5 text-cyan-200">{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={`strong-${index}`}>{token.slice(2, -2)}</strong>);
    } else {
      const href = match[3];
      const wikiFileMatch = href.match(/(?:^\.\/|^\/)?([^/#?]+\.md)(?:[#?].*)?$/);
      if (wikiFileMatch && typeof onDocLink === 'function') {
        parts.push(
          <button
            key={`link-${index}`}
            type="button"
            onClick={() => onDocLink(wikiFileMatch[1])}
            className="text-cyan-300 underline decoration-cyan-500/60 hover:text-cyan-100"
          >
            {match[2]}
          </button>
        );
      } else {
        parts.push(<a key={`link-${index}`} href={href} className="text-cyan-300 underline decoration-cyan-500/60 hover:text-cyan-100">{match[2]}</a>);
      }
    }
    remaining = remaining.slice((match.index || 0) + token.length);
    index += 1;
  }
  return parts;
}

function renderMarkdown(markdown, onDocLink) {
  const blocks = [];
  const lines = markdown.split('\n');
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={`pre-${key++}`} className="my-4 overflow-x-auto rounded-xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-100">
          {language ? <div className="mb-2 text-xs uppercase tracking-wide text-slate-500">{language}</div> : null}
          <code>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      const id = slugify(text);
      const className = level === 1
        ? 'mb-5 mt-1 text-4xl font-black tracking-tight text-white'
        : level === 2
          ? 'mb-3 mt-8 border-t border-slate-800 pt-6 text-2xl font-bold text-white'
          : level === 3
            ? 'mb-2 mt-6 text-xl font-semibold text-cyan-100'
            : 'mb-2 mt-4 text-lg font-semibold text-slate-100';
      const Tag = `h${Math.min(level, 4)}`;
      blocks.push(<Tag key={`h-${key++}`} id={id} className={className}>{text}</Tag>);
      i += 1;
      continue;
    }

    if (line.startsWith('- ')) {
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2));
        i += 1;
      }
      blocks.push(
        <ul key={`ul-${key++}`} className="my-4 list-disc space-y-2 pl-6 text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, onDocLink)}</li>)}
        </ul>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push(
        <ol key={`ol-${key++}`} className="my-4 list-decimal space-y-2 pl-6 text-slate-300">
          {items.map((item, itemIndex) => <li key={itemIndex}>{inlineMarkdown(item, onDocLink)}</li>)}
        </ol>
      );
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('- ') &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith('```')
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push(<p key={`p-${key++}`} className="my-3 leading-7 text-slate-300">{inlineMarkdown(paragraph.join(' '), onDocLink)}</p>);
  }

  return blocks;
}

function DocumentationTab() {
  const [activeSlug, setActiveSlug] = useState(wikiDocs[0]?.slug || '');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredDocs = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return wikiDocs;
    return wikiDocs.filter(
      (doc) =>
        doc.title.toLowerCase().includes(query) ||
        doc.file.toLowerCase().includes(query) ||
        (doc.markdown || '').toLowerCase().includes(query)
    );
  }, [searchQuery]);

  const activeDoc = wikiDocs.find((doc) => doc.slug === activeSlug) || filteredDocs[0] || wikiDocs[0];

  const handleDocLink = (target) => {
    const normalized = String(target || '').replace(/^\.?\//, '').toLowerCase();
    const targetSlug = normalized.replace(/\.md$/, '');
    const targetDoc = wikiDocs.find((doc) => doc.slug === targetSlug || doc.file.toLowerCase() === normalized);
    if (targetDoc) {
      setActiveSlug(targetDoc.slug);
    }
  };
  const rendered = useMemo(() => renderMarkdown(activeDoc?.markdown || '', handleDocLink), [activeDoc]);

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
      <aside className="h-fit rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-cyan-400">Pages</h2>
        <div className="mb-3">
          <input
            type="text"
            placeholder="Search docs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-blue-500"
          />
        </div>
        <nav className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {filteredDocs.map((doc) => (
            <button
              key={doc.slug}
              onClick={() => setActiveSlug(doc.slug)}
              className={`w-full rounded-lg px-3 py-2 text-left text-sm transition ${doc.slug === activeDoc.slug ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
            >
              <span className="block font-semibold">{doc.title}</span>
              <span className="text-xs opacity-75">{doc.file}</span>
            </button>
          ))}
          {filteredDocs.length === 0 ? (
            <p className="p-2 text-xs text-slate-500">No matching pages.</p>
          ) : null}
        </nav>
      </aside>

      <article className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl md:p-8">
        {rendered}
      </article>
    </div>
  );
}

function DatabaseTab({ token }) {
  const [tables, setTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState('');
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ totalRows: 0, page: 1, limit: 25, totalPages: 1 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchTableQuery, setSearchTableQuery] = useState('');
  const [searchRowQuery, setSearchRowQuery] = useState('');
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState('ASC');
  const [inspectorData, setInspectorData] = useState(null);
  const [showCleanModal, setShowCleanModal] = useState(false);
  const [cleanMode, setCleanMode] = useState('older_than'); // 'all' | 'older_than'
  const [cleanDays, setCleanDays] = useState(7);
  const [cleaning, setCleaning] = useState(false);

  const handleCleanTable = async () => {
    if (!selectedTable) return;
    try {
      setCleaning(true);
      setError('');
      const res = await apiRequest(`/admin/db/tables/${selectedTable}/clean`, {
        method: 'POST',
        body: JSON.stringify({ mode: cleanMode, days: cleanDays })
      }, token);
      if (res.success) {
        setShowCleanModal(false);
        fetchTableData(selectedTable, 1, pagination.limit, sortBy, sortOrder);
      }
    } catch (e) {
      setError(`Failed to clean table ${selectedTable}: ` + e.message);
    } finally {
      setCleaning(false);
    }
  };

  const fetchTables = async () => {
    try {
      setLoading(true);
      const res = await apiRequest('/admin/db/tables', {}, token);
      if (res.success && res.tables) {
        setTables(res.tables);
        if (res.tables.length && !selectedTable) {
          setSelectedTable(res.tables[0]);
        }
      }
    } catch (e) {
      setError('Failed to fetch tables: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchTableData = async (tableName, page = 1, limit = 25, sort = '', order = 'ASC') => {
    if (!tableName) return;
    try {
      setLoading(true);
      setError('');
      const sortParams = sort ? `&sortBy=${sort}&sortOrder=${order}` : '';
      const res = await apiRequest(`/admin/db/tables/${tableName}?page=${page}&limit=${limit}${sortParams}`, {}, token);
      if (res.success) {
        setColumns(res.columns || []);
        setRows(res.rows || []);
        setPagination(res.pagination || { totalRows: 0, page, limit, totalPages: 1 });
      }
    } catch (e) {
      setError(`Failed to load data for ${tableName}: ` + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTables();
  }, [token]);

  useEffect(() => {
    if (selectedTable) {
      setSortBy('');
      setSortOrder('ASC');
      setSearchRowQuery('');
      fetchTableData(selectedTable, 1, pagination.limit);
    }
  }, [selectedTable]);

  const handlePageChange = (newPage) => {
    fetchTableData(selectedTable, newPage, pagination.limit, sortBy, sortOrder);
  };

  const handleLimitChange = (newLimit) => {
    fetchTableData(selectedTable, 1, newLimit, sortBy, sortOrder);
  };

  const handleSort = (columnName) => {
    let order = 'ASC';
    if (sortBy === columnName) {
      order = sortOrder === 'ASC' ? 'DESC' : 'ASC';
    }
    setSortBy(columnName);
    setSortOrder(order);
    fetchTableData(selectedTable, 1, pagination.limit, columnName, order);
  };

  const filteredTables = tables.filter((t) => t.toLowerCase().includes(searchTableQuery.toLowerCase()));

  // Client-side row filter
  const filteredRows = rows.filter((row) => {
    if (!searchRowQuery.trim()) return true;
    const query = searchRowQuery.toLowerCase();
    return Object.values(row).some((val) => String(val || '').toLowerCase().includes(query));
  });

  const formatCellValue = (val) => {
    if (val === null || val === undefined) {
      return <span className="italic text-slate-500">null</span>;
    }
    if (typeof val === 'object') {
      return JSON.stringify(val);
    }
    return String(val);
  };

  const isJSON = (str) => {
    try {
      const parsed = JSON.parse(str);
      return typeof parsed === 'object' && parsed !== null;
    } catch {
      return false;
    }
  };

  const tryFormatJSON = (str) => {
    try {
      const parsed = JSON.parse(str);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return str;
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[250px_1fr]">
      {/* Left panel - Tables list */}
      <aside className="h-fit rounded-xl border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="mb-3 text-xs font-bold uppercase tracking-widest text-cyan-400">Database Tables</h2>
        <div className="mb-3">
          <input
            type="text"
            placeholder="Search tables..."
            value={searchTableQuery}
            onChange={(e) => setSearchTableQuery(e.target.value)}
            className="w-full rounded-lg bg-slate-800 px-3 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <nav className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
          {filteredTables.map((t) => (
            <button
              key={t}
              onClick={() => setSelectedTable(t)}
              className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${t === selectedTable ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-800 hover:text-white'}`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.58 4 8 4s8-1.79 8-4M4 7c0-2.21 3.58-4 8-4s8 1.79 8 4m0 5c0 2.21-3.58 4-8 4s-8-1.79-8-4" />
              </svg>
              <span className="font-semibold truncate">{t}</span>
            </button>
          ))}
          {!filteredTables.length ? <p className="p-2 text-xs text-slate-500">No tables found</p> : null}
        </nav>
      </aside>

      {/* Right panel - Table browser */}
      <section className="flex flex-col rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl md:p-6 min-w-0">
        {error ? <p className="mb-4 rounded bg-red-900/50 p-3 text-sm text-red-200">{error}</p> : null}

        {selectedTable ? (
          <>
            {/* Toolbar */}
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <h3 className="text-xl font-bold text-white flex items-center gap-2">
                  <span className="text-cyan-400 font-mono">{selectedTable}</span>
                  <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-400 font-normal">
                    {pagination.totalRows} row{pagination.totalRows === 1 ? '' : 's'}
                  </span>
                </h3>
                <button
                  onClick={() => fetchTableData(selectedTable, pagination.page, pagination.limit, sortBy, sortOrder)}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
                  title="Reload table"
                >
                  <svg className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 7.89M9 11l3-3 3 3m-3-3v12" />
                  </svg>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Search rows..."
                  value={searchRowQuery}
                  onChange={(e) => setSearchRowQuery(e.target.value)}
                  className="min-w-[150px] rounded-lg bg-slate-850 border border-slate-850 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-505 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />

                <select
                  value={pagination.limit}
                  onChange={(e) => handleLimitChange(Number(e.target.value))}
                  className="rounded-lg bg-slate-850 border border-slate-850 px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value={10}>10 rows</option>
                  <option value={25}>25 rows</option>
                  <option value={50}>50 rows</option>
                  <option value={100}>100 rows</option>
                </select>

                <button
                  onClick={() => setShowCleanModal(true)}
                  className="flex items-center gap-1.5 rounded-lg bg-red-650/80 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-600 transition"
                  title="Clean old entries"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  <span>Clean</span>
                </button>
              </div>
            </div>

            {/* Table data */}
            <div className="relative flex-1 overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/50">
                    {columns.map((col) => (
                      <th
                        key={col.name}
                        onClick={() => handleSort(col.name)}
                        className="cursor-pointer select-none px-4 py-3 font-semibold text-slate-200 hover:bg-slate-800/40 transition whitespace-nowrap"
                      >
                        <div className="flex items-center gap-1.5">
                          <span>{col.name}</span>
                          <span className="text-[10px] uppercase font-normal text-slate-500 font-mono">
                            {col.type || 'unknown'}
                          </span>
                          {col.pk === 1 ? (
                            <span className="text-[10px] rounded bg-yellow-900/40 text-yellow-500 px-1 border border-yellow-800/40">PK</span>
                          ) : null}
                          <span className="text-slate-500 ml-1">
                            {sortBy === col.name ? (sortOrder === 'ASC' ? '↑' : '↓') : '↕'}
                          </span>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-850">
                  {filteredRows.map((row, rIdx) => (
                    <tr key={rIdx} className="hover:bg-slate-900/30 transition">
                      {columns.map((col) => {
                        const rawVal = row[col.name];
                        const displayVal = formatCellValue(rawVal);
                        const cellStr = typeof rawVal === 'string' ? rawVal : JSON.stringify(rawVal);
                        const isInspectable = rawVal !== null && rawVal !== undefined && (String(rawVal).length > 60 || isJSON(rawVal));

                        return (
                          <td key={col.name} className="px-4 py-2.5 max-w-xs truncate text-slate-300 font-mono text-xs">
                            {isInspectable ? (
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate">{cellStr}</span>
                                <button
                                  onClick={() => setInspectorData({ title: `${selectedTable} -> ${col.name}`, content: cellStr })}
                                  className="rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-cyan-400 px-1.5 py-0.5 border border-slate-700 transition"
                                >
                                  Inspect
                                </button>
                              </div>
                            ) : (
                              displayVal
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {!filteredRows.length ? (
                    <tr>
                      <td colSpan={columns.length} className="px-4 py-8 text-center text-slate-500">
                        {loading ? 'Loading data...' : 'No entries found'}
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {/* Pagination footer */}
            <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
              <span className="text-xs text-slate-400">
                Showing {pagination.totalRows === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1} to{' '}
                {Math.min(pagination.page * pagination.limit, pagination.totalRows)} of {pagination.totalRows} entries
              </span>
              <div className="flex items-center gap-2">
                <button
                  disabled={pagination.page <= 1 || loading}
                  onClick={() => handlePageChange(pagination.page - 1)}
                  className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:pointer-events-none transition"
                >
                  &larr; Previous
                </button>
                <span className="text-xs font-semibold text-slate-300">
                  Page {pagination.page} of {pagination.totalPages || 1}
                </span>
                <button
                  disabled={pagination.page >= pagination.totalPages || loading}
                  onClick={() => handlePageChange(pagination.page + 1)}
                  className="rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50 disabled:pointer-events-none transition"
                >
                  Next &rarr;
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-20 text-center text-slate-500">
            <svg className="mb-4 h-16 w-16 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.58 4 8 4s8-1.79 8-4M4 7c0-2.21 3.58-4 8-4s8 1.79 8 4m0 5c0 2.21-3.58 4-8 4s-8-1.79-8-4" />
            </svg>
            <p className="text-lg font-semibold">Select a table to start exploring</p>
            <p className="text-sm">Click any table name in the sidebar to load database contents.</p>
          </div>
        )}
      </section>

      {/* Inspector Modal */}
      {inspectorData ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-semibold text-white truncate font-mono text-sm">{inspectorData.title}</h4>
              <button
                onClick={() => setInspectorData(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-auto rounded-lg bg-slate-950 p-4">
              <pre className="font-mono text-xs text-cyan-400 whitespace-pre-wrap leading-5">
                {tryFormatJSON(inspectorData.content)}
              </pre>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setInspectorData(null)}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Clean Table Modal */}
      {showCleanModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="flex w-full max-w-md flex-col rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-3">
              <h4 className="font-semibold text-white">Clean Table: <span className="font-mono text-cyan-400">{selectedTable}</span></h4>
              <button
                onClick={() => setShowCleanModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 py-2">
              <div>
                <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2 font-medium">Clean Mode</label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="radio"
                      name="cleanMode"
                      value="older_than"
                      checked={cleanMode === 'older_than'}
                      onChange={() => setCleanMode('older_than')}
                      className="text-blue-600 focus:ring-0"
                    />
                    <span>Older than X days</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-red-400">
                    <input
                      type="radio"
                      name="cleanMode"
                      value="all"
                      checked={cleanMode === 'all'}
                      onChange={() => setCleanMode('all')}
                      className="text-red-600 focus:ring-0"
                    />
                    <span>Delete ALL entries</span>
                  </label>
                </div>
              </div>

              {cleanMode === 'older_than' ? (
                <div>
                  <label className="block text-xs uppercase tracking-wider text-slate-400 mb-1 font-medium">Days Threshold</label>
                  <input
                    type="number"
                    min="1"
                    value={cleanDays}
                    onChange={(e) => setCleanDays(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full rounded bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-cyan-500"
                  />
                  <p className="mt-1 text-[11px] text-slate-400 leading-normal">
                    This will delete rows with timestamps older than {cleanDays} day{cleanDays === 1 ? '' : 's'}. Note: Only applies to tables with date/time columns.
                  </p>
                </div>
              ) : (
                <div className="rounded border border-red-900/40 bg-red-950/20 p-3">
                  <p className="text-xs text-red-300 leading-normal">
                    <strong>Warning:</strong> This will delete every single record in <span className="font-mono">{selectedTable}</span>. This action is destructive and cannot be undone.
                  </p>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end gap-3">
              <button
                disabled={cleaning}
                onClick={() => setShowCleanModal(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm hover:bg-slate-700 transition"
              >
                Cancel
              </button>
              <button
                disabled={cleaning}
                onClick={handleCleanTable}
                className={`rounded-lg px-4 py-2 text-sm font-semibold text-white transition flex items-center gap-1.5 ${cleanMode === 'all' ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'} disabled:opacity-50`}
              >
                {cleaning ? 'Cleaning...' : cleanMode === 'all' ? 'Delete All' : 'Clean'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LlmLogsTab({ token }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(100);
  const [expandedLogId, setExpandedLogId] = useState(null);

  const fetchLogs = async () => {
    try {
      setLoading(true);
      setError('');
      const res = await apiRequest(`/admin/llm-logs?limit=${limit}`, {}, token);
      if (Array.isArray(res)) {
        setLogs(res);
      } else {
        setLogs([]);
      }
    } catch (e) {
      setError('Failed to fetch LLM logs: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [limit]);

  const toggleExpand = (id) => {
    setExpandedLogId(expandedLogId === id ? null : id);
  };

  const getCallerBadge = (caller) => {
    const name = String(caller || '').toLowerCase();
    let badgeColor = 'bg-slate-800 text-slate-300';
    if (name.includes('agent1')) {
      badgeColor = 'bg-blue-900/30 text-blue-400 border border-blue-800/50';
    } else if (name.includes('agent2')) {
      badgeColor = 'bg-amber-900/30 text-amber-400 border border-amber-800/50';
    } else if (name.includes('agent3')) {
      badgeColor = 'bg-purple-900/30 text-purple-400 border border-purple-800/50';
    } else if (name.includes('room-status')) {
      badgeColor = 'bg-cyan-900/30 text-cyan-400 border border-cyan-800/50';
    } else if (name.includes('admin')) {
      badgeColor = 'bg-pink-900/30 text-pink-400 border border-pink-800/50';
    } else if (name.includes('user-agent-chat')) {
      badgeColor = 'bg-emerald-900/30 text-emerald-400 border border-emerald-800/50';
    }
    return (
      <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${badgeColor}`}>
        {caller}
      </span>
    );
  };

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-6 shadow-xl">
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-bold text-slate-100">LLM API Call Logs</h2>
          <p className="text-sm text-slate-400">Chronological history of OpenAI API calls intercepted by the system</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-400">Show last:</span>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-blue-500"
            >
              <option value="50">50 calls</option>
              <option value="100">100 calls</option>
              <option value="250">250 calls</option>
              <option value="500">500 calls</option>
            </select>
          </div>
          <button
            onClick={fetchLogs}
            disabled={loading}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50 transition"
          >
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {error ? (
        <div className="mb-4 rounded bg-red-900/40 border border-red-800/50 p-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
        <table className="w-full text-left text-sm text-slate-300">
          <thead className="border-b border-slate-800 bg-slate-950/80 text-xs uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-4 py-3.5">ID</th>
              <th className="px-4 py-3.5">Timestamp</th>
              <th className="px-4 py-3.5">Room</th>
              <th className="px-4 py-3.5">Caller</th>
              <th className="px-4 py-3.5">Model</th>
              <th className="px-4 py-3.5 text-right">Tokens</th>
              <th className="px-4 py-3.5 text-center">Payloads</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {logs.map((log) => {
              const isExpanded = expandedLogId === log.id;
              return (
                <Fragment key={log.id}>
                  <tr className={`hover:bg-slate-800/25 transition-colors ${isExpanded ? 'bg-slate-800/20' : ''}`}>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-500">#{log.id}</td>
                    <td className="px-4 py-3.5 whitespace-nowrap text-xs text-slate-400">
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs">
                      {log.room_id ? (
                        <span className="rounded bg-slate-900 border border-slate-800 px-2 py-0.5 text-cyan-400 font-semibold">
                          Room #{log.room_id}
                        </span>
                      ) : (
                        <span className="text-slate-500 italic">Global</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      {getCallerBadge(log.caller)}
                    </td>
                    <td className="px-4 py-3.5 text-xs text-slate-400 font-mono">{log.model}</td>
                    <td className="px-4 py-3.5 text-right font-mono text-emerald-400 font-semibold">
                      {log.tokens_used !== null ? log.tokens_used.toLocaleString() : '—'}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <button
                        onClick={() => toggleExpand(log.id)}
                        className={`rounded px-3 py-1 text-xs font-semibold transition border ${isExpanded ? 'bg-slate-800 border-slate-700 text-slate-200' : 'bg-blue-600/10 border-blue-500/20 text-blue-400 hover:bg-blue-600/20'}`}
                      >
                        {isExpanded ? 'Collapse' : 'Show Payloads'}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-slate-950/60 border-t border-slate-800">
                      <td colSpan="7" className="px-6 py-4">
                        <div className="grid gap-5 md:grid-cols-2">
                          <div className="flex flex-col">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-cyan-400"></span>
                                Prompt Messages
                              </span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(log.prompt);
                                  alert('Prompt copied!');
                                }}
                                className="rounded bg-slate-850 px-2 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition"
                              >
                                Copy Prompt
                              </button>
                            </div>
                            <pre className="flex-1 max-h-[350px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">
                              {log.prompt}
                            </pre>
                          </div>
                          <div className="flex flex-col">
                            <div className="mb-2 flex items-center justify-between">
                              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
                                Completion Response
                              </span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(log.response);
                                  alert('Response copied!');
                                }}
                                className="rounded bg-slate-850 px-2 py-0.5 text-[10px] font-medium text-slate-400 hover:bg-slate-700 hover:text-slate-200 transition"
                              >
                                Copy Response
                              </button>
                            </div>
                            <pre className="flex-1 max-h-[350px] overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3.5 font-mono text-xs text-emerald-300 whitespace-pre-wrap leading-relaxed">
                              {log.response}
                            </pre>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {logs.length === 0 ? (
              <tr>
                <td colSpan="7" className="py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center justify-center gap-2">
                    <span className="text-2xl">⚡</span>
                    <span className="text-sm font-medium">No LLM API call logs found.</span>
                    <span className="text-xs text-slate-605">Logs will appear as soon as agents make OpenAI requests.</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsTab({ token }) {
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const CALLER_INFO = {
    admin_suggest_reopen: { title: 'Suggest Reopen Check', source: 'admin.js', purpose: 'Analyzes chat history to determine if a previously resolved topic should be reopened.' },
    admin_generate_report: { title: 'Generate Process Report', source: 'admin.js', purpose: 'Synthesizes room decisions into a preliminary or final process summary.' },
    admin_reconcile_members: { title: 'Reconcile Room Members', source: 'admin.js', purpose: 'Re-allocates users to balanced groups when merging/rearranging rooms.' },
    admin_generate_questions: { title: 'AI Question Generator', source: 'admin.js', purpose: 'Auto-generates deliberation questions based on context.' },
    admin_generate_description: { title: 'AI Description Generator', source: 'admin.js', purpose: 'Auto-generates user-facing process description from global question.' },
    decision_suggest: { title: 'Decision Option Suggestions', source: 'decision.js', purpose: 'Generates dynamic options or suggestions to assist users in typing in options.' },
    agent1_reply: { title: 'Agent 1 Facilitation & Nudge', source: 'agent1Service.js', purpose: 'Formulates the conversational agent\'s responses, prompting users or nudging silent rooms.' },
    preference_prompt: { title: 'Agent 2 Preference Analysis', source: 'agent2Service.js', purpose: 'Analyzes user statements to cluster participants based on homophilic/heterophilic values.' },
    personal_room_prompt: { title: 'Agent 2 Personal Room Onboarding', source: 'agent2Service.js', purpose: 'Creates targeted onboarding instructions for personal rooms.' },
    convergence_room_prompt: { title: 'Agent 2 Convergence Prompt', source: 'agent2Service.js', purpose: 'Combines group insights to write a convergence room description.' },
    room_report: { title: 'Agent 2 Room Report Summary', source: 'agent2Service.js', purpose: 'Synthesizes a local summary report when a discussion room completes.' },
    'agent3-evaluateReadyToVote': { title: 'Agent 3 Readiness Evaluation', source: 'agent3Service.js', purpose: 'Examines transcripts to evaluate whether users are ready to vote.' },
    draft_poll: { title: 'Agent 3 Poll Formulation', source: 'agent3Service.js', purpose: 'Drafts poll questions and matching choices based on recent conversation.' },
    infer_poll: { title: 'Agent 3 Topic Option Inference', source: 'agent3Service.js', purpose: 'Computes options for a topic from context and previous discussion.' },
    recap_report: { title: 'Agent 3 Recap Report Generator', source: 'agent3Service.js', purpose: 'Compiles room decisions into a final, unified process report.' },
    room_completion: { title: 'Agent 3 Room Completion Check', source: 'agent3Service.js', purpose: 'Checks if a group room has resolved all its active topics.' },
    suggest_reopen_topic: { title: 'Agent 3 Suggest Reopen Topic', source: 'agent3Service.js', purpose: 'Decides if a closed topic needs to be reopened due to user request.' },
    classify_custom_option: { title: 'Other-Option duplicate classifier', source: 'customOptionAnalysisService.js', purpose: 'Classifies and duplicates-filters user-suggested custom options.' },
    proactiveness: { title: 'Proactiveness Message Analytics', source: 'customOptionAnalysisService.js', purpose: 'Categorizes human messages (e.g. proactive, neutral) for quality analytics.' },
    simulation_persona_autofill: { title: 'Simulation Persona Autofill', source: 'admin.js', purpose: 'Creates a simulation backstory and topic stances from the saved decision context.' },
    room_status: { title: 'Sidebar Room Status Summary', source: 'roomStatusService.js', purpose: 'Summarizes ongoing discussion topics and decided points for the sidebar.' },
    simulation: { title: 'Mock User Chat Simulator', source: 'simulationService.js', purpose: 'Simulates user messages, actions, and votes during the simulation process.' }
  };

  const fetchModels = async () => {
    try {
      const data = await apiRequest('/admin/llm-models', {}, token);
      if (data && data.models) {
        setModels(data.models);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  const handleModelChange = async (key, val) => {
    try {
      setModels(prev => prev.map(m => m.call_key === key ? { ...m, model_name: val } : m));
      await apiRequest('/admin/llm-models', {
        method: 'POST',
        body: JSON.stringify({ call_key: key, model_name: val })
      }, token);
    } catch (err) {
      alert('Failed to update model selection: ' + err.message);
      fetchModels();
    }
  };

  if (loading) return <div className="p-4 text-slate-400 font-medium">Loading settings...</div>;
  if (error) return <div className="p-4 text-red-500 font-medium">Error loading settings: {error}</div>;

  return (
    <div className="space-y-6">
      <div className="rounded border border-slate-700 bg-slate-900 p-6 shadow-xl">
        <h2 className="text-2xl font-bold text-slate-100 mb-2">General Settings</h2>
        <p className="text-sm text-slate-400 mb-6">
          Configure general system preferences. Select which LLM model should be used for each API call context below.
        </p>

        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-950/40">
          <table className="w-full text-left text-sm border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50 text-slate-400 font-semibold">
                <th className="px-4 py-3">Source File</th>
                <th className="px-4 py-3">Call Context</th>
                <th className="px-4 py-3">Purpose / Role</th>
                <th className="px-4 py-3 text-right">Model</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800 text-slate-300">
              {models.map((item) => {
                const info = CALLER_INFO[item.call_key] || { title: item.call_key, source: 'unknown', purpose: 'No description' };
                return (
                  <tr key={item.call_key} className="hover:bg-slate-900/20 transition-colors">
                    <td className="px-4 py-3.5 font-mono text-xs text-indigo-400">{info.source}</td>
                    <td className="px-4 py-3.5 font-semibold text-slate-200">{info.title}</td>
                    <td className="px-4 py-3.5 text-xs text-slate-400 max-w-sm leading-relaxed">{info.purpose}</td>
                    <td className="px-4 py-3.5 text-right">
                      <select
                        value={item.model_name}
                        onChange={(e) => handleModelChange(item.call_key, e.target.value)}
                        className="rounded border border-slate-750 bg-slate-900 px-3 py-1.5 text-xs text-slate-100 outline-none focus:border-indigo-500 font-medium cursor-pointer"
                      >
                        <option value="gpt-5.6-sol">gpt 5.6 sol</option>
                        <option value="gpt-5.6-terra">gpt 5.6 terra</option>
                        <option value="gpt-5.6-luna">gpt 5.6 luna</option>
                        <option value="gpt-5.4">gpt 5.4 (legacy)</option>
                        <option value="gpt-5.4-mini">gpt 5.4 mini (legacy)</option>
                        <option value="gpt-4o-mini">gpt 4o mini (legacy)</option>
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
