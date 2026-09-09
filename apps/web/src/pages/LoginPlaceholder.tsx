import { useEffect, useId, useState, type FormEvent } from 'react';
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
import { GitHubIcon } from '@/components/icons/GitHubIcon';
import { useAuth } from '@/hooks/useAuth';
import { api, ApiError } from '@/lib/api';

type ErrorCode =
  | 'access_denied'
  | 'oauth_state_mismatch'
  | 'oauth_session_invalid'
  | 'github_unreachable'
  | 'email_unverified';

const ERROR_MESSAGES: Record<ErrorCode, React.ReactNode> = {
  access_denied:
    'You declined to authorize Code for Philly on GitHub. To sign in, you will need to authorize the app.',
  oauth_state_mismatch:
    'Something went wrong with the sign-in flow. Please try again.',
  oauth_session_invalid:
    'Something went wrong with the sign-in flow. Please try again.',
  github_unreachable:
    'We could not reach GitHub. Please try again in a moment.',
  email_unverified: (
    <>
      Your GitHub account does not have a verified email address visible to us.
      To sign in here, please{' '}
      <a
        href="https://github.com/settings/emails"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:no-underline"
      >
        verify a primary email on GitHub
        <span className="sr-only"> (opens in new tab)</span>
      </a>{' '}
      and ensure email visibility is enabled for our app.
    </>
  ),
};

function WhyGitHub() {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
      >
        Why GitHub?
      </button>
      {open && (
        <div
          id={panelId}
          className="mt-2 text-sm text-muted-foreground bg-muted rounded-md p-3"
        >
          We chose GitHub as the sole identity provider for three reasons: (1)
          the civic-tech community already lives there, (2) it filters spam and
          scam accounts more effectively than email-only sign-ups, and (3) most
          of our project work coordinates on GitHub anyway. Anyone can{' '}
          <a
            href="https://github.com/signup"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            create a GitHub account
            <span className="sr-only"> (opens in new tab)</span>
          </a>{' '}
          in under a minute.
        </div>
      )}
    </div>
  );
}

export function LoginPlaceholder() {
  const { person, loading, reload } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const returnPath = searchParams.get('return');
  const errorCode = searchParams.get('error') as ErrorCode | null;

  // Redirect already-authenticated users
  useEffect(() => {
    if (!loading && person) {
      const target =
        returnPath && returnPath.startsWith('/') ? returnPath : '/';
      void navigate(target, { replace: true });
    }
  }, [loading, person, navigate, returnPath]);

  if (loading) {
    return (
      <div role="status" className="flex justify-center py-20">
        <div
          className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin"
          aria-hidden="true"
        />
        <span className="sr-only">Checking sign-in status…</span>
      </div>
    );
  }

  const startUrl = returnPath
    ? `/api/auth/github/start?return=${encodeURIComponent(returnPath)}`
    : '/api/auth/github/start';

  const handleLegacySuccess = async () => {
    // Refresh /api/auth/me so the navbar + every consumer of useAuth()
    // picks up the new session before we navigate. Without this, the
    // navbar stays in its anonymous state until the next hard refresh.
    await reload();
    const target =
      returnPath && returnPath.startsWith('/') ? returnPath : '/';
    void navigate(target, { replace: true });
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-5xl">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold">Sign in to Code for Philly</h1>
        <p className="text-sm text-muted-foreground mt-2">
          Returning member? Use the password you had before our 2026 switch to
          GitHub. New here? Sign in with GitHub.
        </p>
      </div>

      {errorCode && ERROR_MESSAGES[errorCode] && (
        <div
          role="alert"
          className="text-sm text-destructive bg-destructive/10 rounded-md px-4 py-3 mb-6 max-w-2xl mx-auto"
        >
          {ERROR_MESSAGES[errorCode]}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Returning member</CardTitle>
            <CardDescription>
              Sign in with the username (or email) and password you used at
              codeforphilly.org before our switch to GitHub sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LegacyPasswordLogin onSuccess={handleLegacySuccess} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New here?</CardTitle>
            <CardDescription>
              We use GitHub for all new sign-ups. It is free and takes about a
              minute if you do not have an account yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Button asChild size="lg" className="w-full gap-2">
              <a href={startUrl}>
                <GitHubIcon />
                Sign in with GitHub
              </a>
            </Button>
            <WhyGitHub />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface LegacyPasswordLoginProps {
  onSuccess: () => Promise<void> | void;
}

function LegacyPasswordLogin({ onSuccess }: LegacyPasswordLoginProps) {
  const [usernameOrEmail, setUsernameOrEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await api.auth.login(usernameOrEmail.trim(), password);
      await onSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 429) {
          setErrorMessage(
            'Too many sign-in attempts. Please wait a minute and try again.',
          );
        } else {
          // Uniform 401 for any failure — don't reveal whether
          // username or password was wrong.
          setErrorMessage('The username or password you entered is incorrect.');
        }
      } else {
        setErrorMessage('Sign-in failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="space-y-1.5">
        <Label htmlFor="legacy-username">Username or email</Label>
        <Input
          id="legacy-username"
          value={usernameOrEmail}
          onChange={(e) => setUsernameOrEmail(e.target.value)}
          required
          autoComplete="username"
          aria-invalid={errorMessage ? 'true' : 'false'}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="legacy-password">Password</Label>
        <Input
          id="legacy-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          aria-invalid={errorMessage ? 'true' : 'false'}
        />
      </div>

      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}

      <Button
        type="submit"
        disabled={submitting || !usernameOrEmail.trim() || !password}
        className="w-full"
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>

      <Link
        to="/login/forgot"
        className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline self-center"
      >
        Forgot your password?
      </Link>
    </form>
  );
}
