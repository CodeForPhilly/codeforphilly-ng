import {
  createContext,
  useCallback,
  useContext,
  useState,
  type ReactNode,
} from 'react';

interface NetworkErrorContextValue {
  /**
   * Show the banner. Pass `retry` when the failed work can be re-issued; the
   * button then reads "Retry" and runs it. Without one it reads "Dismiss".
   */
  showError: (message?: string, retry?: () => void) => void;
  clearError: () => void;
}

interface NetworkErrorState {
  message: string;
  retry?: () => void;
}

const NetworkErrorContext = createContext<NetworkErrorContextValue | null>(null);

export function NetworkErrorProvider({ children }: { children: ReactNode }) {
  const [error, setError] = useState<NetworkErrorState | null>(null);

  const showError = useCallback((message?: string, retry?: () => void) => {
    setError({ message: message ?? 'Something went wrong. We are looking at it.', retry });
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
          <span>{error.message}</span>
          <button
            onClick={() => {
              error.retry?.();
              clearError();
            }}
            className="ml-4 underline hover:no-underline"
          >
            {error.retry ? 'Retry' : 'Dismiss'}
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
