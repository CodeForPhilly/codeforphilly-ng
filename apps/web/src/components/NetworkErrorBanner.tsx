import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

interface NetworkErrorContextValue {
  showError: (message?: string) => void;
  clearError: () => void;
}

const NetworkErrorContext = createContext<NetworkErrorContextValue | null>(null);

export function NetworkErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);

  const showError = useCallback((message?: string) => {
    setError(message ?? 'Something went wrong. We are looking at it.');
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return (
    <NetworkErrorContext.Provider value={{ showError, clearError }}>
      {error && (
        <div
          role="alert"
          className="bg-destructive text-destructive-foreground px-4 py-2 text-sm flex items-center justify-between"
          data-testid="network-error-banner"
        >
          <span>{error}</span>
          <button
            onClick={clearError}
            className="ml-4 underline hover:no-underline"
            aria-label="Dismiss error"
          >
            Retry
          </button>
        </div>
      )}
      {children}
    </NetworkErrorContext.Provider>
  );
}

export function useNetworkError(): NetworkErrorContextValue {
  const ctx = useContext(NetworkErrorContext);
  if (!ctx) {
    throw new Error('useNetworkError must be used within NetworkErrorProvider');
  }
  return ctx;
}
