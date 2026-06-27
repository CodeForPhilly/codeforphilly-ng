---
status: done
depends: []
specs: []
issues:
  - 130
pr:
---

# Plan: import legacy person avatars

## Scope

Leadership feedback (#130): legacy users show initials where their codeforphilly.org
photo used to be. The importer brought blog-post media but never person avatars,
so imported people had `avatarKey: null`.

A spike against the live laddr API found the source: `person.PrimaryPhotoID` →
the image at `GET /media/<id>` (confirmed 200, image/jpeg). Projects have **no**
image field in laddr, so this is person avatars only.

What ships:

- **json-fetcher**: `RawPersonSchema` now parses `PrimaryPhotoID`.
- **importer**: for each person with a `PrimaryPhotoID`, fetch `/media/<id>`,
  run it through the existing `processAvatar` (square original + 128px thumb),
  store both as gitsheets attachments (`avatar.jpg` + `avatar-128.jpg`) and set
  `avatarKey = people/<slug>/avatar.jpg` — exactly the convention the avatar
  upload route uses. Reuses the proven `fetchMediaBytes` + `BlobObject.write` +
  `setAttachments` machinery (same as blog media), concurrency 4.

## Implements

# 130. No spec change — the avatar storage contract (api/people.md, behaviors/
storage.md attachments) already exists; this just populates it at import time.

## Approach

`fetchAndMaterializePersonAvatars(photoIdBySlug, sourceHost, …)` mirrors
`fetchAndMaterializeBlogMedia`: parallel fetch + `processAvatar`, returning
slug → {original, thumbnail}. The transact's people loop wires the attachments
- `avatarKey` for people that have one; failed fetches/decodes are skipped with
a warning (the person still imports). `hologit` hoisted to the transact top
(shared by people + blog attachment writes).

## Validation

- [x] `RawPersonSchema` parses `PrimaryPhotoID`.
- [x] Importer test: a person with `PrimaryPhotoID` gets `people/<slug>/avatar.jpg`
      + `avatar-128.jpg` attachments and `avatarKey` set; a person without one
      gets neither. (import-laddr 37/37.)
- [x] `npm run type-check && npm run lint` clean.

## Risks

- Fetch volume: one image per photo-bearing person. Concurrency-capped at 4 and
  failures are non-fatal, matching blog media. `--limit` bounds it for testing.
- Many photo-bearing accounts are spam — but the spam-prune (#133) removes them
  downstream, so net imported avatars skew to real members.

## Notes

## Follow-ups

- The first photo-bearing accounts sampled in the spike were spam; harmless
  (pruned later), but a reminder that import → prune ordering matters (already
  documented in spam-detection.md / cutover.md).
