---
status: in-progress
depends: [slug-references]
specs:
  - specs/behaviors/storage.md
  - specs/behaviors/slug-handles.md
---

# Plan: adopt gitsheets 2.9

## Scope

gitsheets 2.8 and 2.9 shipped the asks this repo filed
(JarvusInnovations/gitsheets #301–#308; 2.9 removed 2.8's `injectedFields`
in favor of the principle that a record carries its own path). This plan
is the bump plus the swaps that need no new design:

- **Bump** to `^2.9.0` (core-napi 0.7.0, `linux-x64-musl` published).
  #304's open-time check (every static template field must be required)
  passes unchanged, because [`slug-references`](slug-references.md) made
  every path field required.
- **#306:** attachments stream with `Content-Length` from `blob.size`
  instead of buffering via `read()`.
- **#302:** renames use gitsheets' native rename-on-upsert (the path
  annotation carried across, attachments moved by gitsheets), replacing
  `services/slug-rename.ts`'s take/restore dance. That covers project,
  person, event and series renames, the reference cascade's moved
  children, and buzz `?regenerateSlug`, which never carried its image.

Out (own plans): #301 `repo.sync()` → [`gitsheets-sync`](gitsheets-sync.md);
#303/#305 script cleanups → [`gitsheets-scripts`](gitsheets-scripts.md)
follow-up; #307 import-merge runbook.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md): attachments
  stream with `Content-Length`.
- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md):
  attachments move with renamed records (unchanged rule, new mechanism).

## Validation

- [x] `gitsheets` resolves to 2.9.x; the musl core-napi is in the lockfile
      and loads in the Alpine image
- [x] Attachments: 200 streams with `Content-Length` and `ETag`; 304 and
      404 unchanged; a > 1 MiB blob streams intact (test)
- [x] No `takeAttachments`/`restoreAttachments` left; rename tests
      (person, project, event, cascade) still show attachments moved;
      buzz regenerateSlug keeps its image (test)
- [x] `type-check` + `lint` + full suite green
- [ ] Sandbox and production boot on the release

## Notes

- 2.9 needed no code changes to pass: every template field became required
  in [`slug-references`](slug-references.md), so #304's open-time check
  holds.
- Renames render the old path with `sheet.pathForRecord(existing)` rather
  than reading the path annotation, because a record re-parsed through
  Zod loses the symbol. Verified identical to the annotation `queryAll()`
  sets, on real data.
- The musl core-napi build is in the lockfile. Loading it in the Alpine
  image is verified when the release image runs on sandbox.

## Follow-ups
