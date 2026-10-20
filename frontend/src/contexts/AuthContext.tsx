import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { getStore, saveStore, getSession, setSession, addAuditLog, makeId } from '../lib/store';
import type { User } from '../lib/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  register: (name: string, email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const session = getSession();
    if (session) {
      const store = getStore();
      const u = store.users.find((x) => x.id === session.user_id);
      if (u && u.account_status === 'active') setUser(u);
      else setSession(null);
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    await new Promise((r) => setTimeout(r, 600));
    const store = getStore();
    const u = store.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) return { ok: false, error: 'No account found with that email address.' };
    if (u.password_hash !== password) return { ok: false, error: 'Incorrect password.' };
    if (u.account_status !== 'active') return { ok: false, error: 'Your account is inactive. Contact an administrator.' };
    const session = { user_id: u.id, token: makeId(), created_at: new Date().toISOString() };
    setSession(session);
    setUser(u);
    const next = addAuditLog(store, u.id, u.full_name, 'Login', `${u.full_name} logged in`);
    saveStore(next);
    return { ok: true };
  }, []);

  const logout = useCallback(() => {
    const session = getSession();
    if (session && user) {
      const store = getStore();
      const next = addAuditLog(store, user.id, user.full_name, 'Logout', `${user.full_name} logged out`);
      saveStore(next);
    }
    setSession(null);
    setUser(null);
  }, [user]);

  const register = useCallback(async (name: string, email: string, password: string) => {
    await new Promise((r) => setTimeout(r, 800));
    const store = getStore();
    const exists = store.users.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (exists) return { ok: false, error: 'An account with this email already exists.' };
    const newUser: User = {
      id: makeId(),
      full_name: name,
      email,
      password_hash: password,
      role: 'Operator',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      account_status: 'active',
    };
    let next = { ...store, users: [...store.users, newUser] };
    next = addAuditLog(next, newUser.id, newUser.full_name, 'User Created', `New account created for ${name}`);
    saveStore(next);
    const session = { user_id: newUser.id, token: makeId(), created_at: new Date().toISOString() };
    setSession(session);
    setUser(newUser);
    return { ok: true };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
