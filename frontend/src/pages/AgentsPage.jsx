import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { io } from 'socket.io-client';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import cimeLogo from '../img/CIME_LOGO.png';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:4000';

export default function AgentsPage() {
  const { token, user } = useAuth();
  const [decision, setDecision] = useState({ current_phase: 'idle', phase1: { completed: 0, total: 0 }, agents: [] });
  const [chat, setChat] = useState([]);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadDecision = async () => {
    const data = await apiRequest('/decision', {}, token);
    setDecision(data);
  };

  useEffect(() => {
    loadDecision().catch((err) => setError(err.message));
  }, [token]);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      auth: { token },
      transports: ['websocket', 'polling']
    });
    socket.on('decision_process_updated', () => loadDecision().catch(() => {}));
    socket.on('rooms_updated', () => loadDecision().catch(() => {}));
    socket.on('polls_updated', () => loadDecision().catch(() => {}));
    return () => socket.disconnect();
  }, [token]);

  const submit = async () => {
    const message = input.trim();
    if (!message || loading) return;
    setInput('');
    setError('');
    setLoading(true);
    setChat((prev) => [...prev, { role: user?.username || 'You', content: message }]);
    try {
      const result = await apiRequest('/decision/agent-chat', { method: 'POST', body: JSON.stringify({ message }) }, token);
      setChat((prev) => [...prev, { role: 'Agents', content: result.reply || 'No update available right now.' }]);
      await loadDecision();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 p-6 text-slate-900 dark:bg-slate-950 dark:text-slate-100 transition-colors duration-300">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <img src={cimeLogo} alt="CIME Logo" className="h-12 w-auto object-contain" />
            <div>
              <h1 className="text-2xl font-bold">Agent Monitor</h1>
              <p className="text-sm text-slate-500 dark:text-slate-400">Read-only view for {user?.username}. You can ask what is happening, but only admins can change the process.</p>
            </div>
          </div>
          <Link to="/dashboard" className="rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-transparent px-4 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors text-slate-700 dark:text-slate-200 shadow-sm dark:shadow-none">Back to Rooms</Link>
        </header>

        {error ? <p className="mb-4 rounded bg-red-900/50 p-2 text-sm text-red-200">{error}</p> : null}

        <section className="mb-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm transition-colors">
          <h2 className="mb-3 text-lg font-semibold">Decision Process</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusCard label="Phase" value={decision.current_phase || 'idle'} />
            <StatusCard label="Phase 1 Complete" value={`${decision.phase1?.completed || 0}/${decision.phase1?.total || 0}`} />
            <StatusCard label="Question" value={decision.global_question || 'Not started'} />
          </div>
          {decision.clustering?.reason ? (
            <div className="mt-3 rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-sm text-slate-700 dark:text-slate-300 transition-colors">
              <span className="font-medium text-slate-900 dark:text-white">Grouping approach:</span> {decision.clustering.reason}
            </div>
          ) : null}
        </section>

        <section className="mb-4 grid gap-4 lg:grid-cols-3">
          {(decision.agents || []).map((agent) => <AgentPanel key={agent.key} agent={agent} />)}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm transition-colors">
          <h2 className="mb-3 text-lg font-semibold">Ask The Agents</h2>
          <div className="mb-3 h-80 overflow-y-auto rounded-lg bg-slate-50 dark:bg-slate-950 p-3 text-sm border border-slate-200 dark:border-slate-800 transition-colors">
            {chat.map((message, index) => (
              <div key={`${message.role}-${index}`} className="mb-3">
                <p className="font-semibold text-slate-700 dark:text-slate-300">{message.role}</p>
                <p className="whitespace-pre-wrap text-slate-900 dark:text-slate-100">{message.content}</p>
              </div>
            ))}
            {!chat.length ? (
              <p className="text-slate-500 dark:text-slate-400">Try: “What phase are we in?”, “What is Agent 3 checking?”, or “Why is the group waiting?”</p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Ask what is going on..."
              className="min-w-0 flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 outline-none focus:border-blue-500 dark:focus:border-blue-400 text-slate-900 dark:text-slate-100 transition-colors"
            />
            <button disabled={loading} onClick={submit} className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-50">
              {loading ? 'Asking...' : 'Ask'}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusCard({ label, value }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-slate-100 dark:bg-slate-800 p-3 transition-colors">
      <p className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 truncate font-medium">{value}</p>
    </div>
  );
}

function AgentPanel({ agent }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 p-4 shadow-sm transition-colors">
      <div className="mb-3">
        <h3 className="font-semibold">{agent.name}</h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">{agent.role}</p>
      </div>
      <div className="mb-3 rounded-lg bg-slate-100 dark:bg-slate-800 p-3 text-sm transition-colors">
        <p className="mb-1"><span className="font-medium text-slate-900 dark:text-white">Doing:</span> <span className="text-slate-700 dark:text-slate-300">{agent.doing}</span></p>
        <p><span className="font-medium text-slate-900 dark:text-white">Why:</span> <span className="text-slate-700 dark:text-slate-300">{agent.why}</span></p>
      </div>
      <div className="h-44 overflow-y-auto rounded-lg bg-slate-50 dark:bg-slate-800 p-2 text-xs border border-slate-200 dark:border-slate-700/50 transition-colors">
        {(agent.events || []).map((event, index) => (
          <div key={`${event.created_at}-${index}`} className="mb-3">
            <p className="font-medium text-slate-900 dark:text-slate-100">{event.summary}</p>
            {event.detail ? <p className="text-slate-400">{event.detail}</p> : null}
          </div>
        ))}
        {!(agent.events || []).length ? <p className="text-slate-400">No recent actions logged.</p> : null}
      </div>
    </article>
  );
}
