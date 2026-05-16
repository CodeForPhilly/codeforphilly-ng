/**
 * Project membership routes (writes only):
 *   POST   /api/projects/:slug/members
 *   PATCH  /api/projects/:slug/members/:personSlug
 *   DELETE /api/projects/:slug/members/:personSlug
 *   POST   /api/projects/:slug/members/join
 *   POST   /api/projects/:slug/members/leave
 */
import type { FastifyInstance } from 'fastify';
import { ok } from '../lib/response.js';
import { buildTransactionOptions } from '../store/commit-meta.js';

interface MembershipResponseShape {
  readonly id: string;
  readonly projectSlug: string;
  readonly person: { slug: string; fullName: string; avatarUrl: string | null };
  readonly role: string | null;
  readonly isMaintainer: boolean;
  readonly joinedAt: string;
}

function serializeMembership(
  m: { id: string; role?: string | null; isMaintainer: boolean; joinedAt: string },
  projectSlug: string,
  person: { slug: string; fullName: string; avatarKey?: string | null },
): MembershipResponseShape {
  return {
    id: m.id,
    projectSlug,
    person: {
      slug: person.slug,
      fullName: person.fullName,
      avatarUrl: person.avatarKey ? `/api/attachments/${person.avatarKey}` : null,
    },
    role: m.role ?? null,
    isMaintainer: m.isMaintainer,
    joinedAt: m.joinedAt,
  };
}

export async function projectMembershipRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /api/projects/:slug/members
  fastify.post('/api/projects/:slug/members', {
    schema: {
      tags: ['project-memberships'],
      summary: 'Add a member',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
      body: {
        type: 'object',
        properties: { personSlug: { type: 'string' }, role: { type: ['string', 'null'] } },
        required: ['personSlug'],
      },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const body = request.body as { personSlug: string; role?: string | null };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-membership.add',
        subjectType: 'project-membership',
        subjectSlug: `${slug}/${body.personSlug}`,
        responseCode: 201,
      }),
      async (tx) =>
        fastify.services.projectMembershipsWrite.add(tx, slug, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const person = fastify.inMemoryState.people.get(result.value.membership.personId)!;
    reply.code(201);
    return ok(serializeMembership(result.value.membership, slug, person));
  });

  // PATCH /api/projects/:slug/members/:personSlug
  fastify.patch('/api/projects/:slug/members/:personSlug', {
    schema: {
      tags: ['project-memberships'],
      summary: 'Update a membership role',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, personSlug: { type: 'string' } },
        required: ['slug', 'personSlug'],
      },
      body: {
        type: 'object',
        properties: { role: { type: ['string', 'null'] } },
      },
    },
  }, async (request) => {
    const { slug, personSlug } = request.params as { slug: string; personSlug: string };
    const body = (request.body ?? {}) as { role?: string | null };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-membership.update',
        subjectType: 'project-membership',
        subjectSlug: `${slug}/${personSlug}`,
        responseCode: 200,
      }),
      async (tx) =>
        fastify.services.projectMembershipsWrite.update(tx, slug, personSlug, body, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const person = fastify.inMemoryState.people.get(result.value.membership.personId)!;
    return ok(serializeMembership(result.value.membership, slug, person));
  });

  // DELETE /api/projects/:slug/members/:personSlug
  fastify.delete('/api/projects/:slug/members/:personSlug', {
    schema: {
      tags: ['project-memberships'],
      summary: 'Remove a member',
      params: {
        type: 'object',
        properties: { slug: { type: 'string' }, personSlug: { type: 'string' } },
        required: ['slug', 'personSlug'],
      },
    },
  }, async (request, reply) => {
    const { slug, personSlug } = request.params as { slug: string; personSlug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-membership.remove',
        subjectType: 'project-membership',
        subjectSlug: `${slug}/${personSlug}`,
        responseCode: 204,
      }),
      async (tx) =>
        fastify.services.projectMembershipsWrite.remove(tx, slug, personSlug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return reply.code(204).send();
  });

  // POST /api/projects/:slug/members/join
  fastify.post('/api/projects/:slug/members/join', {
    schema: {
      tags: ['project-memberships'],
      summary: 'Join the project as the current user',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-membership.join',
        subjectType: 'project-membership',
        subjectSlug: slug,
        responseCode: 201,
      }),
      async (tx) =>
        fastify.services.projectMembershipsWrite.join(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    const person = fastify.inMemoryState.people.get(result.value.membership.personId)!;
    reply.code(201);
    return ok(serializeMembership(result.value.membership, slug, person));
  });

  // POST /api/projects/:slug/members/leave
  fastify.post('/api/projects/:slug/members/leave', {
    schema: {
      tags: ['project-memberships'],
      summary: 'Leave the project',
      params: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] },
    },
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const result = await fastify.store.transact(
      buildTransactionOptions({
        request,
        action: 'project-membership.leave',
        subjectType: 'project-membership',
        subjectSlug: slug,
        responseCode: 204,
      }),
      async (tx) =>
        fastify.services.projectMembershipsWrite.leave(tx, slug, request.session),
    );
    result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
    return reply.code(204).send();
  });
}
