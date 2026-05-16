---
status: planned
depends: [auth-jwt-substrate, read-api]
specs:
  - specs/api/projects.md
  - specs/api/projects-members.md
  - specs/api/projects-updates.md
  - specs/api/projects-buzz.md
  - specs/api/projects-help-wanted.md
  - specs/api/people.md
  - specs/api/tags.md
  - specs/behaviors/project-stages.md
  - specs/behaviors/tags.md
  - specs/behaviors/help-wanted-roles.md
  - specs/behaviors/slug-handles.md
  - specs/behaviors/authorization.md
issues: []
---

# Plan: Write API

## Scope

Every documented `POST` / `PATCH` / `DELETE` endpoint across projects, people, tags, and sub-resources. Mutations route through `store.transact`, which produces gitsheets commits with the documented author + trailer policy and (when needed) PrivateStore PUTs in the same transaction. Authorization enforced per [behaviors/authorization.md](../specs/behaviors/authorization.md).

Out of scope: GitHub-OAuth-triggered mutations (account-claim PATCHes happen in [`account-claim`](account-claim.md)); SAML assertion issuance (its own plan).

## Implements

- All `POST` / `PATCH` / `DELETE` endpoints across:
  - [api/projects.md](../specs/api/projects.md) — create, update, soft-delete, restore, change-maintainer
  - [api/projects-members.md](../specs/api/projects-members.md) — add, update role, remove, join, leave
  - [api/projects-updates.md](../specs/api/projects-updates.md) — create, edit, delete
  - [api/projects-buzz.md](../specs/api/projects-buzz.md) — create, edit, delete
  - [api/projects-help-wanted.md](../specs/api/projects-help-wanted.md) — create, edit, status transitions, express interest
  - [api/people.md](../specs/api/people.md) — `PATCH /api/people/:slug` (self), `POST /api/people/:slug/avatar`, `PATCH /api/people/:slug/newsletter` (private-store touch)
  - [api/tags.md](../specs/api/tags.md) — create, update, merge, delete (all staff)
- [behaviors/project-stages.md](../specs/behaviors/project-stages.md) — stage enum on writes; no transition restrictions in v1
- [behaviors/tags.md](../specs/behaviors/tags.md) — tag creation gated to staff; user-supplied unknown slugs error
- [behaviors/help-wanted-roles.md](../specs/behaviors/help-wanted-roles.md) — status state machine, side effects (membership add on fill, notification dispatch on express-interest)
- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) — slug uniqueness checks, `slug-history` writes on rename
- [behaviors/authorization.md](../specs/behaviors/authorization.md) — per-marker enforcement via `requireAuth(marker)` helper

## Approach

### Service write methods

Each `*Service` from [`read-api`](read-api.md) grows write methods that take a `store.transact` context:

```typescript
class ProjectService {
  async create(tx, input: CreateProjectInput, actor: SessionContext): Promise<Project> {
    // 1. authorize (requireAuth('user'))
    // 2. validate via Zod (the .gitsheets/projects.schema runs again at the gitsheets layer)
    // 3. resolve slug uniqueness via in-memory index
    // 4. tx.public.sheet('projects').upsert(record)
    // 5. tx.public.sheet('project-memberships').upsert(founderMembership)
    // 6. add tags (validates against tag space)
    // 7. return serialized response shape
  }
  async update(tx, slug, input, actor) { ... }
  async softDelete(tx, slug, actor) { ... }
  // etc.
}
```

The route layer:

```typescript
fastify.post('/api/projects', { schema }, async (req, reply) => {
  return req.server.store.transact(
    {
      message: `${req.session.person?.slug ?? 'anon'}: POST /api/projects`,
      author: pseudonymousAuthor(req.session),
      trailers: {
        Action: 'project.create',
        'Actor-Slug': req.session.person?.slug ?? 'anon',
        'Actor-Account-Level': req.session.accountLevel,
        Host: req.hostname,
        'Content-Type': req.headers['content-type'] ?? 'unknown',
        'Response-Code': '201',
      },
    },
    async (tx) => projectService.create(tx, req.body, req.session)
  );
});
```

`pseudonymousAuthor()` produces `{ name: person.fullName, email: '<slug>@users.noreply.codeforphilly.org' }` per [behaviors/storage.md](../specs/behaviors/storage.md). Anonymous → `{ name: 'Anonymous', email: 'anon@users.noreply.codeforphilly.org' }`.

### Authorization

A `requireAuth(marker, ctx?)` helper at `apps/api/src/auth/require.ts`:

```typescript
requireAuth('user', { session: req.session });
requireAuth('maintainer | staff', { session: req.session, project });
requireAuth('self | staff', { session: req.session, slug });
```

Throws typed errors mapped to the envelope per [api/conventions.md](../specs/api/conventions.md#error). Routes call it before doing work; services call it again at the service boundary for defense-in-depth.

### Slug renames

When a `PATCH /api/projects/:slug` includes a new slug:

1. Validate format + uniqueness
2. Inside the same transaction: write the project at the new path, delete the old, write a `SlugHistory` record at `slug-history/project/<oldSlug>.toml`
3. The web layer's redirect handler reads `slug-history` to serve 301s for 90 days

Same logic for person slug changes (rare; staff-only).

### Cascade delete

`DELETE /api/projects/:slug` is a soft-delete (set `deletedAt`). Hard-delete is not exposed via API in v1.

When a hard-delete *does* happen (admin tooling, future plan), the cascade rule from [data-model.md](../specs/data-model.md) applies: within one transaction, write tombstones / delete dependent project-memberships, project-updates, project-buzz, help-wanted-roles, tag-assignments.

### Help-wanted side effects

`POST /api/projects/:slug/help-wanted/:roleId/fill` with `filledBySlug`:

1. Mutate the role record (`status:'filled'`, `filledAt`, `filledById`)
2. If `filledBy` isn't already a member: create a `ProjectMembership` with `role: 'Help-wanted: <title>'`
3. Email the role poster via Resend (the `apps/api/src/notify/` module shaped for `email + slack-DM` fan-out, with slack-DM stubbed)

`POST /api/projects/:slug/help-wanted/:roleId/express-interest`:

1. Rate-cap: check the in-memory `(roleId, personId) → lastInterestAt` map (rebuilt at boot from the `help-wanted-interest` sheet)
2. Upsert the `HelpWantedInterestExpression` record
3. Notify the role poster (email; Slack DM later)

### Newsletter PATCH (touches private store)

`PATCH /api/people/:slug/newsletter` accepts `{ optedIn: boolean }`:

1. `store.transact` with `tx.private` available
2. Read current `PrivateProfile`, update `newsletter.optedIn` + `optedInAt`/`optedOutAt` + generate `unsubscribeToken` on first opt-in
3. PUT the `profiles.jsonl` file
4. No public-side write

This is a private-only mutation — no public commit produced. Documented in [behaviors/private-storage.md](../specs/behaviors/private-storage.md).

## Approach (absorbed deferrals)

### Secondary in-memory indices via `Sheet.defineIndex`

Deferred from [storage-foundation](storage-foundation.md). Wire `Sheet.defineIndex` calls
for all secondary in-memory indices declared in `data-model.md`: `bySlug.person`,
`byLegacyId.person`, `byGithubUserId`, `bySlackSamlNameId`, `membershipsByPerson`,
`membershipsByProject`, `tagsByAssignment`, `assignmentsByTag`, `featuredProjectIds`,
`projectsByStage`, `openHelpWanted`, `updatesByProject`, `updatesByAuthor`,
`buzzByProject`, `buzzByUrl`, `revokedJtis`, etc. These are needed for slug uniqueness
checks and reverse lookups in the write layer.

### Private-store reconciliation script

Deferred from [storage-foundation](storage-foundation.md). Implement
`apps/api/scripts/reconcile-private-store.ts` which walks the public Person records
and ensures each has a matching `profiles.jsonl` entry; flags orphans on both sides.
Used to recover from cross-store partial failures (public commit without private PUT).

### In-memory state invalidation hooks

Deferred from [read-api](read-api.md). Every project / tag-assignment / stage
mutation must call `invalidateFacets()` from `apps/api/src/store/memory/facets.ts`
so the next list response recomputes against the current corpus. Every project
slug change, person slug change, project soft-delete, and project / person /
help-wanted-role mutation that affects the search text must also call the
corresponding `upsertProject` / `removeProject` / `upsertPerson` /
`removePerson` / `upsertHelpWanted` / `removeHelpWanted` on the FTS engine
declared in `apps/api/src/store/fts.ts`. The engine is reachable via
`fastify.services` (decorate the services plugin or pass it explicitly).

### Authenticated `permissions` integration check

Deferred from [read-api](read-api.md). With auth-jwt-substrate populating
`request.session.person`, add a test that hits `GET /api/projects/:slug` as
each of {anonymous, member, maintainer, staff} and asserts the
`permissions.canEdit` / `canDelete` / `canManageMembers` / `canPostUpdate` /
`canLogBuzz` / `canPostHelpWanted` flags match `computeProjectPermissions`.

## Validation

- [ ] `Sheet.defineIndex` calls are wired for all secondary indices in `data-model.md`; lookups verified in tests
- [ ] `apps/api/scripts/reconcile-private-store.ts` exists and correctly flags/fixes orphan private records vs public Person list
- [ ] `POST /api/projects` with valid body creates the project, founder membership, and tags in one commit; commit message + trailers match the documented shape
- [ ] `POST /api/projects` from anonymous → 401
- [ ] `PATCH /api/projects/:slug` enforces maintainer-or-staff
- [ ] `PATCH /api/projects/:slug` with a new slug writes the new record, deletes the old, and adds a `SlugHistory` entry — all in one commit
- [ ] `DELETE /api/projects/:slug` soft-deletes (deletedAt populated); subsequent `GET` returns 404 for non-staff
- [ ] `POST /api/projects/:slug/members` (maintainer) adds; duplicate add returns 409 `already_member`
- [ ] `POST /api/projects/:slug/help-wanted` then `.../fill` sets status, creates membership for `filledBy`, sends notification (verified via Resend mock)
- [ ] `POST .../express-interest` enforces the 30-day rate cap per `(personId, roleId)`
- [ ] `PATCH /api/people/:slug/newsletter` writes only to the private store; verifies via private-store inspector
- [ ] Tag mutations: user-supplied unknown tag slug → 422 with hint; staff-supplied unknown slug auto-creates
- [ ] Cross-cutting: every successful mutation produces exactly one gitsheets commit with the documented commit-message shape (subject + body + trailers) and pseudonymous author
- [ ] Tests cover happy + auth-failure + validation-failure for every endpoint
- [ ] `invalidateFacets()` is called from every project/tag-assignment/stage mutation so the next list response reflects the change
- [ ] FTS engine upsert/remove is called on every project, person, and help-wanted-role mutation that touches its searchable fields (title/summary/overview/fullName/bio/description); verified with an integration test that mutates then queries `?q=`
- [ ] `GET /api/projects/:slug` `permissions` block flips correctly across anonymous / member / maintainer / staff callers (verified with the auth-jwt-substrate session decorator populated)

## Risks / unknowns

- **Authorization rule coverage.** The full matrix from [project-detail.md](../specs/screens/project-detail.md#authorization) needs unit tests across the cross-product of caller-type × action. Use a fixture-driven table.
- **Transaction failure rollback ergonomics.** Storage spec says commit-on-success-only. Verify by deliberately throwing inside a transaction and confirming no commit lands.
- **Notification fan-out blocking the request.** Resend send + Slack DM happen async after the commit; the API returns to the user before fan-out completes. Failures log but don't fail the request.

## Notes
