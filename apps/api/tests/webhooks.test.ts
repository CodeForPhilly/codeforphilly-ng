/**
 * POST /api/_webhooks/postmark/bounce — specs/api/webhooks.md.
 *
 *  - 503 when POSTMARK_WEBHOOK_SECRET is unset
 *  - 401 with a wrong secret (bearer or basic)
 *  - terminal bounce for a known address → profile.emailBounce recorded
 *  - transient bounce → acknowledged, nothing recorded
 *  - unknown address → 200 matched:false
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildApp } from '../src/app.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const SECRET = 'postmark-webhook-secret-for-tests!';
const PERSON_ID = '01951a3c-0000-7000-8000-0000000000c1';

describe('Postmark bounce webhook', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  let unconfigured: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedRawToml(
      dataRepo.path,
      'people/bouncy.toml',
      [
        `id = "${PERSON_ID}"`,
        'slug = "bouncy"',
        'fullName = "Bouncy Person"',
        'accountLevel = "user"',
        'createdAt = "2026-05-01T00:00:00Z"',
        'updatedAt = "2026-05-01T00:00:00Z"',
      ].join('\n'),
      'seed bouncy',
    );
    await writeFile(
      join(privateStore.path, 'profiles.jsonl'),
      JSON.stringify({
        personId: PERSON_ID,
        email: 'bouncy@example.org',
        emailRefreshedAt: '2026-05-01T00:00:00.000Z',
        newsletter: null,
        updatedAt: '2026-05-01T00:00:00.000Z',
      }) + '\n',
    );
    const env = {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
    };
    app = await buildApp({ serverOptions: { logger: false }, overrideEnv: { ...env, POSTMARK_WEBHOOK_SECRET: SECRET } });
    unconfigured = await buildApp({ serverOptions: { logger: false }, overrideEnv: env });
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await unconfigured.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  const bounce = (overrides: Record<string, unknown> = {}) => ({
    RecordType: 'Bounce',
    Type: 'HardBounce',
    Email: 'Bouncy@Example.org',
    BouncedAt: '2026-09-18T12:00:00Z',
    Description: 'The server was unable to deliver your message',
    Inactive: true,
    ...overrides,
  });

  it('503s when the secret is not configured', async () => {
    const res = await unconfigured.inject({
      method: 'POST',
      url: '/api/_webhooks/postmark/bounce',
      payload: bounce(),
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(503);
  });

  it('401s on a wrong secret, bearer or basic', async () => {
    for (const authorization of ['Bearer nope', `Basic ${Buffer.from('postmark:nope').toString('base64')}`, '']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/_webhooks/postmark/bounce',
        payload: bounce(),
        headers: authorization ? { authorization } : {},
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('records a terminal bounce on the matching profile (basic auth, case-insensitive email)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/_webhooks/postmark/bounce',
      payload: bounce(),
      headers: { authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString('base64')}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { matched: boolean; recorded: boolean } }>().data).toEqual({ matched: true, recorded: true });
    const profile = await app.store.private.getProfile(PERSON_ID);
    expect(profile?.emailBounce).toMatchObject({ type: 'HardBounce', bouncedAt: '2026-09-18T12:00:00.000Z', inactive: true });
  });

  it('acknowledges but ignores transient bounces and unknown addresses', async () => {
    const transient = await app.inject({
      method: 'POST',
      url: '/api/_webhooks/postmark/bounce',
      payload: bounce({ Type: 'Transient', Email: 'someone-else@example.org' }),
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(transient.statusCode).toBe(200);
    expect(transient.json<{ data: { ignored: boolean } }>().data.ignored).toBe(true);

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/_webhooks/postmark/bounce',
      payload: bounce({ Email: 'nobody@example.org' }),
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json<{ data: { matched: boolean } }>().data.matched).toBe(false);
  });
});
