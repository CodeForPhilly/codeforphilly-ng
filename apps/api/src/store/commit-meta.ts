/**
 * Helpers for assembling the public gitsheets commit metadata
 * (author + message + trailers) per specs/behaviors/storage.md#commit-message-shape.
 *
 * Author identity is always pseudonymous: `<fullName> <<slug>@users.noreply.codeforphilly.org>`.
 * Anonymous requests use `Anonymous <anon@users.noreply.codeforphilly.org>`.
 *
 * The User-Ip / User-Agent / Authorization / Cookie headers are deliberately
 * NOT included — the public commit log is forever-public.
 */
import type { Author, TransactionOptions } from 'gitsheets';
import type { FastifyRequest } from 'fastify';
import type { SessionContext } from '../auth/middleware.js';

const PSEUDONYMOUS_EMAIL_HOST = 'users.noreply.codeforphilly.org';

export function pseudonymousAuthor(session: SessionContext): Author {
  const person = session.person;
  if (!person) {
    return { name: 'Anonymous', email: `anon@${PSEUDONYMOUS_EMAIL_HOST}` };
  }
  return {
    name: person.fullName,
    email: `${person.slug}@${PSEUDONYMOUS_EMAIL_HOST}`,
  };
}

export interface CommitContext {
  readonly request: FastifyRequest;
  readonly action: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly subjectSlug?: string;
  readonly responseCode: number;
  /** Extra semantic trailers to merge in. */
  readonly extraTrailers?: Readonly<Record<string, string>>;
  /** Optional override for the human summary in the commit body. */
  readonly summary?: string;
}

/**
 * Build the `TransactionOptions` (author, committer, message, trailers)
 * for a public gitsheets commit triggered by a request.
 */
export function buildTransactionOptions(ctx: CommitContext): TransactionOptions {
  const { request, action, subjectType, subjectId, subjectSlug, responseCode, summary } = ctx;
  const session = request.session;
  const author = pseudonymousAuthor(session);
  const actorSlug = session.person?.slug ?? 'anon';

  const method = request.method.toUpperCase();
  const path = request.url.split('?')[0] ?? request.url;
  const subject = `${actorSlug}: ${method} ${path}`;
  const body = summary ? `\n${summary}\n` : '';
  const message = body ? `${subject}\n${body}` : subject;

  const trailers: Record<string, string> = {
    Action: action,
    'Actor-Slug': actorSlug,
    'Actor-Account-Level': session.accountLevel,
    Host: request.hostname || 'unknown',
    'Content-Type': String(request.headers['content-type'] ?? 'unknown'),
    'Response-Code': String(responseCode),
  };

  if (subjectType) trailers['Subject-Type'] = subjectType;
  if (subjectId) trailers['Subject-Id'] = subjectId;
  if (subjectSlug) trailers['Subject-Slug'] = subjectSlug;

  if (ctx.extraTrailers) {
    for (const [k, v] of Object.entries(ctx.extraTrailers)) {
      trailers[k] = v;
    }
  }

  return { author, committer: author, message, trailers };
}
