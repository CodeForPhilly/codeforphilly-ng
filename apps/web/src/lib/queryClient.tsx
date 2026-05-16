import { useEffect, useMemo, type ReactNode } from 'react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNetworkError } from '@/components/NetworkErrorBanner';
import { ApiError } from '@/lib/api';

export function ApiQueryClientProvider({ children }: { children: ReactNode }) {
  const { showError } = useNetworkError();

  const client = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
            refetchOnWindowFocus: false,
          },
        },
        queryCache: new QueryCache({
          onError: (error) => {
            if (error instanceof ApiError && error.isServerError) {
              showError('Something went wrong. We are looking at it.');
            } else if (!(error instanceof ApiError)) {
              // Network-level error (fetch threw): treat as server error
              showError('Network error. Please check your connection and try again.');
            }
          },
        }),
      }),
    [showError],
  );

  // Clean up on unmount
  useEffect(() => {
    return () => {
      client.clear();
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
