# Person lifecycle: deactivate & purge

A person record has two removal paths with very different intent and reversibility.

| State | Set by | Effect | Reversible |
| ----- | ------ | ------ | ---------- |
| **Active** | default | Normal — visible in lists, detail, and as a reference on content. | — |
| **Deactivated** | self **or** staff/admin | Soft hide. `deletedAt` set. Hidden from public lists + detail; references render a placeholder. The person **can still sign in** and reactivate. | Reactivate (clears `deletedAt`). |
| **Purged** | admin only | Cascading hard delete of the person + their content, in a single commit. | Via git history only (revert the commit). |

## Deactivate (soft, self-service)

The privacy / self-removal path — members should be able to remove themselves; CfP gets these requests often.

- **Who:** a person may deactivate/reactivate their OWN account; staff and administrators may deactivate/reactivate ANY account.
- **Mechanism:** sets `person.deletedAt = now()` (reactivate clears it). The record and relationships stay intact.
- **Visibility while deactivated:** excluded from public list endpoints; `GET /api/people/:slug` returns 404 for non-staff (staff may still fetch it, with `deletedAt` populated). Anywhere a deactivated person is referenced (project member grids, project-update/project-buzz authors, help-wanted "posted by", blog author) the serialized reference is a **"Deactivated user" placeholder** (no slug link, generic avatar) rather than the person — substitute, do not omit, so counts/history stay coherent.
- **Login is NOT blocked** — a deactivated user can still authenticate and reactivate themselves. No session revocation.
- **Surfaces:** self at `/account` ("Deactivate my account" / "Reactivate"); staff/admin via a person "Danger Zone".

## Purge (cascading hard delete, admin only)

The garbage-collection path for spam — the runtime sibling of the offline spam-prune (behaviors/spam-exclusion.md).

- **Who:** administrators only.
- **Mechanism:** one write-mutex transaction that hard-deletes: the `people` record; their `project-membership`; their `help-wanted-interest`; their person `tag-assignment`; AND their authored `project-update`, `project-buzz`, and `blog-post` records (unlike the prune which nulls authorId — purge DELETES the content, it's garbage).
- **Atomic + git-revertable** (one commit).
- **Surface:** person "Danger Zone" (admin only), behind a confirm dialog.

## Authorization summary

| Action | Self | Staff | Admin |
| ------ | ---- | ----- | ----- |
| Deactivate / Reactivate | ✓ (own) | ✓ (any) | ✓ (any) |
| Purge | – | – | ✓ |

## Relationship to other specs

- storage.md — all writes go through the in-process mutex; purge is one transaction.
- spam-exclusion.md — offline prune and on-demand purge share cascade semantics; keep aligned.
- API endpoints + response placeholder shape are specified in api/people.md.
