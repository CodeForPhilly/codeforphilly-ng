/**
 * Tests for the project filter + facet contract per
 * specs/api/projects.md:
 *
 *   - Tag filters: OR within namespace, AND across namespaces.
 *   - Facets reflect the filtered corpus with self-namespace exclusion
 *     so the user can widen within a facet group.
 *   - Active selections are pinned into their namespace's facet list
 *     when they fall below top 10.
 *
 * Drives ProjectService directly against a hand-built InMemoryState so
 * the test stays focused on the filter algebra without TOML/gitsheets
 * round-trips. The HTTP wiring is covered by read-api.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  createEmptyState,
  indexProject,
  indexTag,
  indexTagAssignment,
} from '../src/store/memory/state.js';
import type { InMemoryState } from '../src/store/memory/state.js';
import { ProjectService } from '../src/services/project.js';
import type { FtsEngine } from '../src/store/fts.js';
import type { Project, Tag, TagAssignment } from '@cfp/shared/schemas';

// ---------------------------------------------------------------------------
// Test fixtures — six projects across three topic tags, two tech tags,
// three stages. Lets us cover: single namespace OR, cross-namespace AND,
// stage filter facet exclusion, and a low-popularity tag pin scenario.
// ---------------------------------------------------------------------------

const NOW = '2026-06-01T00:00:00Z';

function makeProject(slug: string, overrides: Partial<Project> = {}): Project {
  return {
    id: `0195000-0000-7000-8000-${slug.padEnd(12, '0').slice(0, 12)}`,
    slug,
    title: slug,
    summary: null,
    overview: null,
    stage: 'prototyping',
    maintainerId: null,
    featured: false,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeTag(namespace: 'topic' | 'tech' | 'event', slug: string): Tag {
  return {
    id: `tag-${namespace}-${slug}`,
    namespace,
    slug,
    title: slug.charAt(0).toUpperCase() + slug.slice(1),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeAssignment(projectId: string, tagId: string): TagAssignment {
  return {
    id: `ta-${projectId}-${tagId}`,
    tagId,
    taggableType: 'project',
    taggableId: projectId,
    createdAt: NOW,
  };
}

const noopFts: FtsEngine = {
  reload: () => {},
  searchProjects: () => [],
  searchBlogPosts: () => [],
};

function setupState(): {
  state: InMemoryState;
  service: ProjectService;
  ids: Record<string, string>;
} {
  const state = createEmptyState();

  // Tags
  const tags = {
    topicTransit: makeTag('topic', 'transit'),
    topicMapping: makeTag('topic', 'mapping'),
    topicEducation: makeTag('topic', 'education'),
    techPython: makeTag('tech', 'python'),
    techFlutter: makeTag('tech', 'flutter'),
  };
  for (const t of Object.values(tags)) indexTag(state, t);

  // Projects + their tag assignments + stages
  //
  //   alpha     stage=testing      tags: topic.transit
  //   bravo     stage=testing      tags: topic.mapping
  //   charlie   stage=prototyping  tags: topic.transit, tech.python
  //   delta     stage=prototyping  tags: topic.mapping, tech.flutter
  //   echo      stage=maintaining  tags: topic.transit, tech.python, tech.flutter
  //   foxtrot   stage=maintaining  tags: topic.education
  //
  const layout: Array<{
    slug: string;
    stage: Project['stage'];
    tagKeys: Array<keyof typeof tags>;
  }> = [
    { slug: 'alpha',   stage: 'testing',      tagKeys: ['topicTransit'] },
    { slug: 'bravo',   stage: 'testing',      tagKeys: ['topicMapping'] },
    { slug: 'charlie', stage: 'prototyping',  tagKeys: ['topicTransit', 'techPython'] },
    { slug: 'delta',   stage: 'prototyping',  tagKeys: ['topicMapping', 'techFlutter'] },
    { slug: 'echo',    stage: 'maintaining',  tagKeys: ['topicTransit', 'techPython', 'techFlutter'] },
    { slug: 'foxtrot', stage: 'maintaining',  tagKeys: ['topicEducation'] },
  ];

  const ids: Record<string, string> = {};
  for (const { slug, stage, tagKeys } of layout) {
    const p = makeProject(slug, { stage });
    ids[slug] = p.id;
    indexProject(state, p);
    for (const tk of tagKeys) {
      indexTagAssignment(state, makeAssignment(p.id, tags[tk].id));
    }
  }

  const service = new ProjectService(state, noopFts);
  return { state, service, ids };
}

function listSlugs(result: { items: Array<{ slug: string }> } | { error: string }): string[] {
  if ('error' in result) throw new Error(`unexpected error: ${result.error}`);
  return result.items.map((p) => p.slug).sort();
}

// ---------------------------------------------------------------------------
// Tag filter semantics
// ---------------------------------------------------------------------------

describe('ProjectService tag filter', () => {
  it('OR within a single namespace — projects matching ANY tag in the namespace', () => {
    const { service } = setupState();
    const result = service.list({ tag: ['topic.transit', 'topic.mapping'] });
    expect(listSlugs(result)).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'echo']);
  });

  it('AND across namespaces — projects must match every namespace at least once', () => {
    const { service } = setupState();
    const result = service.list({ tag: ['topic.transit', 'tech.python'] });
    // alpha = transit only (no tech)        → excluded
    // bravo = mapping only                  → excluded
    // charlie = transit + python            → included
    // delta = mapping + flutter             → excluded (transit absent)
    // echo = transit + python + flutter     → included
    // foxtrot = education only              → excluded
    expect(listSlugs(result)).toEqual(['charlie', 'echo']);
  });

  it('combines OR-within and AND-across — (transit OR mapping) AND (python OR flutter)', () => {
    const { service } = setupState();
    const result = service.list({
      tag: ['topic.transit', 'topic.mapping', 'tech.python', 'tech.flutter'],
    });
    // charlie = transit + python      → included
    // delta = mapping + flutter       → included
    // echo = transit + python+flutter → included
    expect(listSlugs(result)).toEqual(['charlie', 'delta', 'echo']);
  });

  it('unknown tag handles are silently dropped (no false zero-results)', () => {
    const { service } = setupState();
    const result = service.list({ tag: ['topic.transit', 'topic.does-not-exist'] });
    // The known handle still narrows; the unknown one drops out of the
    // tagsByNamespace map entirely (it leaves the namespace empty if it
    // was the only handle, which then means no filter for that ns).
    expect(listSlugs(result)).toEqual(['alpha', 'charlie', 'echo']);
  });
});

// ---------------------------------------------------------------------------
// Facet self-exclusion + pinning
// ---------------------------------------------------------------------------

describe('ProjectService facets', () => {
  it('byTopic excludes the topic tag filter — user can widen topic selection', () => {
    const { service } = setupState();
    const result = service.list({ tag: ['topic.transit'] });
    if ('error' in result) throw new Error('unexpected error');

    // The TOPIC facet should still include mapping + education, with counts
    // narrowed by OTHER filters (none here, so full counts apply):
    //   transit appears on alpha, charlie, echo  → count 3 (the active selection)
    //   mapping appears on bravo, delta          → count 2
    //   education appears on foxtrot             → count 1
    const byTopicMap = new Map(result.facets.byTopic.map((f) => [f.tag, f.count]));
    expect(byTopicMap.get('topic.transit')).toBe(3);
    expect(byTopicMap.get('topic.mapping')).toBe(2);
    expect(byTopicMap.get('topic.education')).toBe(1);
  });

  it('byTech narrows toward the active topic filter (filtered counts, not unfiltered)', () => {
    const { service } = setupState();
    const result = service.list({ tag: ['topic.transit'] });
    if ('error' in result) throw new Error('unexpected error');

    // byTech is computed over projects matching ALL filters except tech
    // tags. With topic=transit:
    //   transit-tagged projects = alpha, charlie, echo
    //   of those: python tagged on charlie + echo → count 2
    //   flutter tagged on echo only             → count 1
    const byTechMap = new Map(result.facets.byTech.map((f) => [f.tag, f.count]));
    expect(byTechMap.get('tech.python')).toBe(2);
    expect(byTechMap.get('tech.flutter')).toBe(1);
  });

  it('byStage excludes the stage filter — user can widen stage selection', () => {
    const { service } = setupState();
    const result = service.list({ stageIn: ['testing'] });
    if ('error' in result) throw new Error('unexpected error');

    // Stage facet ignores the active stage filter — counts should reflect
    // all 3 stages in the corpus.
    const byStageMap = new Map(result.facets.byStage.map((f) => [f.stage, f.count]));
    expect(byStageMap.get('testing')).toBe(2);
    expect(byStageMap.get('prototyping')).toBe(2);
    expect(byStageMap.get('maintaining')).toBe(2);
  });

  it('pins a selected tag with count 0 if no projects match under the rest of the filters', () => {
    const { service } = setupState();
    // education is only on foxtrot. Filter by tech.python (only charlie +
    // echo have it). topic.education's count under that filter is 0.
    // It should still appear in byTopic because it's selected.
    const result = service.list({ tag: ['topic.education', 'tech.python'] });
    if ('error' in result) throw new Error('unexpected error');

    const educationFacet = result.facets.byTopic.find((f) => f.tag === 'topic.education');
    expect(educationFacet).toBeDefined();
    expect(educationFacet!.count).toBe(0);

    // And the listing itself has no matches (AND across namespaces:
    // education AND python is empty).
    expect(result.items).toHaveLength(0);
  });

  it('uses tag (not handle) field in the response shape', () => {
    const { service } = setupState();
    const result = service.list({});
    if ('error' in result) throw new Error('unexpected error');

    for (const f of result.facets.byTopic) {
      expect(typeof f.tag).toBe('string');
      expect(f.tag).toMatch(/^topic\./);
    }
    for (const f of result.facets.byTech) {
      expect(typeof f.tag).toBe('string');
      expect(f.tag).toMatch(/^tech\./);
    }
    for (const f of result.facets.byStage) {
      expect(typeof f.stage).toBe('string');
    }
  });
});
