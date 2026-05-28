---
status: in-progress
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/api/people.md
issues: [77]
---

# Plan: GET /api/attachments/:key

## Scope

[`specs/behaviors/storage.md`](../specs/behaviors/storage.md#attachments) specifies that binary blobs (avatars, buzz images, featured-project hero images) live alongside their owning record via gitsheets' attachment plumbing, and are served via a streamed `GET /api/attachments/<key>` route. Serializers already construct these URLs (e.g. [`projects-members.ts:33`](../apps/api/src/routes/projects-members.ts) builds `/api/attachments/${person.avatarKey}` for `avatarUrl`), but the route doesn't exist — every reference 404s.

This is a pre-req for [#32](https://github.com/CodeForPhilly/codeforphilly-ng/issues/32) (avatar upload): even once upload lands, the file can't be read back without this.

Closes [#77](https://github.com/CodeForPhilly/codeforphilly-ng/issues/77).

## Implements

- [behaviors/storage.md#attachments](../specs/behaviors/storage.md#attachments) — "Web serves attachments via a streamed `GET /api/attachments/<key>` route with cache headers."
- [api/people.md](../specs/api/people.md) — `avatarUrl` shape (`/api/attachments/<avatarKey>`).
- [api/projects-buzz.md](../specs/api/projects-buzz.md) — `imageUrl` shape (`/api/attachments/<imageKey>`).

## Approach

### 1. Route

`GET /api/attachments/*` (wildcard segment) in `apps/api/src/routes/attachments.ts`. The wildcard captures the full path-after-prefix as a single string, which is the gitsheets attachment key per spec (e.g. `people/janedoe/avatar.jpg`, `project-buzz/squadquest/inquirer-praises-foo/image.jpg`).

### 2. Implementation — direct git plumbing

Bare-repo invariant ([`storage.md`](../specs/behaviors/storage.md) → "The data clone is bare") means we can't read files off disk; we read blobs from the git object DB. The attachment key IS the path in the HEAD tree, so:

```
git cat-file blob HEAD:<key>
```

streams the bytes. The route spawns this as a child process, pipes stdout into the Fastify reply, and sets headers.

The alternative — going through `sheet.getAttachment(record, name)` — requires parsing the key to identify (sheet, record, attachment-name), looking up the record in memory, then resolving the blob via the cached `dataTree` on the standing Sheet (which is itself a known staleness vector per #47). Plumbing skips both burdens.

### 3. Path validation

Before invoking git, validate the key:

- Must not start with `/` (Fastify wildcard already strips the leading `/`, but defensive).
- Must not contain `..` segments (path traversal).
- Must not contain empty segments (`//`, leading/trailing `/`).
- Must not contain control characters or null bytes.

Invalid → 400. The `git cat-file` invocation itself sanitizes against most exploits because we pass `HEAD:<key>` as a single argument (not a shell string), but defense in depth.

### 4. Content-Type

Infer from the file extension. The set we care about today:

- Images: jpg/jpeg, png, gif, webp, svg
- Documents: pdf
- Fallback: `application/octet-stream`

A small in-file table; if we ever want a larger set, lift the table from gitsheets' own `inferMimeType` (it has ~30 entries; not worth importing for our subset).

### 5. Caching

`Cache-Control: public, max-age=3600` (1 hour). Path-keyed attachments mean an update to (say) `people/janedoe/avatar.jpg` keeps the same URL — we *can't* use immutable + long max-age. Future polish: derive an `ETag` from `git rev-parse HEAD:<key>` (the blob hash) so conditional GETs short-circuit with 304. Skipped for v1 — short max-age is good enough; ETag adds an extra git invocation per request.

### 6. Error shapes

- 404 — `git cat-file` exits non-zero (path not in HEAD tree)
- 400 — path validation fails
- 500 — git invocation errors not matching the 404 case (rare; probably a corrupt repo)

All 4xx/5xx use the standard response envelope from `lib/response.ts` (the route helpers handle that).

### 7. Streaming vs buffering

`git cat-file blob` writes to stdout; the child's stdout is a `Readable`. Fastify accepts a Readable as the response body and streams it. For large attachments (PDF, hi-res images), this avoids buffering into memory. No size limit at the route level — the data repo's own write surface is what gates upload size.

## Validation

- [ ] `GET /api/attachments/people/<slug>/avatar.jpg` against a seeded attachment returns 200 + the bytes + correct Content-Type.
- [ ] `GET /api/attachments/<nonexistent>` returns 404 with the standard envelope.
- [ ] Path traversal attempts (`../etc/passwd`, `people/../../foo`) return 400.
- [ ] Content-Type for image/* extensions matches expectations.
- [ ] Existing 274 API tests still pass.
- [ ] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **Backpressure when the client is slow.** Streaming from `git cat-file` to Fastify means a slow client could block the git process. Fastify handles backpressure on the destination side; we don't need to do anything special.
- **Concurrent attachment serves.** Each request spawns a `git` process. For high concurrency (hundreds of avatars per page load via project lists), this could fork-bomb. Today's traffic is low; if profiling ever shows it, we can pool or batch. Out of scope.
- **No range request support.** A 200 OK with the full body for every request — no `Range:`/206. Fine for small avatars/images; if we ever serve video or very large PDFs, revisit.
- **No ETag in v1.** Path-keyed attachments + 1-hour cache means a user who updates their avatar may see the old one for up to an hour. Acceptable for civic-platform avatars; we can add ETag in a follow-up if it bites.
- **Stale gitsheets Sheet dataTree (#47) does NOT apply here.** We read from `HEAD` via plumbing on every request, not from any cached Sheet handle. So the staleness footgun documented in `behaviors/storage.md` is sidestepped by going direct.

## Notes

*(filled at done time)*

## Follow-ups

*(filled at done time)*
