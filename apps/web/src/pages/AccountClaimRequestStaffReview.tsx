import { useState } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

function safeReturn(input: string | null): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

export function AccountClaimRequestStaffReview() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const returnPath = safeReturn(searchParams.get('return'));

  const [claimedSlug, setClaimedSlug] = useState(searchParams.get('slug') ?? '');
  const [evidence, setEvidence] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [continuing, setContinuing] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await api.accountClaim.requestStaffReview(claimedSlug.trim(), evidence.trim());
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401 && err.code === 'claim_token_invalid') {
        void navigate(`/login?return=${encodeURIComponent(returnPath)}`, { replace: true });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  const onContinue = async () => {
    setContinuing(true);
    try {
      await api.accountClaim.decline();
      await reload();
      void navigate(returnPath, { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to continue');
      setContinuing(false);
    }
  };

  if (submitted) {
    return (
      <div className="flex justify-center py-12 px-4">
        <Card className="w-full max-w-[480px]">
          <CardHeader>
            <CardTitle>Submitted</CardTitle>
            <CardDescription>
              A Code for Philly staff member will reach out via the contact you
              provided. In the meantime you can start fresh — once staff
              verify your claim, we'll merge your accounts.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={onContinue} disabled={continuing} className="w-full">
              {continuing ? 'Setting up…' : 'Continue as a new member →'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex justify-center py-12 px-4">
      <Card className="w-full max-w-[560px]">
        <CardHeader>
          <CardTitle>Request staff review</CardTitle>
          <CardDescription>
            If your pre-cutover email is no longer reachable and you don't
            remember your old password, send us a note. We'll verify your
            identity through Slack or email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="claim-slug">Old username</Label>
              <Input
                id="claim-slug"
                value={claimedSlug}
                onChange={(e) => setClaimedSlug(e.target.value)}
                required
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-evidence">Evidence</Label>
              <Textarea
                id="claim-evidence"
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                placeholder="Tell us who you are in CFP — your Slack handle, projects you worked on, an email a staff member can reach you at. We'll follow up within a few days."
                rows={8}
                maxLength={5000}
                required
              />
            </div>
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Sending…' : 'Send to staff'}
            </Button>
            <Link
              to={`/account-claim?return=${encodeURIComponent(returnPath)}`}
              className="block text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline text-center"
            >
              ← Back
            </Link>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
