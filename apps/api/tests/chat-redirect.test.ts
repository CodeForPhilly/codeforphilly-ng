/**
 * Tests for GET /chat and /chat/<channel> — Slack SSO launch per
 * specs/screens/chat.md. Every response is a 302 to Slack's SP-initiated
 * SSO start URL carrying `redir=/messages/<channel>/`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { slackSsoStartUrl } from '../src/routes/chat.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance;

const HOST = 'codeforphilly.slack.com';
const start = (channel: string): string => slackSsoStartUrl(HOST, channel);

beforeAll(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      SLACK_TEAM_HOST: HOST,
      NODE_ENV: 'test',
    },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

async function launch(url: string): Promise<string> {
  const res = await app.inject({ method: 'GET', url });
  expect(res.statusCode).toBe(302);
  expect(res.headers['cache-control']).toBe('no-cache');
  return String(res.headers.location);
}

describe('slackSsoStartUrl', () => {
  it('targets Slack SSO start with an encoded /messages/<channel>/ redir', () => {
    expect(start('general')).toBe(
      'https://codeforphilly.slack.com/sso/saml/start?redir=%2Fmessages%2Fgeneral%2F',
    );
  });
});

describe('GET /chat', () => {
  it('launches into #general when no channel is given', async () => {
    expect(await launch('/chat')).toBe(start('general'));
  });

  it('deep-links a valid ?channel=', async () => {
    expect(await launch('/chat?channel=phlask')).toBe(start('phlask'));
  });

  it('accepts hyphens and underscores in the channel name', async () => {
    expect(await launch('/chat?channel=philly_civic-tech')).toBe(start('philly_civic-tech'));
  });

  it('falls back to #general for an empty channel', async () => {
    expect(await launch('/chat?channel=')).toBe(start('general'));
  });

  it('falls back to #general for uppercase characters (invalid format)', async () => {
    expect(await launch('/chat?channel=General')).toBe(start('general'));
  });

  it('falls back to #general for slashes (path-injection attempt)', async () => {
    expect(await launch('/chat?channel=foo%2Fbar')).toBe(start('general'));
  });

  it('falls back to #general for an over-long channel name', async () => {
    const channel = 'a'.repeat(42);
    expect(await launch(`/chat?channel=${channel}`)).toBe(start('general'));
  });

  it('falls back to #general for a leading hyphen (invalid first char)', async () => {
    expect(await launch('/chat?channel=-leading-hyphen')).toBe(start('general'));
  });

  it('does not register on /api/chat (only /chat)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat' });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /chat/<channel>', () => {
  it('deep-links the path form — the shape of the links in the wild', async () => {
    expect(await launch('/chat/phlask')).toBe(start('phlask'));
  });

  it('tolerates a trailing slash', async () => {
    expect(await launch('/chat/phlask/')).toBe(start('phlask'));
  });

  it('falls back to #general for an invalid path segment', async () => {
    expect(await launch('/chat/Not%20A%20Channel')).toBe(start('general'));
  });

  it('never lets the channel reach the host', async () => {
    const location = await launch('/chat/evil.example');
    expect(new URL(location).host).toBe(HOST);
  });
});
