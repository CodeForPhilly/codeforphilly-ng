import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';

export function PasswordResetConfirm() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { reload } = useAuth();
  const token = searchParams.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    token
      ? null
      : 'This reset link is missing its token. Request a new link to continue.',
  );

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    if (password !== confirm) {
      setErrorMessage('The two passwords don’t match.');
      return;
    }
    if (password.length < 8) {
      setErrorMessage('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await api.auth.passwordResetConfirm(token, password);
      await reload();
      void navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setErrorMessage(
            'This reset link is invalid or has expired. Request a new link to continue.',
          );
        } else if (err.status === 429) {
          setErrorMessage(
            'Too many attempts. Please wait a minute and try again.',
          );
        } else if (err.status === 422) {
          setErrorMessage(
            err.message || 'That password doesn’t meet the minimum requirements.',
          );
        } else {
          setErrorMessage('Something went wrong. Please try again.');
        }
      } else {
        setErrorMessage('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex justify-center py-16 px-4">
      <Card className="w-full max-w-[480px]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Set a new password</CardTitle>
          <CardDescription className="mt-2 text-sm">
            Pick a new password for your Code for Philly account. You&rsquo;ll
            be signed in automatically.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errorMessage ? 'true' : 'false'}
                disabled={!token}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                aria-invalid={errorMessage ? 'true' : 'false'}
                disabled={!token}
              />
            </div>

            {errorMessage && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            )}

            <Button
              type="submit"
              disabled={submitting || !token || !password || !confirm}
              className="w-full"
            >
              {submitting ? 'Setting password…' : 'Set password and sign in'}
            </Button>

            <Link
              to="/login/forgot"
              className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline self-center"
            >
              Request a new reset link
            </Link>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
