import { useOnline } from '@/hooks/useOnline';

export function OfflineBanner() {
  const online = useOnline();

  if (online) return null;

  return (
    <div
      role="alert"
      className="bg-yellow-500 text-yellow-950 px-4 py-2 text-sm text-center"
      data-testid="offline-banner"
    >
      You are offline. Some features may not work.
    </div>
  );
}
