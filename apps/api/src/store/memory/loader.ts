/**
 * Loads all gitsheets records into the InMemoryState at boot.
 *
 * Reads directly from the store's top-level sheet properties (no transaction
 * needed for reads). Builds all secondary indices.
 */
import type { PublicStore } from '../public.js';
import {
  createEmptyState,
  indexBlogPost,
  indexHelpWantedInterest,
  indexHelpWantedRole,
  indexMembership,
  indexPerson,
  indexProject,
  indexProjectBuzz,
  indexProjectUpdate,
  indexSlugHistory,
  indexTag,
  indexTagAssignment,
  type InMemoryState,
} from './state.js';

export async function loadInMemoryState(publicStore: PublicStore): Promise<InMemoryState> {
  const state = createEmptyState();

  // Read each sheet sequentially, NOT via Promise.all. Running all eleven
  // queryAll() reads concurrently makes every sheet's transient
  // read/decompress/parse buffers peak at the same instant; with the full
  // import that combined spike exceeded a 1.5 GB heap on the runtime nodes and
  // OOM'd the boot — even though the *retained* state is only ~0.5 GB.
  // Sequential reads bound the peak to the single largest sheet. Boot speed is
  // not latency-sensitive, so the serialization is free in practice.
  const projects = await publicStore.projects.queryAll();
  const people = await publicStore.people.queryAll();
  const tags = await publicStore.tags.queryAll();
  const tagAssignments = await publicStore['tag-assignments'].queryAll();
  const memberships = await publicStore['project-memberships'].queryAll();
  const updates = await publicStore['project-updates'].queryAll();
  const buzzes = await publicStore['project-buzz'].queryAll();
  // Blog-posts may be absent on data repos that haven't merged the sheet
  // config PR yet — queryAll returns [] in that case, which is fine.
  const blogPosts = await publicStore['blog-posts'].queryAll();
  const roles = await publicStore['help-wanted-roles'].queryAll();
  const interests = await publicStore['help-wanted-interest'].queryAll();
  const slugHistoryRecords = await publicStore['slug-history'].queryAll();

  for (const p of projects) indexProject(state, p);
  for (const p of people) indexPerson(state, p);
  for (const t of tags) indexTag(state, t);
  for (const ta of tagAssignments) indexTagAssignment(state, ta);
  for (const m of memberships) indexMembership(state, m);
  for (const u of updates) indexProjectUpdate(state, u);
  for (const b of buzzes) indexProjectBuzz(state, b);
  for (const bp of blogPosts) indexBlogPost(state, bp);
  for (const r of roles) indexHelpWantedRole(state, r);
  for (const i of interests) indexHelpWantedInterest(state, i);
  // Slug-history is filtered for expiry inside indexSlugHistory — records
  // past their 90-day window are skipped (the sheet retains them until a
  // separate sweeper purges; this is the read-path defense).
  const bootNow = new Date();
  for (const r of slugHistoryRecords) indexSlugHistory(state, r, bootNow);

  return state;
}
