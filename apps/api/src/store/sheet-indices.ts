/**
 * Wire `Sheet.defineIndex` for all secondary indices declared in
 * data-model.md. These indices are used by the write layer for fast
 * slug-uniqueness and reverse-lookup checks against the on-disk gitsheets
 * state, separate from the in-memory state maps.
 *
 * The in-memory state in `store/memory/state.ts` is the primary source of
 * truth for read services; these gitsheets-level indices exist so write
 * services can verify uniqueness against the committed gitsheets tree
 * before staging a new write (defense against the in-memory state
 * temporarily diverging from gitsheets).
 */
import type { PublicStore } from './public.js';

export async function wireSheetIndices(publicStore: PublicStore): Promise<void> {
  // people
  publicStore.people.defineIndex('bySlug', (r) => r.slug);
  publicStore.people.defineIndex('byLegacyId', (r) =>
    typeof r.legacyId === 'number' ? String(r.legacyId) : undefined,
  );
  publicStore.people.defineIndex('byGithubUserId', (r) =>
    typeof r.githubUserId === 'number' ? String(r.githubUserId) : undefined,
  );
  publicStore.people.defineIndex('bySlackSamlNameId', (r) =>
    r.slackSamlNameId ? String(r.slackSamlNameId) : undefined,
  );

  // projects
  publicStore.projects.defineIndex('bySlug', (r) => r.slug);
  publicStore.projects.defineIndex('byLegacyId', (r) =>
    typeof r.legacyId === 'number' ? String(r.legacyId) : undefined,
  );
  publicStore.projects.defineIndex('byMaintainerId', (r) =>
    r.maintainerId ? String(r.maintainerId) : undefined,
  );

  // tags — composite (namespace.slug) key
  publicStore.tags.defineIndex('byHandle', (r) => `${String(r.namespace)}.${String(r.slug)}`);

  // tag-assignments
  publicStore['tag-assignments'].defineIndex('byTaggable', (r) =>
    `${String(r.taggableType)}:${String(r.taggableId)}`,
  );
  publicStore['tag-assignments'].defineIndex('byTag', (r) => String(r.tagId));

  // project-memberships
  publicStore['project-memberships'].defineIndex('byProject', (r) => String(r.projectId));
  publicStore['project-memberships'].defineIndex('byPerson', (r) => String(r.personId));
  publicStore['project-memberships'].defineIndex('byProjectAndPerson', (r) =>
    `${String(r.projectId)}:${String(r.personId)}`,
  );

  // project-updates
  publicStore['project-updates'].defineIndex('byProject', (r) => String(r.projectId));
  publicStore['project-updates'].defineIndex('byAuthor', (r) =>
    r.authorId ? String(r.authorId) : undefined,
  );
  publicStore['project-updates'].defineIndex('byProjectAndNumber', (r) =>
    `${String(r.projectId)}:${String(r.number)}`,
  );

  // project-buzz
  publicStore['project-buzz'].defineIndex('byProject', (r) => String(r.projectId));
  publicStore['project-buzz'].defineIndex('byUrl', (r) => String(r.url));
  publicStore['project-buzz'].defineIndex('byProjectAndUrl', (r) =>
    `${String(r.projectId)}:${String(r.url)}`,
  );
  publicStore['project-buzz'].defineIndex('byProjectAndSlug', (r) =>
    `${String(r.projectId)}:${String(r.slug)}`,
  );

  // help-wanted-roles
  publicStore['help-wanted-roles'].defineIndex('byProject', (r) => String(r.projectId));
  publicStore['help-wanted-roles'].defineIndex('byStatus', (r) => String(r.status));

  // help-wanted-interest
  publicStore['help-wanted-interest'].defineIndex('byRole', (r) => String(r.roleId));
  publicStore['help-wanted-interest'].defineIndex('byRoleAndPerson', (r) =>
    `${String(r.roleId)}:${String(r.personId)}`,
  );

  // slug-history — keyed by entity + old slug
  publicStore['slug-history'].defineIndex('byEntityType', (r) => String(r.entityType));
  publicStore['slug-history'].defineIndex('byEntityTypeAndOldSlug', (r) =>
    `${String(r.entityType)}:${String(r.oldSlug)}`,
  );

  // revocations — by jti (path key) and also a sentinel-friendly per-person index
  publicStore.revocations.defineIndex('byPerson', (r) => String(r.personId));
}
