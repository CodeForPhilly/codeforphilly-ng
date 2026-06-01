import { useEffect, useState, type FormEvent } from 'react';
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
      </a>{' '}
      and ensure email visibility is enabled for our app.
    </>
  ),
};

function GitHubIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function WhyGitHub() {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-sm text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        aria-expanded={open}
      >
        Why GitHub?
      </button>
      {open && (
        <div className="mt-2 text-sm text-muted-foreground bg-muted rounded-md p-3">
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
          </a>{' '}
          in under a minute.
        </div>
      )}
    </div>
  );
}

export function LoginPlaceholder() {
  const { person, loading } = useAuth();
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
      <div className="flex justify-center py-20" aria-live="polite" aria-label="Checking sign-in status">
        <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const startUrl = returnPath
    ? `/api/auth/github/start?return=${encodeURIComponent(returnPath)}`
    : '/api/auth/github/start';

  const handleLegacySuccess = () => {
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
  onSuccess: () => void;
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
      onSuccess();
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
