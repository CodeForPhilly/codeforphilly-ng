import { useEffect, useMemo, type ReactNode } from 'react';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useNetworkError } from '@/components/NetworkErrorBanner';
import { ApiError } from '@/lib/api';

export function ApiQueryClientProvider({ children }: { children: ReactNode }) {
  const { showError } = useNetworkError();

  const client = useMemo(() => {
    // The banner's Retry re-issues whatever is currently on screen. The
    // closure runs on a later error, after `queryClient` is assigned.
    const retry = () => void queryClient.refetchQueries({ type: 'active' });
    const queryClient = new QueryClient({
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
            showError('Something went wrong. We are looking at it.', retry);
          } else if (!(error instanceof ApiError)) {
            // Network-level error (fetch threw): treat as server error
            showError('Network error. Please check your connection and try again.', retry);
          }
        },
      }),
    });
    return queryClient;
  }, [showError]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      client.clear();
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
