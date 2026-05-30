---
status: in-progress
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/data-model.md
issues: []
---

# Plan: capture blog post media as gitsheets attachments

## Scope

After PR #107 the importer surfaces blog post bodies, but **media references still point at the legacy laddr server** (`https://codeforphilly.org/thumbnail/<id>/<dim>`). 215 such references across 138 posts. At cutover (laddr decommission) every image breaks.

Fix: capture each referenced media item's bytes at import time, store as a gitsheets attachment scoped to the owning blog post record, rewrite the body's media URLs to point at the local `/api/attachments/:key` route.

This is the durable-record path — original bytes land in the data repo and travel with every clone. Runtime thumbnail resizing (so a 200×200 card doesn't pull a 2 MB original) is **deferred to [#108](https://github.com/CodeForPhilly/codeforphilly-ng/issues/108)**; this plan ships originals only.

## Implements

- [behaviors/storage.md](../specs/behaviors/storage.md) — attachments per record, served via `GET /api/attachments/:key`.
- [data-model.md → BlogPost](../specs/data-model.md#blogpost) — adds an "Attachments" note documenting the convention.

## Approach

### 1. Filename derivation

Better than raw integer media IDs. Format:

```
<caption-slug-or-image>-<MediaID>.<ext>
```

- Caption non-empty: `slugify(caption).slice(0, 80) + '-' + mediaId + '.' + ext`
- Caption empty: `'image-' + mediaId + '.' + ext`
- Extension from response `Content-Type` (e.g., `image/jpeg` → `.jpg`)

Examples:

- `2023-launchpad-kick-off-event-at-city-hall-3349.jpg`
- `image-3127.jpg`

The MediaID suffix is the **stable disambiguator** — re-imports with a changed caption produce a renamed file (git tracks as add+remove, content-hash unchanged so no actual blob duplication).

### 2. Source URL

Fetch from `https://<source-host>/media/<MediaID>/original`, not the thumbnail endpoint. We're capturing the durable record; the SPA + future thumbnail service handle sizing.

### 3. Two item paths in `translateBlogPost`

**`Item\Media`** (182 occurrences):

- Compute filename from caption + mediaId + ext
- Emit `![Caption](/api/attachments/blog-posts/<slug>/<filename>)`
- Add a `MediaAsset` entry to the post's plan

**`Item\Embed`** (44 occurrences):

- Scan `Data` HTML for `https?://codeforphilly\.org/(thumbnail|media)/(\d+)/[^"' )]*`
- For each match: filename is `image-<mediaId>.<ext>` (embeds don't have captions)
- Rewrite the URL inline in the HTML
- Add a `MediaAsset` entry to the plan
- Third-party URLs (YouTube iframes etc.) are left alone

### 4. Pre-fetch + transact

The translator stays sync. After all records translate:

1. Aggregate every `{ slug, filename, sourceUrl }` into a flat list.
2. **Pre-fetch in parallel** (with a configurable concurrency cap — default 4 — and the same politeness delay as JSON page fetches).
3. Inside the existing `store.transact(...)` callback (where blog-posts records are upserted): for each post, call `tx['blog-posts'].setAttachments(record, { '<filename>': blobRef })` then upsert as today.

`BlobObject.write(hologit, bytes)` hashes content into the git object DB — same pattern as the avatar-upload route. Idempotent against content hash (rerunning with the same bytes is a no-op).

### 5. Content-Type → extension

Defensive map:

```ts
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
```

Unknown content-type → warn + skip the asset (markdown link will 404, but the post itself imports). Survey of laddr's media shows JPEGs dominate — production data should be 99% covered.

### 6. Tests

`apps/api/tests/import-laddr.test.ts`:

- Translator returns a plan with the right `{ filename, sourceUrl }` entries for a row with mixed Media + Embed items.
- Caption slugification: long caption + special chars → cleaned slug.
- Empty caption falls back to `image-<id>`.
- Embed HTML URL rewrite: codeforphilly.org URLs become `/api/attachments/...`; third-party URLs are untouched.
- Orchestrator: mock fetch covers the binary `/media/<id>/original` endpoints; after import, attachments exist on the tree under `blog-posts/<slug>/<filename>`.

## Validation

- [ ] Every `Item\Media` reference in the imported `blog-posts/*.md` files resolves to `/api/attachments/blog-posts/<slug>/<filename>`.
- [ ] No `codeforphilly.org/(thumbnail|media)/...` URLs remain in any blog-post body.
- [ ] Attachment bytes land in the data repo (a fresh clone has the assets without network access).
- [ ] Filenames are human-readable when captions are present.
- [ ] `npm run type-check && npm run lint && npm test` clean.
- [ ] Sandbox redeploy → re-import → merge to `published` → SPA renders blog posts with images served from the new pod.

## Risks / unknowns

- **Import duration.** ~215 binary fetches at ~150 ms each (serial) is ~30 sec added; with concurrency=4, ~10 sec. Fine.
- **Repo size growth.** ~215 originals × ~250 KB average ≈ 50 MB. Acceptable for a v1 corpus.
- **Embed HTML correctness.** Rewriting `<img src="...">` inside arbitrary HTML via regex is fragile if the URL appears in a weird context (alt text, data-* attributes). Spot-checked production embeds — all references appear in `src="..."` attributes inside `<img>` tags. Acceptable risk; fragile-by-spec but pragmatic.
- **Hot-reload sees the new attachments.** The runtime store reads attachments by their git path; once the new commit lands on `published` and the webhook fires, the next `/api/attachments/...` request resolves against the new tree. No special index work needed.

## Notes

_(filled at done time)_

## Follow-ups

_(filled at done time)_
