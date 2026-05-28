---
status: in-progress
depends: []
specs:
  - specs/api/people.md
  - specs/behaviors/storage.md
issues: [32]
---

# Plan: POST /api/people/:slug/avatar (multipart + image resize)

## Scope

[`specs/api/people.md`](../specs/api/people.md#post-apipeopleslugavatar) declares the avatar-upload endpoint:

- Multipart upload, single file field `image`
- Max 5 MB
- Allowed types: `image/png`, `image/jpeg`, `image/webp`
- Server crops to a square and stores the original + a 128×128 thumbnail as gitsheets attachments at `people/<slug>/avatar.jpg` and `people/<slug>/avatar-128.jpg`
- `Person.avatarKey` is set to the relative path
- Response: `{ avatarUrl: "/api/attachments/<key>" }`

Today's serializers already construct the `avatarUrl` ([`projects-members.ts:33`](../apps/api/src/routes/projects-members.ts)) and the attachment-serving route ([#94](https://github.com/CodeForPhilly/codeforphilly-ng/pull/94)) is now in place — but uploads have nowhere to go. This plan fills that gap and proves the attachments-serving path end-to-end against a realistic write workload.

Closes [#32](https://github.com/CodeForPhilly/codeforphilly-ng/issues/32).

## Implements

- [api/people.md → POST /api/people/:slug/avatar](../specs/api/people.md)
- [behaviors/storage.md → Attachments](../specs/behaviors/storage.md#attachments)

## Approach

### 1. Deps

Already added in the preceding commit:

- `@fastify/multipart` — streaming multipart parser with built-in size caps
- `sharp` — image decode + crop + encode (ships prebuilt linux-musl binaries; clean fit for our Alpine base image)

### 2. Fastify plugin registration

Register `@fastify/multipart` in `apps/api/src/app.ts` with sandbox-friendly defaults:

```ts
await fastify.register(fastifyMultipart, {
  limits: {
    fileSize: 5 * 1024 * 1024, // 5 MB per spec
    files: 1,                  // single 'image' field
    fields: 0,                 // no other form fields
  },
});
```

The size cap is enforced at parse time — oversized uploads abort streaming and emit a `FST_REQ_FILE_TOO_LARGE` error which Fastify maps to 413.

### 3. Route

`POST /api/people/:slug/avatar` in `apps/api/src/routes/people.ts` (alongside the existing person routes).

```ts
fastify.post('/api/people/:slug/avatar', { /* schema */ }, async (request, reply) => {
  const session = await requireSession(request);
  const target = state.personIdBySlug.get(params.slug);
  // 404 if no target

  const person = state.people.get(target);
  // 403 if not (self || admin) — re-use computePersonPermissions

  const file = await request.file();
  // 422 if no file or wrong field name
  // 422 if mimetype not in allowlist

  const original = await file.toBuffer();
  // (toBuffer respects the configured fileSize limit; oversized = exception → 413)

  const processed = await processAvatar(original, file.mimetype);
  // { original: Buffer (JPEG), thumbnail: Buffer (128x128 JPEG) }

  const { newPerson } = await fastify.store.transact(
    { author: pseudonymousAuthorFor(session) },
    async (tx) => {
      const updated = { ...person, avatarKey: `people/${person.slug}/avatar.jpg`, updatedAt: now() };
      const blobOriginal = await BlobObject.write(repo.hologitRepo, processed.original);
      const blobThumb = await BlobObject.write(repo.hologitRepo, processed.thumbnail);
      await tx.public.people.setAttachments(updated, {
        'avatar.jpg': blobOriginal,
        'avatar-128.jpg': blobThumb,
      });
      await tx.public.people.upsert(updated);
      stateApply.upsertPerson(updated);
      return { newPerson: updated };
    },
  );

  return ok({ avatarUrl: `/api/attachments/${newPerson.avatarKey}` });
});
```

### 4. Image processing — `processAvatar(buffer, mimeType)`

A pure function in `apps/api/src/lib/avatar.ts`:

```ts
async function processAvatar(buffer: Buffer, mimeType: string): Promise<{ original: Buffer; thumbnail: Buffer }> {
  const decoder = sharp(buffer);
  const meta = await decoder.metadata();
  // Sanity: dimensions must be present + sane
  if (!meta.width || !meta.height) throw new ApiValidationError('image is unreadable', { image: 'unreadable' });

  const side = Math.min(meta.width, meta.height);
  const left = Math.floor((meta.width - side) / 2);
  const top = Math.floor((meta.height - side) / 2);

  // Center-crop to a square, then encode as JPEG q85
  // (JPEG for both — preserves the original quality but normalizes the format
  // so the served URL doesn't depend on what the user uploaded.)
  const original = await sharp(buffer)
    .extract({ left, top, width: side, height: side })
    .jpeg({ quality: 85 })
    .toBuffer();

  const thumbnail = await sharp(buffer)
    .extract({ left, top, width: side, height: side })
    .resize(128, 128, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toBuffer();

  return { original, thumbnail };
}
```

JPEG output for both (per the spec's path `avatar.jpg`/`avatar-128.jpg`) — normalizes input PNG/WebP to a single served format. Loses transparency for PNG-with-alpha inputs (filled white via sharp's default flatten), but for avatars that's acceptable.

### 5. Permission check

The endpoint allows the person to update their *own* avatar plus administrators to update anyone's. Reuses `computePersonPermissions` from `apps/api/src/services/permissions.ts`. 403 with `error.code = 'forbidden'` when neither.

### 6. Response envelope

Per the spec:

```json
{ "success": true, "data": { "avatarUrl": "/api/attachments/people/<slug>/avatar.jpg" } }
```

Path-relative URL — the client prepends the site origin. Matches how serializers already construct `avatarUrl` for read responses.

### 7. Tests

`apps/api/tests/avatar-upload.test.ts`:

- Happy path: PNG upload → 200, person.avatarKey set, the two attachments exist in HEAD, GET /api/attachments/people/<slug>/avatar.jpg returns the JPEG bytes
- JPEG upload → 200 (same flow)
- WebP upload → 200
- Unsupported MIME (e.g. `image/svg+xml`) → 422 with `error.code = 'unsupported_image_type'`
- File too large (>5 MB) → 413
- No file → 422
- Wrong field name → 422 (file field must be `image`)
- Unauthenticated → 401
- Authenticated but not self / not admin → 403
- Admin uploading on behalf of someone else → 200
- Image dimensions: non-square input is center-cropped (verify by checking the served image's width === height)
- 128 thumbnail is exactly 128×128

### 8. Spec — no changes

The spec already documents the route precisely; no spec edit needed.

### 9. Operator docs

`docs/operations/deploy.md` env table — no new env (the size limit is a code constant, not an env knob in v1). Worth mentioning in deploy.md that the Docker image needs sharp's musl binaries; verify they're present in the build.

## Validation

- [ ] All 11+ test cases pass.
- [ ] Existing 280 API tests still pass.
- [ ] `npm run type-check && npm run lint` clean.
- [ ] Spec compliance — input limits + output paths + response shape all match `api/people.md`.
- [ ] End-to-end with the attachments route from #94 — upload → fetch via `/api/attachments/<key>` returns the JPEG bytes.

## Risks / unknowns

- **sharp + Alpine base image.** sharp ships prebuilt linux-musl binaries (`@img/sharp-linuxmusl-x64`) which our `node:22-alpine` image picks up at install. If the build fails to install the prebuilt and falls back to compiling from source, the Docker build will be slow but should still succeed. Verify in CI on first run.
- **No virus scanning.** Avatars are user-supplied binaries. v1 doesn't scan — we rely on sharp's input validation (which rejects malformed images) + the size cap. Out of scope; if/when it bites, an antivirus pre-process belongs in a separate plan.
- **Old-avatar cleanup.** Replacing an avatar overwrites the gitsheets attachment at the same path — the old blob remains in git history (correct per spec; commits are the audit log) but the served path always points at the latest. No orphaned-blob sweep needed.
- **BlobObject construction.** Uses `repo.hologitRepo` which gitsheets marks `@internal`. The `BlobObject.write(hologitRepo, buffer)` path is the only way to commit a buffer-as-blob inside a transact handler without disk IO. Acceptable use of the internal surface — if gitsheets ever exposes a Buffer-input setAttachment we'd switch to it.
- **EXIF / orientation.** Phones often upload images with EXIF rotation metadata that sharp respects by default via `.rotate()`. We don't currently call `.rotate()` — adding it would prevent sideways portraits. Worth including in v1; cost is one extra method in the chain.

## Notes

*(filled at done time)*

## Follow-ups

*(filled at done time)*
