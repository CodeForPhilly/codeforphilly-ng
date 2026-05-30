/**
 * Unit tests for the JSON-based laddr importer.
 *
 * The fetcher and translators are exercised with synthetic JSON payloads —
 * we deliberately do *not* hit the live codeforphilly.org from tests. The
 * end-to-end run against the real site is performed by the operator during
 * dev (see plans/laddr-import-via-json.md).
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { importLaddrFromJson } from '../scripts/import-laddr/importer.js';
import {
  fetchAllPages,
  RawTagSchema,
  type RawPerson,
  type RawProject,
  type RawTag,
} from '../scripts/import-laddr/json-fetcher.js';
import {
  newExistingIds,
  newIdMaps,
  splitTagHandle,
  translateBlogPost,
  translatePerson,
  translateProject,
  translateTag,
  type TranslateCtx,
} from '../scripts/import-laddr/translators.js';
import type { RawBlogPost } from '../scripts/import-laddr/json-fetcher.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// In-memory fetch mock
// ---------------------------------------------------------------------------

interface MockRoutes {
  /** path-without-host → ordered list of JSON responses (one per request) */
  readonly responses: Map<string, unknown[]>;
}

function makeFetch(routes: MockRoutes): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    const key = `${url.pathname}?${url.searchParams.toString()}`;
    const queue = routes.responses.get(key);
    if (!queue || queue.length === 0) {
      // 404 fallback so missing routes are loud
      return new Response('Not found', { status: 404 });
    }
    const body = queue.shift()!;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function envelope(rows: unknown[], total: number, limit: number, offset: number) {
  return {
    success: true,
    total,
    limit,
    offset: offset === 0 ? false : offset,
    data: rows,
  };
}

// ---------------------------------------------------------------------------
// JSON fetcher
// ---------------------------------------------------------------------------

describe('fetchAllPages', () => {
  it('iterates a single-page response', async () => {
    const routes: MockRoutes = {
      responses: new Map([
        [
          '/things?format=json&limit=2&offset=0',
          [envelope([{ ID: 1, Class: 'X', Handle: 'tech.a' }, { ID: 2, Class: 'X', Handle: 'tech.b' }], 2, 2, 0)],
        ],
      ]),
    };
    const got: RawTag[] = [];
    for await (const row of fetchAllPages<RawTag>(
      '/things',
      RawTagSchema,
      {},
      { host: 'example.test', pageSize: 2, delayMs: 0, fetchImpl: makeFetch(routes) },
    )) {
      got.push(row);
    }
    expect(got.map((r) => r.ID)).toEqual([1, 2]);
  });

  it('paginates with offset until total reached', async () => {
    const routes: MockRoutes = {
      responses: new Map([
        [
          '/p?format=json&limit=2&offset=0',
          [envelope([{ ID: 1, Class: 'X', Handle: 'tech.a' }, { ID: 2, Class: 'X', Handle: 'tech.b' }], 5, 2, 0)],
        ],
        [
          '/p?format=json&limit=2&offset=2',
          [envelope([{ ID: 3, Class: 'X', Handle: 'tech.c' }, { ID: 4, Class: 'X', Handle: 'tech.d' }], 5, 2, 2)],
        ],
        [
          '/p?format=json&limit=2&offset=4',
          [envelope([{ ID: 5, Class: 'X', Handle: 'tech.e' }], 5, 2, 4)],
        ],
      ]),
    };
    const ids: number[] = [];
    for await (const row of fetchAllPages<RawTag>(
      '/p',
      RawTagSchema,
      {},
      { host: 'example.test', pageSize: 2, delayMs: 0, fetchImpl: makeFetch(routes) },
    )) {
      ids.push(row.ID);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('respects caller limit and truncates pagination', async () => {
    const routes: MockRoutes = {
      responses: new Map([
        [
          '/p?format=json&limit=10&offset=0',
          [
            envelope(
              Array.from({ length: 10 }).map((_, i) => ({ ID: i + 1, Class: 'X', Handle: 'tech.a' })),
              50,
              10,
              0,
            ),
          ],
        ],
      ]),
    };
    const ids: number[] = [];
    for await (const row of fetchAllPages<RawTag>(
      '/p',
      RawTagSchema,
      {},
      { host: 'example.test', pageSize: 10, limit: 3, delayMs: 0, fetchImpl: makeFetch(routes) },
    )) {
      ids.push(row.ID);
    }
    expect(ids).toEqual([1, 2, 3]);
  });

  it('throws when the response shape does not match the schema', async () => {
    const routes: MockRoutes = {
      responses: new Map([
        ['/p?format=json&limit=2&offset=0', [{ success: true, total: 1, limit: 2, offset: false, data: [{ foo: 1 }] }]],
      ]),
    };
    const it_ = fetchAllPages<RawTag>(
      '/p',
      RawTagSchema,
      {},
      { host: 'example.test', pageSize: 2, delayMs: 0, fetchImpl: makeFetch(routes) },
    );
    await expect((async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _row of it_) {
        // intentionally empty
      }
    })()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Translators
// ---------------------------------------------------------------------------

function ctx(): TranslateCtx & { warnings: { items: string[]; push: (w: string) => void } } {
  const items: string[] = [];
  return {
    idMaps: newIdMaps(),
    warnings: { items, push: (w: string) => items.push(w) },
    now: '2026-05-18T00:00:00.000Z',
    existingIds: newExistingIds(),
  };
}

describe('translateTag', () => {
  it('splits `topic.transit` into namespace + slug', () => {
    const c = ctx();
    const row: RawTag = {
      ID: 7,
      Class: 'Tag',
      Handle: 'topic.transit',
      Title: 'Transit',
      Created: 1377126953,
    };
    const tag = translateTag(row, c);
    expect(tag).not.toBeNull();
    expect(tag!.namespace).toBe('topic');
    expect(tag!.slug).toBe('transit');
    expect(tag!.title).toBe('Transit');
    expect(tag!.legacyId).toBe(7);
  });

  it('recovers a missing-dot handle from the title', () => {
    const c = ctx();
    const row: RawTag = {
      ID: 9,
      Class: 'Tag',
      Handle: 'topictransit',
      Title: 'topic.Transit',
      Created: 1377126953,
    };
    const tag = translateTag(row, c);
    expect(tag).not.toBeNull();
    expect(tag!.namespace).toBe('topic');
    expect(tag!.slug).toBe('transit');
  });

  it('defaults bare handles with no namespace to topic', () => {
    const c = ctx();
    const row: RawTag = { ID: 11, Class: 'Tag', Handle: 'cocoa', Title: 'cocoa' };
    const tag = translateTag(row, c);
    expect(tag).not.toBeNull();
    expect(tag!.namespace).toBe('topic');
    expect(tag!.slug).toBe('cocoa');
    expect(c.warnings.items.some((w) => w.includes('defaulted to topic'))).toBe(true);
  });

  it('coerces underscores in the slug component', () => {
    const c = ctx();
    const row: RawTag = {
      ID: 12,
      Class: 'Tag',
      Handle: 'topic.urban_design',
      Title: 'Urban Design',
    };
    const tag = translateTag(row, c);
    expect(tag).not.toBeNull();
    expect(tag!.slug).toBe('urban-design');
  });
});

describe('splitTagHandle', () => {
  it('defaults unknown namespaces to topic with a warning', () => {
    const warnings = { items: [] as string[], push: (w: string) => warnings.items.push(w) };
    expect(splitTagHandle('weird.foo', null, warnings, 1)).toEqual({
      namespace: 'topic',
      slug: 'weird.foo',
    });
    expect(warnings.items).toEqual([
      '[tags] legacyId=1 handle "weird.foo" has no resolvable namespace; defaulted to topic',
    ]);
  });

  it('defaults bare-word handles to topic', () => {
    const warnings = { items: [] as string[], push: (w: string) => warnings.items.push(w) };
    expect(splitTagHandle('naloxone', null, warnings, 1)).toEqual({
      namespace: 'topic',
      slug: 'naloxone',
    });
    expect(warnings.items).toEqual([
      '[tags] legacyId=1 handle "naloxone" has no resolvable namespace; defaulted to topic',
    ]);
  });

  it('handles event namespace', () => {
    const warnings = { items: [] as string[], push: (w: string) => warnings.items.push(w) };
    expect(splitTagHandle('event.ecocamp-2014', null, warnings, 1)).toEqual({
      namespace: 'event',
      slug: 'ecocamp-2014',
    });
  });
});

describe('translatePerson', () => {
  it('normalizes a CamelCase username into a valid slug', () => {
    const c = ctx();
    const row: RawPerson = {
      ID: 100,
      Class: 'Emergence\\People\\User',
      Username: 'BobSmith',
      FirstName: 'Bob',
      LastName: 'Smith',
      Created: 1377126953,
    };
    const p = translatePerson(row, c);
    expect(p.slug).toBe('bobsmith');
    expect(p.slackSamlNameId).toBe('bobsmith');
    expect(p.fullName).toBe('Bob Smith');
    expect(p.legacyId).toBe(100);
  });

  it('falls back to `legacy-<id>` when the username has no Latin chars', () => {
    const c = ctx();
    const row: RawPerson = {
      ID: 200,
      Class: 'Emergence\\People\\User',
      Username: '美洽下载',
    };
    const p = translatePerson(row, c);
    expect(p.slug).toBe('legacy-200');
  });

  it('truncates oversized bios with a warning', () => {
    const c = ctx();
    const big = 'a'.repeat(11_000);
    const row: RawPerson = {
      ID: 300,
      Class: 'Emergence\\People\\User',
      Username: 'spammer',
      About: big,
    };
    const p = translatePerson(row, c);
    expect(p.bio).toHaveLength(10_000);
    expect(c.warnings.items.some((w) => w.includes('bio truncated'))).toBe(true);
  });

  it('maps AccountLevel `Administrator` to `administrator`', () => {
    const c = ctx();
    const row: RawPerson = {
      ID: 400,
      Class: 'Emergence\\People\\User',
      Username: 'alice',
      AccountLevel: 'Administrator',
    };
    const p = translatePerson(row, c);
    expect(p.accountLevel).toBe('administrator');
  });
});

describe('translateProject', () => {
  it('lowercases stage values regardless of source casing', () => {
    const c = ctx();
    const row: RawProject = {
      ID: 1,
      Class: 'Laddr\\Project',
      Handle: 'my-project',
      Title: 'My Project',
      Stage: 'Prototyping',
      Created: 1377126953,
    };
    const p = translateProject(row, c);
    expect(p.stage).toBe('prototyping');
  });

  it('coerces a freeform ChatChannel into the regex shape', () => {
    const c = ctx();
    const row: RawProject = {
      ID: 2,
      Class: 'Laddr\\Project',
      Handle: 'p2',
      Title: 'P2',
      ChatChannel: '#General Slack-Channel!',
    };
    const p = translateProject(row, c);
    expect(p.chatChannel).toBe('general-slack-channel');
  });

  it('drops http URLs in usersUrl/developersUrl', () => {
    const c = ctx();
    const row: RawProject = {
      ID: 3,
      Class: 'Laddr\\Project',
      Handle: 'p3',
      Title: 'P3',
      UsersUrl: 'http://insecure.example.com/',
      DevelopersUrl: 'https://github.com/example/p3',
    };
    const p = translateProject(row, c);
    expect(p.usersUrl).toBeUndefined();
    expect(p.developersUrl).toBe('https://github.com/example/p3');
  });
});

describe('translateBlogPost', () => {
  it('maps the canonical happy-path row', () => {
    const c = ctx();
    // Author needs to be resolvable through idMaps.
    c.idMaps.personByLegacy.set(12, '01951a3c-0000-7000-8000-000000000012');
    const row: RawBlogPost = {
      ID: 5,
      Class: 'BlogPost',
      Handle: 'civic-tech-roundup-2026',
      Title: 'Civic Tech Roundup, May 2026',
      Summary: 'A short blurb.',
      AuthorID: 12,
      Published: 1746028800, // 2025-04-30
      Created: 1746028800,
      Modified: 1746028800,
      items: [
        {
          ID: 100,
          Class: 'Emergence\\CMS\\Item\\Markdown',
          Order: 1,
          Data: '# Heading\n\nA blog body.',
        },
      ],
    };
    const bp = translateBlogPost(row, c);
    expect(bp).not.toBeNull();
    expect(bp!.slug).toBe('civic-tech-roundup-2026');
    expect(bp!.title).toBe('Civic Tech Roundup, May 2026');
    expect(bp!.body).toBe('# Heading\n\nA blog body.');
    expect(bp!.summary).toBe('A short blurb.');
    expect(bp!.legacyId).toBe(5);
    expect(bp!.authorId).toBe('01951a3c-0000-7000-8000-000000000012');
    expect(bp!.postedAt).toBe('2025-04-30T16:00:00.000Z');
    // No edit-window gap → editedAt undefined.
    expect(bp!.editedAt).toBeUndefined();
  });

  it('assembles a body from interleaved Markdown / Media / Embed items', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 7,
      Class: 'BlogPost',
      Handle: 'multi-item',
      Title: 'Multi-item Post',
      Published: 1746028800,
      items: [
        {
          ID: 200,
          Class: 'Emergence\\CMS\\Item\\Media',
          Order: 1,
          Data: { MediaID: 3349, Caption: 'A photo' },
        },
        {
          ID: 201,
          Class: 'Emergence\\CMS\\Item\\Markdown',
          Order: 2,
          Data: 'Some intro markdown.',
        },
        {
          ID: 202,
          Class: 'Emergence\\CMS\\Item\\Embed',
          Order: 3,
          Data: '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
        },
      ],
    };
    const bp = translateBlogPost(row, c);
    expect(bp).not.toBeNull();
    expect(bp!.body).toBe(
      [
        '![A photo](https://codeforphilly.org/thumbnail/3349/1920x1920)',
        'Some intro markdown.',
        '<iframe src="https://www.youtube.com/embed/abc"></iframe>',
      ].join('\n\n'),
    );
  });

  it('sorts items by Order before assembling', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 8,
      Class: 'BlogPost',
      Handle: 'unordered',
      Title: 'Unordered',
      Published: 1746028800,
      items: [
        { ID: 300, Class: 'Emergence\\CMS\\Item\\Markdown', Order: 2, Data: 'second' },
        { ID: 301, Class: 'Emergence\\CMS\\Item\\Markdown', Order: 1, Data: 'first' },
      ],
    };
    const bp = translateBlogPost(row, c);
    expect(bp!.body).toBe('first\n\nsecond');
  });

  it('returns an empty body when items is absent', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 9,
      Class: 'BlogPost',
      Handle: 'bodiless',
      Title: 'Bodiless',
      Published: 1746028800,
    };
    const bp = translateBlogPost(row, c);
    expect(bp!.body).toBe('');
  });

  it('warns on unknown Item class but keeps the post', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 10,
      Class: 'BlogPost',
      Handle: 'unknown-item',
      Title: 'Unknown Item',
      Published: 1746028800,
      items: [
        {
          ID: 400,
          Class: 'Emergence\\CMS\\Item\\NewType',
          Order: 1,
          Data: 'whatever',
        },
        {
          ID: 401,
          Class: 'Emergence\\CMS\\Item\\Markdown',
          Order: 2,
          Data: 'still here',
        },
      ],
    };
    const bp = translateBlogPost(row, c);
    expect(bp!.body).toBe('still here');
    expect(c.warnings.items.some((w) => w.includes('item=400'))).toBe(true);
  });

  it('falls back through Title → legacy-<id> when Handle is missing', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 11,
      Class: 'BlogPost',
      Title: 'A Hello Post',
      Published: 1746028800,
    };
    const bp = translateBlogPost(row, c);
    expect(bp).not.toBeNull();
    expect(bp!.slug).toBe('a-hello-post');
  });

  it('warns and posts anonymously when AuthorID does not resolve', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 12,
      Class: 'BlogPost',
      Handle: 'orphan',
      Title: 'Orphan',
      AuthorID: 999,
      Published: 1746028800,
    };
    const bp = translateBlogPost(row, c);
    expect(bp).not.toBeNull();
    expect(bp!.authorId).toBeUndefined();
    expect(c.warnings.items.some((w) => w.includes('legacyId=12'))).toBe(true);
  });

  it('sets editedAt when Modified is >60s after Published', () => {
    const c = ctx();
    const row: RawBlogPost = {
      ID: 17,
      Class: 'BlogPost',
      Handle: 'edited',
      Title: 'Edited',
      Published: 1746028800,
      Modified: 1746028800 + 3600, // +1 hour
    };
    const bp = translateBlogPost(row, c);
    expect(bp!.editedAt).toBe('2025-04-30T17:00:00.000Z');
  });

  it('truncates an over-long summary to 500 chars with an ellipsis', () => {
    const c = ctx();
    const overlong = 'x'.repeat(600);
    const row: RawBlogPost = {
      ID: 23,
      Class: 'BlogPost',
      Handle: 'long-summary',
      Title: 'Long Summary',
      Summary: overlong,
      Published: 1746028800,
    };
    const bp = translateBlogPost(row, c);
    expect(bp!.summary?.length).toBe(498); // 497 + ellipsis (one codepoint)
    expect(bp!.summary?.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end orchestrator (using the in-memory fetch mock)
// ---------------------------------------------------------------------------

async function makeRepo(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'cfp-import-json-'));
  const bareDir = join(root, 'data.git');
  const seedDir = join(root, 'seed');

  // Bare gitdir — what the importer opens via openPublicStore.
  await exec('git', ['init', '--bare', '-b', 'main', bareDir]);
  await exec('git', ['config', 'receive.denyCurrentBranch', 'ignore'], { cwd: bareDir });

  // Transient working-tree clone to stage the initial sheet configs.
  await exec('git', ['init', '-b', 'main', seedDir]);
  const run = (...args: string[]) => exec('git', args, { cwd: seedDir });
  await run('config', 'user.email', 'test@cfp.test');
  await run('config', 'user.name', 'test');
  await run('config', 'commit.gpgsign', 'false');
  // Create an "empty" branch with the full .gitsheets config matrix. The
  // importer opens the gitsheets store at boot, which requires every sheet
  // declared on the validator map (PublicValidators) to have a corresponding
  // .gitsheets/<name>.toml. Mirrors the upstream codeforphilly-data repo.
  await mkdir(join(seedDir, '.gitsheets'), { recursive: true });
  const sheets: Array<[string, string]> = [
    ['people', "root = 'people'\npath = '${{ slug }}'\n"],
    ['projects', "root = 'projects'\npath = '${{ slug }}'\n"],
    ['tags', "root = 'tags'\npath = '${{ namespace }}/${{ slug }}'\n"],
    [
      'project-memberships',
      "root = 'project-memberships'\npath = '${{ projectSlug }}/${{ personSlug }}'\n",
    ],
    [
      'project-updates',
      "root = 'project-updates'\npath = '${{ projectSlug }}/${{ number }}'\n",
    ],
    ['project-buzz', "root = 'project-buzz'\npath = '${{ projectSlug }}/${{ slug }}'\n"],
    [
      'blog-posts',
      "root = 'blog-posts'\npath = '${{ slug }}'\n\n[gitsheet.format]\ntype = 'markdown'\nbody = 'body'\n",
    ],
    [
      'tag-assignments',
      "root = 'tag-assignments'\npath = '${{ taggableType }}/${{ taggableId }}/${{ tagId }}'\n",
    ],
    ['help-wanted-roles', "root = 'help-wanted-roles'\npath = '${{ projectSlug }}/${{ slug }}'\n"],
    [
      'help-wanted-interest',
      "root = 'help-wanted-interest'\npath = '${{ roleId }}/${{ personId }}'\n",
    ],
    ['slug-history', "root = 'slug-history'\npath = '${{ entityType }}/${{ slug }}'\n"],
    ['revocations', "root = 'revocations'\npath = '${{ jti }}'\n"],
  ];
  for (const [name, body] of sheets) {
    await writeFile(join(seedDir, '.gitsheets', `${name}.toml`), `[gitsheet]\n${body}`);
  }
  await run('add', '.gitsheets');
  await run('commit', '-m', 'initial empty branch');
  await run('branch', '-M', 'empty'); // rename initial branch
  await run('remote', 'add', 'origin', bareDir);
  await run('push', 'origin', 'empty');
  await rm(seedDir, { recursive: true, force: true });
  await exec('git', ['symbolic-ref', 'HEAD', 'refs/heads/empty'], { cwd: bareDir });
  return { path: bareDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function mockRoutes(): MockRoutes {
  return {
    responses: new Map([
      [
        '/tags?format=json&limit=200&offset=0',
        [
          envelope(
            [
              { ID: 1, Class: 'Tag', Handle: 'topic.transit', Title: 'Transit', Created: 1377126953 },
              { ID: 2, Class: 'Tag', Handle: 'tech.javascript', Title: 'JavaScript', Created: 1377126953 },
            ],
            2,
            200,
            0,
          ),
        ],
      ],
      [
        '/people?format=json&include=Tags&limit=200&offset=0',
        [
          envelope(
            [
              {
                ID: 10,
                Class: 'Emergence\\People\\User',
                Username: 'alice',
                FirstName: 'Alice',
                LastName: 'Anderson',
                AccountLevel: 'User',
                Created: 1377126953,
                Tags: [{ ID: 2, Class: 'Tag', Handle: 'tech.javascript', Title: 'JavaScript' }],
              },
              {
                ID: 20,
                Class: 'Emergence\\People\\User',
                Username: 'bob',
                FirstName: 'Bob',
                LastName: 'Brown',
                AccountLevel: 'Staff',
                Created: 1377126953,
              },
            ],
            2,
            200,
            0,
          ),
        ],
      ],
      [
        '/projects?format=json&include=Tags%2CMemberships&limit=200&offset=0',
        [
          envelope(
            [
              {
                ID: 100,
                Class: 'Laddr\\Project',
                Handle: 'transit-app',
                Title: 'Transit App',
                MaintainerID: 10,
                Stage: 'Prototyping',
                ChatChannel: 'transit-app',
                DevelopersUrl: 'https://github.com/example/transit',
                Created: 1377126953,
                Modified: 1377126953,
                Tags: [{ ID: 1, Class: 'Tag', Handle: 'topic.transit', Title: 'Transit' }],
                Memberships: [
                  { ID: 999, Class: 'Laddr\\ProjectMember', ProjectID: 100, MemberID: 10, Role: 'Founder', Created: 1377126953 },
                  { ID: 1000, Class: 'Laddr\\ProjectMember', ProjectID: 100, MemberID: 20, Role: null, Created: 1377126953 },
                ],
              },
            ],
            1,
            200,
            0,
          ),
        ],
      ],
      [
        '/project-updates?format=json&limit=200&offset=0',
        [
          envelope(
            [
              { ID: 500, Class: 'Laddr\\ProjectUpdate', ProjectID: 100, CreatorID: 10, Number: 1, Body: 'First update', Created: 1377126953 },
            ],
            1,
            200,
            0,
          ),
        ],
      ],
      [
        '/project-buzz?format=json&limit=200&offset=0',
        [
          envelope(
            [
              {
                ID: 800,
                Class: 'Laddr\\ProjectBuzz',
                ProjectID: 100,
                CreatorID: 10,
                Handle: 'transit-app-on-tv',
                Headline: 'Transit App on TV',
                URL: 'https://news.example.com/transit-app',
                Published: 1377126953,
                Created: 1377126953,
              },
            ],
            1,
            200,
            0,
          ),
        ],
      ],
      [
        // Importer fetches /blog with `?include=*` so it can read the
        // structured body items (laddr doesn't expose Body via the flat
        // JSON fields). `*` is a sub-delim per RFC 3986 and stays
        // unencoded through URLSearchParams.
        '/blog?format=json&include=*&limit=200&offset=0',
        [
          envelope(
            [
              {
                ID: 900,
                Class: 'BlogPost',
                Handle: 'hello-philly',
                Title: 'Hello Philly',
                Summary: 'A short hello.',
                AuthorID: 10,
                Published: 1377126953,
                Created: 1377126953,
                Modified: 1377126953,
                items: [
                  {
                    ID: 1000,
                    Class: 'Emergence\\CMS\\Item\\Markdown',
                    Order: 1,
                    Data: '# Hello\n\nFirst blog post.',
                  },
                ],
              },
            ],
            1,
            200,
            0,
          ),
        ],
      ],
    ]),
  };
}

describe('importLaddrFromJson — orchestrator', () => {
  it('produces counts in dry-run without touching the repo', async () => {
    const { path: repo, cleanup } = await makeRepo();
    try {
      const report = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        dryRun: true,
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(report.counts['tags']!.imported).toBe(2);
      expect(report.counts['people']!.imported).toBe(2);
      expect(report.counts['projects']!.imported).toBe(1);
      expect(report.counts['project-memberships']!.imported).toBe(2);
      expect(report.counts['project-updates']!.imported).toBe(1);
      expect(report.counts['project-buzz']!.imported).toBe(1);
      // 1 (project tag) + 1 (alice's tech.javascript) = 2 tag-assignments
      expect(report.counts['tag-assignments']!.imported).toBe(2);
      expect(report.commitHash).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('writes a commit on legacy-import with the right author/trailers/paths', async () => {
    const { path: repo, cleanup } = await makeRepo();
    try {
      const report = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(report.commitHash).not.toBeNull();

      const log = await exec('git', ['log', '-1', '--format=%an <%ae>%n---%n%B'], { cwd: repo });
      expect(log.stdout).toContain('Code for Philly API <api@users.noreply.codeforphilly.org>');
      expect(log.stdout).toContain('Action: import.laddr.json');
      expect(log.stdout).toContain('Source-Host: example.test');
      expect(log.stdout).toContain('Run-At: 2026-05-18T00:00:00.000Z');

      const tree = await exec('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: repo });
      const paths = tree.stdout.split('\n').filter(Boolean);

      // people/<slug>.toml — gitsheets path templates resolve `${{ slug }}`
      expect(paths).toContain('people/alice.toml');
      expect(paths).toContain('people/bob.toml');
      // projects/<slug>.toml
      expect(paths).toContain('projects/transit-app.toml');
      // tags/<namespace>/<slug>.toml — split from handle `topic.transit`
      expect(paths).toContain('tags/topic/transit.toml');
      expect(paths).toContain('tags/tech/javascript.toml');
      // project-memberships/<projectSlug>/<personSlug>.toml
      expect(paths).toContain('project-memberships/transit-app/alice.toml');
      expect(paths).toContain('project-memberships/transit-app/bob.toml');
      // tag-assignments: `taggableType/taggableId/tagId.toml`, UUID-keyed.
      // Don't pin exact UUIDs — check shape + that both taggable types appear.
      const tagAssignmentPaths = paths.filter((p) => p.startsWith('tag-assignments/'));
      expect(tagAssignmentPaths.length).toBeGreaterThanOrEqual(2);
      expect(tagAssignmentPaths.some((p) => p.startsWith('tag-assignments/project/'))).toBe(true);
      expect(tagAssignmentPaths.some((p) => p.startsWith('tag-assignments/person/'))).toBe(true);
      // project-updates/<projectSlug>/<number>.toml
      expect(paths).toContain('project-updates/transit-app/1.toml');
      // project-buzz/<projectSlug>/<slug>.toml — buzz slug derived from Handle
      expect(paths).toContain('project-buzz/transit-app/transit-app-on-tv.toml');

      // gitsheets writes commits directly to the git object DB without
      // touching the working tree. Read blob contents via `git show HEAD:<path>`.
      const showBlob = async (path: string): Promise<string> =>
        (await exec('git', ['show', `HEAD:${path}`], { cwd: repo })).stdout;

      // Stage lowercased
      const projToml = await showBlob('projects/transit-app.toml');
      expect(projToml).toContain('stage = "prototyping"');
      expect(projToml).toContain('legacyId = 100');
      // chatChannel preserved
      expect(projToml).toContain('chatChannel = "transit-app"');

      // Person.slackSamlNameId == slug
      const aliceToml = await showBlob('people/alice.toml');
      expect(aliceToml).toContain('slackSamlNameId = "alice"');
      expect(aliceToml).toContain('slug = "alice"');

      // No PII (email-shaped patterns / bcrypt hashes) in any committed file
      for (const path of paths.filter((p) => p.endsWith('.toml'))) {
        const content = await showBlob(path);
        expect(content, `email-like in ${path}`).not.toMatch(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
        expect(content, `bcrypt-like in ${path}`).not.toMatch(/\$2[ayb]\$/);
      }
    } finally {
      await cleanup();
    }
  });

  it('is idempotent: re-running on identical mock data makes no new commit', async () => {
    const { path: repo, cleanup } = await makeRepo();
    try {
      const first = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(first.commitHash).not.toBeNull();

      // Second run uses a fresh mockRoutes() because the first one's queue is
      // drained. Keep `now` identical to the first run — `ctx.now` is the
      // fallback for missing Created/Modified, so shifting it would change
      // every record's `updatedAt` and break idempotence. The real-world
      // re-runner uses `new Date().toISOString()` which drifts; for those
      // re-runs the entire snapshot has new `updatedAt` values, which is
      // intentional (it captures the source-data refresh window).
      const second = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(second.noChanges).toBe(true);
      expect(second.commitHash).toBeNull();

      // Only one import commit on top of the seed
      const log = await exec('git', ['log', '--format=%s', 'legacy-import'], { cwd: repo });
      const importLines = log.stdout.split('\n').filter((l) => l.startsWith('import:'));
      expect(importLines).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  it('honors --limit by truncating each per-resource fetch', async () => {
    const { path: repo, cleanup } = await makeRepo();
    try {
      const report = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        dryRun: true,
        limit: 1,
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(report.counts['tags']!.imported).toBe(1);
      expect(report.counts['people']!.imported).toBe(1);
      expect(report.counts['projects']!.imported).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('a modified single record produces a commit whose diff is that one record', async () => {
    const { path: repo, cleanup } = await makeRepo();
    try {
      // First run with baseline data
      const first = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(mockRoutes()),
      });
      expect(first.commitHash).not.toBeNull();

      // Second run with a single tweak: the transit-app project's Title
      // changed. Everything else (including UUIDs, since they're carried
      // forward from the first commit's tree) stays identical.
      const tweaked = mockRoutes();
      // Walk the queue and overwrite the projects response with a Title change.
      const projectsKey = '/projects?format=json&include=Tags%2CMemberships&limit=200&offset=0';
      const projectsResp = tweaked.responses.get(projectsKey)![0] as { data: Array<{ Title: string }> };
      projectsResp.data[0]!.Title = 'Transit App — Renamed';

      const second = await importLaddrFromJson({
        sourceHost: 'example.test',
        dataRepo: repo,
        branch: 'legacy-import',
        initialParent: 'empty',
        now: '2026-05-18T00:00:00.000Z',
        delayMs: 0,
        pageSize: 200,
        fetchImpl: makeFetch(tweaked),
      });
      expect(second.commitHash).not.toBeNull();
      expect(second.noChanges).toBe(false);

      // The diff between the two commits should touch exactly one file:
      // the transit-app project itself (path is slug-keyed). All other
      // records (memberships, tag-assignments, etc.) preserve their UUIDs
      // and content across re-runs.
      const diff = await exec('git', ['diff', '--name-only', `${first.commitHash}..${second.commitHash}`], { cwd: repo });
      const changed = diff.stdout.split('\n').filter(Boolean);
      expect(changed).toEqual(['projects/transit-app.toml']);
    } finally {
      await cleanup();
    }
  });
});
