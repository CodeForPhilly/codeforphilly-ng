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
import { STATUS_CODES } from 'node:http';
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
  /**
   * The session the write is made as, when it is not `request.session` — an
   * agent's writes are made as `agentSessionContext(request.agent)`, since
   * `request.session` is anonymous for a grant.
   */
  readonly session?: SessionContext;
}

/**
 * Build the `TransactionOptions` (author, committer, message, trailers)
 * for a public gitsheets commit triggered by a request.
 */
export function buildTransactionOptions(ctx: CommitContext): TransactionOptions {
  const { request, action, subjectType, subjectId, subjectSlug, responseCode, summary } = ctx;
  const session = ctx.session ?? request.session;
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
    // HTTP reason phrase for the response code, per
    // specs/behaviors/storage.md#commit-message-shape.
    'Response-Message': STATUS_CODES[responseCode] ?? 'Unknown',
  };

  // An agent grant's writes say so, and which grant (never the token):
  // specs/behaviors/storage.md → Commit message shape.
  if (session.agent) {
    trailers['Actor-Kind'] = 'agent';
    trailers['Grant-Id'] = session.agent.grantId;
  }

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

/**
 * Move every trailer into the message itself, with `repeated` trailers (one
 * key, several values — e.g. one `Evidence:` per cited record) after them.
 * gitsheets takes trailers as a map, one value per key, and appends them as
 * their own paragraph; a commit that needs a repeated key carries the whole
 * trailer block in the message and passes no map, so `git interpret-trailers`
 * still parses one block.
 */
export function withInlineTrailers(
  opts: TransactionOptions,
  repeated: ReadonlyArray<readonly [string, string]>,
): TransactionOptions {
  const lines = [...Object.entries(opts.trailers ?? {}), ...repeated].map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`trailer ${k} has a newline`);
    return `${k}: ${v}`;
  });
  return { ...opts, message: `${opts.message.replace(/\s+$/, '')}\n\n${lines.join('\n')}\n`, trailers: {} };
}
