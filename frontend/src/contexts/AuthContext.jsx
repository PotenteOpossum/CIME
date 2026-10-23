import { participantRunId, sessionKey, platformRequest } from '../platform/client.js';
import { createContext, useContext, useMemo, useState } from 'react';

const AuthContext = createContext(null);

const TOKEN_KEY = sessionKey('chat_jwt_token');
const USER_KEY = sessionKey('chat_user');

export function AuthProvider({ children }) {
  const [token, setToken] = useState(sessionStorage.getItem(TOKEN_KEY) || '');
  const [user, setUser] = useState(() => {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  });

  const login = ({ token: nextToken, user: nextUser }) => {
    sessionStorage.removeItem(sessionKey('stop_logout_at'));
    sessionStorage.removeItem(sessionKey('participation_stopped'));
    sessionStorage.removeItem(sessionKey('participation_completed'));
    sessionStorage.removeItem(sessionKey('completion_url'));
    sessionStorage.setItem(TOKEN_KEY, nextToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  };

  const logout = ({ completed = false } = {}) => {
    if (completed) sessionStorage.setItem(sessionKey('participation_completed'), 'true');
    if (token && participantRunId) platformRequest(`/platform/participants/${participantRunId}/logout`, { method: 'POST' }, token).catch(() => {});
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    setToken('');
    setUser(null);
  };

  const value = useMemo(
    () => ({ token, user, login, logout }),
    [token, user]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
