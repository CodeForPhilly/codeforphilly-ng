/**
 * Tests for GET /chat — Slack-workspace redirect per specs/screens/chat.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance;

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
      NODE_ENV: 'test',
    },
  });
}, 60_000);

afterAll(async () => {
  await app.close();
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

describe('GET /chat', () => {
  it('redirects to the Slack workspace root when no channel is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
    expect(res.headers['cache-control']).toContain('no-cache');
  });

  it('deep-links to a valid channel', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=general' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/channels/general');
  });

  it('accepts hyphens and underscores in the channel name', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=philly_civic-tech' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/channels/philly_civic-tech');
  });

  it('falls back to root for an empty channel', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
  });

  it('falls back to root for uppercase characters (invalid format)', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=General' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
  });

  it('falls back to root for slashes (path-injection attempt)', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=foo%2Fbar' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
  });

  it('falls back to root for an over-long channel name', async () => {
    // 42 chars total (> 41 max per the regex)
    const channel = 'a'.repeat(42);
    const res = await app.inject({ method: 'GET', url: `/chat?channel=${channel}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
  });

  it('falls back to root for leading hyphen (invalid first char)', async () => {
    const res = await app.inject({ method: 'GET', url: '/chat?channel=-leading-hyphen' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://codeforphilly.slack.com/');
  });

  it('does not register on /api/chat (only /chat)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat' });
    expect(res.statusCode).toBe(404);
  });
});
