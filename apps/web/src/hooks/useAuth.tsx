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

export type LoginMethod = 'github' | 'legacy_password' | 'password_reset';

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
  /** Whether the current Person has a GitHub identity bound. False when anonymous. */
  hasGitHubLink: boolean;
  /** How the current session was minted. null for anonymous or pre-loginMethod sessions. */
  lastLoginMethod: LoginMethod | null;
  /** Reload auth state from the server */
  reload: () => Promise<void>;
  /** Sign out: calls POST /api/auth/logout then clears state */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

interface MeEnvelope {
  data?: {
    person?: AuthPerson | null;
    accountLevel?: AccountLevel;
    hasGitHubLink?: boolean;
    lastLoginMethod?: LoginMethod | null;
  };
}

interface MeSnapshot {
  person: AuthPerson | null;
  hasGitHubLink: boolean;
  lastLoginMethod: LoginMethod | null;
}

const ANON_SNAPSHOT: MeSnapshot = {
  person: null,
  hasGitHubLink: false,
  lastLoginMethod: null,
};

async function fetchMe(): Promise<MeSnapshot> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (!res.ok) {
      // 401 = anonymous, 404 = not yet implemented — both mean no session
      return ANON_SNAPSHOT;
    }
    const json = (await res.json()) as MeEnvelope;
    return {
      person: json.data?.person ?? null,
      hasGitHubLink: json.data?.hasGitHubLink ?? false,
      lastLoginMethod: json.data?.lastLoginMethod ?? null,
    };
  } catch {
    // Network error — treat as anonymous, don't throw
    return ANON_SNAPSHOT;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<MeSnapshot>(ANON_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  // Use a ref to track if we're mounted so we don't setState after unmount
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const snap = await fetchMe();
    if (mountedRef.current) {
      setSnapshot(snap);
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
      setSnapshot(ANON_SNAPSHOT);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Kick off initial auth check; all setState calls happen in the async
    // callback, not synchronously in the effect body.
    fetchMe()
      .then((snap) => {
        if (mountedRef.current) {
          setSnapshot(snap);
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
    <AuthContext.Provider
      value={{
        person: snapshot.person,
        loading,
        hasGitHubLink: snapshot.hasGitHubLink,
        lastLoginMethod: snapshot.lastLoginMethod,
        reload,
        signOut,
      }}
    >
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
