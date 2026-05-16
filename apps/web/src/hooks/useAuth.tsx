import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type AccountLevel = 'anonymous' | 'user' | 'staff' | 'administrator';

export interface AuthPerson {
  id: string;
  slug: string;
  fullName: string;
  avatarUrl: string | null;
  accountLevel: AccountLevel;
}

export interface AuthState {
  /** null = anonymous or not yet loaded */
  person: AuthPerson | null;
  /** true while the initial /api/auth/me fetch is in flight */
  loading: boolean;
  /** Reload auth state from the server */
  reload: () => Promise<void>;
  /** Sign out: calls POST /api/auth/logout then clears state */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

async function fetchMe(): Promise<AuthPerson | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      // 401 = anonymous, 404 = not yet implemented — both mean no session
      return null;
    }
    const json = (await res.json()) as { data?: AuthPerson };
    return json.data ?? null;
  } catch {
    // Network error — treat as anonymous, don't throw
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [person, setPerson] = useState<AuthPerson | null>(null);
  const [loading, setLoading] = useState(true);
  // Use a ref to track if we're mounted so we don't setState after unmount
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const p = await fetchMe();
    if (mountedRef.current) {
      setPerson(p);
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch {
      // Ignore network errors on logout
    }
    if (mountedRef.current) {
      setPerson(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Kick off initial auth check; all setState calls happen in the async
    // callback, not synchronously in the effect body.
    fetchMe()
      .then((p) => {
        if (mountedRef.current) {
          setPerson(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });

    return () => {
      mountedRef.current = false;
    };
  }, []);

  return (
    <AuthContext.Provider value={{ person, loading, reload, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
