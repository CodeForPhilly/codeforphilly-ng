---
status: done
depends: []
specs:
  - specs/behaviors/person-lifecycle.md
  - specs/api/people.md
issues:
  - 129
pr: 144
---

# Plan: person deactivate / reactivate / purge

## Scope

Leadership ask (#129): admins can edit users but can't delete them. Implement
two verbs (per discussion):

- **Deactivate** (soft, self-service): self or staff/admin sets `deletedAt`;
  person hidden from public lists + 404 on detail for non-staff (self + staff
  still see it); references render a "Deactivated user" placeholder. The person
  can still sign in and reactivate. Reactivate clears `deletedAt`.
- **Purge** (admin only): cascading hard delete of the person + their
  memberships, help-wanted-interest, person tag-assignments, and authored
  updates/buzz/blog-posts, in one commit (git-revertable).

## Implements

- [person-lifecycle.md](../specs/behaviors/person-lifecycle.md) — the two verbs,
  authz, placeholder, login-not-blocked.
- [api/people.md](../specs/api/people.md) — endpoints + placeholder response.

## Approach

- **API:** `POST /api/people/:slug/deactivate|reactivate` (self | staff) and
  `POST /api/people/:slug/purge` (administrator), via the write mutex. Authz
  through the existing `requireAuth` markers. Purge cascade mirrors the offline
  spam-prune but deletes authored content.
- **Read/serialize:** `people.get` returns a deactivated person only to staff or
  self (for reactivation); list excludes deactivated for non-staff;
  `serializePersonAvatar` (+ the author/member serializers that use it) emits a
  "Deactivated user" placeholder for deactivated references.
- **Web:** `/account` self deactivate/reactivate; admin Danger Zone on the
  person screen; placeholder rendering in `PersonAvatar`.

## Validation

- [x] deactivate: self ✓, staff ✓, anon → 401, other user → 403; response
      carries `deletedAt`.
- [x] deactivated hidden from list (non-staff), 404 on detail (non-staff),
      visible to staff + self.
- [x] reactivate: self + staff clear `deletedAt`.
- [x] purge: admin → person + authored content + memberships removed; staff
      (non-admin) → 403; anon → 401; cascade verified on a project membership.
- [x] placeholder renders for a deactivated reference.
- [x] `type-check` + `lint` clean; people-lifecycle 14/14; read-api/project/
      blog/help-wanted/people 67/67; web 85/85.

## Risks

- Authz hinges on the session's accountLevel claim (not data) — verified by the
  guard tests.

## Notes

- Drafted by a subagent in an isolated worktree; it hit a context limit before
  committing/validating. Taken over here: the implementation was sound, the only
  defect was the test's `mintCookies` ignoring its `level` argument (so staff/
  admin callers authenticated as plain users → spurious 403s). Fixed that; all
  suites green.

## Follow-ups

- Purge and the offline spam-prune (#133) now both cascade person content; keep
  their semantics aligned if either changes.
