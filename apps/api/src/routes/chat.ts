/**
 * Chat launch.
 *
 *   GET /chat                      → 302 to Slack SSO start, redir=/messages/general/
 *   GET /chat/<channel>            → 302 to Slack SSO start, redir=/messages/<channel>/
 *   GET /chat?channel=<name>       → same as the path form
 *   GET /chat?channel= or invalid  → fall back to general (+ warn log for invalid)
 *
 * The target is Slack's SP-initiated SSO start URL, not the workspace: Slack
 * sends an AuthnRequest to our IdP (/api/saml/slack/sso), the member signs in
 * here if needed, and Slack honours `redir` to open the channel. This mirrors
 * laddr's Emergence\Slack\Connector::handleLaunchRequest, which the
 * codeforphilly.org/chat/<channel> links in the wild were built for.
 *
 * 302 (temporary) so the destination can flip later without browser caches
 * sticking. Channel format matches Project.chatChannel
 * (`/^[a-z0-9][a-z0-9_-]{0,40}$/`) — same regex protects against
 * open-redirect via URL injection.
 *
 * Per specs/screens/chat.md.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';

const CHANNEL_REGEX = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const DEFAULT_CHANNEL = 'general';

export function slackSsoStartUrl(slackHost: string, channel: string): string {
  return `https://${slackHost}/sso/saml/start?redir=${encodeURIComponent(`/messages/${channel}/`)}`;
}

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  const launch = (reply: FastifyReply, requested: string | null | undefined): FastifyReply => {
    const slackHost = fastify.config.SLACK_TEAM_HOST;
    // Empty string is spec'd to behave like no channel — fall back to general.
    let channel = requested && requested.length > 0 ? requested : DEFAULT_CHANNEL;
    if (!CHANNEL_REGEX.test(channel)) {
      fastify.log.warn(
        // The encoded value keeps log-injection-style payloads benign.
        { channel: encodeURIComponent(channel) },
        'chat launch: invalid channel format; falling back to general',
      );
      channel = DEFAULT_CHANNEL;
    }
    return reply
      .code(302)
      .header('Location', slackSsoStartUrl(slackHost, channel))
      .header('Cache-Control', 'no-cache')
      .send();
  };

  const querySchema = {
    type: 'object',
    properties: { channel: { type: 'string' } },
    additionalProperties: false,
  };

  fastify.get(
    '/chat',
    {
      schema: {
        tags: ['chat'],
        summary: 'Sign into the Code for Philly Slack workspace via SSO',
        querystring: querySchema,
      },
    },
    async (request, reply) => launch(reply, (request.query as { channel?: string }).channel),
  );

  // The app does not ignore trailing slashes globally, and links in the wild
  // come in both shapes, so register both.
  for (const path of ['/chat/:channel', '/chat/:channel/']) {
    fastify.get(
      path,
      {
        schema: {
          tags: ['chat'],
          summary: 'Sign into the Code for Philly Slack workspace via SSO and open a channel',
          params: {
            type: 'object',
            properties: { channel: { type: 'string' } },
            required: ['channel'],
          },
          querystring: querySchema,
        },
      },
      async (request, reply) => launch(reply, (request.params as { channel: string }).channel),
    );
  }
}
