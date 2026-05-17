/**
 * GitHub OAuth flow orchestration.
 *
 * The route handlers in routes/auth.ts call into these two functions:
 *
 *   - buildAuthorizeUrl: assemble the GitHub /login/oauth/authorize URL
 *   - completeCallback:  full callback pipeline — verify state, exchange code,
 *                        fetch identity, resolve to a Person, mint session or
 *                        claim-pending JWT, and return a "next step" descriptor
 *                        for the route to act on (set cookies + redirect).
 *
 * The route shouldn't know about PKCE, GitHub clients, or matching internals —
 * it just translates the descriptor into HTTP-level effects.
 */
import type { FastifyInstance } from 'fastify';
import { issueClaimPending } from './jwt.js';
import { mintSessionFor } from './issue.js';
import {
  exchangeCodeForToken,
  fetchGitHubEmails,
  fetchGitHubUser,
  resolveIdentitySnapshot,
  GitHubApiError,
  type ResolvedGitHubIdentity,
} from './github-client.js';
import { resolveIdentity } from '../services/account-matching.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import type { FastifyRequest } from 'fastify';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_SCOPES = 'read:user user:email';

export interface AuthorizeUrlParams {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPES);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export type CallbackOutcome =
  | { kind: 'session'; personId: string; accessToken: string; refreshToken: string; refreshJti: string }
  | { kind: 'claim-pending'; token: string; identity: ResolvedGitHubIdentity; candidates: string[] }
  | { kind: 'error'; code: CallbackErrorCode };

export type CallbackErrorCode =
  | 'github_unreachable'
  | 'email_unverified';

export interface CompleteCallbackParams {
  readonly fastify: FastifyInstance;
  readonly request: FastifyRequest;
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

/**
 * Run the full OAuth callback pipeline:
 *   1. Exchange code → GitHub access token (PKCE)
 *   2. Fetch /user + /user/emails
 *   3. Filter to verified emails; if none → email_unverified
 *   4. Resolve identity against state + private store
 *   5. Route to existing-refresh, fresh-create, or claim-pending outcome
 */
export async function completeCallback(
  params: CompleteCallbackParams,
): Promise<CallbackOutcome> {
  const { fastify, request, code, codeVerifier, redirectUri } = params;
  const cfg = fastify.config;

  if (!cfg.GITHUB_OAUTH_CLIENT_ID || !cfg.GITHUB_OAUTH_CLIENT_SECRET) {
    return { kind: 'error', code: 'github_unreachable' };
  }

  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken({
      clientId: cfg.GITHUB_OAUTH_CLIENT_ID,
      clientSecret: cfg.GITHUB_OAUTH_CLIENT_SECRET,
      code,
      codeVerifier,
      redirectUri,
    });
  } catch (err) {
    fastify.log.warn({ err }, 'github token exchange failed');
    return { kind: 'error', code: 'github_unreachable' };
  }

  let identity: ResolvedGitHubIdentity;
  try {
    const [ghUser, rawEmails] = await Promise.all([
      fetchGitHubUser(accessToken),
      fetchGitHubEmails(accessToken),
    ]);
    identity = resolveIdentitySnapshot(ghUser, rawEmails);
  } catch (err) {
    fastify.log.warn({ err }, 'github user/emails fetch failed');
    if (err instanceof GitHubApiError) {
      return { kind: 'error', code: 'github_unreachable' };
    }
    return { kind: 'error', code: 'github_unreachable' };
  }

  if (!identity.primaryEmail) {
    return { kind: 'error', code: 'email_unverified' };
  }
  const primaryEmail: string = identity.primaryEmail;

  const match = await resolveIdentity(identity, fastify.inMemoryState, fastify.store.private);

  if (match.kind === 'existing') {
    const profile = await fastify.store.private.getProfile(match.personId);
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.github-refresh',
        subjectType: 'person',
        subjectId: match.personId,
        subjectSlug: match.person.slug,
        responseCode: 302,
      }),
      async (tx) => fastify.services.githubAccount.refreshLinked(
        tx,
        match.person,
        identity,
        primaryEmail,
        profile,
      ),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

    const minted = await mintSessionFor(
      match.personId,
      result.value.person.accountLevel,
      cfg.CFP_JWT_SIGNING_KEY,
    );
    return {
      kind: 'session',
      personId: match.personId,
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      refreshJti: minted.refreshJti,
    };
  }

  if (match.kind === 'create-fresh') {
    const result = await fastify.store.transact(
      {
        ...buildTransactionOptions({
          request,
          action: 'person.create',
          subjectType: 'person',
          responseCode: 302,
        }),
        writeOrder: 'private-first',
      },
      async (tx) => fastify.services.githubAccount.createFresh(tx, identity, primaryEmail),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

    const minted = await mintSessionFor(
      result.value.person.id,
      result.value.person.accountLevel,
      cfg.CFP_JWT_SIGNING_KEY,
    );
    return {
      kind: 'session',
      personId: result.value.person.id,
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      refreshJti: minted.refreshJti,
    };
  }

  // candidates
  const claimToken = await issueClaimPending(
    {
      ghId: String(identity.id),
      ghLogin: identity.login,
      ghName: identity.name,
      ghEmails: identity.emails.map((e) => e.email),
    },
    match.candidates,
    cfg.CFP_JWT_SIGNING_KEY,
  );
  return { kind: 'claim-pending', token: claimToken, identity, candidates: match.candidates };
}
