/**
 * Chat redirect.
 *
 *   GET /chat                      → 302 to https://<SLACK_TEAM_HOST>/
 *   GET /chat?channel=<name>       → 302 to https://<SLACK_TEAM_HOST>/channels/<name>
 *   GET /chat?channel=             → fall back to workspace root
 *   GET /chat?channel=<invalid>    → fall back to root + warn log
 *
 * 302 (temporary) so the destination can flip later without browser caches
 * sticking. Channel format matches Project.chatChannel
 * (`/^[a-z0-9][a-z0-9_-]{0,40}$/`) — same regex protects against
 * open-redirect via URL injection.
 *
 * Per specs/screens/chat.md.
 */
import type { FastifyInstance } from 'fastify';

const CHANNEL_REGEX = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/chat',
    {
      schema: {
        tags: ['chat'],
        summary: 'Redirect to the Code for Philly Slack workspace',
        querystring: {
          type: 'object',
          properties: { channel: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const slackHost = fastify.config.SLACK_TEAM_HOST;
      const root = `https://${slackHost}/`;

      const raw = (request.query as { channel?: string }).channel;
      // Empty string is spec'd to behave like no channel — fall back to root.
      const channel = raw && raw.length > 0 ? raw : null;

      if (channel === null) {
        return reply
          .code(302)
          .header('Location', root)
          .header('Cache-Control', 'no-cache')
          .send();
      }

      if (!CHANNEL_REGEX.test(channel)) {
        fastify.log.warn(
          // The encoded value keeps log-injection-style payloads benign.
          { channel: encodeURIComponent(channel) },
          'chat redirect: invalid channel format; falling back to root',
        );
        return reply
          .code(302)
          .header('Location', root)
          .header('Cache-Control', 'no-cache')
          .send();
      }

      return reply
        .code(302)
        .header('Location', `https://${slackHost}/channels/${channel}`)
        .header('Cache-Control', 'no-cache')
        .send();
    },
  );
}
