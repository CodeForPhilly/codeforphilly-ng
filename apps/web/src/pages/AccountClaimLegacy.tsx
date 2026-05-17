import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/useAuth';
import {
  api,
  ApiError,
  type AccountClaimCandidate,
} from '@/lib/api';

export function AccountClaimLegacy() {
  const { person, loading } = useAuth();
  const navigate = useNavigate();

  const [q, setQ] = useState('');
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [candidate, setCandidate] = useState<AccountClaimCandidate | null>(null);
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!loading && !person) {
      void navigate('/login?return=/account/claim-legacy', { replace: true });
    }
  }, [loading, person, navigate]);

  const onSearch = async (event: React.FormEvent) => {
    event.preventDefault();
    setSearching(true);
    setSearched(false);
    try {
      const res = await api.accountClaim.legacySearch(q.trim());
      setCandidate(res.data.candidates[0] ?? null);
      setSearched(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const onSubmitMerge = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!candidate) return;
    setSubmitting(true);
    try {
      await api.accountClaim.legacyRequest(candidate.slug, evidence.trim());
      setSubmitted(true);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !person) {
    return (
      <div className="container mx-auto px-4 py-12 text-muted-foreground">Loading…</div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Claim a legacy account</CardTitle>
          <CardDescription>
            Had a Code for Philly account from before the GitHub sign-in change
            that we didn't surface at sign-in? Search for it here. Merges go
            through staff review.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSearch} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="legacy-q">Old username or email</Label>
              <Input
                id="legacy-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="janedoe or jane@old-email.com"
                required
              />
            </div>
            <Button type="submit" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {searched && !candidate && (
        <Card>
          <CardHeader>
            <CardTitle>Nothing matched</CardTitle>
            <CardDescription>
              We couldn't find a legacy account from that. If you remember the
              old username, you can still file a staff-review request below.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmitMerge} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="manual-slug">Old username</Label>
                <Input
                  id="manual-slug"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-evidence">Evidence</Label>
                <Textarea
                  id="manual-evidence"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Tell us who you are in CFP — your Slack handle, projects you worked on, an email a staff member can reach you at."
                  rows={6}
                  maxLength={5000}
                  required
                />
              </div>
              <Button type="submit" disabled={submitting || !q.trim() || !evidence.trim()}>
                {submitting ? 'Submitting…' : 'Submit for staff review'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {candidate && !submitted && (
        <Card>
          <CardHeader>
            <CardTitle>{candidate.fullName}</CardTitle>
            <CardDescription>
              <span className="font-mono">{candidate.slug}</span>
              {candidate.memberOfCount > 0 && (
                <>
                  {' · '}
                  member of {candidate.memberOfCount} project
                  {candidate.memberOfCount === 1 ? '' : 's'}
                </>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              If this is you, submit a merge request. Staff will verify and
              re-point your contributions from your current Code for Philly
              profile onto this legacy one — your current GitHub identity will
              end up linked to the legacy account.
            </p>
            <Separator />
            <form onSubmit={onSubmitMerge} className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="merge-evidence">Evidence</Label>
                <Textarea
                  id="merge-evidence"
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                  placeholder="Confirm any details that prove this account is yours — projects you worked on, Slack handle, etc."
                  rows={6}
                  maxLength={5000}
                  required
                />
              </div>
              <Button type="submit" disabled={submitting || !evidence.trim()}>
                {submitting ? 'Submitting…' : 'Submit merge request'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {submitted && (
        <Card>
          <CardHeader>
            <CardTitle>Submitted</CardTitle>
            <CardDescription>
              A Code for Philly staff member will reach out via the contact you
              provided. Once approved, your current profile will be merged into
              the legacy account.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void navigate('/account')}>← Back to account</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
