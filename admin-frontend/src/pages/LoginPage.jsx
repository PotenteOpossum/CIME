import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../api/client.js';
import { useAdminAuth } from '../contexts/AdminAuthContext.jsx';
import cimeLogo from '../img/CIME_LOGO.png';

export default function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAdminAuth();
  const navigate = useNavigate();

  const onSubmit = async (event) => {
    event.preventDefault();
    setLoading(true);
    setError('');

    try {
      const result = await apiRequest('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });

      if (!result.user?.is_admin) {
        throw new Error('This account is not an admin');
      }

      login(result);
      navigate('/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100 font-sans relative overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute top-1/4 left-1/4 h-96 w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500/20 blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 h-96 w-96 translate-x-1/2 translate-y-1/2 rounded-full bg-emerald-500/10 blur-[120px] pointer-events-none"></div>
      
      <form onSubmit={onSubmit} className="glass-panel w-full max-w-md rounded-[2rem] p-10 relative z-10 flex flex-col gap-6 shadow-2xl shadow-indigo-900/10">
        <div className="flex justify-center mb-2">
          <div className="bg-slate-900/50 p-4 rounded-3xl border border-white/5 backdrop-blur shadow-inner">
            <img src={cimeLogo} alt="CIME Logo" className="h-16 w-auto object-contain opacity-90" />
          </div>
        </div>
        
        <div className="text-center space-y-1 mb-2">
          <h1 className="text-3xl font-semibold tracking-tight text-white">Admin Console</h1>
          <p className="text-sm text-slate-400 font-inter">Sign in to manage decision processes</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 ml-1">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3.5 text-white transition-all placeholder:text-slate-500 hover:bg-slate-900/80 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400 ml-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-2xl border border-white/10 bg-slate-900/60 px-4 py-3.5 text-white transition-all placeholder:text-slate-500 hover:bg-slate-900/80 focus:border-indigo-500 focus:bg-slate-900 focus:outline-none focus:ring-4 focus:ring-indigo-500/10"
            />
          </div>
        </div>

        {error ? (
          <div className="rounded-2xl bg-red-500/10 border border-red-500/20 p-3 text-center">
            <p className="text-sm text-red-400 font-medium">{error}</p>
          </div>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="mt-4 w-full rounded-full bg-gradient-to-r from-indigo-600 to-indigo-500 px-6 py-3.5 text-sm font-semibold tracking-wide text-white transition-all hover:scale-[1.02] hover:shadow-lg hover:shadow-indigo-500/25 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? 'Authenticating...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
