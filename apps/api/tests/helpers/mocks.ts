import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

/**
 * Minimal shape of a GitHub user object — only fields the API routes consume.
 * Extend as needed when auth routes are implemented.
 */
export interface GitHubUser {
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatar_url: string;
}

export interface GitHubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
  readonly visibility: string | null;
}

/**
 * A captured outbound email send — inspectable in tests.
 */
/** Postmark `POST /email` body — PascalCase fields as the API wants them. */
export interface CapturedEmail {
  readonly To: string;
  readonly From: string;
  readonly Subject: string;
  readonly HtmlBody?: string;
  readonly TextBody?: string;
  readonly MessageStream?: string;
}

/**
 * Build an MSW server that intercepts outbound HTTP to api.github.com and the
 * GitHub OAuth token endpoint.
 *
 * Usage:
 *   const { server, setGitHubUser } = createGitHubMock();
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => server.resetHandlers());
 *   afterAll(() => server.close());
 */
export function createGitHubMock(defaults?: {
  user?: GitHubUser;
  emails?: GitHubEmail[];
  tokenResponse?: Record<string, unknown>;
  capturedTokenRequests?: Array<Record<string, unknown>>;
}) {
  let currentUser: GitHubUser = defaults?.user ?? {
    id: 1,
    login: 'testuser',
    name: 'Test User',
    avatar_url: 'https://avatars.githubusercontent.com/u/1',
  };

  let currentEmails: GitHubEmail[] = defaults?.emails ?? [
    { email: 'testuser@example.com', primary: true, verified: true, visibility: 'public' },
  ];

  let tokenResponse: Record<string, unknown> =
    defaults?.tokenResponse ?? { access_token: 'gho_test_access_token', token_type: 'bearer', scope: 'read:user,user:email' };

  const capturedTokenRequests = defaults?.capturedTokenRequests ?? [];

  const server = setupServer(
    http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      capturedTokenRequests.push(body);
      return HttpResponse.json(tokenResponse);
    }),
    http.get('https://api.github.com/user', () =>
      HttpResponse.json(currentUser),
    ),
    http.get('https://api.github.com/user/emails', () =>
      HttpResponse.json(currentEmails),
    ),
  );

  return {
    server,
    capturedTokenRequests,
    setGitHubUser(user: GitHubUser) {
      currentUser = user;
    },
    setGitHubEmails(emails: GitHubEmail[]) {
      currentEmails = emails;
    },
    setTokenResponse(resp: Record<string, unknown>) {
      tokenResponse = resp;
    },
  };
}

/**
 * No-op Postmark mock. Intercepts POST /email via MSW and collects sends
 * into an in-memory array for inspection. Does not call the real Postmark API.
 *
 * Usage:
 *   const { server, sentEmails } = createPostmarkMock();
 *   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
 *   afterEach(() => { server.resetHandlers(); sentEmails.length = 0; });
 *   afterAll(() => server.close());
 */
export function createPostmarkMock() {
  const sentEmails: CapturedEmail[] = [];

  const server = setupServer(
    http.post('https://api.postmarkapp.com/email', async ({ request }) => {
      const body = (await request.json()) as CapturedEmail;
      sentEmails.push(body);
      return HttpResponse.json(
        {
          To: body.To,
          SubmittedAt: new Date().toISOString(),
          MessageID: `mock-${Date.now()}`,
          ErrorCode: 0,
          Message: 'OK',
        },
        { status: 200 },
      );
    }),
  );

  return { server, sentEmails };
}
