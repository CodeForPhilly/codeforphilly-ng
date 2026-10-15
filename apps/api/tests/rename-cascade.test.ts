/**
 * Rename cascade — specs/behaviors/slug-handles.md: renaming a project, a
 * person or an event rewrites every record that references the old slug in
 * the same commit, so no record anywhere holds the old slug afterwards.
 *
 * Generic over the reference map: the referencing sheets come from
 * SHEET_REFERENCES (derived from the schemas), so a newly declared reference
 * is covered here without editing this test — the seed guard fails until the
 * fixture holds a record in that sheet.
 */
import { SHEET_REFERENCES, type ContractSheet } from '@cfp/shared';
import type { FastifyInstance } from 'fastify';
import { openRepo } from 'gitsheets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { mintSessionFor } from '../src/auth/issue.js';
import { referencingSheets, unsupportedReferences } from '../src/services/reference-cascade.js';
import { loadInMemoryState } from '../src/store/memory/loader.js';
import type { InMemoryState } from '../src/store/memory/state.js';
import { seedFixtures, type SeededFixtures } from './helpers/seed-fixtures.js';
import { createFullDataRepo, createPrivateStorageDir } from './helpers/test-full-repo.js';

const JWT_KEY = 'test-jwt-signing-key-at-least-32-chars!!';
const NOW = '2026-05-15T18:42:00Z';
const OTHER_PERSON_ID = '01951a3c-0000-7000-8000-0000000000e1';
const EVENT_ID = '01951a3c-0000-7000-8000-0000000000e2';
const EVENT_SLUG = 'hack-night';
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

let dataRepo: { path: string; cleanup: () => Promise<void> };
let privateStore: { path: string; cleanup: () => Promise<void> };
let app: FastifyInstance | undefined;
let fixtures: SeededFixtures;
let buzzImageKey: string;

/** Every target the reference map names, with the slug the fixture renames. */
const TARGET_SLUGS: Record<string, () => string> = {
  projects: () => fixtures.projectSlug,
  people: () => fixtures.personSlug,
  events: () => EVENT_SLUG,
};

/**
 * Give every referencing sheet at least one record pointing at the fixture's
 * project / person / event, plus a record pointing elsewhere that a rename
 * must leave alone.
 */
async function seedReferencingRecords(): Promise<void> {
  const repo = await openRepo({ gitDir: dataRepo.path });
  await repo.transact({ message: 'seed referencing records', author: { name: 't', email: 't@cfp.test' } }, async (tx) => {
    await tx.sheet('people').upsert({
      id: OTHER_PERSON_ID, slug: 'other-person', fullName: 'Other Person', accountLevel: 'user',
      createdAt: NOW, updatedAt: NOW,
    });
    await tx.sheet('events').upsert(
      {
        id: EVENT_ID, slug: EVENT_SLUG, title: 'Hack Night', startsAt: '2026-06-01T23:00:00Z',
        endsAt: '2026-06-02T01:00:00Z', status: 'scheduled', icsSequence: 0, createdAt: NOW, updatedAt: NOW,
      },
      { allowMissingBody: true },
    );
    await tx.sheet('event-rsvps').upsert({
      id: '01951a3c-0000-7000-8000-0000000000e3', year: '2026', eventSlug: EVENT_SLUG,
      personSlug: fixtures.personSlug, plan: 'project', projectId: fixtures.projectId,
      createdAt: NOW, updatedAt: NOW,
    });
    await tx.sheet('event-rsvps').upsert({
      id: '01951a3c-0000-7000-8000-0000000000e4', year: '2026', eventSlug: EVENT_SLUG,
      personSlug: 'other-person', createdAt: NOW, updatedAt: NOW,
    });
    await tx.sheet('help-wanted-interest').upsert({
      id: '01951a3c-0000-7000-8000-0000000000e5', roleId: fixtures.helpWantedId,
      personSlug: fixtures.personSlug, message: 'Count me in', createdAt: NOW,
    });
    await tx.sheet('person-evaluations').upsert({
      personSlug: fixtures.personSlug, evaluator: 'human-other-person', verdict: 'legit', confidence: 1,
      flags: [], evaluatedAt: NOW,
    });

    // A buzz image: an attachment of the buzz record, keyed under its path.
    const buzzSheet = tx.sheet('project-buzz');
    const [buzz] = (await buzzSheet.queryAll()) as Array<Record<string, unknown>>;
    buzzImageKey = `project-buzz/${fixtures.projectSlug}/${String(buzz!['slug'])}/image.png`;
    const withImage = { ...buzz, imageKey: buzzImageKey };
    await buzzSheet.upsert(withImage);
    await buzzSheet.setAttachment(withImage, 'image.png', IMAGE);
  });
}

async function staffCookie(): Promise<string> {
  const session = await mintSessionFor(fixtures.personId, 'staff', JWT_KEY);
  return `cfp_session=${session.accessToken}`;
}

beforeEach(async () => {
  dataRepo = await createFullDataRepo();
  privateStore = await createPrivateStorageDir();
  fixtures = await seedFixtures(dataRepo.path);
  await seedReferencingRecords();
  app = await buildApp({
    serverOptions: { logger: false },
    overrideEnv: {
      CFP_DATA_REPO_PATH: dataRepo.path,
      STORAGE_BACKEND: 'filesystem',
      CFP_PRIVATE_STORAGE_PATH: privateStore.path,
      CFP_JWT_SIGNING_KEY: JWT_KEY,
      NODE_ENV: 'test',
    },
  });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await dataRepo.cleanup();
  await privateStore.cleanup();
});

type Rec = Record<string, unknown>;

/** Records of a sheet as stored (the committed tree). */
async function onDisk(sheet: ContractSheet): Promise<Rec[]> {
  return (await (app!.store.public[sheet] as unknown as { queryAll(): Promise<Rec[]> }).queryAll());
}

/** Records of a sheet as held in memory. */
function inMemory(state: InMemoryState, sheet: ContractSheet): Rec[] {
  const maps: Partial<Record<ContractSheet, Map<string, unknown>>> = {
    'project-memberships': state.projectMemberships,
    'project-updates': state.projectUpdates,
    'project-buzz': state.projectBuzz,
    'help-wanted-roles': state.helpWantedRoles,
    'help-wanted-interest': state.helpWantedInterest,
    'event-rsvps': state.eventRsvps,
    'person-evaluations': state.personEvaluations,
  };
  const map = maps[sheet];
  if (!map) throw new Error(`test has no in-memory view of ${sheet}`);
  return [...map.values()] as Rec[];
}

/** Count, per referencing sheet+field, the records holding `slug`. */
async function referenceCounts(target: string, slug: string): Promise<Map<string, { disk: number; memory: number }>> {
  const out = new Map<string, { disk: number; memory: number }>();
  for (const ref of referencingSheets(target)) {
    const disk = (await onDisk(ref.sheet)).filter((r) => r[ref.field] === slug).length;
    const memory = inMemory(app!.inMemoryState, ref.sheet).filter((r) => r[ref.field] === slug).length;
    out.set(`${ref.sheet}.${ref.field}`, { disk, memory });
  }
  return out;
}

/**
 * The in-memory indices after a write must match a full load of the tree
 * (ids per map, every secondary index). Record bodies are compared through
 * the reference fields only: a StateApply record carries explicit nulls a
 * reload omits.
 */
function indexSnapshot(state: InMemoryState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (!(value instanceof Map)) continue;
    out[key] = [...value.entries()]
      .map(([k, v]) => {
        if (v instanceof Set) return [String(k), [...v].sort()];
        if (typeof v === 'object' && v !== null) {
          const refs = SHEET_REFERENCES.map((r) => r.field).filter((f) => f in v);
          return [String(k), Object.fromEntries(refs.map((f) => [f, (v as Rec)[f]]))];
        }
        return [String(k), v];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  }
  return out;
}

async function expectStateMatchesFullLoad(): Promise<void> {
  const full = await loadInMemoryState(app!.store.public);
  expect(indexSnapshot(app!.inMemoryState)).toEqual(indexSnapshot(full));
}

async function rename(target: string, oldSlug: string, newSlug: string): Promise<void> {
  const url = { projects: '/api/projects', people: '/api/people', events: '/api/events' }[target];
  if (!url) throw new Error(`no rename endpoint for ${target}`);
  const res = await app!.inject({
    method: 'PATCH',
    url: `${url}/${oldSlug}`,
    headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
    payload: { slug: newSlug },
  });
  expect(res.statusCode, res.body).toBe(200);
}

describe('rename cascade', () => {
  it('every declared reference targets a renameable sheet the cascade can walk', () => {
    expect(SHEET_REFERENCES.length).toBeGreaterThan(0);
    expect(unsupportedReferences()).toEqual([]);
    for (const ref of SHEET_REFERENCES) {
      expect(Object.keys(TARGET_SLUGS), `${ref.sheet}.${ref.field}`).toContain(ref.target.sheet);
      expect(ref.target.field).toBe('slug');
    }
  });

  const targets = [...new Set(SHEET_REFERENCES.map((r) => r.target.sheet))];
  it.each(targets)('renaming a %s rewrites and moves every record that references it', async (target) => {
    const oldSlug = TARGET_SLUGS[target]!();
    const newSlug = `${oldSlug}-renamed`;

    const before = await referenceCounts(target, oldSlug);
    for (const [ref, counts] of before) {
      // The fixture must exercise every referencing sheet.
      expect(counts.disk, `fixture has no ${ref} referencing ${target}/${oldSlug}`).toBeGreaterThan(0);
      expect(counts.memory, ref).toBe(counts.disk);
    }

    await rename(target, oldSlug, newSlug);

    const stale = await referenceCounts(target, oldSlug);
    const moved = await referenceCounts(target, newSlug);
    for (const [ref, counts] of before) {
      expect(stale.get(ref), `${ref} still holds ${oldSlug}`).toEqual({ disk: 0, memory: 0 });
      expect(moved.get(ref), `${ref} on ${newSlug}`).toEqual(counts);
    }

    // No record anywhere holds the old slug as a reference to this target.
    for (const ref of SHEET_REFERENCES.filter((r) => r.target.sheet === target)) {
      const holders = (await onDisk(ref.sheet)).filter((r) => r[ref.field] === oldSlug);
      expect(holders, `${ref.sheet}.${ref.field}`).toEqual([]);
    }

    await expectStateMatchesFullLoad();
  });

  it('a project rename carries buzz images to the buzz record’s new path', async () => {
    const newSlug = 'squadquest-renamed';
    await rename('projects', fixtures.projectSlug, newSlug);

    const [buzz] = inMemory(app!.inMemoryState, 'project-buzz');
    const expectedKey = buzzImageKey.replace(`project-buzz/${fixtures.projectSlug}/`, `project-buzz/${newSlug}/`);
    expect(buzz!['imageKey']).toBe(expectedKey);

    const moved = await app!.inject({ method: 'GET', url: `/api/attachments/${expectedKey}` });
    expect(moved.statusCode).toBe(200);
    expect(moved.rawPayload.equals(IMAGE)).toBe(true);
    const old = await app!.inject({ method: 'GET', url: `/api/attachments/${buzzImageKey}` });
    expect(old.statusCode).toBe(404);

    // Read endpoints follow the moved records.
    const res = await app!.inject({ method: 'GET', url: `/api/projects/${newSlug}/buzz` });
    expect(res.json<{ data: Array<{ imageUrl: string | null; project: { slug: string } }> }>().data).toEqual([
      expect.objectContaining({ imageUrl: `/api/attachments/${expectedKey}`, project: expect.objectContaining({ slug: newSlug }) }),
    ]);
  });

  it('a person rename keeps their memberships, interest and RSVP visible through the API', async () => {
    const newSlug = 'jane-renamed';
    await rename('people', fixtures.personSlug, newSlug);

    const project = await app!.inject({ method: 'GET', url: `/api/projects/${fixtures.projectSlug}` });
    const members = project.json<{ data: { memberships: Array<{ person: { slug: string | null } }> } }>().data.memberships;
    expect(members.map((m) => m.person.slug)).toEqual([newSlug]);

    const person = await app!.inject({ method: 'GET', url: `/api/people/${newSlug}` });
    const memberships = person.json<{ data: { memberships: Array<{ project: { slug: string } }> } }>().data.memberships;
    expect(memberships.map((m) => m.project.slug)).toEqual([fixtures.projectSlug]);

    const rsvps = await app!.inject({ method: 'GET', url: `/api/events/${EVENT_SLUG}/rsvps` });
    const people = rsvps.json<{ data: Array<{ person: { slug: string } | null }> }>().data.map((r) => r.person?.slug);
    expect(people.sort()).toEqual([newSlug, 'other-person'].sort());
  });

  it('an event that moves across a year boundary moves its RSVPs to the new year', async () => {
    const res = await app!.inject({
      method: 'PATCH',
      url: `/api/events/${EVENT_SLUG}`,
      headers: { cookie: await staffCookie(), 'content-type': 'application/json' },
      payload: { startsAt: '2027-01-05T23:00:00Z', endsAt: '2027-01-06T01:00:00Z' },
    });
    expect(res.statusCode, res.body).toBe(200);

    const rsvps = await onDisk('event-rsvps');
    expect(rsvps.map((r) => `${String(r['year'])}/${String(r['eventSlug'])}`)).toEqual([
      `2027/${EVENT_SLUG}`,
      `2027/${EVENT_SLUG}`,
    ]);
    expect(inMemory(app!.inMemoryState, 'event-rsvps').map((r) => r['year'])).toEqual(['2027', '2027']);
    await expectStateMatchesFullLoad();
  });
});
