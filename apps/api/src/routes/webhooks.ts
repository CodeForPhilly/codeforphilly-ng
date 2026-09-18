/**
 * Inbound webhooks — specs/api/webhooks.md.
 *
 *   POST /api/_webhooks/postmark/bounce
 *     Postmark's bounce webhook. Authenticated with POSTMARK_WEBHOOK_SECRET as
 *     either the basic-auth password or a bearer token. Records terminal
 *     bounce types on the member's private profile so the roster can show
 *     "mailbox dead" without any SMTP probing of our own.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PrivateProfileSchema } from '@cfp/shared/schemas';
import { ok, errorResponse } from '../lib/response.js';
import { UnauthenticatedError } from '../lib/errors.js';

/** Bounce types that mean the mailbox is not going to work. */
const TERMINAL_BOUNCE_TYPES = new Set([
  'HardBounce',
  'SpamComplaint',
  'SpamNotification',
  'Blocked',
  'DnsError',
  'BadEmailAddress',
  'ManuallyDeactivated',
  'Unsubscribe',
]);

function secretMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedSecret(request: FastifyRequest): string | undefined {
  const header = request.headers['authorization'];
  if (typeof header !== 'string') return undefined;
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length).trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon === -1 ? decoded : decoded.slice(colon + 1);
  }
  return undefined;
}

interface PostmarkBouncePayload {
  RecordType?: string;
  Type?: string;
  Email?: string;
  BouncedAt?: string;
  Description?: string;
  Inactive?: boolean;
}

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/api/_webhooks/postmark/bounce',
    {
      schema: {
        tags: ['webhooks'],
        summary: 'Postmark bounce webhook',
        body: { type: 'object', additionalProperties: true },
      },
    },
    async (request, reply) => {
      const expected = fastify.config.POSTMARK_WEBHOOK_SECRET;
      if (!expected) {
        return reply.code(503).send(
          errorResponse(
            'not_configured',
            'POSTMARK_WEBHOOK_SECRET is not set',
            (request as FastifyRequest & { traceId?: string }).traceId,
          ),
        );
      }
      if (!secretMatches(presentedSecret(request), expected)) {
        throw new UnauthenticatedError('Invalid webhook credentials');
      }

      const body = request.body as PostmarkBouncePayload;
      if (body.RecordType !== 'Bounce' && body.RecordType !== 'SpamComplaint') {
        return ok({ ignored: true });
      }
      const type = typeof body.Type === 'string' ? body.Type : body.RecordType;
      if (!TERMINAL_BOUNCE_TYPES.has(type)) {
        return ok({ ignored: true, type });
      }
      const email = typeof body.Email === 'string' ? body.Email.trim().toLowerCase() : '';
      if (!email) return ok({ ignored: true, reason: 'no email' });

      const personId = await fastify.store.private.findPersonIdByEmail(email);
      if (!personId) return ok({ matched: false });
      const profile = await fastify.store.private.getProfile(personId);
      if (!profile) return ok({ matched: false });

      const bouncedAt =
        typeof body.BouncedAt === 'string' && !Number.isNaN(Date.parse(body.BouncedAt))
          ? new Date(body.BouncedAt).toISOString()
          : new Date().toISOString();
      const updated = PrivateProfileSchema.parse({
        ...profile,
        emailBounce: {
          type,
          bouncedAt,
          description: typeof body.Description === 'string' ? body.Description.slice(0, 500) : null,
          ...(typeof body.Inactive === 'boolean' ? { inactive: body.Inactive } : {}),
        },
        updatedAt: new Date().toISOString(),
      });
      await fastify.store.private.putProfile(updated);
      request.log.info({ personId, type }, 'postmark bounce recorded');
      return ok({ matched: true, recorded: true });
    },
  );
}
