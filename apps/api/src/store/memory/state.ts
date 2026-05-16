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
  HelpWantedInterestExpression,
  HelpWantedRole,
  Person,
  Project,
  ProjectBuzz,
  ProjectMembership,
  ProjectUpdate,
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
  helpWantedRoles: Map<string, HelpWantedRole>;
  helpWantedInterest: Map<string, HelpWantedInterestExpression>;

  // ---------------------------------------------------------------------------
  // Secondary indices
  // ---------------------------------------------------------------------------

  /** project.id → project.slug */
  projectSlugById: Map<string, string>;
  /** project.slug → project.id */
  projectIdBySlug: Map<string, string>;

  /** person.id → person.slug */
  personSlugById: Map<string, string>;
  /** person.slug → person.id */
  personIdBySlug: Map<string, string>;

  /** tag.id → tag (namespace.slug handle → tag.id for quick lookup) */
  tagIdByHandle: Map<string, string>;

  /** projectId → Set<membershipId> */
  membershipsByProject: Map<string, Set<string>>;
  /** personId → Set<membershipId> */
  membershipsByPerson: Map<string, Set<string>>;

  /** projectId → Set<updateId> */
  updatesByProject: Map<string, Set<string>>;
  /** projectId + number → updateId */
  updateByProjectAndNumber: Map<string, string>;

  /** projectId → Set<buzzId> */
  buzzByProject: Map<string, Set<string>>;
  /** projectId + buzzSlug → buzzId */
  buzzByProjectAndSlug: Map<string, string>;

  /** projectId → Set<roleId> */
  helpWantedByProject: Map<string, Set<string>>;

  /** taggableId → Set<tagAssignmentId> */
  tagAssignmentsByTaggable: Map<string, Set<string>>;
  /** tagId → Set<tagAssignmentId> */
  tagAssignmentsByTag: Map<string, Set<string>>;

  /** roleId + personId → interestId */
  interestByRoleAndPerson: Map<string, string>;
  /** roleId → Set<interestId> */
  interestByRole: Map<string, Set<string>>;
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
    helpWantedRoles: new Map(),
    helpWantedInterest: new Map(),

    projectSlugById: new Map(),
    projectIdBySlug: new Map(),
    personSlugById: new Map(),
    personIdBySlug: new Map(),
    tagIdByHandle: new Map(),
    membershipsByProject: new Map(),
    membershipsByPerson: new Map(),
    updatesByProject: new Map(),
    updateByProjectAndNumber: new Map(),
    buzzByProject: new Map(),
    buzzByProjectAndSlug: new Map(),
    helpWantedByProject: new Map(),
    tagAssignmentsByTaggable: new Map(),
    tagAssignmentsByTag: new Map(),
    interestByRoleAndPerson: new Map(),
    interestByRole: new Map(),
  };
}

/** Add or replace one project and update its secondary indices. */
export function indexProject(state: InMemoryState, project: Project): void {
  const old = state.projects.get(project.id);
  if (old) {
    state.projectSlugById.delete(old.id);
    state.projectIdBySlug.delete(old.slug);
  }
  state.projects.set(project.id, project);
  state.projectSlugById.set(project.id, project.slug);
  state.projectIdBySlug.set(project.slug, project.id);
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
  state.projectMemberships.set(m.id, m);

  let byProject = state.membershipsByProject.get(m.projectId);
  if (!byProject) { byProject = new Set(); state.membershipsByProject.set(m.projectId, byProject); }
  byProject.add(m.id);

  let byPerson = state.membershipsByPerson.get(m.personId);
  if (!byPerson) { byPerson = new Set(); state.membershipsByPerson.set(m.personId, byPerson); }
  byPerson.add(m.id);
}

/** Add or replace a project update and update secondary indices. */
export function indexProjectUpdate(state: InMemoryState, update: ProjectUpdate): void {
  state.projectUpdates.set(update.id, update);

  let byProject = state.updatesByProject.get(update.projectId);
  if (!byProject) { byProject = new Set(); state.updatesByProject.set(update.projectId, byProject); }
  byProject.add(update.id);

  const key = `${update.projectId}:${update.number}`;
  state.updateByProjectAndNumber.set(key, update.id);
}

/** Add or replace a buzz item and update secondary indices. */
export function indexProjectBuzz(state: InMemoryState, buzz: ProjectBuzz): void {
  state.projectBuzz.set(buzz.id, buzz);

  let byProject = state.buzzByProject.get(buzz.projectId);
  if (!byProject) { byProject = new Set(); state.buzzByProject.set(buzz.projectId, byProject); }
  byProject.add(buzz.id);

  const key = `${buzz.projectId}:${buzz.slug}`;
  state.buzzByProjectAndSlug.set(key, buzz.id);
}

/** Add or replace a help-wanted role and update secondary indices. */
export function indexHelpWantedRole(state: InMemoryState, role: HelpWantedRole): void {
  state.helpWantedRoles.set(role.id, role);

  let byProject = state.helpWantedByProject.get(role.projectId);
  if (!byProject) { byProject = new Set(); state.helpWantedByProject.set(role.projectId, byProject); }
  byProject.add(role.id);
}

/** Add or replace a help-wanted interest expression and update secondary indices. */
export function indexHelpWantedInterest(state: InMemoryState, expr: HelpWantedInterestExpression): void {
  state.helpWantedInterest.set(expr.id, expr);

  let byRole = state.interestByRole.get(expr.roleId);
  if (!byRole) { byRole = new Set(); state.interestByRole.set(expr.roleId, byRole); }
  byRole.add(expr.id);

  const key = `${expr.roleId}:${expr.personId}`;
  state.interestByRoleAndPerson.set(key, expr.id);
}
