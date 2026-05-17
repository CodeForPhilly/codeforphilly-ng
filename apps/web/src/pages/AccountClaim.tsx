import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  ApiError,
  type AccountClaimCandidate,
  type AccountClaimCandidatesPayload,
} from '@/lib/api';
import { formatAbsoluteDate, formatRelativeTime } from '@/lib/time';

function safeReturn(input: string | null): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

export function AccountClaim() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload, person: existingPerson, loading: authLoading } = useAuth();
  const returnPath = safeReturn(searchParams.get('return'));

  const [loading, setLoading] = useState(true);
  const [payload, setPayload] = useState<AccountClaimCandidatesPayload | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // If the user already has a session, the claim flow doesn't apply.
    // Per specs/screens/account-claim.md: when cfp_session is present, the
    // claim screen sends the user to /account.
    if (!authLoading && existingPerson) {
      void navigate('/account', { replace: true });
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      try {
        const res = await api.accountClaim.candidates();
        if (cancelled) return;
        setPayload(res.data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          // Missing or expired claim cookie → send to login
          void navigate(`/login?return=${encodeURIComponent(returnPath)}`, { replace: true });
          return;
        }
        toast.error(err instanceof ApiError ? err.message : 'Failed to load claim candidates');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authLoading, existingPerson, navigate, returnPath]);

  const onConfirm = async (candidate: AccountClaimCandidate) => {
    if (!candidate.matchedEmail) {
      // Username-only: take them to the password verify flow with slug pre-filled
      void navigate(
        `/account-claim/by-password?slug=${encodeURIComponent(candidate.slug)}&return=${encodeURIComponent(returnPath)}`,
      );
      return;
    }
    setConfirming(candidate.personId);
    try {
      await api.accountClaim.confirm(candidate.personId);
      toast.success(`Welcome back, ${candidate.fullName}`);
      await reload();
      void navigate(returnPath, { replace: true });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Failed to confirm';
      toast.error(msg);
      setConfirming(null);
    }
  };

  const onDecline = async () => {
    setDeclining(true);
    try {
      await api.accountClaim.decline();
      toast.success("Got it — we'll set up a fresh profile");
      await reload();
      void navigate(returnPath, { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to start fresh');
      setDeclining(false);
    }
  };

  if (loading || authLoading) {
    return (
      <div className="flex justify-center py-20" aria-live="polite" aria-label="Loading claim candidates">
        <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!payload) {
    // Error path already handled by toast + redirect — render nothing
    return null;
  }

  const candidates = payload.candidates;
  const anyEmailMatch = candidates.some((c) => c.matchedVia.includes('email'));
  const header = anyEmailMatch ? 'Welcome back' : 'Almost there';

  return (
    <div className="flex justify-center py-12 px-4">
      <div className="w-full max-w-[640px] space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">{header}</CardTitle>
            <CardDescription className="text-sm">
              We think you might have a Code for Philly account from before our
              recent upgrade. We're trying to connect your GitHub identity to it
              so you don't lose your project memberships and history.
            </CardDescription>
          </CardHeader>
        </Card>

        {candidates.length === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>No candidates</CardTitle>
              <CardDescription>
                We couldn't find an account to suggest. You can start fresh, or
                try the password-verify flow if you remember an old slug.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Button onClick={onDecline} disabled={declining}>
                {declining ? 'Setting up…' : 'Continue as a new member'}
              </Button>
              <Button asChild variant="outline">
                <Link
                  to={`/account-claim/by-password?return=${encodeURIComponent(returnPath)}`}
                >
                  Verify with old username + password
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {candidates.map((c) => (
          <Card key={c.personId}>
            <CardHeader>
              <CardTitle className="text-lg">{c.fullName}</CardTitle>
              <CardDescription>
                <span className="font-mono">{c.slug}</span>
                {c.memberOfCount > 0 && (
                  <>
                    {' · '}member of {c.memberOfCount} project{c.memberOfCount === 1 ? '' : 's'}
                  </>
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div
                className="text-xs text-muted-foreground"
                title={formatAbsoluteDate(c.lastActiveAt)}
              >
                Last updated {formatRelativeTime(c.lastActiveAt)}
              </div>
              {c.matchedEmail ? (
                <div className="rounded-md bg-green-100 dark:bg-green-900/30 text-green-900 dark:text-green-100 px-3 py-2 text-xs">
                  Matched via <span className="font-mono">{c.matchedEmail}</span>
                </div>
              ) : (
                <div className="rounded-md bg-yellow-100 dark:bg-yellow-900/30 text-yellow-900 dark:text-yellow-100 px-3 py-2 text-xs">
                  Matched via username only — please verify with old password
                </div>
              )}

              {c.matchedEmail ? (
                <Button
                  className="w-full"
                  onClick={() => void onConfirm(c)}
                  disabled={confirming !== null}
                >
                  {confirming === c.personId ? 'Confirming…' : 'Yes, this is me'}
                </Button>
              ) : (
                <Button asChild variant="default" className="w-full">
                  <Link
                    to={`/account-claim/by-password?slug=${encodeURIComponent(c.slug)}&return=${encodeURIComponent(returnPath)}`}
                  >
                    Verify with old password →
                  </Link>
                </Button>
              )}
            </CardContent>
          </Card>
        ))}

        {candidates.length > 0 && (
          <Card>
            <CardContent className="pt-6 flex flex-col gap-3">
              <Button onClick={onDecline} disabled={declining} variant="outline">
                {declining ? 'Setting up…' : candidates.length > 1 ? 'None of these are me — start fresh' : "No, this isn't me — start fresh"}
              </Button>
              <Separator />
              <Link
                to={`/account-claim/by-password?return=${encodeURIComponent(returnPath)}`}
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline text-center"
              >
                Have an old account we didn't find? Verify with password →
              </Link>
              <Link
                to={`/account-claim/request-staff-review?return=${encodeURIComponent(returnPath)}`}
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline text-center"
              >
                I don't have the password either — request staff review →
              </Link>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
