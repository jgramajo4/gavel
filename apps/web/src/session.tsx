import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { VerifiedSession } from './types';

/**
 * Wallet sessions live in React state for the lifetime of the tab and nowhere
 * else. The Gate auth contract does not require a persisted token, so nothing
 * is written to localStorage, sessionStorage, IndexedDB, or a cookie: a bearer
 * token that survives a reload is a token that survives an XSS too.
 */

interface SessionContextValue {
  session: VerifiedSession | null;
  setSession(session: VerifiedSession | null): void;
  clearSession(): void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({
  children,
  initialSession = null,
}: {
  children: ReactNode;
  initialSession?: VerifiedSession | null;
}) {
  const [session, setSessionState] = useState<VerifiedSession | null>(initialSession);
  const setSession = useCallback((next: VerifiedSession | null) => setSessionState(next), []);
  const clearSession = useCallback(() => setSessionState(null), []);
  const value = useMemo(
    () => ({ session, setSession, clearSession }),
    [session, setSession, clearSession],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession requires a SessionProvider');
  return value;
}
