/**
 * Facet computation for the projects-list + people-list sidebars.
 *
 * **Projects** use `computeProjectFacets` — invoked per request by
 * ProjectService.list. Each facet group's counts are computed over the
 * project set filtered by every criterion *except* the one being
 * widened (self-namespace exclusion). Implements the contract in
 * specs/api/projects.md → "Counts reflect the filtered corpus with
 * self-namespace exclusion."
 *
 * **People** still use the simpler cached unfiltered approach
 * (`getPeopleFacets`). That's a deliberate scope limit — the projects
 * filter UX was the regressed one; the people sidebar can adopt the
 * same pattern when someone notices it matters there.
 */
import type { Project, Tag } from '@cfp/shared/schemas';
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

const STAGE_ORDER = [
  'commenting',
  'bootstrapping',
  'prototyping',
  'testing',
  'maintaining',
  'drifting',
  'hibernating',
];

type FacetNamespace = 'topic' | 'tech' | 'event';

export interface ComputeProjectFacetsInput {
  readonly tags: ReadonlyMap<string, Tag>;
  readonly projectsExcludingStage: readonly Project[];
  readonly projectsExcludingTopic: readonly Project[];
  readonly projectsExcludingTech: readonly Project[];
  readonly projectsExcludingEvent: readonly Project[];
  /** Returns the set of tag IDs assigned to a given project (cached upstream). */
  readonly getProjectTagIds: (projectId: string) => ReadonlySet<string>;
  /**
   * Selected tag filters keyed by namespace. Used to ensure active
   * selections appear in their namespace's facet list even when they'd
   * otherwise fall below the top-10 cut after the self-exclusion count
   * narrows.
   */
  readonly selectedTagsByNamespace: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Compute the project-list facet response per the spec.
 *
 * Each tag-namespace facet (topic/tech/event) is counted over the
 * project set that has every filter applied *except* tag filters in
 * that namespace. The stage facet is counted over the set with every
 * filter applied except `stage`/`stageIn`.
 *
 * Active selections are pinned into their namespace's facet list when
 * they fall below the top-10 cut so the SPA can still render them as
 * still-selected.
 */
export function computeProjectFacets(input: ComputeProjectFacetsInput): ProjectFacets {
  const byTopic = computeTagNamespaceFacet(
    'topic',
    input.projectsExcludingTopic,
    input.tags,
    input.getProjectTagIds,
    input.selectedTagsByNamespace.get('topic') ?? null,
  );
  const byTech = computeTagNamespaceFacet(
    'tech',
    input.projectsExcludingTech,
    input.tags,
    input.getProjectTagIds,
    input.selectedTagsByNamespace.get('tech') ?? null,
  );
  const byEvent = computeTagNamespaceFacet(
    'event',
    input.projectsExcludingEvent,
    input.tags,
    input.getProjectTagIds,
    input.selectedTagsByNamespace.get('event') ?? null,
  );

  const stageCounts = new Map<string, number>();
  for (const p of input.projectsExcludingStage) {
    stageCounts.set(p.stage, (stageCounts.get(p.stage) ?? 0) + 1);
  }
  const byStage: StageFacet[] = STAGE_ORDER.filter((s) => stageCounts.has(s)).map((s) => ({
    stage: s,
    count: stageCounts.get(s)!,
  }));

  return { byTopic, byTech, byEvent, byStage };
}

function computeTagNamespaceFacet(
  namespace: FacetNamespace,
  baseProjects: readonly Project[],
  allTags: ReadonlyMap<string, Tag>,
  getProjectTagIds: (projectId: string) => ReadonlySet<string>,
  selectedTagIds: ReadonlySet<string> | null,
): TagFacet[] {
  // Aggregate counts: tagId → count over baseProjects
  const counts = new Map<string, number>();
  for (const p of baseProjects) {
    const projectTagIds = getProjectTagIds(p.id);
    for (const tagId of projectTagIds) {
      const tag = allTags.get(tagId);
      if (!tag || tag.namespace !== namespace) continue;
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
  }

  // Sort by count desc, then by tag title for stability.
  const sorted = [...counts.entries()]
    .map(([tagId, count]) => {
      const tag = allTags.get(tagId);
      return tag ? { tagId, tag, count } : null;
    })
    .filter((x): x is { tagId: string; tag: Tag; count: number } => x !== null)
    .sort((a, b) => b.count - a.count || a.tag.title.localeCompare(b.tag.title));

  const top = sorted.slice(0, 10);

  // Pin any selected tags that fell below the top-10 cut. Selected tags
  // with count 0 (no project matches them under the current filter set,
  // including OR-widening within the namespace) still get pinned with
  // count 0 so the SPA renders them as selected.
  if (selectedTagIds && selectedTagIds.size > 0) {
    const topIds = new Set(top.map((e) => e.tagId));
    for (const selId of selectedTagIds) {
      if (topIds.has(selId)) continue;
      const tag = allTags.get(selId);
      if (!tag || tag.namespace !== namespace) continue;
      top.push({ tagId: selId, tag, count: counts.get(selId) ?? 0 });
    }
  }

  return top.map(({ tag, count }) => ({
    tag: `${tag.namespace}.${tag.slug}`,
    title: tag.title,
    count,
  }));
}

// ---------------------------------------------------------------------------
// People facets — still simple, still cached, still unfiltered. When the
// people-list filter UX gets the same treatment, replace with the same
// per-request pattern as computeProjectFacets above.
// ---------------------------------------------------------------------------

let cachedPeopleFacets: PeopleFacets | null = null;

export function invalidateFacets(): void {
  cachedPeopleFacets = null;
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
      tag.namespace === 'topic'
        ? topicCounts
        : tag.namespace === 'tech'
          ? techCounts
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
