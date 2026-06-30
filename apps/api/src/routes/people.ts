/**
 * People routes:
 *   GET    /api/people
 *   GET    /api/people/:slug
 *   PATCH  /api/people/:slug
 *   POST   /api/people/:slug/deactivate
 *   POST   /api/people/:slug/reactivate
 *   POST   /api/people/:slug/purge
 *   POST   /api/people/:slug/account-level (administrator)
 *   PATCH  /api/people/:slug/newsletter (private-only mutation)
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError, ForbiddenError } from '../lib/errors.js';
import { computePersonPermissions, getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import type { UpdatePersonInput } from '../services/person.write.js';
import { AVATAR_ALLOWED_MIME, processAvatar } from '../lib/avatar.js';
import { BlobObject } from 'hologit';
import type { Person } from '@cfp/shared/schemas';
import { PersonSchema } from '@cfp/shared/schemas';
import { StateApply } from '../store/state-apply.js';

export async function peopleRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/people
  fastify.get(
    '/api/people',
    {
      schema: {
        tags: ['people'],
        summary: 'Browse members',
        querystring: {
          type: 'object',
          properties: {
            q: { type: 'string' },
            tag: { type: 'array', items: { type: 'string' } },
            accountLevel: { type: 'string' },
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const opts = {
        q: q['q'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
        accountLevel: q['accountLevel'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.people.list(opts, caller);

      if ('error' in result) {
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid filter parameter');
      }

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 30));

      return {
        ...paginated(result.items, {
          page,
          perPage,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / perPage),
        }),
        metadata: {
          timestamp: new Date().toISOString(),
          page,
          perPage,
          totalItems: result.totalItems,
          totalPages: Math.ceil(result.totalItems / perPage),
          facets: result.facets,
        },
      };
    },
  );

  // GET /api/people/:slug
  fastify.get(
    '/api/people/:slug',
    {
      schema: {
        tags: ['people'],
        summary: 'Fetch a single person profile',
        params: {
          type: 'object',
          properties: {
            slug: { type: 'string' },
          },
          required: ['slug'],
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const caller = getCallerSession(request);

      const person = await fastify.services.people.get(slug, caller);
      if (!person) {
        throw new ApiNotFoundError(`Person '${slug}' not found`);
      }

      return ok(person);
    },
  );

  // PATCH /api/people/:slug
  fastify.patch('/api/people/:slug', {
    schema: {
      tags: ['people'],
      summary: 'Update profile',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: { type: 'object' },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };
    const body = (request.body ?? {}) as UpdatePersonInput;
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.update',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 200,
      }),
      async (tx) => fastify.services.peopleWrite.update(tx, slug, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const caller = getCallerSession(request);
    return ok(await fastify.services.people.get(result.value.person.slug, caller));
  });

  // DELETE /api/people/:slug (admin-only soft-delete — legacy, kept for backward compat)
  fastify.delete('/api/people/:slug', {
    schema: {
      tags: ['people'],
      summary: 'Soft-delete a person (admin only, legacy)',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.soft-delete',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 204,
      }),
      async (tx) => fastify.services.peopleWrite.softDelete(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return reply.code(204).send();
  });

  // POST /api/people/:slug/deactivate (self | staff)
  // Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
  fastify.post('/api/people/:slug/deactivate', {
    schema: {
      tags: ['people'],
      summary: 'Deactivate a person account (self or staff)',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.deactivate',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 200,
      }),
      async (tx) => fastify.services.peopleWrite.deactivate(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const caller = getCallerSession(request);
    return ok(await fastify.services.people.get(result.value.person.slug, caller));
  });

  // POST /api/people/:slug/reactivate (self | staff)
  // Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
  fastify.post('/api/people/:slug/reactivate', {
    schema: {
      tags: ['people'],
      summary: 'Reactivate a deactivated person account (self or staff)',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.reactivate',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 200,
      }),
      async (tx) => fastify.services.peopleWrite.reactivate(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const caller = getCallerSession(request);
    return ok(await fastify.services.people.get(result.value.person.slug, caller));
  });

  // POST /api/people/:slug/purge (administrator only)
  // Spec: specs/behaviors/person-lifecycle.md, specs/api/people.md
  fastify.post('/api/people/:slug/purge', {
    schema: {
      tags: ['people'],
      summary: 'Purge a person and all their content (admin only)',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.purge',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 204,
      }),
      async (tx) => fastify.services.peopleWrite.purge(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return reply.code(204).send();
  });

  // POST /api/people/:slug/account-level (administrator only)
  // Spec: specs/api/people.md → POST /api/people/:slug/account-level
  fastify.post('/api/people/:slug/account-level', {
    schema: {
      tags: ['people'],
      summary: "Change a person's account level (admin only)",
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: {
        type: 'object',
        properties: { level: { type: 'string', enum: ['user', 'staff', 'administrator'] } },
        required: ['level'],
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };
    const { level } = request.body as { level: Person['accountLevel'] };

    // Resolve the current level up-front so the audit trailers capture the
    // before/after. Reads in-memory state, which is current under the write
    // mutex; if the slug is unknown, setAccountLevel below 404s.
    const existingId = fastify.inMemoryState.personIdBySlug.get(slug);
    const previousLevel = existingId
      ? fastify.inMemoryState.people.get(existingId)?.accountLevel
      : undefined;

    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'account-level.change',
        subjectType: 'person',
        subjectSlug: slug,
        responseCode: 200,
        extraTrailers: {
          'Previous-Account-Level': previousLevel ?? 'unknown',
          'New-Account-Level': level,
        },
      }),
      async (tx) => fastify.services.peopleWrite.setAccountLevel(tx, slug, level, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const caller = getCallerSession(request);
    return ok(await fastify.services.people.get(result.value.person.slug, caller));
  });

  // PATCH /api/people/:slug/newsletter (private-store only — no public commit)
  fastify.patch('/api/people/:slug/newsletter', {
    schema: {
      tags: ['people'],
      summary: 'Update newsletter opt-in (private-store only)',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: {
        type: 'object',
        properties: { optedIn: { type: 'boolean' } },
        required: ['optedIn'],
      },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };
    const { optedIn } = request.body as { optedIn: boolean };
    if (typeof optedIn !== 'boolean') {
      throw new ApiValidationError('optedIn must be boolean', { optedIn: 'required' });
    }
    const { profile } = await fastify.services.peopleWrite.updateNewsletter(
      slug,
      optedIn,
      request.session,
    );
    return ok({
      personId: profile.personId,
      newsletter: profile.newsletter ?? null,
    });
  });

  // POST /api/people/:slug/avatar — multipart upload, file field `image`.
  // Spec: specs/api/people.md → POST /api/people/:slug/avatar.
  fastify.post('/api/people/:slug/avatar', {
    schema: {
      tags: ['people'],
      summary: 'Upload an avatar image (multipart, field: image)',
      consumes: ['multipart/form-data'],
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: { avatarUrl: { type: 'string' } },
              required: ['avatarUrl'],
            },
          },
        },
      },
    },
  }, async (request) => {
    const { slug } = request.params as { slug: string };

    const caller = getCallerSession(request);
    if (!caller) {
      throw new ForbiddenError('authentication required');
    }

    const personId = fastify.inMemoryState.personIdBySlug.get(slug);
    if (!personId) {
      throw new ApiNotFoundError(`person not found: ${slug}`);
    }
    const person = fastify.inMemoryState.people.get(personId);
    if (!person) {
      // personIdBySlug exists but the record's missing — state-corruption
      // shape; treat as 404 rather than 500 so the client retries cleanly.
      throw new ApiNotFoundError(`person not found: ${slug}`);
    }

    const perms = computePersonPermissions(caller, person);
    if (!perms.canEdit) {
      throw new ForbiddenError('cannot edit this person');
    }

    // Pull the single multipart file. @fastify/multipart raises
    // FST_REQ_FILE_TOO_LARGE on oversized uploads (mapped to 413 by Fastify's
    // default error handler upstream of our mapError).
    const file = await request.file();
    if (!file) {
      throw new ApiValidationError('file field "image" is required', { image: 'required' });
    }
    if (file.fieldname !== 'image') {
      throw new ApiValidationError(
        `file field name must be "image" (got "${file.fieldname}")`,
        { image: 'wrong_field_name' },
      );
    }
    if (!AVATAR_ALLOWED_MIME.has(file.mimetype)) {
      throw new ApiValidationError(
        `unsupported image type: ${file.mimetype} (allowed: image/png, image/jpeg, image/webp)`,
        { image: 'unsupported_image_type' },
      );
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch (err) {
      // @fastify/multipart raises FST_REQ_FILE_TOO_LARGE when the streamed
      // upload exceeds the configured fileSize limit (5 MB per spec).
      if (err !== null && typeof err === 'object' && 'code' in err && err.code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new ApiValidationError(
          'image too large (max 5 MB)',
          { image: 'too_large' },
        );
      }
      throw err;
    }

    let processed;
    try {
      processed = await processAvatar(buffer);
    } catch {
      throw new ApiValidationError('image could not be decoded', { image: 'unreadable' });
    }

    const newAvatarKey = `people/${person.slug}/avatar.jpg`;
    const stateApply = new StateApply();
    const hologit = fastify.publicRepo.hologitRepo;

    let updatedPerson: Person = person;
    await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'person.avatar.upload',
        subjectType: 'person',
        subjectSlug: slug,
        subjectId: person.id,
        responseCode: 200,
      }),
      async (tx) => {
        // Write the two attachment blobs into the gitsheets transaction
        // tree. BlobObject.write hashes the buffer into the git object DB
        // via `git hash-object -w`; the tx-level setAttachments then wires
        // the blob refs into the post-commit tree at the conventional path.
        //
        // BlobObject.write's TypeScript signature declares `content: string`
        // but the underlying `git-client` `$putBlob` spawns `git hash-object
        // --stdin -w` and pipes `content` to stdin, which accepts both
        // strings and Buffers at runtime. Cast to match the declared shape;
        // hologit's type would tighten upstream eventually.
        const originalBlob = await BlobObject.write(hologit, processed.original as unknown as string);
        const thumbnailBlob = await BlobObject.write(hologit, processed.thumbnail as unknown as string);
        await tx.public.people.setAttachments(person, {
          'avatar.jpg': originalBlob,
          'avatar-128.jpg': thumbnailBlob,
        });

        updatedPerson = PersonSchema.parse({
          ...person,
          avatarKey: newAvatarKey,
          updatedAt: new Date().toISOString(),
        });
        await tx.public.people.upsert(updatedPerson);
        stateApply.upsertPerson(updatedPerson);
      },
    );
    stateApply.apply(fastify.inMemoryState, fastify.fts);

    return ok({ avatarUrl: `/api/attachments/${updatedPerson.avatarKey}` });
  });
}
