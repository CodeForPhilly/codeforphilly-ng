import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';

/**
 * Persistent nag banner shown directly under the navbar to legacy
 * users (signed in via password) who haven't linked GitHub yet.
 *
 * Visibility rule per specs/screens/account.md +
 * specs/behaviors/account-migration.md:
 *
 *   person is signed in
 *   AND hasGitHubLink === false
 *   AND lastLoginMethod ∈ {legacy_password, password_reset}
 *
 * Dismissible per-session via in-memory state; reload brings it back
 * (the nag is intentionally persistent across navigations to keep the
 * "link your account" prompt visible until the user either links or
 * dismisses).
 */
export function ConnectGitHubBanner() {
  const { person, loading, hasGitHubLink, lastLoginMethod } = useAuth();
  const [dismissed, setDismissed] = useState(false);

  if (loading || !person) return null;
  if (hasGitHubLink) return null;
  if (lastLoginMethod !== 'legacy_password' && lastLoginMethod !== 'password_reset') {
    return null;
  }
  if (dismissed) return null;

  return (
    <div
      role="region"
      aria-label="Connect GitHub"
      className="border-b border-primary/40 bg-primary/5 print:hidden"
    >
      <div className="container mx-auto px-4 py-2 flex flex-col sm:flex-row sm:items-center gap-3">
        <p className="flex-1 text-sm">
          <span className="font-medium">Connect your GitHub account</span>
          <span className="text-muted-foreground">
            {' '}— faster sign-in next time, and one less password to remember.
            Code for Philly plans to retire password sign-in eventually.
          </span>
        </p>
        <form method="POST" action="/api/auth/link-github" className="shrink-0">
          <Button type="submit" size="sm">
            Connect GitHub
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
