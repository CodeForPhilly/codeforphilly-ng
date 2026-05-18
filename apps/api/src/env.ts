/**
 * Environment schema and config type.
 *
 * This is the ONLY place that reads process.env. All other modules read
 * fastify.config.<FIELD> after @fastify/env has validated and populated it.
 */
import { z } from 'zod';

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
   * Slack workspace host. Used as the SAML `NameQualifier` per
   * specs/api/saml.md and shared with the `/chat` redirect handler.
   */
  SLACK_TEAM_HOST: z.string().default('codeforphilly.slack.com'),
  /**
   * Path to the built apps/web/dist directory. When set, the API serves the
   * SPA as a fallthrough for non-/api/* routes. Set in the production Docker
   * image; unset in dev (Vite owns 5173).
   */
  CFP_WEB_DIST_PATH: z.string().optional(),
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
    SLACK_TEAM_HOST: { type: 'string', default: 'codeforphilly.slack.com' },
    CFP_WEB_DIST_PATH: { type: 'string' },
  },
} as const;
