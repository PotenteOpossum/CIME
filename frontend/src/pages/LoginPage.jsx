import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../api/client.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import cimeLogo from '../img/CIME_LOGO.png';

export default function LoginPage() {
  const [username, setUsername] = useState('alice');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const { login } = useAuth();

  const onSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const data = await apiRequest('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      login(data);
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#131314] p-4 transition-colors duration-300">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-sm rounded-3xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-[#1e1f20] p-8 shadow-sm dark:shadow-none transition-colors duration-300"
      >
        <div className="mb-6 flex justify-center">
          <img src={cimeLogo} alt="CIME Logo" className="h-16 w-auto object-contain" />
        </div>
        <h1 className="mb-8 text-center text-2xl font-semibold text-gray-900 dark:text-gray-100">Sign in to CIME</h1>

        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300 ml-2">Username</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="mb-6 w-full rounded-full bg-gray-100 dark:bg-[#282a2c] px-4 py-3 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
        />

        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300 ml-2">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-8 w-full rounded-full bg-gray-100 dark:bg-[#282a2c] px-4 py-3 text-gray-900 dark:text-gray-100 outline-none focus:ring-2 focus:ring-blue-500/50 transition-all"
        />

        {error ? <p className="mb-6 text-center text-sm font-medium text-red-500">{error}</p> : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-blue-600 dark:bg-blue-500 px-4 py-3 font-medium text-white transition hover:bg-blue-700 dark:hover:bg-blue-400 disabled:opacity-70 disabled:cursor-not-allowed shadow-sm hover:shadow-md"
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>
    </div>
  );
}
