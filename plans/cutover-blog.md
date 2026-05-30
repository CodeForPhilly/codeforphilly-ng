---
status: done
depends: []
specs:
  - specs/api/blog.md
  - specs/screens/blog-index.md
  - specs/screens/blog-detail.md
  - specs/data-model.md
  - specs/deferred.md
  - specs/behaviors/legacy-id-mapping.md
issues: [84]
pr: 101
---

# Plan: cutover blog — content-typed `blog-posts` sheet + minimum-viable viewer

## Scope

Bring laddr's `blog_posts` table back online before cutover so the absence
of historical posts at flip-time doesn't read as a regression. Implements
the [#84](https://github.com/CodeForPhilly/codeforphilly-ng/issues/84)
minimum-viable viewer scope **with the upgrade** to a content-typed
gitsheets sheet (per the broader #45 direction) rather than the
plain-TOML interim scope the original #84 body proposed.

Why content-typed now: gitsheets v1.3.1 supports
`[gitsheet.format] type='markdown' body='body'` directly (verified
in `node_modules/gitsheets/dist/format/markdown.js`). The on-disk
artifact becomes Hugo-style markdown — `+++` TOML frontmatter + body —
which round-trips through `Sheet.upsert`/`queryAll` transparently and
makes blog content reviewable as plain markdown in PRs to the data
repo. The cost over plain-TOML is one extra format-config line and a
slightly larger boot read (markdown is parsed via the same gitsheets
pipeline). Lazy body loading (`withBody: false`) stays deferred to
[#45](https://github.com/CodeForPhilly/codeforphilly-ng/issues/45) —
not worth the API complication until the post count justifies it.

Closes [#84](https://github.com/CodeForPhilly/codeforphilly-ng/issues/84).
Reduces (but does not close) [#45](https://github.com/CodeForPhilly/codeforphilly-ng/issues/45) — the content-typed substrate lands here; lazy-loading + full reader experience remain.

## Implements

- [api/blog.md](../specs/api/blog.md) — new spec file.
- [screens/blog-index.md](../specs/screens/blog-index.md) — new spec file.
- [screens/blog-detail.md](../specs/screens/blog-detail.md) — new spec file.
- [data-model.md](../specs/data-model.md) — adds `BlogPost` entity.
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — `BlogPost.legacyId` joins the list of migrated sheets.
- [deferred.md](../specs/deferred.md) — updates the "Blog as user-facing CMS" entry to point at this plan + #45.

## Approach

### 1. Specs first (write before code)

Four new + edited spec files. They establish the shape of everything
downstream, so the spec PR-review surface is tight:

- `specs/api/blog.md` — `GET /api/blog-posts` (list, paginated,
  optional `tag` filter) + `GET /api/blog-posts/:slug` (detail). Both
  public, no auth. List returns body included (no lazy-load yet) so the
  index can render summaries from the body's first paragraph if no
  `summary` field is set. Mutations (POST/PATCH/DELETE) are explicitly
  out-of-scope — writes happen via PR to the data repo, same as the
  importer's snapshot updates.
- `specs/screens/blog-index.md` — `/blog`, paginated reverse-chrono
  list of `postedAt`-ordered posts. Each card: title (link), author
  avatar+name (link), `postedAt` formatted, summary or first-paragraph
  excerpt. Empty state, filtered-empty state for `?tag=` filter.
- `specs/screens/blog-detail.md` — `/blog/:slug`, full post render
  (title, author byline, `postedAt`+`editedAt`, body rendered via the
  existing server-side markdown pipeline → `bodyHtml`). 404 routing.
- `specs/data-model.md` — `BlogPost` entity inserted alphabetically
  near `ProjectUpdate`; secondary indices (`blogPostIdBySlug`,
  `blogPostIdByLegacyId`).
- `specs/behaviors/legacy-id-mapping.md` — add `blog-posts` to the
  bullet-list of migrated sheets carrying `legacyId`.
- `specs/deferred.md` — update the "Blog (`/blog`) as a user-facing
  CMS" entry: superseded by content-typed sheet, pointer to this plan
  - #45 for the future lazy-loading/reader work.

### 2. Schema

`packages/shared/src/schemas/blog-post.ts`:

```ts
export const BlogPostSchema = z.object({
  id: z.string().uuid(),
  legacyId: z.number().int().optional(),
  slug: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  summary: z.string().max(500).nullable().optional(),
  authorId: z.string().uuid().nullable().optional(),
  postedAt: z.string().datetime({ offset: true }),
  editedAt: z.string().datetime({ offset: true }).nullable().optional(),
  featuredImageKey: z.string().nullable().optional(),
  deletedAt: z.string().datetime({ offset: true }).nullable().optional(),
  body: z.string(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).passthrough();
```

Exported through `packages/shared/src/schemas/index.ts`.

### 3. Data-repo sheet config

`.gitsheets/blog-posts.toml` (on the data repo's `empty` branch, which
propagates into fixture / legacy-import / published):

```toml
[gitsheet]
root = 'blog-posts'
path = '${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
title = 'title'
```

`title = 'title'` opts into title-from-H1 — the body's first ATX `#`
heading is the authoritative title and gets reflected into the
frontmatter on serialize. Matches what content authors already do.

This config ships as a separate PR to `codeforphilly-data`. The
codeforphilly-ng PR doesn't depend on it landing first — the boot
loader can gracefully tolerate the sheet being absent (returns empty
results from `queryAll`), and the importer doesn't run in CI.

### 4. Backend wiring

- **`apps/api/src/store/public.ts`** — register `blog-posts` in the
  `PublicValidators` map (insert next to `project-updates`).
- **`apps/api/src/store/memory/state.ts`** — `blogPosts: Map<id,
  BlogPost>`, `blogPostIdBySlug: Map<slug, id>`,
  `blogPostIdByLegacyId: Map<int, id>` indices, `indexBlogPost(state,
  bp)` helper.
- **`apps/api/src/store/memory/loader.ts`** — add `blog-posts` to the
  `Promise.all` queryAll and iterate via `indexBlogPost`.
- **`apps/api/src/services/blog-post.ts`** — `listBlogPosts({ page,
  perPage, tag? })`, `findBlogPostBySlug(slug)`. Filters out
  `deletedAt != null` and sorts by `postedAt` desc.
- **`apps/api/src/services/serializers/blog-post.ts`** —
  `serializeBlogPost(bp, { state, markdownService })`: resolves
  `authorId` → `PersonAvatar` (null-safe), renders `body` →
  `bodyHtml` via `fastify.markdown.render`, returns the API shape.
- **`apps/api/src/routes/blog-posts.ts`** — two endpoints matching the
  spec.
- **`apps/api/src/app.ts`** — register `blogPostsRoutes` after
  `chatRoutes`.

### 5. Importer translator

`apps/api/scripts/import-laddr/`:

- **`json-fetcher.ts`** — `RawBlogPost` type matching laddr's
  `?format=json` shape (fields: `ID`, `Created`, `Modified`,
  `Published`, `Title`, `Slug`, `Body`, `Summary`, `AuthorID`,
  `Class`).
- **`translators.ts`** — `translateBlogPost(raw, ctx)`: maps fields,
  resolves `AuthorID` via `idMaps.personByLegacy`, mints a fresh
  UUIDv7 (or carries existing on re-run), normalizes timestamps
  (laddr's epoch-seconds → ISO), slugify-with-dedupe falls back when
  slug is missing.
- **`importer.ts`** — fetch + translate + commit in the same pattern
  as `project-updates`. Skips on missing `AuthorID` only when the
  laddr-author had no corresponding `People` row (rare; today's people
  table has them all).

### 6. SPA

- **`apps/web/src/screens/BlogIndex.tsx`** — paginated list at
  `/blog`. Lazy-loaded route. Loads via existing `apiFetch` helper.
- **`apps/web/src/screens/BlogDetail.tsx`** — single-post render at
  `/blog/:slug`. 404 → catch-all NotFound screen.
- **Router**: add the two routes to `apps/web/src/main.tsx`.

### 7. Tests

- **Schema** — `packages/shared/tests/schemas/blog-post.test.ts`:
  required-fields, body-empty-OK, title-too-long rejects.
- **Importer translator** — `apps/api/tests/import-laddr.test.ts`:
  one new case round-tripping a `RawBlogPost` fixture into a
  `BlogPost`, including author-resolution.
- **Routes** — `apps/api/tests/blog-posts.test.ts`: list-empty,
  list-with-records (seeded via `seedRawBlob` with a real
  `+++`-frontmatter markdown file), detail by slug, 404, deletedAt
  filter.
- **SPA** — `apps/web/tests/BlogIndex.test.tsx`,
  `BlogDetail.test.tsx`: render with fixtures, click-through to detail,
  404 path.

## Validation

- [x] All 6 spec files written + reviewed.
- [x] `@cfp/shared` exports `BlogPost` + `BlogPostSchema`.
- [x] Sheet config PR opened against `codeforphilly-data:empty` ([codeforphilly-data#1](https://github.com/CodeForPhilly/codeforphilly-data/pull/1)).
- [x] Backend boot loads `blog-posts` without erroring even when the
      sheet is absent (gracefully empty — `queryAll` returns `[]`).
- [x] `GET /api/blog-posts` returns paginated results matching spec
      envelope (8 route tests pass).
- [x] `GET /api/blog-posts/:slug` returns 200 with `bodyHtml`
      populated + 404 on unknown slug + 404 on soft-deleted.
- [x] `/blog` + `/blog/:slug` render in the SPA (3 BlogIndex tests
      pass; BlogDetail relies on shared MarkdownView).
- [x] Importer translator round-trips a fixture row into a valid
      `BlogPost` (5 new translator cases pass) and the orchestrator
      end-to-end mock includes `/blog`.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **`title = 'title'` body→frontmatter enforcement.** The markdown
  format requires the body's first ATX `# H1` to equal the
  frontmatter's `title`. Laddr posts may have bodies that don't lead
  with an H1, or whose H1 disagrees with the stored title. The
  translator needs to either (a) prepend an H1 to bodies that lack one
  (using `Title`), or (b) skip the `title` config opt-in and store
  title as a normal frontmatter field. Going with (b) — safer for
  legacy content; the auto-extraction is a v2 nicety.
- **Body bytes on every list query.** Without `withBody: false` (the
  lazy-load feature deferred to #45), `GET /api/blog-posts` reads full
  bodies for every record on every request. With laddr having ~few-dozen
  posts, this is fine. If counts ever grow past ~100, revisit.
- **Sheet config arrives before app deploy.** If the data repo gets
  the `blog-posts.toml` first and the running pod is on an older image
  that doesn't know how to validate it, gitsheets will throw at boot.
  Mitigation: ship the schema-aware app image **before** merging the
  data-repo PR. Or: don't include schema validation in the sheet
  config (rely on the app's Zod validator instead). Going with the
  latter — simpler and matches the existing sheet configs.

## Notes

Five commits across two repos (plus the data-repo PR):

  codeforphilly-ng:
    chore(plans): open cutover-blog (in-progress)
    docs(specs): blog-posts entity + /blog screens + /api/blog-posts
    feat(shared): BlogPost Zod schema
    feat(api): GET /api/blog-posts list + detail
    feat(importer): translate + import laddr blog_posts
    feat(web): /blog index + detail screens

  codeforphilly-data:
    feat(gitsheets): add blog-posts content-typed sheet (PR #1)

Surprises:

- **The `title = 'title'` body-from-H1 opt-in was tempting but
  fragile for legacy content.** I sketched it in the plan and then
  backed it out before writing the code: laddr posts can't be assumed
  to start with an `# H1` heading whose text exactly equals the stored
  Title, and the gitsheets markdown format throws hard on mismatch.
  Better to leave title in TOML frontmatter and let H1-extraction
  become a v2 nicety once content authors are operating against the
  sheet directly.
- **TagAssignment.taggableType needed `'blog_post'`.** The blog-index
  spec calls out `?tag=` filtering, but the existing TagAssignment
  enum only knew `'project' | 'person' | 'help_wanted_role'`. Adding
  the value was a one-line schema change; without it the filter
  loop in BlogPostService.list would have been dead code. snake_case
  matches the existing convention (`help_wanted_role`).
- **`reload.ts` is missing some pre-existing indices.** While
  threading `blogPostIdBySlug` + `blogPostIdByLegacyId` through
  `swapInPlace`, I noticed the existing function never copies
  `projectIdByLegacyId`, `buzzIdBySlug`, or `slugHistory`. So
  hot-reload would have left those indices stale on the live state.
  Out of scope here — captured below as a follow-up.
- **Importer pre-pass needs every sheet that mints UUIDs to be in
  `simpleSheets`.** Forgot this on the first pass and the
  "is idempotent" orchestrator test caught it — the second run was
  minting fresh UUIDs for the same blog posts, so every re-run
  produced a phantom commit. One-line fix.
- **No `withBody: false` yet.** The plan explicitly defers lazy body
  loading to #45. At ~few-dozen posts this is fine; the API will
  fetch all bodies on every list request. The boot loader also reads
  them all into memory — fine at this scale but worth re-measuring
  once we're at >100 posts.

## Follow-ups

- **Re-run the laddr importer + merge to `published`** after both PRs
  land. Sequence: (1) merge codeforphilly-ng#101 + redeploy sandbox
  pod, (2) merge codeforphilly-data#1 to `empty` and let it propagate,
  (3) `npm run import-laddr` against the upstream laddr instance to
  populate `legacy-import`, (4) merge `legacy-import` → `published`
  → the hot-reload webhook surfaces the new blog content. *Deferred
  to plan* — sequence runs at sandbox-redeploy time.
- **`reload.ts` missing-indices audit.** `swapInPlace` doesn't
  reassign `projectIdByLegacyId`, `buzzIdBySlug`, or `slugHistory`,
  so hot-reload leaves them stale relative to the rest of the in-
  memory state. Likely a pre-existing bug from when those indices
  were added. *Tracked as* — needs its own small issue + plan.
- **Lazy body loading + reader experience** — `withBody: false` on
  list reads, prev/next nav, related posts. *Tracked as* — [#45](https://github.com/CodeForPhilly/codeforphilly-ng/issues/45).
- **Blog tagging UI** — the API supports `?tag=` filtering and the
  schema allows `TagAssignment.taggableType = 'blog_post'`, but
  there's no UI today to apply tags to blog posts (writes are PR-only).
  *None* — content authors set tags directly in the frontmatter via
  the PR-to-data-repo flow.
- **Featured image upload UI** — `featuredImageKey` is plumbed
  through the schema + serializer, but uploading one requires a CMS
  surface that doesn't exist (blog writes are PR-only). Content
  authors can drop a JPEG into the data repo at
  `blog-posts/<slug>/cover.jpg` and reference the key in the
  frontmatter. *None* — explicit non-goal for the cutover scope.
- **Top-nav Blog link** — added only to the footer. Adding to the
  top navigation is a design decision worth deferring until there's
  a critical mass of posts that justify the visual real estate.
  *None* — footer link satisfies the discoverability requirement
  from the spec.
