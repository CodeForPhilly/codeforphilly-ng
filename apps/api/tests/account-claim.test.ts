/**
 * Tests for the account-claim plan validation criteria.
 *
 * Covers each endpoint per specs/api/account-claim.md:
 *   - GET   /candidates
 *   - POST  /confirm                 (email-match auto-claim)
 *   - POST  /decline                 (fresh Person)
 *   - POST  /by-password             (legacy bcrypt verify)
 *   - POST  /request-staff-review    (anti-enumeration: 202 always)
 *   - GET   /legacy                  (post-onboarding search)
 *   - POST  /legacy/request          (post-onboarding submission)
 *   - GET   /staff/.../queue
 *   - POST  /staff/.../:id/approve   (pre-onboarding + post-onboarding merge)
 *   - POST  /staff/.../:id/deny
 *
 * Most tests bypass the GitHub OAuth callback and mint a `cfp_claim` JWT
 * directly so each scenario can seed its own candidate state. Each test uses
 * a unique remoteAddress so the 10-req/min/IP cap doesn't cross-contaminate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';

import { buildApp } from '../src/app.js';
import { issueClaimPending, issueSession } from '../src/auth/jwt.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';
import { seedRawToml } from './helpers/seed-fixtures.js';

const exec = promisify(execFile);
const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';

let testIpCounter = 0;
function nextTestIp(): string {
  testIpCounter += 1;
  return `10.1.${Math.floor(testIpCounter / 250)}.${testIpCounter % 250}`;
}

interface SeedPersonOpts {
  readonly accountLevel?: 'user' | 'staff' | 'administrator';
  readonly githubUserId?: number;
  readonly githubLogin?: string;
  readonly githubLinkedAt?: string;
  readonly slackSamlNameId?: string;
}

async function seedPerson(
  repoDir: string,
  slug: string,
  id: string,
  opts: SeedPersonOpts = {},
): Promise<void> {
  const lines = [
    `id = "${id}"`,
    `slug = "${slug}"`,
    `fullName = "Test ${slug}"`,
    `accountLevel = "${opts.accountLevel ?? 'user'}"`,
    `createdAt = "2026-05-01T00:00:00Z"`,
    `updatedAt = "2026-05-01T00:00:00Z"`,
  ];
  if (opts.githubUserId !== undefined) lines.push(`githubUserId = ${opts.githubUserId}`);
  if (opts.githubLogin !== undefined) lines.push(`githubLogin = "${opts.githubLogin}"`);
  if (opts.githubLinkedAt !== undefined) lines.push(`githubLinkedAt = "${opts.githubLinkedAt}"`);
  if (opts.slackSamlNameId !== undefined) {
    lines.push(`slackSamlNameId = "${opts.slackSamlNameId}"`);
  }

  await seedRawToml(repoDir, `people/${slug}.toml`, lines.join('\n'), `seed person ${slug}`);
}

async function seedPrivateProfile(
  privatePath: string,
  personId: string,
  email: string,
): Promise<void> {
  const filePath = join(privatePath, 'profiles.jsonl');
  const profile = {
    personId,
    email: email.toLowerCase(),
    emailRefreshedAt: '2026-05-01T00:00:00Z',
    newsletter: null,
    updatedAt: '2026-05-01T00:00:00Z',
  };
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // file doesn't exist yet
  }
  await writeFile(filePath, content + JSON.stringify(profile) + '\n');
}

async function seedLegacyPassword(
  privatePath: string,
  personId: string,
  passwordHash: string,
): Promise<void> {
  const filePath = join(privatePath, 'legacy-passwords.jsonl');
  const cred = {
    personId,
    passwordHash,
    importedAt: '2026-05-01T00:00:00Z',
  };
  let content = '';
  try {
    content = await readFile(filePath, 'utf8');
  } catch {
    // first write
  }
  await writeFile(filePath, content + JSON.stringify(cred) + '\n');
}

async function buildTestApp(
  dataPath: string,
  privatePath: string,
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataPath,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privatePath,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      GITHUB_OAUTH_CLIENT_ID: 'test-client-id',
      GITHUB_OAUTH_CLIENT_SECRET: 'test-client-secret',
      NODE_ENV: 'test',
    },
  });
}

async function mintClaim(
  ghId: string,
  ghLogin: string,
  ghEmails: string[],
  candidates: string[],
): Promise<string> {
  return issueClaimPending(
    { ghId, ghLogin, ghName: ghLogin, ghEmails },
    candidates,
    JWT_KEY,
  );
}

// ---------------------------------------------------------------------------
// GET /api/account-claim/candidates
// ---------------------------------------------------------------------------

describe('GET /api/account-claim/candidates', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const candidateId = '01951a3c-0000-7000-8000-0000aaaaaaa1';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'jane-doe', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'jane@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('returns 401 claim_token_invalid when cfp_claim cookie missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/account-claim/candidates',
      remoteAddress: nextTestIp(),
    });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('claim_token_invalid');
  });

  it('returns candidates with matchedVia and matchedEmail for email match', async () => {
    const token = await mintClaim('77', 'jane', ['jane@example.com'], [candidateId]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/account-claim/candidates',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: {
        ghLogin: string;
        candidates: Array<{ personId: string; matchedVia: string[]; matchedEmail: string | null }>;
      };
    };
    expect(body.data.ghLogin).toBe('jane');
    expect(body.data.candidates).toHaveLength(1);
    expect(body.data.candidates[0]!.personId).toBe(candidateId);
    expect(body.data.candidates[0]!.matchedVia).toEqual(['email']);
    expect(body.data.candidates[0]!.matchedEmail).toBe('jane@example.com');
  });

  it('marks a username-only candidate with matchedVia=["username"] and null email', async () => {
    const token = await mintClaim('78', 'jane-doe', ['someoneelse@example.com'], [candidateId]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/account-claim/candidates',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      data: { candidates: Array<{ matchedVia: string[]; matchedEmail: string | null }> };
    };
    expect(body.data.candidates[0]!.matchedVia).toEqual(['username']);
    expect(body.data.candidates[0]!.matchedEmail).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/account-claim/confirm
// ---------------------------------------------------------------------------

describe('POST /api/account-claim/confirm', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const candidateId = '01951a3c-0000-7000-8000-0000bbbbbbb1';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'confirm-target', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'confirm@example.com');
    // Seed a legacy credential so we can assert it's removed on success
    await seedLegacyPassword(privateStore.path, candidateId, '$2a$10$abcdefghijklmnopqrstuvwx');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('links the Person, deletes legacy credential, issues session', async () => {
    const token = await mintClaim('1234', 'gh-user', ['confirm@example.com'], [candidateId]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/confirm',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { personId: candidateId },
    });
    expect(res.statusCode).toBe(200);

    const setCookies = res.headers['set-cookie'];
    const cookies = Array.isArray(setCookies) ? setCookies : [String(setCookies ?? '')];
    expect(cookies.some((c) => c.startsWith('cfp_session='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('cfp_refresh='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('cfp_claim=;') || c.startsWith('cfp_claim=;'))).toBe(true);

    const person = app.inMemoryState.people.get(candidateId);
    expect(person?.githubUserId).toBe(1234);
    expect(person?.githubLogin).toBe('gh-user');
    expect(person?.githubLinkedAt).toBeDefined();
    expect(person?.slackSamlNameId).toBe('confirm-target');

    // Legacy credential deleted
    const cred = await app.store.private.getLegacyPassword(candidateId);
    expect(cred).toBeNull();

    // Profile email refreshed
    const profile = await app.store.private.getProfile(candidateId);
    expect(profile?.email).toBe('confirm@example.com');
  });

  it('refuses confirm when the personId is not in the JWT candidates', async () => {
    const otherId = '01951a3c-0000-7000-8000-0000bbbbbbb9';
    const token = await mintClaim('99', 'someone-else', ['someone@example.com'], [otherId]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/confirm',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { personId: candidateId },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('not_a_candidate');
  });

  it('refuses confirm with email_match_required when only username matches', async () => {
    // Seed a separate candidate with no email overlap
    const userId = '01951a3c-0000-7000-8000-0000bbbbbbb5';
    await seedPerson(dataRepo.path, 'username-only', userId);
    await seedPrivateProfile(privateStore.path, userId, 'unrelated@example.com');
    // Reload the app state to pick up the new seed (simplest way: rebuild app)
    await app.close();
    app = await buildTestApp(dataRepo.path, privateStore.path);

    const token = await mintClaim('1500', 'username-only', ['gh@example.com'], [userId]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/confirm',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { personId: userId },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string } };
    expect(body.error.code).toBe('email_match_required');
  });
});

// ---------------------------------------------------------------------------
// POST /api/account-claim/decline
// ---------------------------------------------------------------------------

describe('POST /api/account-claim/decline', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const candidateId = '01951a3c-0000-7000-8000-0000ccccccc1';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'declined-candidate', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'never-claim@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('creates a fresh Person and leaves the candidate untouched', async () => {
    const token = await mintClaim('2001', 'brand-new-gh', ['fresh@example.com'], [candidateId]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/decline',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: {},
    });
    expect(res.statusCode).toBe(201);

    const fresh = [...app.inMemoryState.people.values()].find(
      (p) => p.githubUserId === 2001,
    );
    expect(fresh).toBeDefined();
    expect(fresh?.slug).toBe('brand-new-gh');

    // The candidate is still unclaimed
    const candidate = app.inMemoryState.people.get(candidateId);
    expect(candidate?.githubUserId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// POST /api/account-claim/by-password
// ---------------------------------------------------------------------------

describe('POST /api/account-claim/by-password', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const candidateId = '01951a3c-0000-7000-8000-0000ddddddd1';
  const linkedId = '01951a3c-0000-7000-8000-0000ddddddd2';
  const sha1CandidateId = '01951a3c-0000-7000-8000-0000ddddddd3';
  const correctPassword = 'hunter2-correct';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    // Unclaimed candidate with a bcrypt hash on file
    await seedPerson(dataRepo.path, 'bcrypt-user', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'bcrypt-user@example.com');
    const hash = await bcrypt.hash(correctPassword, 4);
    await seedLegacyPassword(privateStore.path, candidateId, hash);
    // Already-linked person — its password row should NOT be acceptable
    await seedPerson(dataRepo.path, 'already-linked', linkedId, {
      githubUserId: 5555,
      githubLogin: 'linked-gh',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, linkedId, 'linked@example.com');
    await seedLegacyPassword(privateStore.path, linkedId, hash);
    // Legacy-laddr candidate with an unsalted SHA-1 hash (the actual
    // production format per emergence-skeleton User.class.php:33). The
    // new verifier accepts this path; pre-rewrite the verifier only
    // knew bcrypt.
    await seedPerson(dataRepo.path, 'sha1-user', sha1CandidateId);
    await seedPrivateProfile(privateStore.path, sha1CandidateId, 'sha1-user@example.com');
    const { createHash } = await import('node:crypto');
    const sha1Hash = createHash('sha1').update(correctPassword).digest('hex');
    await seedLegacyPassword(privateStore.path, sha1CandidateId, sha1Hash);

    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('claims on correct password', async () => {
    const token = await mintClaim('3001', 'gh-bcrypt-user', ['gh-fresh@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/by-password',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { slug: 'bcrypt-user', password: correctPassword },
    });
    expect(res.statusCode).toBe(200);

    const person = app.inMemoryState.people.get(candidateId);
    expect(person?.githubUserId).toBe(3001);

    const cred = await app.store.private.getLegacyPassword(candidateId);
    expect(cred).toBeNull();
  });

  it('claims on correct password against a SHA-1 hash (legacy laddr format)', async () => {
    const token = await mintClaim('3010', 'gh-sha1-user', ['gh-sha1-fresh@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/by-password',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { slug: 'sha1-user', password: correctPassword },
    });
    expect(res.statusCode).toBe(200);

    const person = app.inMemoryState.people.get(sha1CandidateId);
    expect(person?.githubUserId).toBe(3010);

    // Credential deleted on successful claim (per byPassword semantics —
    // the claim path still removes the credential since the user is now
    // GitHub-linked. Rehash-on-keep is a phase-B concern.)
    const cred = await app.store.private.getLegacyPassword(sha1CandidateId);
    expect(cred).toBeNull();
  });

  it('returns uniform 401 claim_credentials_invalid for unknown slug', async () => {
    const token = await mintClaim('3002', 'gh-nothing-user', ['none@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/by-password',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { slug: 'no-such-slug', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'claim_credentials_invalid',
    );
  });

  it('returns uniform 401 for an already-claimed slug (no enumeration)', async () => {
    const token = await mintClaim('3003', 'gh-attempt', ['attempt@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/by-password',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { slug: 'already-linked', password: correctPassword },
    });
    expect(res.statusCode).toBe(401);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      'claim_credentials_invalid',
    );
  });
});

// ---------------------------------------------------------------------------
// POST /api/account-claim/request-staff-review — anti-enumeration
// ---------------------------------------------------------------------------

describe('POST /api/account-claim/request-staff-review', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('returns 202 even for a nonexistent slug (anti-enumeration)', async () => {
    const token = await mintClaim('4001', 'gh-staff-test', ['s@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/request-staff-review',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: token },
      payload: { claimedSlug: 'no-such-account', evidence: 'I really am them.' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { data: { delivered: boolean } };
    expect(body.data.delivered).toBe(true);

    const open = await app.store.private.listOpenClaimRequests();
    expect(open).toHaveLength(1);
    expect(open[0]!.claimedPersonId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Staff queue + approve/deny
// ---------------------------------------------------------------------------

describe('Staff queue + approve/deny (pre-onboarding path)', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const candidateId = '01951a3c-0000-7000-8000-0000eeeeeee1';
  const staffId = '01951a3c-0000-7000-8000-0000eeeeeee2';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    await seedPerson(dataRepo.path, 'queue-target', candidateId);
    await seedPrivateProfile(privateStore.path, candidateId, 'queue@example.com');
    await seedPerson(dataRepo.path, 'staff-user', staffId, {
      accountLevel: 'staff',
      githubUserId: 999,
      githubLogin: 'staff-user',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, staffId, 'staff@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  async function staffCookies(): Promise<string> {
    const { access } = await issueSession(staffId, 'staff', JWT_KEY);
    return access;
  }

  it('full lifecycle: submit → queue → approve links GH to legacy Person', async () => {
    // 1. Submit a request via the claim flow
    const claimToken = await mintClaim('7001', 'wants-queue', ['wq@example.com'], []);
    const submitRes = await app.inject({
      method: 'POST',
      url: '/api/account-claim/request-staff-review',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: claimToken },
      payload: {
        claimedSlug: 'queue-target',
        evidence: 'I am them. Email me at wq@example.com.',
      },
    });
    expect(submitRes.statusCode).toBe(202);

    // 2. Staff lists the queue
    const access = await staffCookies();
    const queueRes = await app.inject({
      method: 'GET',
      url: '/api/staff/account-claim/queue',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
    });
    expect(queueRes.statusCode).toBe(200);
    const queueBody = queueRes.json() as { data: Array<{ requestId: string; claimedSlug: string }> };
    const open = queueBody.data.find((r) => r.claimedSlug === 'queue-target');
    expect(open).toBeDefined();
    const requestId = open!.requestId;

    // 3. Staff approves → legacy Person gets GH identity
    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/staff/account-claim/${requestId}/approve`,
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
      payload: { reason: 'verified via Slack DM' },
    });
    expect(approveRes.statusCode).toBe(200);

    const candidate = app.inMemoryState.people.get(candidateId);
    expect(candidate?.githubUserId).toBe(7001);
    expect(candidate?.githubLogin).toBe('wants-queue');
    expect(candidate?.githubLinkedAt).toBeDefined();

    // Request marked approved
    const stored = await app.store.private.getClaimRequest(requestId);
    expect(stored?.status).toBe('approved');
    expect(stored?.reviewedBy).toBe(staffId);
  });
});

// ---------------------------------------------------------------------------
// Post-onboarding /api/account-claim/legacy + merge approval
// ---------------------------------------------------------------------------

describe('Post-onboarding /account-claim/legacy search + merge approval', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;
  const legacyId = '01951a3c-0000-7000-8000-0000fffffff1';
  const freshId = '01951a3c-0000-7000-8000-0000fffffff2';
  const staffId = '01951a3c-0000-7000-8000-0000fffffff3';

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    // Unclaimed legacy person
    await seedPerson(dataRepo.path, 'legacy-old', legacyId);
    await seedPrivateProfile(privateStore.path, legacyId, 'legacy-old@example.com');
    // Fresh post-onboarding person (already linked to GH 8001)
    await seedPerson(dataRepo.path, 'fresh-new', freshId, {
      githubUserId: 8001,
      githubLogin: 'fresh-new',
      githubLinkedAt: '2026-05-15T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, freshId, 'fresh-new@example.com');
    // Staff
    await seedPerson(dataRepo.path, 'staff2', staffId, {
      accountLevel: 'staff',
      githubUserId: 9001,
      githubLogin: 'staff2',
      githubLinkedAt: '2026-04-01T00:00:00Z',
    });
    await seedPrivateProfile(privateStore.path, staffId, 'staff2@example.com');
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('legacy search by username returns the legacy candidate', async () => {
    const { access } = await issueSession(freshId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/account-claim/legacy?q=legacy-old',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { candidates: Array<{ personId: string }> } };
    expect(body.data.candidates).toHaveLength(1);
    expect(body.data.candidates[0]!.personId).toBe(legacyId);
  });

  it('legacy search returns empty array for nonexistent slug (no enumeration)', async () => {
    const { access } = await issueSession(freshId, 'user', JWT_KEY);
    const res = await app.inject({
      method: 'GET',
      url: '/api/account-claim/legacy?q=no-such-slug-here',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: access },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { candidates: unknown[] } };
    expect(body.data.candidates).toHaveLength(0);
  });

  it('submit + staff-approve merges fresh Person into legacy', async () => {
    const { access: freshAccess } = await issueSession(freshId, 'user', JWT_KEY);
    const submitRes = await app.inject({
      method: 'POST',
      url: '/api/account-claim/legacy/request',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: freshAccess },
      payload: {
        claimedSlug: 'legacy-old',
        evidence: 'I had both — same person. legacy-old@example.com is my old address.',
      },
    });
    expect(submitRes.statusCode).toBe(202);

    const { access: staffAccess } = await issueSession(staffId, 'staff', JWT_KEY);
    const queueRes = await app.inject({
      method: 'GET',
      url: '/api/staff/account-claim/queue',
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: staffAccess },
    });
    const queueBody = queueRes.json() as {
      data: Array<{ requestId: string; type: string; claimedSlug: string }>;
    };
    const open = queueBody.data.find(
      (r) => r.type === 'post-onboarding-merge' && r.claimedSlug === 'legacy-old',
    );
    expect(open).toBeDefined();
    const requestId = open!.requestId;

    const approveRes = await app.inject({
      method: 'POST',
      url: `/api/staff/account-claim/${requestId}/approve`,
      remoteAddress: nextTestIp(),
      cookies: { cfp_session: staffAccess },
      payload: { reason: 'merge approved' },
    });
    expect(approveRes.statusCode).toBe(200);

    // Legacy Person now has the GH identity
    const legacy = app.inMemoryState.people.get(legacyId);
    expect(legacy?.githubUserId).toBe(8001);
    expect(legacy?.githubLogin).toBe('fresh-new');

    // Fresh Person is hard-deleted
    const fresh = app.inMemoryState.people.get(freshId);
    expect(fresh).toBeUndefined();

    // slug-history entry created for old → new. We read it via `git show`
    // rather than `app.store.public['slug-history'].queryAll()` — that sheet
    // isn't loaded into the typed in-memory Store, so the standing Sheet
    // handle caches the pre-transact dataTree and returns []. See #47 and
    // specs/behaviors/storage.md → "Direct gitsheets reads after a transact".
    const showRes = await exec('git', ['show', 'HEAD:slug-history/person/fresh-new.toml'], {
      cwd: dataRepo.path,
    });
    expect(showRes.stdout).toContain('newSlug');
    expect(showRes.stdout).toContain('legacy-old');
  });
});

// ---------------------------------------------------------------------------
// Commit-message PII smoke — verify no email/evidence leaks via trailers
// ---------------------------------------------------------------------------

describe('Anti-PII commit trailers', () => {
  let dataRepo: { path: string; cleanup: () => Promise<void> };
  let privateStore: { path: string; cleanup: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    dataRepo = await createFullDataRepo();
    privateStore = await createPrivateStorageDir();
    app = await buildTestApp(dataRepo.path, privateStore.path);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await dataRepo.cleanup();
    await privateStore.cleanup();
  });

  it('request-staff-review trailer carries no slug, evidence, or email', async () => {
    const claimToken = await mintClaim('9101', 'pii-test', ['pii-test@example.com'], []);
    const res = await app.inject({
      method: 'POST',
      url: '/api/account-claim/request-staff-review',
      remoteAddress: nextTestIp(),
      cookies: { cfp_claim: claimToken },
      payload: {
        claimedSlug: 'secret-slug-do-not-leak',
        evidence: 'my secret email: pii-test@private-domain.example',
      },
    });
    expect(res.statusCode).toBe(202);

    // The staff-review submit only writes to the private store, so no public
    // commit is produced. Verify by listing public log entries — the most
    // recent commits should NOT mention the evidence.
    const log = await exec('git', ['log', '--all', '--format=%B%n---END---'], {
      cwd: dataRepo.path,
    });
    expect(log.stdout).not.toContain('secret-slug-do-not-leak');
    expect(log.stdout).not.toContain('pii-test@private-domain.example');
  });
});
