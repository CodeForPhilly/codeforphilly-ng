import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
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
import { api } from '@/lib/api';

export function PasswordResetRequest() {
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.auth.passwordResetRequest(usernameOrEmail.trim());
    } catch {
      // The endpoint is always 202; failure here is a network problem.
      // We still flip to the confirmation state to avoid leaking signal.
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <div className="flex justify-center py-16 px-4">
      <Card className="w-full max-w-[480px]">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Reset your password</CardTitle>
          <CardDescription className="mt-2 text-sm">
            Enter the username or email you used at Code for Philly. If we find
            an account with a password on file, we&rsquo;ll email a reset link.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {submitted ? (
            <div
              role="status"
              className="text-sm rounded-md bg-muted p-4 text-center"
            >
              <p>
                If we have an account on file matching{' '}
                <strong>{usernameOrEmail.trim()}</strong>, we just sent a
                password-reset link to the email address on the account.
              </p>
              <p className="mt-2 text-muted-foreground">
                The link is good for one hour. Check your spam folder if it
                doesn&rsquo;t arrive in a few minutes.
              </p>
              <p className="mt-4">
                <Link to="/login" className="underline hover:no-underline">
                  Back to sign in
                </Link>
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="reset-username">Username or email</Label>
                <Input
                  id="reset-username"
                  value={usernameOrEmail}
                  onChange={(e) => setUsernameOrEmail(e.target.value)}
                  required
                  autoComplete="username"
                  autoFocus
                />
              </div>

              <Button
                type="submit"
                disabled={submitting || !usernameOrEmail.trim()}
                className="w-full"
              >
                {submitting ? 'Sending…' : 'Send reset link'}
              </Button>

              <Link
                to="/login"
                className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline self-center"
              >
                Back to sign in
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
