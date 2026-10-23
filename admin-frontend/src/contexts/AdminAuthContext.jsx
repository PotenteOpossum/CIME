import { createContext, useContext, useMemo, useState } from 'react';

const AdminAuthContext = createContext(null);

const TOKEN_KEY = 'cime_account_token';
const USER_KEY = 'cime_account_user';

export function AdminAuthProvider({ children }) {
  const [token, setToken] = useState(sessionStorage.getItem(TOKEN_KEY) || '');
  const [user, setUser] = useState(() => {
    const raw = sessionStorage.getItem(USER_KEY);
    return raw ? { ...JSON.parse(raw), username: JSON.parse(raw).name, is_admin: true } : null;
  });

  const login = ({ token: nextToken, user: nextUser }) => {
    sessionStorage.setItem(TOKEN_KEY, nextToken);
    sessionStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  };

  const logout = () => {
    fetch('/api/accounts/logout', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(USER_KEY);
    setToken('');
    setUser(null);
  };

  const value = useMemo(() => ({ token, user, login, logout }), [token, user]);
  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext);
  if (!ctx) throw new Error('useAdminAuth must be used within AdminAuthProvider');
  return ctx;
}
