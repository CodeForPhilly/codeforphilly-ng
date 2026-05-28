/**
 * Tests for POST /api/_internal/reload-data — the hot-reload webhook.
 *
 * Covers:
 *  - 401 when Authorization header is missing
 *  - 401 when bearer token doesn't match (constant-time compare path)
 *  - 503 when CFP_DATA_RELOAD_SECRET is unset (route still registered,
 *    refuses at request time so the deployment surface is stable
 *    across environments)
 *  - 400 when no branch is resolvable (no body + no CFP_DATA_BRANCH)
 *  - 200 noChanges via the cheap pre-check (commitHash is already an
 *    ancestor of local HEAD — no fetch, no lock)
 *  - 200 with outcome=in-sync when no body + no upstream changes
 *  - 200 with outcome=fast-forwarded + rebuilt:true; AND the new
 *    record introduced on the "remote" must be visible via a service
 *    call AFTER the reload completes (proves the in-memory state +
 *    FTS index actually got rebuilt against the new tree).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { createPrivateStorageDir } from './helpers/test-full-repo.js';

const exec = promisify(execFile);

// 32+ char secret so it satisfies the schema min length.
const VALID_SECRET = 'test-reload-secret-at-least-32-chars-long!!';

// Sheet configs — mirrors test-full-repo.ts. Inlined so we can drop them
// into the bare remote + into the local clone at controlled commits.
const SHEET_CONFIGS: Record<string, string> = {
  'people': `[gitsheet]\nroot = 'people'\npath = '\${{ slug }}'\n`,
  'projects': `[gitsheet]\nroot = 'projects'\npath = '\${{ slug }}'\n`,
  'project-memberships': `[gitsheet]\nroot = 'project-memberships'\npath = '\${{ projectSlug }}/\${{ personSlug }}'\n`,
  'project-updates': `[gitsheet]\nroot = 'project-updates'\npath = '\${{ projectSlug }}/\${{ number }}'\n`,
  'project-buzz': `[gitsheet]\nroot = 'project-buzz'\npath = '\${{ projectSlug }}/\${{ slug }}'\n`,
  'help-wanted-roles': `[gitsheet]\nroot = 'help-wanted-roles'\npath = '\${{ projectSlug }}/\${{ id }}'\n`,
  'help-wanted-interest': `[gitsheet]\nroot = 'help-wanted-interest'\npath = '\${{ roleId }}/\${{ personSlug }}'\n`,
  'tags': `[gitsheet]\nroot = 'tags'\npath = '\${{ namespace }}/\${{ slug }}'\n`,
  'tag-assignments': `[gitsheet]\nroot = 'tag-assignments'\npath = '\${{ tagId }}/\${{ taggableType }}/\${{ taggableId }}'\n`,
  'slug-history': `[gitsheet]\nroot = 'slug-history'\npath = '\${{ entityType }}/\${{ oldSlug }}'\n`,
  'revocations': `[gitsheet]\nroot = 'revocations'\npath = '\${{ jti }}'\n`,
};

interface Rig {
  /** Path to the local working tree (CFP_DATA_REPO_PATH). */
  readonly local: string;
  /** Path to the bare "remote" repo. */
  readonly bare: string;
  /** The branch name both sides are on (we use 'main'). */
  readonly branch: string;
  readonly cleanup: () => Promise<void>;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

/**
 * Build an isolated local working tree + bare remote pair. The local
 * tree is checked out at the same HEAD the remote has, with all
 * .gitsheets/*.toml sheet configs committed.
 *
 * The reconcile plugin will fetch/reconcile against the bare on boot;
 * since they start in-sync, boot is a no-op.
 */
async function createRig(): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), 'cfp-hot-reload-'));
  const bare = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const local = join(root, 'local.git');

  // Seed: produces the initial sheet-configs commit on `main`.
  await exec('git', ['init', '-b', 'main', seed]);
  await git(seed, 'config', 'user.email', 'seed@test.local');
  await git(seed, 'config', 'user.name', 'seed');
  await git(seed, 'config', 'commit.gpgsign', 'false');
  await git(seed, 'config', 'core.hooksPath', '/dev/null');

  await exec('mkdir', ['-p', join(seed, '.gitsheets')]);
  for (const [name, contents] of Object.entries(SHEET_CONFIGS)) {
    await writeFile(join(seed, '.gitsheets', `${name}.toml`), contents);
  }
  await git(seed, 'add', '.gitsheets');
  await git(seed, 'commit', '-m', 'initial: gitsheets sheet configs');

  // Bare remote.
  await exec('git', ['init', '--bare', '-b', 'main', bare]);
  await git(bare, 'config', 'receive.denyCurrentBranch', 'ignore');
  await exec('git', ['push', bare, 'main'], { cwd: seed });

  // Local clone from the bare — also bare, matching the app's runtime invariant
  // (specs/behaviors/storage.md → "The data clone is bare").
  await exec('git', ['clone', '--bare', bare, local]);
  await git(local, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await git(local, 'config', 'user.email', 'local@test.local');
  await git(local, 'config', 'user.name', 'local');
  await git(local, 'config', 'commit.gpgsign', 'false');

  return {
    local,
    bare,
    branch: 'main',
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Advance the bare remote by one commit on `main` via an ephemeral
 * clone. Used to put the local working tree behind so a hot reload
 * fast-forwards. The new commit introduces a fresh project record at
 * `projects/<slug>.toml`.
 */
async function advanceRemoteWithProject(
  rig: Rig,
  fields: { id: string; slug: string; title: string; summary?: string },
): Promise<string> {
  const wt = `${rig.local}-advance-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await exec('git', ['clone', rig.bare, wt]);
  await git(wt, 'config', 'user.email', 'advance@test.local');
  await git(wt, 'config', 'user.name', 'advance');
  await git(wt, 'config', 'commit.gpgsign', 'false');
  await git(wt, 'config', 'core.hooksPath', '/dev/null');

  // Minimal Project TOML the gitsheets reader will accept + the Zod
  // schema will validate at load time. The schema allows a lot of
  // optional fields; we provide only the required ones plus a couple
  // for the assertion.
  const toml = [
    `id = '${fields.id}'`,
    `slug = '${fields.slug}'`,
    `title = '${fields.title}'`,
    ...(fields.summary ? [`summary = '${fields.summary}'`] : []),
    `stage = 'testing'`,
    `featured = false`,
    `createdAt = '2026-05-19T00:00:00Z'`,
    `updatedAt = '2026-05-19T00:00:00Z'`,
    '',
  ].join('\n');
  await exec('mkdir', ['-p', join(wt, 'projects')]);
  await writeFile(join(wt, 'projects', `${fields.slug}.toml`), toml);
  await git(wt, 'add', `projects/${fields.slug}.toml`);
  await git(wt, 'commit', '-m', `seed: project ${fields.slug}`);
  await git(wt, 'push', 'origin', 'main');
  const head = await git(wt, 'rev-parse', 'HEAD');
  await rm(wt, { recursive: true, force: true });
  return head;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let rig: Rig;
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;

async function buildTestApp(
  overrides: Partial<Record<string, string>> = {},
): Promise<FastifyInstance> {
  return buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: rig.local,
      CFP_DATA_REMOTE: rig.bare,
      CFP_DATA_BRANCH: rig.branch,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
      NODE_ENV: 'test',
      ...overrides,
    },
  });
}

beforeEach(async () => {
  rig = await createRig();
  privateStore = await createPrivateStorageDir();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
  await rig.cleanup();
  await privateStore.cleanup();
});

// ---------------------------------------------------------------------------
// Auth + configuration
// ---------------------------------------------------------------------------

describe('POST /api/_internal/reload-data — auth', () => {
  it('responds 401 when the Authorization header is missing', async () => {
    app = await buildTestApp({ CFP_DATA_RELOAD_SECRET: VALID_SECRET });

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ success: boolean; error: { code: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('unauthorized');
  });

  it('responds 401 when the bearer token does not match', async () => {
    app = await buildTestApp({ CFP_DATA_RELOAD_SECRET: VALID_SECRET });

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: 'Bearer this-token-is-wrong-but-the-same-length-as-the-secret!!' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: { code: string; message: string } }>();
    expect(body.error.code).toBe('unauthorized');
    // Generic message — must not reveal whether the secret is set vs.
    // mismatched.
    expect(body.error.message).toBe('Authentication required');
  });

  it('responds 503 when CFP_DATA_RELOAD_SECRET is unset', async () => {
    // Build without the secret. Caller provides a (bogus) bearer so we
    // get past the missing-header guard and reach the "configured?" check.
    app = await buildTestApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: 'Bearer some-token-the-server-cannot-check' },
      payload: {},
    });
    expect(res.statusCode).toBe(503);
    const body = res.json<{ success: boolean; error: { code: string; message: string } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('service_unavailable');
    expect(body.error.message).toBe('hot-reload not configured');
  });

  it('responds 400 when no branch is resolvable (no body, no CFP_DATA_BRANCH)', async () => {
    // The reconcile plugin requires CFP_DATA_BRANCH alongside CFP_DATA_REMOTE,
    // so we drop the remote too — bootable, and the webhook is the only
    // thing that needs a branch.
    app = await buildApp({
      serverOptions: { logger: false },
      overrideEnv: {
        CFP_DATA_REPO_PATH: rig.local,
        STORAGE_BACKEND: 'filesystem',
        CFP_PRIVATE_STORAGE_PATH: privateStore.path,
        CFP_JWT_SIGNING_KEY: 'test-jwt-signing-key-at-least-32-chars!!',
        CFP_DATA_RELOAD_SECRET: VALID_SECRET,
        NODE_ENV: 'test',
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: `Bearer ${VALID_SECRET}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: { code: string } }>();
    expect(body.error.code).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

describe('POST /api/_internal/reload-data — short-circuit + reconcile', () => {
  it('returns 200 noChanges via the cheap pre-check when commitHash is already in HEAD', async () => {
    app = await buildTestApp({ CFP_DATA_RELOAD_SECRET: VALID_SECRET });

    // The local HEAD itself is trivially an ancestor of HEAD, so the
    // pre-check should fire without any fetch.
    const localHead = await git(rig.local, 'rev-parse', 'HEAD');

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: `Bearer ${VALID_SECRET}` },
      payload: { commitHash: localHead },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: { noChanges: boolean; outcome: string; head: string; durationMs: number };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.noChanges).toBe(true);
    expect(body.data.outcome).toBe('in-sync');
    expect(body.data.head).toBe(localHead);
    expect(typeof body.data.durationMs).toBe('number');
  });

  it('returns 200 with outcome=in-sync when local matches remote', async () => {
    app = await buildTestApp({ CFP_DATA_RELOAD_SECRET: VALID_SECRET });

    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: `Bearer ${VALID_SECRET}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      data: { noChanges: boolean; outcome: string; oldCommit: string; newCommit: string };
    }>();
    expect(body.data.noChanges).toBe(true);
    expect(body.data.outcome).toBe('in-sync');
    expect(body.data.oldCommit).toBe(body.data.newCommit);
  });

  it('fast-forwards and rebuilds in-memory state so a new project becomes visible', async () => {
    app = await buildTestApp({ CFP_DATA_RELOAD_SECRET: VALID_SECRET });

    // Before the reload, the project doesn't exist.
    const before = await app.inject({
      method: 'GET',
      url: '/api/projects/lazyloader',
    });
    expect(before.statusCode).toBe(404);

    // Advance the remote with a new project record.
    const newRemoteHead = await advanceRemoteWithProject(rig, {
      id: '01951a3c-0000-7000-8000-00000000aaaa',
      slug: 'lazyloader',
      title: 'LazyLoader',
      summary: 'Loads on demand.',
    });

    // Fire the webhook.
    const res = await app.inject({
      method: 'POST',
      url: '/api/_internal/reload-data',
      headers: { authorization: `Bearer ${VALID_SECRET}` },
      payload: { branch: rig.branch, commitHash: newRemoteHead },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json<{
      data: {
        noChanges: boolean;
        rebuilt: boolean;
        outcome: string;
        oldCommit: string;
        newCommit: string;
      };
    }>();
    expect(body.data.noChanges).toBe(false);
    expect(body.data.rebuilt).toBe(true);
    expect(body.data.outcome).toBe('fast-forwarded');
    expect(body.data.newCommit).toBe(newRemoteHead);

    // The new project must be visible AFTER the reload.
    const after = await app.inject({
      method: 'GET',
      url: '/api/projects/lazyloader',
    });
    expect(after.statusCode).toBe(200);
    const project = after.json<{ data: { slug: string; title: string } }>();
    expect(project.data.slug).toBe('lazyloader');
    expect(project.data.title).toBe('LazyLoader');

    // Confirm the local bare actually fast-forwarded too.
    const afterHead = await git(rig.local, 'rev-parse', 'HEAD');
    expect(afterHead).toBe(newRemoteHead);

    // Sanity-check that gitsheets has parsed the new record by reading
    // the TOML from the bare's HEAD tree (no working tree to filesystem-read).
    const contents = await git(rig.local, 'show', 'HEAD:projects/lazyloader.toml');
    expect(contents).toContain("slug = 'lazyloader'");
  });
});
