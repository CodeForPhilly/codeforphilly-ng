/**
 * Facet cache — computes and caches the tag-group and stage counts for the
 * projects list sidebar. Counts are over the UNFILTERED corpus per spec.
 *
 * Invalidated by write-api after any project or tag-assignment mutation.
 */
import type { InMemoryState } from './state.js';

export interface TagFacet {
  readonly tag: string;
  readonly title: string;
  readonly count: number;
}

export interface StageFacet {
  readonly stage: string;
  readonly count: number;
}

export interface ProjectFacets {
  readonly byTopic: TagFacet[];
  readonly byTech: TagFacet[];
  readonly byEvent: TagFacet[];
  readonly byStage: StageFacet[];
}

export interface PeopleFacets {
  readonly byTopic: TagFacet[];
  readonly byTech: TagFacet[];
}

let cachedProjectFacets: ProjectFacets | null = null;
let cachedPeopleFacets: PeopleFacets | null = null;

export function invalidateFacets(): void {
  cachedProjectFacets = null;
  cachedPeopleFacets = null;
}

export function getProjectFacets(state: InMemoryState): ProjectFacets {
  if (cachedProjectFacets) return cachedProjectFacets;

  const topicCounts = new Map<string, { title: string; count: number }>();
  const techCounts = new Map<string, { title: string; count: number }>();
  const eventCounts = new Map<string, { title: string; count: number }>();
  const stageCounts = new Map<string, number>();

  // Count projects per stage (non-deleted only)
  for (const project of state.projects.values()) {
    if (project.deletedAt) continue;
    stageCounts.set(project.stage, (stageCounts.get(project.stage) ?? 0) + 1);
  }

  // Count tag assignments for projects (non-deleted projects only)
  const nonDeletedProjectIds = new Set(
    [...state.projects.values()].filter((p) => !p.deletedAt).map((p) => p.id),
  );

  for (const ta of state.tagAssignments.values()) {
    if (ta.taggableType !== 'project') continue;
    if (!nonDeletedProjectIds.has(ta.taggableId)) continue;

    const tag = state.tags.get(ta.tagId);
    if (!tag) continue;

    const handle = `${tag.namespace}.${tag.slug}`;
    const target =
      tag.namespace === 'topic' ? topicCounts
      : tag.namespace === 'tech' ? techCounts
      : tag.namespace === 'event' ? eventCounts
      : null;

    if (!target) continue;
    const existing = target.get(handle);
    if (existing) {
      existing.count++;
    } else {
      target.set(handle, { title: tag.title, count: 1 });
    }
  }

  const toSortedFacets = (m: Map<string, { title: string; count: number }>): TagFacet[] =>
    [...m.entries()]
      .map(([tag, { title, count }]) => ({ tag, title, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

  const stageOrder = ['commenting', 'bootstrapping', 'prototyping', 'testing', 'maintaining', 'drifting', 'hibernating'];
  const byStage: StageFacet[] = stageOrder
    .filter((s) => stageCounts.has(s))
    .map((s) => ({ stage: s, count: stageCounts.get(s)! }));

  cachedProjectFacets = {
    byTopic: toSortedFacets(topicCounts),
    byTech: toSortedFacets(techCounts),
    byEvent: toSortedFacets(eventCounts),
    byStage,
  };

  return cachedProjectFacets;
}

export function getPeopleFacets(state: InMemoryState): PeopleFacets {
  if (cachedPeopleFacets) return cachedPeopleFacets;

  const topicCounts = new Map<string, { title: string; count: number }>();
  const techCounts = new Map<string, { title: string; count: number }>();

  const nonDeletedPersonIds = new Set(
    [...state.people.values()].filter((p) => !p.deletedAt).map((p) => p.id),
  );

  for (const ta of state.tagAssignments.values()) {
    if (ta.taggableType !== 'person') continue;
    if (!nonDeletedPersonIds.has(ta.taggableId)) continue;

    const tag = state.tags.get(ta.tagId);
    if (!tag) continue;

    const handle = `${tag.namespace}.${tag.slug}`;
    const target =
      tag.namespace === 'topic' ? topicCounts
      : tag.namespace === 'tech' ? techCounts
      : null;

    if (!target) continue;
    const existing = target.get(handle);
    if (existing) {
      existing.count++;
    } else {
      target.set(handle, { title: tag.title, count: 1 });
    }
  }

  const toSortedFacets = (m: Map<string, { title: string; count: number }>): TagFacet[] =>
    [...m.entries()]
      .map(([tag, { title, count }]) => ({ tag, title, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

  cachedPeopleFacets = {
    byTopic: toSortedFacets(topicCounts),
    byTech: toSortedFacets(techCounts),
  };

  return cachedPeopleFacets;
}
