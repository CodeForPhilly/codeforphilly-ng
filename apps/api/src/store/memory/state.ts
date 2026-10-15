/**
 * In-memory state: typed Maps keyed by entity ID plus secondary indices.
 *
 * Boot loads all gitsheets records into these maps; mutations update them
 * synchronously after the gitsheets commit so reads are always current.
 *
 * Secondary indices are plain Map<foreignKey, Set<id>> or Map<key, id>.
 * They're rebuilt from scratch at boot and kept in sync by write-api.
 */
import type {
  BlogPost,
  Event,
  EventRsvp,
  EventSeries,
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
  PersonEvaluation,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
  SlugHistory,
  Tag,
  TagAssignment,
} from '@cfp/shared/schemas';

// ---------------------------------------------------------------------------
// Primary maps
// ---------------------------------------------------------------------------

export interface InMemoryState {
  projects: Map<string, Project>;
  people: Map<string, Person>;
  tags: Map<string, Tag>;
  tagAssignments: Map<string, TagAssignment>;
  projectMemberships: Map<string, ProjectMembership>;
  projectUpdates: Map<string, ProjectUpdate>;
  projectBuzz: Map<string, ProjectBuzz>;
  blogPosts: Map<string, BlogPost>;
  helpWantedRoles: Map<string, HelpWantedRole>;
  helpWantedInterest: Map<string, HelpWantedInterestExpression>;
  events: Map<string, Event>;
  eventRsvps: Map<string, EventRsvp>;
  eventSeries: Map<string, EventSeries>;

  // ---------------------------------------------------------------------------
  // Secondary indices
  // ---------------------------------------------------------------------------

  /** project.id → project.slug */
  projectSlugById: Map<string, string>;
  /** project.slug → project.id */
  projectIdBySlug: Map<string, string>;
  /**
   * project.legacyId → project.id. Populated only for records that carry a
   * laddr legacy ID (the importer sets these; runtime-created projects don't).
   * Used by the legacy-redirect plugin to resolve `/projects?ID=<n>` and
   * `/project-updates?ProjectID=<n>` to the canonical slug URL.
   * Per specs/behaviors/legacy-id-mapping.md.
   */
  projectIdByLegacyId: Map<number, string>;

  /** person.id → person.slug */
  personSlugById: Map<string, string>;
  /** person.slug → person.id */
  personIdBySlug: Map<string, string>;

  /** tag.id → tag (namespace.slug handle → tag.id for quick lookup) */
  tagIdByHandle: Map<string, string>;

  /** projectSlug → Set<membershipId> */
  membershipsByProject: Map<string, Set<string>>;
  /** personSlug → Set<membershipId> */
  membershipsByPerson: Map<string, Set<string>>;

  /** projectSlug → Set<updateId> */
  updatesByProject: Map<string, Set<string>>;
  /** projectSlug + number → updateId (see {@link projectChildKey}) */
  updateByProjectAndNumber: Map<string, string>;

  /** projectSlug → Set<buzzId> */
  buzzByProject: Map<string, Set<string>>;
  /** projectSlug + buzzSlug → buzzId (see {@link projectChildKey}) */
  buzzByProjectAndSlug: Map<string, string>;
  /**
   * buzz.slug → buzz.id (global). Buzz slugs are globally unique per
   * `data-model.md#projectbuzz`, so a flat map is the right shape for the
   * legacy `/project-buzz/<slug>` redirect (which carries only the buzz slug
   * with no project hint).
   */
  buzzIdBySlug: Map<string, string>;

  /** blogPost.slug → blogPost.id. Per specs/data-model.md#blogpost. */
  blogPostIdBySlug: Map<string, string>;
  /**
   * blogPost.legacyId → blogPost.id. Populated only for records carrying a
   * laddr legacy ID (the importer sets these). Used for importer idempotence
   * and future legacy `/blog/<numeric-id>` redirects if needed.
   */
  blogPostIdByLegacyId: Map<number, string>;

  /** projectSlug → Set<roleId> */
  helpWantedByProject: Map<string, Set<string>>;

  /** taggableId → Set<tagAssignmentId> */
  tagAssignmentsByTaggable: Map<string, Set<string>>;
  /** tagId → Set<tagAssignmentId> */
  tagAssignmentsByTag: Map<string, Set<string>>;

  /** roleId + personSlug → interestId (see {@link interestKey}) */
  interestByRoleAndPerson: Map<string, string>;
  /** roleId → Set<interestId> */
  interestByRole: Map<string, Set<string>>;

  /**
   * Slug-history index, keyed by `${entityType}:${oldSlug}` → newSlug + expiry.
   * Populated at boot from non-expired SlugHistory records; updated in
   * lockstep with rename writes via StateApply.upsertSlugHistory. The
   * `slug-redirect` plugin reads this on every non-/api/* GET request to
   * decide whether to serve a 301 per specs/behaviors/slug-handles.md.
   */
  slugHistory: Map<string, { newSlug: string; expiresAt: string }>;

  /**
   * Human spam votes from `person-evaluations` on the served branch, keyed
   * `${personSlug}/${evaluator}`. Machine verdicts never reach the runtime
   * (specs/behaviors/spam-exclusion.md → "What the runtime sees").
   */
  personEvaluations: Map<string, PersonEvaluation>;
  /** personSlug → Set<evaluation key> */
  evaluationsByPerson: Map<string, Set<string>>;

  /** event.slug → event.id. Per specs/data-model.md#event. */
  eventIdBySlug: Map<string, string>;
  /** event.legacyId → event.id — backfill idempotence only. */
  eventIdByLegacyId: Map<number, string>;
  /** eventSlug → Set<rsvpId> */
  rsvpsByEvent: Map<string, Set<string>>;
  /** personSlug → Set<rsvpId> — purge cascade. */
  rsvpsByPerson: Map<string, Set<string>>;
  /** eventSlug + personSlug → rsvpId — the "has this person RSVP'd" test. */
  rsvpIdByEventAndPerson: Map<string, string>;
  /** eventSeries.slug → eventSeries.id */
  eventSeriesIdBySlug: Map<string, string>;
  /** seriesId → Set<eventId> — the series page. */
  eventsBySeries: Map<string, Set<string>>;
}

/**
 * Child records whose paths are keyed by a parent's handle are indexed by
 * that handle (specs/data-model.md → References): the slug the record holds,
 * not the parent's id.
 */

/** Compose the event+person RSVP key. Kept here so call sites stay consistent. */
export function rsvpKey(eventSlug: string, personSlug: string): string {
  return `${eventSlug}:${personSlug}`;
}

/** Compose the role+person interest key. */
export function interestKey(roleId: string, personSlug: string): string {
  return `${roleId}:${personSlug}`;
}

/** Compose a project-scoped child key (update number, buzz slug). */
export function projectChildKey(projectSlug: string, child: string | number): string {
  return `${projectSlug}:${child}`;
}

function addToSet<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(id);
}

/** The project a slug reference names, if it is in memory. */
export function projectBySlug(state: InMemoryState, slug: string): Project | undefined {
  const id = state.projectIdBySlug.get(slug);
  return id === undefined ? undefined : state.projects.get(id);
}

/** The person a slug reference names, if they are in memory. */
export function personBySlug(state: InMemoryState, slug: string): Person | undefined {
  const id = state.personIdBySlug.get(slug);
  return id === undefined ? undefined : state.people.get(id);
}

/** The event a slug reference names, if it is in memory. */
export function eventBySlug(state: InMemoryState, slug: string): Event | undefined {
  const id = state.eventIdBySlug.get(slug);
  return id === undefined ? undefined : state.events.get(id);
}

/** Compose the slug-history map key. Kept here so call sites stay consistent. */
export function slugHistoryKey(entityType: SlugHistory['entityType'], oldSlug: string): string {
  return `${entityType}:${oldSlug}`;
}

export function createEmptyState(): InMemoryState {
  return {
    projects: new Map(),
    people: new Map(),
    tags: new Map(),
    tagAssignments: new Map(),
    projectMemberships: new Map(),
    projectUpdates: new Map(),
    projectBuzz: new Map(),
    blogPosts: new Map(),
    helpWantedRoles: new Map(),
    helpWantedInterest: new Map(),
    events: new Map(),
    eventRsvps: new Map(),
    eventSeries: new Map(),

    projectSlugById: new Map(),
    projectIdBySlug: new Map(),
    projectIdByLegacyId: new Map(),
    personSlugById: new Map(),
    personIdBySlug: new Map(),
    tagIdByHandle: new Map(),
    membershipsByProject: new Map(),
    membershipsByPerson: new Map(),
    updatesByProject: new Map(),
    updateByProjectAndNumber: new Map(),
    buzzByProject: new Map(),
    buzzByProjectAndSlug: new Map(),
    buzzIdBySlug: new Map(),
    blogPostIdBySlug: new Map(),
    blogPostIdByLegacyId: new Map(),
    helpWantedByProject: new Map(),
    tagAssignmentsByTaggable: new Map(),
    tagAssignmentsByTag: new Map(),
    interestByRoleAndPerson: new Map(),
    interestByRole: new Map(),
    slugHistory: new Map(),
    personEvaluations: new Map(),
    evaluationsByPerson: new Map(),
    eventIdBySlug: new Map(),
    eventIdByLegacyId: new Map(),
    rsvpsByEvent: new Map(),
    rsvpsByPerson: new Map(),
    rsvpIdByEventAndPerson: new Map(),
    eventSeriesIdBySlug: new Map(),
    eventsBySeries: new Map(),
  };
}

/** Add or replace one event and update its secondary indices. */
export function indexEvent(state: InMemoryState, event: Event): void {
  const old = state.events.get(event.id);
  if (old) {
    state.eventIdBySlug.delete(old.slug);
    if (typeof old.legacyId === 'number') state.eventIdByLegacyId.delete(old.legacyId);
    if (old.seriesId) removeFromSet(state.eventsBySeries, old.seriesId, old.id);
  }
  state.events.set(event.id, event);
  state.eventIdBySlug.set(event.slug, event.id);
  if (typeof event.legacyId === 'number') state.eventIdByLegacyId.set(event.legacyId, event.id);
  if (event.seriesId) {
    let bySeries = state.eventsBySeries.get(event.seriesId);
    if (!bySeries) { bySeries = new Set(); state.eventsBySeries.set(event.seriesId, bySeries); }
    bySeries.add(event.id);
  }
}

/** Add or replace one event series and update its slug index. */
export function indexEventSeries(state: InMemoryState, series: EventSeries): void {
  const old = state.eventSeries.get(series.id);
  if (old) state.eventSeriesIdBySlug.delete(old.slug);
  state.eventSeries.set(series.id, series);
  state.eventSeriesIdBySlug.set(series.slug, series.id);
}

export function unindexEventSeries(state: InMemoryState, series: EventSeries): void {
  state.eventSeries.delete(series.id);
  deleteIfOwned(state.eventSeriesIdBySlug, series.slug, series.id);
}

/** Add or replace one event RSVP and update its secondary indices. */
export function indexEventRsvp(state: InMemoryState, rsvp: EventRsvp): void {
  const old = state.eventRsvps.get(rsvp.id);
  if (old) unindexEventRsvp(state, old);
  state.eventRsvps.set(rsvp.id, rsvp);
  addToSet(state.rsvpsByEvent, rsvp.eventSlug, rsvp.id);
  addToSet(state.rsvpsByPerson, rsvp.personSlug, rsvp.id);
  state.rsvpIdByEventAndPerson.set(rsvpKey(rsvp.eventSlug, rsvp.personSlug), rsvp.id);
}

/**
 * Index a SlugHistory record into the in-memory map. Expired records (where
 * `expiresAt < now`) are dropped — the periodic sweeper that purges them
 * from the gitsheets sheet is a separate concern; this is the read-path
 * defense.
 */
export function indexSlugHistory(state: InMemoryState, record: SlugHistory, now: Date = new Date()): void {
  if (new Date(record.expiresAt) <= now) return;
  state.slugHistory.set(slugHistoryKey(record.entityType, record.oldSlug), {
    newSlug: record.newSlug,
    expiresAt: record.expiresAt,
  });
}

/** Add or replace one project and update its secondary indices. */
export function indexProject(state: InMemoryState, project: Project): void {
  const old = state.projects.get(project.id);
  if (old) {
    state.projectSlugById.delete(old.id);
    state.projectIdBySlug.delete(old.slug);
    if (typeof old.legacyId === 'number') {
      state.projectIdByLegacyId.delete(old.legacyId);
    }
  }
  state.projects.set(project.id, project);
  state.projectSlugById.set(project.id, project.slug);
  state.projectIdBySlug.set(project.slug, project.id);
  if (typeof project.legacyId === 'number') {
    state.projectIdByLegacyId.set(project.legacyId, project.id);
  }
}

/** Add or replace one person and update their secondary indices. */
export function indexPerson(state: InMemoryState, person: Person): void {
  const old = state.people.get(person.id);
  if (old) {
    state.personSlugById.delete(old.id);
    state.personIdBySlug.delete(old.slug);
  }
  state.people.set(person.id, person);
  state.personSlugById.set(person.id, person.slug);
  state.personIdBySlug.set(person.slug, person.id);
}

/** Add or replace one tag and update its handle index. */
export function indexTag(state: InMemoryState, tag: Tag): void {
  const handle = `${tag.namespace}.${tag.slug}`;
  state.tags.set(tag.id, tag);
  state.tagIdByHandle.set(handle, tag.id);
}

/** Add or replace one tag assignment and update secondary indices. */
export function indexTagAssignment(state: InMemoryState, ta: TagAssignment): void {
  state.tagAssignments.set(ta.id, ta);

  let byTaggable = state.tagAssignmentsByTaggable.get(ta.taggableId);
  if (!byTaggable) { byTaggable = new Set(); state.tagAssignmentsByTaggable.set(ta.taggableId, byTaggable); }
  byTaggable.add(ta.id);

  let byTag = state.tagAssignmentsByTag.get(ta.tagId);
  if (!byTag) { byTag = new Set(); state.tagAssignmentsByTag.set(ta.tagId, byTag); }
  byTag.add(ta.id);
}

/** Add or replace a membership and update secondary indices. */
export function indexMembership(state: InMemoryState, m: ProjectMembership): void {
  const old = state.projectMemberships.get(m.id);
  if (old) unindexMembership(state, old);
  state.projectMemberships.set(m.id, m);
  addToSet(state.membershipsByProject, m.projectSlug, m.id);
  addToSet(state.membershipsByPerson, m.personSlug, m.id);
}

/** Add or replace a project update and update secondary indices. */
export function indexProjectUpdate(state: InMemoryState, update: ProjectUpdate): void {
  const old = state.projectUpdates.get(update.id);
  if (old) unindexProjectUpdate(state, old);
  state.projectUpdates.set(update.id, update);
  addToSet(state.updatesByProject, update.projectSlug, update.id);
  state.updateByProjectAndNumber.set(projectChildKey(update.projectSlug, update.number), update.id);
}

/** Add or replace a buzz item and update secondary indices. */
export function indexProjectBuzz(state: InMemoryState, buzz: ProjectBuzz): void {
  const old = state.projectBuzz.get(buzz.id);
  if (old) unindexProjectBuzz(state, old);
  state.projectBuzz.set(buzz.id, buzz);
  addToSet(state.buzzByProject, buzz.projectSlug, buzz.id);
  state.buzzByProjectAndSlug.set(projectChildKey(buzz.projectSlug, buzz.slug), buzz.id);
  state.buzzIdBySlug.set(buzz.slug, buzz.id);
}

/** Add or replace a blog post and update secondary indices. */
export function indexBlogPost(state: InMemoryState, post: BlogPost): void {
  const old = state.blogPosts.get(post.id);
  if (old) {
    state.blogPostIdBySlug.delete(old.slug);
    if (typeof old.legacyId === 'number') {
      state.blogPostIdByLegacyId.delete(old.legacyId);
    }
  }
  state.blogPosts.set(post.id, post);
  state.blogPostIdBySlug.set(post.slug, post.id);
  if (typeof post.legacyId === 'number') {
    state.blogPostIdByLegacyId.set(post.legacyId, post.id);
  }
}

/** Add or replace a help-wanted role and update secondary indices. */
export function indexHelpWantedRole(state: InMemoryState, role: HelpWantedRole): void {
  const old = state.helpWantedRoles.get(role.id);
  if (old) unindexHelpWantedRole(state, old);
  state.helpWantedRoles.set(role.id, role);
  addToSet(state.helpWantedByProject, role.projectSlug, role.id);
}

/** Add or replace a help-wanted interest expression and update secondary indices. */
export function indexHelpWantedInterest(state: InMemoryState, expr: HelpWantedInterestExpression): void {
  const old = state.helpWantedInterest.get(expr.id);
  if (old) unindexHelpWantedInterest(state, old);
  state.helpWantedInterest.set(expr.id, expr);
  addToSet(state.interestByRole, expr.roleId, expr.id);
  state.interestByRoleAndPerson.set(interestKey(expr.roleId, expr.personSlug), expr.id);
}

/** Add or replace one person-evaluation record (one per person + evaluator). */
export function indexPersonEvaluation(state: InMemoryState, record: PersonEvaluation): void {
  const key = `${record.personSlug}/${record.evaluator}`;
  state.personEvaluations.set(key, record);
  let set = state.evaluationsByPerson.get(record.personSlug);
  if (!set) {
    set = new Set();
    state.evaluationsByPerson.set(record.personSlug, set);
  }
  set.add(key);
}

// ---------------------------------------------------------------------------
// Unindexing — the exact inverse of each index* above, so applying a commit
// diff (unindex the old version, index the new one) leaves the state equal to
// a full load of the new tree. Empty secondary Sets are deleted, since a full
// load never creates them. Used by the incremental hot reload.
// ---------------------------------------------------------------------------

function removeFromSet<K>(map: Map<K, Set<string>>, key: K, id: string): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) map.delete(key);
}

/** Delete `key` from `map` only if it still points at `id`. */
function deleteIfOwned<K>(map: Map<K, string>, key: K, id: string): void {
  if (map.get(key) === id) map.delete(key);
}

export function unindexSlugHistory(state: InMemoryState, record: SlugHistory): void {
  const key = slugHistoryKey(record.entityType, record.oldSlug);
  if (state.slugHistory.get(key)?.newSlug === record.newSlug) state.slugHistory.delete(key);
}

export function unindexProject(state: InMemoryState, project: Project): void {
  state.projects.delete(project.id);
  state.projectSlugById.delete(project.id);
  deleteIfOwned(state.projectIdBySlug, project.slug, project.id);
  if (typeof project.legacyId === 'number') {
    deleteIfOwned(state.projectIdByLegacyId, project.legacyId, project.id);
  }
}

export function unindexPerson(state: InMemoryState, person: Person): void {
  state.people.delete(person.id);
  state.personSlugById.delete(person.id);
  deleteIfOwned(state.personIdBySlug, person.slug, person.id);
}

export function unindexTag(state: InMemoryState, tag: Tag): void {
  state.tags.delete(tag.id);
  deleteIfOwned(state.tagIdByHandle, `${tag.namespace}.${tag.slug}`, tag.id);
}

export function unindexTagAssignment(state: InMemoryState, ta: TagAssignment): void {
  state.tagAssignments.delete(ta.id);
  removeFromSet(state.tagAssignmentsByTaggable, ta.taggableId, ta.id);
  removeFromSet(state.tagAssignmentsByTag, ta.tagId, ta.id);
}

export function unindexMembership(state: InMemoryState, m: ProjectMembership): void {
  state.projectMemberships.delete(m.id);
  removeFromSet(state.membershipsByProject, m.projectSlug, m.id);
  removeFromSet(state.membershipsByPerson, m.personSlug, m.id);
}

export function unindexProjectUpdate(state: InMemoryState, update: ProjectUpdate): void {
  state.projectUpdates.delete(update.id);
  removeFromSet(state.updatesByProject, update.projectSlug, update.id);
  deleteIfOwned(state.updateByProjectAndNumber, projectChildKey(update.projectSlug, update.number), update.id);
}

export function unindexProjectBuzz(state: InMemoryState, buzz: ProjectBuzz): void {
  state.projectBuzz.delete(buzz.id);
  removeFromSet(state.buzzByProject, buzz.projectSlug, buzz.id);
  deleteIfOwned(state.buzzByProjectAndSlug, projectChildKey(buzz.projectSlug, buzz.slug), buzz.id);
  deleteIfOwned(state.buzzIdBySlug, buzz.slug, buzz.id);
}

export function unindexBlogPost(state: InMemoryState, post: BlogPost): void {
  state.blogPosts.delete(post.id);
  deleteIfOwned(state.blogPostIdBySlug, post.slug, post.id);
  if (typeof post.legacyId === 'number') {
    deleteIfOwned(state.blogPostIdByLegacyId, post.legacyId, post.id);
  }
}

export function unindexHelpWantedRole(state: InMemoryState, role: HelpWantedRole): void {
  state.helpWantedRoles.delete(role.id);
  removeFromSet(state.helpWantedByProject, role.projectSlug, role.id);
}

export function unindexHelpWantedInterest(
  state: InMemoryState,
  expr: HelpWantedInterestExpression,
): void {
  state.helpWantedInterest.delete(expr.id);
  removeFromSet(state.interestByRole, expr.roleId, expr.id);
  deleteIfOwned(state.interestByRoleAndPerson, interestKey(expr.roleId, expr.personSlug), expr.id);
}

export function unindexEvent(state: InMemoryState, event: Event): void {
  state.events.delete(event.id);
  deleteIfOwned(state.eventIdBySlug, event.slug, event.id);
  if (typeof event.legacyId === 'number') {
    deleteIfOwned(state.eventIdByLegacyId, event.legacyId, event.id);
  }
  if (event.seriesId) removeFromSet(state.eventsBySeries, event.seriesId, event.id);
}

export function unindexEventRsvp(state: InMemoryState, rsvp: EventRsvp): void {
  state.eventRsvps.delete(rsvp.id);
  removeFromSet(state.rsvpsByEvent, rsvp.eventSlug, rsvp.id);
  removeFromSet(state.rsvpsByPerson, rsvp.personSlug, rsvp.id);
  deleteIfOwned(state.rsvpIdByEventAndPerson, rsvpKey(rsvp.eventSlug, rsvp.personSlug), rsvp.id);
}

export function unindexPersonEvaluation(state: InMemoryState, record: PersonEvaluation): void {
  const key = `${record.personSlug}/${record.evaluator}`;
  state.personEvaluations.delete(key);
  removeFromSet(state.evaluationsByPerson, record.personSlug, key);
}
