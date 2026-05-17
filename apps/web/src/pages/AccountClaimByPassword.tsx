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
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/hooks/useAuth';

function safeReturn(input: string | null): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

export function AccountClaimByPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const returnPath = safeReturn(searchParams.get('return'));

  const [slug, setSlug] = useState(searchParams.get('slug') ?? '');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.accountClaim.byPassword(slug.trim(), password);
      toast.success('Welcome back');
      await reload();
      void navigate(returnPath, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401 && err.code === 'claim_token_invalid') {
          // Claim cookie expired — restart the flow
          void navigate(`/login?return=${encodeURIComponent(returnPath)}`, { replace: true });
          return;
        }
        if (err.status === 401) {
          setError("Username or password didn't match");
        } else {
          setError(err.message);
        }
      } else {
        setError('Something went wrong');
      }
      setSubmitting(false);
    }
  };

  return (
    <div className="flex justify-center py-12 px-4">
      <Card className="w-full max-w-[480px]">
        <CardHeader>
          <CardTitle>Verify with old password</CardTitle>
          <CardDescription>
            Enter your pre-cutover Code for Philly username and password. We'll
            connect your new GitHub identity to that legacy account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="claim-slug">Old username</Label>
              <Input
                id="claim-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                autoComplete="username"
                autoFocus={!slug}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="claim-password">Old password</Label>
              <Input
                id="claim-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                autoFocus={!!slug}
                required
              />
            </div>
            {error && (
              <div
                role="alert"
                className="text-sm text-destructive bg-destructive/10 rounded-md px-3 py-2"
              >
                {error}
              </div>
            )}
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Verifying…' : 'Verify'}
            </Button>
            <div className="flex flex-col gap-2 pt-2 text-sm text-muted-foreground">
              <Link
                to={`/account-claim/request-staff-review?return=${encodeURIComponent(returnPath)}`}
                className="hover:text-foreground underline-offset-2 hover:underline text-center"
              >
                I don't remember my password — request staff review →
              </Link>
              <Link
                to={`/account-claim?return=${encodeURIComponent(returnPath)}`}
                className="hover:text-foreground underline-offset-2 hover:underline text-center"
              >
                ← Back to suggestions
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
