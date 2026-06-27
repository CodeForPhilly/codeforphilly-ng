import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';
import { formatRelativeTime, formatAbsoluteDate } from '@/lib/time';

function parseUA(ua: string): string {
  // Tiny UA pretty-printer — pulls out major browser + OS for human display.
  let browser = 'Unknown browser';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari') && !ua.includes('Chrome')) browser = 'Safari';
  else if (ua.includes('Firefox')) browser = 'Firefox';
  let os = '';
  if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  return os ? `${browser} on ${os}` : browser;
}

const LINK_GITHUB_ERROR_MESSAGES: Record<string, string> = {
  github_already_linked: 'Your account is already connected to GitHub.',
  github_id_in_use_elsewhere:
    'That GitHub account is already connected to a different Code for Philly account. Email accounts@codeforphilly.org if this is a mistake.',
  github_unreachable: 'We could not reach GitHub. Please try again in a moment.',
  oauth_state_mismatch: 'Something went wrong with the GitHub link flow. Please try again.',
  oauth_session_invalid: 'Something went wrong with the GitHub link flow. Please try again.',
};

export function Account() {
  const { person, loading, signOut, reload, hasGitHubLink } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // Toast on /account?linked=github or ?error=<code> from the link-flow
  // callback, then strip the param so reloading doesn't re-toast.
  useEffect(() => {
    const linked = searchParams.get('linked');
    const errorCode = searchParams.get('error');
    if (linked === 'github') {
      toast.success('GitHub account connected.');
      void reload();
      const next = new URLSearchParams(searchParams);
      next.delete('linked');
      setSearchParams(next, { replace: true });
    } else if (errorCode && errorCode in LINK_GITHUB_ERROR_MESSAGES) {
      toast.error(LINK_GITHUB_ERROR_MESSAGES[errorCode]!);
      const next = new URLSearchParams(searchParams);
      next.delete('error');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams, reload]);

  const sessionsQ = useQuery({
    queryKey: ['auth-sessions'],
    queryFn: () => api.auth.sessions(),
    enabled: !!person,
  });

  // The /api/people/:slug response for self should include `newsletter`,
  // but the read serializer doesn't yet expose it publicly. We default to
  // false and update from the PATCH response.
  const [optedIn, setOptedIn] = useState<boolean>(false);
  const [savingNewsletter, setSavingNewsletter] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [confirmDeactivateOpen, setConfirmDeactivateOpen] = useState(false);

  useEffect(() => {
    if (!loading && !person) {
      void navigate('/login?return=/account', { replace: true });
    }
  }, [loading, person, navigate]);

  if (loading || !person) {
    return <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>;
  }

  const toggleNewsletter = async () => {
    const next = !optedIn;
    setSavingNewsletter(true);
    try {
      const res = await api.people.setNewsletter(person.slug, next);
      setOptedIn(res.data.newsletter?.optedIn ?? next);
      toast.success(next ? 'Newsletter on' : 'Newsletter off');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update newsletter");
    } finally {
      setSavingNewsletter(false);
    }
  };

  const revokeSession = async (jti: string) => {
    if (!window.confirm('Revoke this session?')) return;
    try {
      await api.auth.revokeSession(jti);
      await queryClient.invalidateQueries({ queryKey: ['auth-sessions'] });
      toast.success('Session revoked');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Revoke failed');
    }
  };

  const handleSignOut = async () => {
    await signOut();
    await reload();
    void navigate('/', { replace: true });
  };

  const handleDeactivate = async () => {
    setDeactivating(true);
    try {
      await api.people.deactivate(person.slug);
      toast.success('Your account has been deactivated. You can reactivate at any time.');
      // Reload auth so the deactivated state is reflected in session display.
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to deactivate account');
    } finally {
      setDeactivating(false);
    }
  };

  const handleReactivate = async () => {
    setDeactivating(true);
    try {
      await api.people.reactivate(person.slug);
      toast.success('Your account has been reactivated and is visible again.');
      await reload();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to reactivate account');
    } finally {
      setDeactivating(false);
    }
  };

  const isDeactivated = !!person.deletedAt;

  const sessions = sessionsQ.data?.data ?? [];

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">Account Settings</h1>

      {/* Identity */}
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>
            {hasGitHubLink
              ? 'Your sign-in identity is sourced from GitHub. To change your name or email, update them on GitHub and sign back in.'
              : 'Connect a GitHub account to use GitHub sign-in. You can still use your existing password until you do.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">GitHub</div>
              <div className="text-xs text-muted-foreground">
                {hasGitHubLink ? 'Connected — primary identity' : 'Not connected'}
              </div>
            </div>
            {hasGitHubLink ? (
              <Button asChild size="sm" variant="outline">
                <a
                  href="https://github.com/settings"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Manage on GitHub →
                </a>
              </Button>
            ) : (
              <form method="POST" action="/api/auth/link-github">
                <Button type="submit" size="sm">
                  Connect GitHub
                </Button>
              </form>
            )}
          </div>
          <div className="border-t border-border pt-3">
            <div className="font-medium">Slack</div>
            <Button size="sm" variant="outline" disabled className="mt-1">
              Connect Slack (coming soon)
            </Button>
          </div>
          <p className="text-xs text-muted-foreground border-t border-border pt-3">
            Profile fields like name, bio, slug, and tags live on the{' '}
            <Link
              to={`/members/${person.slug}/edit`}
              className="text-primary underline"
            >
              profile edit
            </Link>{' '}
            screen.
          </p>
        </CardContent>
      </Card>

      {/* Newsletter */}
      <Card>
        <CardHeader>
          <CardTitle>Newsletter</CardTitle>
          <CardDescription>
            We send occasional updates about Code for Philly events, projects, and
            opportunities.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <label className="flex items-center gap-3 text-sm">
            <Checkbox
              checked={optedIn}
              onCheckedChange={() => void toggleNewsletter()}
              disabled={savingNewsletter}
            />
            Receive Code for Philly newsletters
          </label>
          <p className="text-xs text-muted-foreground mt-2">
            We'll send you newsletters at the email you have on file with GitHub.
            Every email has an unsubscribe link.
          </p>
        </CardContent>
      </Card>

      {/* Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Remembered sessions</CardTitle>
          <CardDescription>
            Devices you've signed in from. Revoke a session to sign that device
            out.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sessionsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No remembered sessions.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase tracking-wide">
                <tr>
                  <th className="text-left font-medium pb-2">Device</th>
                  <th className="text-left font-medium pb-2">IP</th>
                  <th className="text-left font-medium pb-2">Issued</th>
                  <th className="text-right font-medium pb-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sessions.map((s) => (
                  <tr key={s.jti}>
                    <td className="py-2">{parseUA(s.userAgent)}</td>
                    <td className="py-2 font-mono text-xs">{s.ipAddress}</td>
                    <td className="py-2" title={formatAbsoluteDate(s.issuedAt)}>
                      {formatRelativeTime(s.issuedAt)}
                    </td>
                    <td className="py-2 text-right">
                      {s.current ? (
                        <span className="inline-flex items-center rounded-full bg-primary/15 text-primary px-2 py-0.5 text-xs">
                          Current
                        </span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => revokeSession(s.jti)}
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="border-t border-border mt-4 pt-3">
            <Button type="button" variant="outline" onClick={handleSignOut}>
              Sign out of this session
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Claim legacy */}
      <Card>
        <CardHeader>
          <CardTitle>Claim another legacy account</CardTitle>
          <CardDescription>
            Had a Code for Philly account from before the GitHub sign-in change?
            You can claim it here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <Link to="/account/claim-legacy">Find my old account →</Link>
          </Button>
        </CardContent>
      </Card>

      {/* Danger */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Danger zone</CardTitle>
          <CardDescription>
            {isDeactivated
              ? 'Your account is currently deactivated. Your profile is hidden from public views. You can reactivate at any time.'
              : 'Deactivating your account hides your profile from public views. Past contributions remain. You can reactivate at any time by signing back in.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isDeactivated ? (
            <Button
              variant="outline"
              onClick={() => void handleReactivate()}
              disabled={deactivating}
            >
              {deactivating ? 'Reactivating…' : 'Reactivate my account'}
            </Button>
          ) : (
            <>
              <Button
                variant="destructive"
                disabled={deactivating}
                onClick={() => setConfirmDeactivateOpen(true)}
              >
                Deactivate my account
              </Button>
              <Dialog open={confirmDeactivateOpen} onOpenChange={setConfirmDeactivateOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Deactivate your account?</DialogTitle>
                    <DialogDescription>
                      Your profile will be hidden from public views. Past contributions remain
                      in our records. You can sign back in and reactivate at any time.
                    </DialogDescription>
                  </DialogHeader>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setConfirmDeactivateOpen(false)}>
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={deactivating}
                      onClick={() => {
                        setConfirmDeactivateOpen(false);
                        void handleDeactivate();
                      }}
                    >
                      {deactivating ? 'Deactivating…' : 'Deactivate'}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
