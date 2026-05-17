/**
 * Thin client wrapper for the GitHub OAuth flow.
 *
 * Exposes three functions matching specs/api/auth.md:
 *   - exchangeCodeForToken: POST /login/oauth/access_token with PKCE verifier
 *   - fetchGitHubUser:      GET /user
 *   - fetchGitHubEmails:    GET /user/emails
 *
 * Each function throws `GitHubApiError` on transport failure or non-2xx.
 * The route handler catches that and surfaces `github_unreachable` to the SPA.
 *
 * The token-exchange endpoint is on github.com, while the user/emails endpoints
 * are on api.github.com — that's GitHub's split, not ours.
 */

const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const EMAILS_URL = 'https://api.github.com/user/emails';

const USER_AGENT = 'codeforphilly-ng';

export interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatar_url?: string;
}

export interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
  readonly visibility?: string | null;
}

export class GitHubApiError extends Error {
  readonly code: string;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(message: string, code: string, opts?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

export interface GitHubTokenExchange {
  /** OAuth client id of the registered GitHub OAuth App. */
  readonly clientId: string;
  /** OAuth client secret. */
  readonly clientSecret: string;
  /** Authorization code returned to /github/callback. */
  readonly code: string;
  /** PKCE verifier matching the challenge sent at /start. */
  readonly codeVerifier: string;
  /** Same redirect_uri sent at /start (some IdPs require it on exchange). */
  readonly redirectUri: string;
}

/**
 * Exchange the authorization code for a GitHub access token.
 *
 * GitHub returns JSON when `Accept: application/json` is set (default form
 * is x-www-form-urlencoded). We use JSON so we don't have to parse it.
 */
export async function exchangeCodeForToken(
  params: GitHubTokenExchange,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
      }),
    });
  } catch (err) {
    throw new GitHubApiError('GitHub token exchange transport error', 'github_unreachable', { cause: err });
  }

  if (!res.ok) {
    throw new GitHubApiError(
      `GitHub token exchange returned ${res.status}`,
      'github_unreachable',
      { status: res.status },
    );
  }

  const body = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: string; error_description?: string }
    | null;

  if (!body || typeof body !== 'object') {
    throw new GitHubApiError('GitHub token exchange returned invalid JSON', 'github_unreachable');
  }

  if (body.error) {
    // GitHub returned 200 with an error payload — surface as github_unreachable
    // (the user-facing error message is the same; we log details server-side).
    throw new GitHubApiError(
      `GitHub token exchange error: ${body.error}`,
      'github_unreachable',
    );
  }

  if (!body.access_token || typeof body.access_token !== 'string') {
    throw new GitHubApiError('GitHub token exchange missing access_token', 'github_unreachable');
  }

  return body.access_token;
}

async function ghGet(url: string, accessToken: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
    });
  } catch (err) {
    throw new GitHubApiError(`GitHub API transport error: ${url}`, 'github_unreachable', { cause: err });
  }

  if (!res.ok) {
    throw new GitHubApiError(
      `GitHub API ${url} returned ${res.status}`,
      'github_unreachable',
      { status: res.status },
    );
  }

  return res.json();
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const body = (await ghGet(USER_URL, accessToken)) as Partial<GitHubUser> | null;
  if (!body || typeof body.id !== 'number' || typeof body.login !== 'string') {
    throw new GitHubApiError('GitHub /user returned unexpected shape', 'github_unreachable');
  }
  return {
    id: body.id,
    login: body.login,
    name: typeof body.name === 'string' ? body.name : null,
    ...(typeof body.avatar_url === 'string' ? { avatar_url: body.avatar_url } : {}),
  };
}

export async function fetchGitHubEmails(accessToken: string): Promise<GitHubEmail[]> {
  const body = await ghGet(EMAILS_URL, accessToken);
  if (!Array.isArray(body)) {
    throw new GitHubApiError('GitHub /user/emails returned non-array', 'github_unreachable');
  }
  const emails: GitHubEmail[] = [];
  for (const entry of body) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as GitHubEmail).email === 'string' &&
      typeof (entry as GitHubEmail).primary === 'boolean' &&
      typeof (entry as GitHubEmail).verified === 'boolean'
    ) {
      emails.push({
        email: (entry as GitHubEmail).email,
        primary: (entry as GitHubEmail).primary,
        verified: (entry as GitHubEmail).verified,
      });
    }
  }
  return emails;
}

/**
 * Resolved GitHub identity passed downstream to the matching algorithm.
 *
 * `emails` is filtered to verified-only; `primaryEmail` is the verified primary
 * if there is one, else the first verified email, else null.
 */
export interface ResolvedGitHubIdentity {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly emails: readonly GitHubEmail[];
  readonly primaryEmail: string | null;
}

export function resolveIdentitySnapshot(
  user: GitHubUser,
  rawEmails: readonly GitHubEmail[],
): ResolvedGitHubIdentity {
  const verified = rawEmails.filter((e) => e.verified);
  const primary = verified.find((e) => e.primary) ?? verified[0] ?? null;
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    emails: verified,
    primaryEmail: primary?.email.toLowerCase() ?? null,
  };
}
