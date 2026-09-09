/**
 * Environment schema and config type.
 *
 * This is the ONLY place that reads process.env. All other modules read
 * fastify.config.<FIELD> after @fastify/env has validated and populated it.
 */
import { z } from 'zod';

/**
 * Default SAML IdP entity ID. Stable across hosts — see the SAML_ENTITY_ID
 * field below and specs/api/saml.md#idp-identity-and-hosts.
 */
export const SAML_ENTITY_ID_DEFAULT = 'https://codeforphilly.org/api/saml/slack/metadata';

export const EnvSchema = z.object({
  /** TCP port the Fastify server listens on. */
  PORT: z.coerce.number().default(3001),
  /** Runtime mode — controls logger format, cookie Secure flag, etc. */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Absolute path to the gitsheets public data repo working tree. */
  CFP_DATA_REPO_PATH: z.string(),
  /** Git remote URL to push public data commits to (optional in dev). */
  CFP_DATA_REMOTE: z.string().optional(),
  /** Branch the push daemon pushes to. Defaults to the repo's current HEAD. */
  CFP_DATA_BRANCH: z.string().optional(),
  /**
   * Shared bearer-token secret for the `POST /api/_internal/reload-data`
   * webhook (see specs/behaviors/storage.md#hot-reload). When unset, the
   * route is still registered but responds 503 — hot-reload is opt-in per
   * environment via the sealed Secret in the GitOps repo.
   */
  CFP_DATA_RELOAD_SECRET: z.string().min(32).optional(),
  /** Which private-storage backend to use. */
  STORAGE_BACKEND: z.enum(['s3', 'filesystem']),
  /** Filesystem backend: absolute path to the private-storage directory. */
  CFP_PRIVATE_STORAGE_PATH: z.string().optional(),
  /** S3 endpoint URL (required when STORAGE_BACKEND=s3). */
  S3_ENDPOINT: z.string().optional(),
  /** S3 bucket name (required when STORAGE_BACKEND=s3). */
  S3_BUCKET: z.string().optional(),
  /** S3 region (required when STORAGE_BACKEND=s3). */
  S3_REGION: z.string().optional(),
  /** S3 access key ID (required when STORAGE_BACKEND=s3). */
  S3_ACCESS_KEY_ID: z.string().optional(),
  /** S3 secret access key (required when STORAGE_BACKEND=s3). */
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** GitHub OAuth app client ID. */
  GITHUB_OAUTH_CLIENT_ID: z.string().optional(),
  /** GitHub OAuth app client secret. */
  GITHUB_OAUTH_CLIENT_SECRET: z.string().optional(),
  /** HS256 signing key for session JWTs — min 32 chars in production. */
  CFP_JWT_SIGNING_KEY: z.string().min(1),
  /** SAML IdP private key (PEM) for the Slack SAML integration. */
  SAML_PRIVATE_KEY: z.string().optional(),
  /** SAML IdP certificate (PEM) for the Slack SAML integration. */
  SAML_CERTIFICATE: z.string().optional(),
  /**
   * SAML IdP entity ID — the metadata `entityID` and the `<Issuer>` on every
   * assertion. A stable logical identifier Slack stores at setup time, so it
   * deliberately does NOT follow CFP_SITE_HOST: the pre-cutover
   * `next.codeforphilly.org` deploy and the post-cutover `codeforphilly.org`
   * deploy present the same issuer. Per specs/api/saml.md#idp-identity-and-hosts.
   */
  SAML_ENTITY_ID: z.url().default(SAML_ENTITY_ID_DEFAULT),
  /**
   * Slack workspace host. Used for the SAML ACS URL and `NameQualifier` per
   * specs/api/saml.md and shared with the `/chat` redirect handler. Never
   * used for our own IdP entity ID or endpoint URLs.
   */
  SLACK_TEAM_HOST: z.string().default('codeforphilly.slack.com'),
  /**
   * Path to the built apps/web/dist directory. When set, the API serves the
   * SPA as a fallthrough for non-/api/* routes. Set in the production Docker
   * image; unset in dev (Vite owns 5173).
   */
  CFP_WEB_DIST_PATH: z.string().optional(),
  /**
   * Host of the public-facing site (e.g. `codeforphilly.org` in prod,
   * `next-v2.codeforphilly.org` in sandbox). Used by the server-side
   * markdown renderer to distinguish internal from external links — anchors
   * with a host different from this one get `target="_blank" rel="noopener
   * nofollow"`. Per specs/behaviors/markdown-rendering.md. Also the host the
   * SAML IdP metadata advertises for its SSO endpoint Locations (per
   * specs/api/saml.md#idp-identity-and-hosts).
   */
  CFP_SITE_HOST: z.string().default('codeforphilly.org'),
  /**
   * Postmark server token for the email notifier. When unset, the services
   * plugin falls back to LoggingNotifier so dev + test runs don't need a
   * real token. See plans/postmark-notifier.md.
   */
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  /**
   * Postmark message stream outbound mail is sent on. `outbound` is the
   * transactional default stream every Postmark server ships with. Only
   * relevant when POSTMARK_SERVER_TOKEN is set.
   */
  POSTMARK_MESSAGE_STREAM: z.string().default('outbound'),
  /**
   * From-address for outbound notifications. RFC 5322 form
   * (e.g. `"Code for Philly <notifications@codeforphilly.org>"`). Only
   * relevant when POSTMARK_SERVER_TOKEN is set.
   */
  CFP_NOTIFICATION_FROM: z
    .string()
    .default('Code for Philly <notifications@codeforphilly.org>'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * JSON Schema representation of EnvSchema for @fastify/env.
 * @fastify/env expects a JSON Schema object, not a Zod schema.
 */
export const envJsonSchema = {
  type: 'object',
  required: ['CFP_DATA_REPO_PATH', 'STORAGE_BACKEND', 'CFP_JWT_SIGNING_KEY'],
  properties: {
    PORT: { type: 'number', default: 3001 },
    NODE_ENV: {
      type: 'string',
      enum: ['development', 'test', 'production'],
      default: 'development',
    },
    CFP_DATA_REPO_PATH: { type: 'string' },
    CFP_DATA_REMOTE: { type: 'string' },
    CFP_DATA_BRANCH: { type: 'string' },
    CFP_DATA_RELOAD_SECRET: { type: 'string', minLength: 32 },
    STORAGE_BACKEND: { type: 'string', enum: ['s3', 'filesystem'] },
    CFP_PRIVATE_STORAGE_PATH: { type: 'string' },
    S3_ENDPOINT: { type: 'string' },
    S3_BUCKET: { type: 'string' },
    S3_REGION: { type: 'string' },
    S3_ACCESS_KEY_ID: { type: 'string' },
    S3_SECRET_ACCESS_KEY: { type: 'string' },
    GITHUB_OAUTH_CLIENT_ID: { type: 'string' },
    GITHUB_OAUTH_CLIENT_SECRET: { type: 'string' },
    CFP_JWT_SIGNING_KEY: { type: 'string', minLength: 1 },
    SAML_PRIVATE_KEY: { type: 'string' },
    SAML_CERTIFICATE: { type: 'string' },
    SAML_ENTITY_ID: { type: 'string', default: SAML_ENTITY_ID_DEFAULT },
    SLACK_TEAM_HOST: { type: 'string', default: 'codeforphilly.slack.com' },
    CFP_WEB_DIST_PATH: { type: 'string' },
    CFP_SITE_HOST: { type: 'string', default: 'codeforphilly.org' },
    POSTMARK_SERVER_TOKEN: { type: 'string' },
    POSTMARK_MESSAGE_STREAM: { type: 'string', default: 'outbound' },
    CFP_NOTIFICATION_FROM: {
      type: 'string',
      default: 'Code for Philly <notifications@codeforphilly.org>',
    },
  },
} as const;
