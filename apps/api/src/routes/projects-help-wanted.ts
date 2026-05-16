/**
 * Help-wanted routes:
 *   GET  /api/projects/:slug/help-wanted
 *   GET  /api/help-wanted (global browse)
 *   POST /api/projects/:slug/help-wanted
 *   PATCH /api/projects/:slug/help-wanted/:roleId
 *   POST /api/projects/:slug/help-wanted/:roleId/express-interest
 *   POST /api/projects/:slug/help-wanted/:roleId/fill
 *   POST /api/projects/:slug/help-wanted/:roleId/close
 *   POST /api/projects/:slug/help-wanted/:roleId/reopen
 */
import type { FastifyInstance } from 'fastify';
import { ok, paginated } from '../lib/response.js';
import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';
import { computeHelpWantedPermissions } from '../services/permissions.js';
import { serializeHelpWantedRole } from '../services/serializers/help-wanted.js';
import type { HelpWantedRole, ProjectMembership } from '@cfp/shared/schemas';

export async function helpWantedRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /api/projects/:slug/help-wanted
  fastify.get(
    '/api/projects/:slug/help-wanted',
    {
      schema: {
        tags: ['help-wanted'],
        summary: "List a project's help-wanted roles",
        params: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'filled', 'closed'] },
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const q = request.query as Record<string, unknown>;
      const caller = getCallerSession(request);

      const opts = {
        status: q['status'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.helpWanted.listForProject(slug, opts, caller);

      if ('error' in result) {
        if (result.error === 'not_found') throw new ApiNotFoundError(`Project '${slug}' not found`);
        if (result.error === 'invalid_sort') {
          throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        }
        throw new ApiValidationError('Invalid filter parameter');
      }

      const page = Math.max(1, opts.page ?? 1);
      const perPage = Math.min(100, Math.max(1, opts.perPage ?? 20));

      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // GET /api/help-wanted (global browse)
  fastify.get(
    '/api/help-wanted',
    {
      schema: {
        tags: ['help-wanted'],
        summary: 'Cross-project browse of help-wanted roles',
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'filled', 'closed'] },
            tag: { type: 'array', items: { type: 'string' } },
            commitmentMax: { type: 'integer', minimum: 0 },
            q: { type: 'string' },
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
        status: q['status'] as string | undefined,
        tag: q['tag'] as string[] | undefined,
        commitmentMax: q['commitmentMax'] as number | undefined,
        q: q['q'] as string | undefined,
        sort: q['sort'] as string | undefined,
        page: q['page'] as number | undefined,
        perPage: q['perPage'] as number | undefined,
      };

      const result = fastify.services.helpWanted.globalBrowse(opts, caller);

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

  function serializeRoleResponse(role: HelpWantedRole, request: Parameters<typeof getCallerSession>[0]) {
    const project = fastify.inMemoryState.projects.get(role.projectId)!;
    const memberships = [...(fastify.inMemoryState.membershipsByProject.get(role.projectId) ?? [])]
      .map((id) => fastify.inMemoryState.projectMemberships.get(id))
      .filter((m): m is ProjectMembership => m !== undefined);
    const postedBy = fastify.inMemoryState.people.get(role.postedById) ?? null;
    const filledBy = role.filledById
      ? (fastify.inMemoryState.people.get(role.filledById) ?? null)
      : null;
    const tagAssignments = [...(fastify.inMemoryState.tagAssignmentsByTaggable.get(role.id) ?? [])]
      .map((id) => fastify.inMemoryState.tagAssignments.get(id))
      .filter((ta): ta is NonNullable<typeof ta> => ta !== undefined);
    const caller = getCallerSession(request);
    const interestCount = fastify.inMemoryState.interestByRole.get(role.id)?.size ?? 0;
    const alreadyExpressed = caller
      ? fastify.inMemoryState.interestByRoleAndPerson.has(`${role.id}:${caller.id}`)
      : false;
    const permissions = computeHelpWantedPermissions(
      caller,
      role,
      project,
      memberships,
      alreadyExpressed,
    );
    return serializeHelpWantedRole(role, {
      project,
      postedBy,
      filledBy,
      tagAssignments,
      allTags: fastify.inMemoryState.tags,
      interestCount,
      permissions,
    });
  }

  // POST /api/projects/:slug/help-wanted
  fastify.post('/api/projects/:slug/help-wanted', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Post a help-wanted role',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = request.body as Parameters<
      typeof fastify.services.helpWantedWrite.create
    >[2];
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.create',
        subjectType: 'help-wanted-role',
        subjectSlug: slug,
        responseCode: 201,
      }),
      async (tx) => fastify.services.helpWantedWrite.create(tx, slug, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    reply.code(201);
    return ok(serializeRoleResponse(result.value.role, request));
  });

  // PATCH /api/projects/:slug/help-wanted/:roleId
  fastify.patch('/api/projects/:slug/help-wanted/:roleId', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Edit a help-wanted role',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, roleId: { type: 'string' } },
        required: ['slug', 'roleId'],
      },
      body: { type: 'object' },
    },
  }, async (request) => {
    const { slug, roleId } = request.params as { slug: string; roleId: string };
    const body = (request.body ?? {}) as Parameters<
      typeof fastify.services.helpWantedWrite.update
    >[3];
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.edit',
        subjectType: 'help-wanted-role',
        subjectSlug: `${slug}/${roleId}`,
        responseCode: 200,
      }),
      async (tx) =>
        fastify.services.helpWantedWrite.update(tx, slug, roleId, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return ok(serializeRoleResponse(result.value.role, request));
  });

  // POST /api/projects/:slug/help-wanted/:roleId/express-interest
  fastify.post('/api/projects/:slug/help-wanted/:roleId/express-interest', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Express interest in a role',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, roleId: { type: 'string' } },
        required: ['slug', 'roleId'],
      },
      body: { type: 'object' },
    },
  }, async (request, reply) => {
    const { slug, roleId } = request.params as { slug: string; roleId: string };
    const body = (request.body ?? {}) as { message?: string | null };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.express-interest',
        subjectType: 'help-wanted-role',
        subjectSlug: `${slug}/${roleId}`,
        responseCode: 202,
      }),
      async (tx) =>
        fastify.services.helpWantedWrite.expressInterest(tx, slug, roleId, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

    // Fire notification AFTER commit. Failures here log but do not fail.
    void fastify.notifier
      .notifyHelpWantedInterest({
        maintainerEmail: null,
        maintainerSlackHandle: result.value.poster?.slackHandle ?? null,
        roleTitle: result.value.role.title,
        projectTitle: result.value.project.title,
        projectSlug: result.value.project.slug,
        roleId: result.value.role.id,
        interestedPersonFullName: request.session.person!.fullName,
        interestedPersonSlug: request.session.person!.slug,
        message: result.value.expression.message ?? null,
      })
      .catch((err) => request.log.warn({ err }, 'help-wanted interest notification failed'));

    reply.code(202);
    return ok({ delivered: true });
  });

  // POST /api/projects/:slug/help-wanted/:roleId/fill
  fastify.post('/api/projects/:slug/help-wanted/:roleId/fill', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Mark a role as filled',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, roleId: { type: 'string' } },
        required: ['slug', 'roleId'],
      },
      body: { type: 'object' },
    },
  }, async (request) => {
    const { slug, roleId } = request.params as { slug: string; roleId: string };
    const body = (request.body ?? {}) as { filledBySlug?: string | null };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.fill',
        subjectType: 'help-wanted-role',
        subjectSlug: `${slug}/${roleId}`,
        responseCode: 200,
        ...(body.filledBySlug
          ? { extraTrailers: { 'Filled-By-Slug': body.filledBySlug } }
          : {}),
      }),
      async (tx) => fastify.services.helpWantedWrite.fill(tx, slug, roleId, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

    void fastify.notifier
      .notifyHelpWantedFilled({
        maintainerEmail: null,
        roleTitle: result.value.role.title,
        projectTitle: result.value.project.title,
        filledByFullName: result.value.filledBy?.fullName ?? null,
        filledBySlug: result.value.filledBy?.slug ?? null,
      })
      .catch((err) => request.log.warn({ err }, 'help-wanted filled notification failed'));

    return ok(serializeRoleResponse(result.value.role, request));
  });

  // POST /api/projects/:slug/help-wanted/:roleId/close
  fastify.post('/api/projects/:slug/help-wanted/:roleId/close', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Close a role without filling',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, roleId: { type: 'string' } },
        required: ['slug', 'roleId'],
      },
    },
  }, async (request) => {
    const { slug, roleId } = request.params as { slug: string; roleId: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.close',
        subjectType: 'help-wanted-role',
        subjectSlug: `${slug}/${roleId}`,
        responseCode: 200,
      }),
      async (tx) => fastify.services.helpWantedWrite.close(tx, slug, roleId, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return ok(serializeRoleResponse(result.value.role, request));
  });

  // POST /api/projects/:slug/help-wanted/:roleId/reopen
  fastify.post('/api/projects/:slug/help-wanted/:roleId/reopen', {
    schema: {
      tags: ['help-wanted'],
      summary: 'Reopen a previously filled or closed role',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, roleId: { type: 'string' } },
        required: ['slug', 'roleId'],
      },
    },
  }, async (request) => {
    const { slug, roleId } = request.params as { slug: string; roleId: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'help-wanted.reopen',
        subjectType: 'help-wanted-role',
        subjectSlug: `${slug}/${roleId}`,
        responseCode: 200,
      }),
      async (tx) => fastify.services.helpWantedWrite.reopen(tx, slug, roleId, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return ok(serializeRoleResponse(result.value.role, request));
  });

  // Silence unused imports — they're used elsewhere when validation failures are
  // thrown by deeper layers; kept available for path-level guards if added.
  void ApiNotFoundError;
  void ApiValidationError;
}
