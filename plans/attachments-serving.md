---
status: done
depends: []
specs:
  - specs/behaviors/storage.md
  - specs/api/people.md
issues: [77]
pr: 94
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

- [x] `GET /api/attachments/people/<slug>/avatar.png` against a seeded attachment returns 200 + the bytes + correct Content-Type.
- [x] `GET /api/attachments/<nonexistent>` returns 404 with the standard envelope.
- [x] URL-based path traversal (`/api/attachments/../etc/passwd`) — Fastify normalizes upstream of the handler, so these never reach our validator and never serve 200 from outside the data repo. Test confirms `statusCode !== 200`.
- [x] Null-byte-in-key (`%00`) returns 422 from the validator.
- [x] Content-Type inferred for jpg/jpeg/png/gif/webp/avif/svg/pdf; unknown extensions get `application/octet-stream`.
- [x] Binary content byte-identical end-to-end (test seeds all 256 byte values; route returns them unchanged).
- [x] All 280 API tests pass (274 pre-existing + 6 new).
- [x] `npm run type-check && npm run lint` clean.

## Risks / unknowns

- **Backpressure when the client is slow.** Streaming from `git cat-file` to Fastify means a slow client could block the git process. Fastify handles backpressure on the destination side; we don't need to do anything special.
- **Concurrent attachment serves.** Each request spawns a `git` process. For high concurrency (hundreds of avatars per page load via project lists), this could fork-bomb. Today's traffic is low; if profiling ever shows it, we can pool or batch. Out of scope.
- **No range request support.** A 200 OK with the full body for every request — no `Range:`/206. Fine for small avatars/images; if we ever serve video or very large PDFs, revisit.
- **No ETag in v1.** Path-keyed attachments + 1-hour cache means a user who updates their avatar may see the old one for up to an hour. Acceptable for civic-platform avatars; we can add ETag in a follow-up if it bites.
- **Stale gitsheets Sheet dataTree (#47) does NOT apply here.** We read from `HEAD` via plumbing on every request, not from any cached Sheet handle. So the staleness footgun documented in `behaviors/storage.md` is sidestepped by going direct.

## Notes

Three commits — plan opening + route + tests/lint-fix.

Surprises:

- **Fastify normalizes URL path segments before routing.** `/api/attachments/../etc/passwd` gets collapsed to `/etc/passwd` upstream of our handler — the validator never sees the `..` from URL-borne traversal attempts. The validator's `..` check is defense in depth, not the primary line. Adjusted the test to assert "doesn't 200 from outside the data repo" rather than "validator returns 422". The validator still catches null bytes, control chars, and leading `/` which Fastify doesn't normalize.
- **Hijacking the reply for streaming.** First pass used `reply.header()` + `reply.raw.write()` to inject the buffered first chunk, but headers set via `reply.header()` are tracked by Fastify and only flushed on `reply.send()` — bypassing send via `.raw.write()` skips header flush, so the response went out with no Content-Type. Fixed by calling `reply.hijack()` first (tells Fastify "I own the response from here"), then `reply.raw.writeHead(200, { ... })` to write headers directly.
- **First-chunk-or-exit race.** `git cat-file` exits non-zero with `fatal:` on stderr when a path is missing. Race-style `Promise` on `firstData` vs `exit` lets us distinguish "exited before any stdout" (translate to 404) from "first chunk arrived" (200 + stream). Zero-byte blobs would currently 404 — edge case not worth designing around for v1 since gitsheets' `setAttachment` rejects zero-byte input.

## Follow-ups

- **ETag + 304 conditional GETs.** Easy win: `git rev-parse HEAD:<key>` gives the blob hash; use it as ETag. With `If-None-Match`, 304 the request instead of streaming the blob. Saves the git-spawn cost on cache hits. *Tracked as*: low-priority polish; the 1-hour max-age already gives most clients fresh-enough responses.
- **Range request support.** No `Range:` handling today — full 200 OK on every request. Fine for small avatars/buzz-images; if we ever serve video or large PDFs, revisit.
- **Process pool for high concurrency.** Each request spawns a `git cat-file` process. If a project-list page renders 30 avatars in parallel, that's 30 fork/execs. Today's traffic doesn't warrant pooling; if flamegraphs show fork overhead, switch to `git cat-file --batch` long-running mode shared via a pool.
- **404 vs 410 for tombstoned records.** Plan originally mentioned 410 for tombstoned record attachments. Distinguishing requires re-querying the record by sheet/slug, which adds a lookup per request. *Deferred* until a concrete user-facing need for the distinction appears.
