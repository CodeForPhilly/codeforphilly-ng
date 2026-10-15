---
status: done
depends: [slug-history-config]
specs:
  - specs/behaviors/slug-handles.md
awaits:
  - "https://github.com/JarvusInnovations/gitsheets/issues/302 — rename-on-upsert moves the record's attachment folder, or sheet.move()"
---

# Plan: slug renames keep attachments

## Scope

Renaming a person or project slug runs `people.delete(existing)` and then an
upsert (`services/person.write.ts` ~118, `project.write.ts` ~274). In
gitsheets, delete cascades to the record's attachment folder.

- **Bug:** a renamed person loses their avatar, and `avatarKey` still points
  at `people/<old>/avatar.jpg`. This is masked today only because renames
  500 on the slug-history bug.
- **Workaround:** gitsheets 2.7 can rename on upsert via
  `Symbol.for('gitsheets-path')`, but Zod `.parse` strips the symbol, which
  is why the code deletes and re-upserts. Even 2.7's rename moves only the
  `.toml`, not the attachment folder.

In:

- **Now:** inside the rename transaction, read the old record's attachments
  and re-attach them to the new record before the delete, then rewrite
  `avatarKey`.
- **When upstream ships the move:** replace that with a native rename that
  carries the gitsheets-path symbol across `.parse`.

Out: project child records (memberships, help-wanted roles, buzz, updates)
live under `<projectSlug>/` paths and are re-written on rename. Re-keying
them by `projectId` is an app-side path decision. Track it separately if
it's wanted.

## Implements

- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md): a rename
  changes the handle and nothing else about the entity.

## Approach

Interim fix first, as its own commit, with a test. The upstream swap is a
later commit once the move API ships.

## Validation

- [x] Test: rename a person with an avatar; the avatar is served at the new
      key and `avatarKey` matches
- [x] Test: rename a project; no attachments are orphaned
- [x] (after upstream) no delete-then-upsert left in the rename paths
- [x] `type-check` + `lint` + full api suite green

## Risks / unknowns

- Attachment-copy cost for records with many attachments; avatars are small.

## Notes

- Interim fix landed in PR #201 (`services/slug-rename.ts`): attachments are
  read before the delete and re-attached by blob hash, and `avatarKey` /
  `featuredImageKey` are rewritten. What's left is swapping this for a native
  gitsheets move once one exists (see `awaits`).

- Finished by [`gitsheets-2.9`](gitsheets-2.9.md) (PR #243): gitsheets#302
  shipped native rename-on-upsert that moves attachments, and every rename
  path now uses it via `upsertMoved`. The take/restore interim is removed.

## Follow-ups
