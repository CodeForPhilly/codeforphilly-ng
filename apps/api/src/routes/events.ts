/**
 * Event routes — specs/api/events.md.
 *
 *   GET    /api/events
 *   GET    /api/events/feed.ics
 *   GET    /api/events/:slug
 *   GET    /api/events/:slug/ics
 *   GET    /api/events/:slug/rsvps
 *   PUT    /api/events/:slug/rsvp
 *   DELETE /api/events/:slug/rsvp
 *   POST   /api/events
 *   PATCH  /api/events/:slug
 *   POST   /api/events/:slug/publish
 *   POST   /api/events/:slug/cancel
 *   DELETE /api/events/:slug
 *
 * The two `.ics` routes are the documented non-JSON exception in
 * specs/api/conventions.md#content-type.
 */
import type { Event } from '@cfp/shared/schemas';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiNotFoundError, ApiValidationError } from '../lib/errors.js';
import { formatEventInstant } from '../lib/event-time.js';
import { buildEventIcs, buildFeedIcs, googleCalendarUrl } from '../lib/ics.js';
import { ok, paginated } from '../lib/response.js';
import { collectAttendees, eventEmailFacts } from '../services/event-notify.js';
import type { EventChange, EventInput, RsvpInput } from '../services/event.write.js';
import { getCallerSession } from '../services/permissions.js';
import { buildTransactionOptions } from '../store/commit-meta.js';

const slugParams = {
  type: 'object',
  properties: { slug: { type: 'string' } },
  required: ['slug'],
} as const;

const agendaItemSchema = {
  type: 'object',
  properties: {
    startsAt: { type: 'string' },
    endsAt: { type: ['string', 'null'] },
    title: { type: 'string' },
    venueName: { type: ['string', 'null'] },
    venueAddress: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
  },
  required: ['startsAt', 'title'],
} as const;

const eventBodyProperties = {
  title: { type: 'string' },
  slug: { type: ['string', 'null'] },
  description: { type: ['string', 'null'] },
  startsAt: { type: 'string' },
  endsAt: { type: 'string' },
  venueName: { type: ['string', 'null'] },
  venueAddress: { type: ['string', 'null'] },
  onlineUrl: { type: ['string', 'null'] },
  meetupUrl: { type: ['string', 'null'] },
  seriesSlug: { type: ['string', 'null'] },
  agenda: { type: ['array', 'null'], items: agendaItemSchema },
  status: { type: 'string', enum: ['draft', 'scheduled'] },
} as const;

function icsHeaders(disposition: string) {
  return {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': disposition,
  };
}

export async function eventRoutes(fastify: FastifyInstance): Promise<void> {
  const siteHost = (): string => fastify.config.CFP_SITE_HOST;

  const facts = (event: Event) => eventEmailFacts(event, siteHost());

  /** Every going attendee with a deliverable address, as `{ email, fullName }`. */
  async function attendees(eventId: string): Promise<Array<{ email: string; fullName: string }>> {
    const all = await collectAttendees(
      fastify.inMemoryState,
      fastify.store.private,
      fastify.services.events.rsvpsFor(eventId),
    );
    return all.map(({ email, fullName }) => ({ email, fullName }));
  }

  /** Fire-and-forget fan-out after a commit; the mutation already succeeded. */
  function fanOut(request: FastifyRequest, label: string, work: () => Promise<void>): void {
    void work().catch((err) => request.log.warn({ err }, `${label}: notification fan-out failed`));
  }

  /** Human form of a change line for the "event updated" email: instants in Philly time, strings as-is. */
  function describeChange(c: EventChange): { field: string; from: string | null; to: string | null } {
    if (c.field === 'startsAt' || c.field === 'endsAt') {
      const fmt = (v: string | null) => (v ? formatEventInstant(v) : null);
      return { field: c.field, from: fmt(c.from), to: fmt(c.to) };
    }
    return c;
  }

  // GET /api/events ----------------------------------------------------------
  fastify.get(
    '/api/events',
    {
      schema: {
        tags: ['events'],
        summary: 'List events (upcoming by default)',
        querystring: {
          type: 'object',
          properties: {
            when: { type: 'string', enum: ['upcoming', 'past', 'all'] },
            sort: { type: 'string' },
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const q = request.query as { when?: string; sort?: string; page?: number; perPage?: number };
      const caller = getCallerSession(request);
      const result = fastify.services.events.list(q, caller);
      if ('error' in result) {
        if (result.error === 'invalid_sort') throw new ApiValidationError('Unknown sort key', { sort: 'unknown sort key' });
        throw new ApiValidationError('Invalid when', { when: 'must be upcoming, past, or all' });
      }
      const page = Math.max(1, q.page ?? 1);
      const perPage = Math.min(100, Math.max(1, q.perPage ?? 30));
      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // GET /api/events/feed.ics — registered before /:slug ---------------------
  fastify.get(
    '/api/events/feed.ics',
    { schema: { tags: ['events'], summary: 'iCalendar subscription feed' } },
    async (_request, reply) => {
      const ics = buildFeedIcs(fastify.services.events.feedEvents(), siteHost());
      return reply
        .headers({ ...icsHeaders('inline; filename="code-for-philly.ics"'), 'Cache-Control': 'public, max-age=300' })
        .send(ics);
    },
  );

  // GET /api/events/:slug ----------------------------------------------------
  fastify.get(
    '/api/events/:slug',
    { schema: { tags: ['events'], summary: 'Event detail', params: slugParams } },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const result = fastify.services.events.get(slug, getCallerSession(request));
      if (!result) throw new ApiNotFoundError(`Event '${slug}' not found`);
      return ok(result);
    },
  );

  // GET /api/events/:slug/ics ------------------------------------------------
  fastify.get(
    '/api/events/:slug/ics',
    { schema: { tags: ['events'], summary: 'One event as an .ics file', params: slugParams } },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const event = fastify.services.events.findVisible(slug, getCallerSession(request));
      if (!event) throw new ApiNotFoundError(`Event '${slug}' not found`);
      return reply
        .headers(icsHeaders(`attachment; filename="${event.slug}.ics"`))
        .send(buildEventIcs(event, siteHost()));
    },
  );

  // GET /api/events/:slug/rsvps ----------------------------------------------
  fastify.get(
    '/api/events/:slug/rsvps',
    {
      schema: {
        tags: ['events'],
        summary: 'Going attendees',
        params: slugParams,
        querystring: {
          type: 'object',
          properties: {
            page: { type: 'integer', minimum: 1 },
            perPage: { type: 'integer', minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const q = request.query as { page?: number; perPage?: number };
      const result = fastify.services.events.listRsvps(slug, q, getCallerSession(request));
      if (!result) throw new ApiNotFoundError(`Event '${slug}' not found`);
      const page = Math.max(1, q.page ?? 1);
      const perPage = Math.min(100, Math.max(1, q.perPage ?? 100));
      return paginated(result.items, {
        page,
        perPage,
        totalItems: result.totalItems,
        totalPages: Math.ceil(result.totalItems / perPage),
      });
    },
  );

  // PUT /api/events/:slug/rsvp -----------------------------------------------
  fastify.put(
    '/api/events/:slug/rsvp',
    {
      schema: {
        tags: ['events'],
        summary: "RSVP (I'm going), or answer the follow-up",
        params: slugParams,
        body: {
          type: ['object', 'null'],
          properties: {
            plan: { type: ['string', 'null'] },
            projectSlug: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const body = (request.body ?? {}) as RsvpInput;
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'event.rsvp',
          subjectType: 'event',
          subjectSlug: slug,
          responseCode: 200,
        }),
        async (tx) => fastify.services.eventsWrite.putRsvp(tx, slug, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

      const { event, rsvp, created } = result.value;
      let confirmationDelivered: boolean | null = null;
      if (created) {
        const person = request.session.person!;
        const profile = await fastify.store.private.getProfile(person.id);
        if (profile?.email) {
          const outcome = await fastify.notifier.notifyEventRsvp({
            email: profile.email,
            fullName: person.fullName,
            event: facts(event),
            ics: buildEventIcs(event, siteHost()),
            googleCalendarUrl: googleCalendarUrl(event, siteHost()),
          });
          confirmationDelivered = outcome.delivered;
        } else {
          confirmationDelivered = false;
        }
      }

      const caller = getCallerSession(request);
      reply.code(created ? 201 : 200);
      const rsvps = fastify.services.events.listRsvps(event.slug, { perPage: 100 }, caller);
      const serializedRsvp = rsvps?.items.find((r) => r.person?.slug === request.session.person!.slug) ?? {
        person: null,
        plan: rsvp.plan ?? null,
        project: null,
        createdAt: rsvp.createdAt,
        updatedAt: rsvp.updatedAt,
      };
      return ok({
        rsvp: serializedRsvp,
        rsvpCount: fastify.services.events.rsvpCount(event.id),
        confirmationDelivered,
      });
    },
  );

  // DELETE /api/events/:slug/rsvp --------------------------------------------
  fastify.delete(
    '/api/events/:slug/rsvp',
    { schema: { tags: ['events'], summary: 'Withdraw the RSVP', params: slugParams } },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({
          request,
          action: 'event.rsvp.withdraw',
          subjectType: 'event',
          subjectSlug: slug,
          responseCode: 204,
        }),
        async (tx) => fastify.services.eventsWrite.deleteRsvp(tx, slug, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return reply.code(204).send();
    },
  );

  // POST /api/events ---------------------------------------------------------
  fastify.post(
    '/api/events',
    {
      schema: {
        tags: ['events'],
        summary: 'Create an event (staff)',
        body: { type: 'object', properties: eventBodyProperties, required: ['title', 'startsAt', 'endsAt'] },
      },
    },
    async (request, reply) => {
      const body = request.body as EventInput;
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event.create', subjectType: 'event', responseCode: 201 }),
        async (tx) => fastify.services.eventsWrite.create(tx, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      reply.code(201);
      return ok(fastify.services.events.serialize(result.value.event, getCallerSession(request)));
    },
  );

  // PATCH /api/events/:slug --------------------------------------------------
  fastify.patch(
    '/api/events/:slug',
    {
      schema: {
        tags: ['events'],
        summary: 'Edit an event (staff)',
        params: slugParams,
        body: { type: 'object', properties: eventBodyProperties },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const body = (request.body ?? {}) as EventInput;
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event.edit', subjectType: 'event', subjectSlug: slug, responseCode: 200 }),
        async (tx) => fastify.services.eventsWrite.update(tx, slug, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

      const { event, changes } = result.value;
      if (event.status === 'scheduled' && changes.length > 0) {
        fanOut(request, 'event updated', async () => {
          const ics = buildEventIcs(event, siteHost());
          const described = changes.map(describeChange);
          for (const a of await attendees(event.id)) {
            await fastify.notifier.notifyEventUpdated({ ...a, event: facts(event), changes: described, ics });
          }
        });
      }
      return ok(fastify.services.events.serialize(event, getCallerSession(request)));
    },
  );

  // POST /api/events/:slug/publish -------------------------------------------
  fastify.post(
    '/api/events/:slug/publish',
    { schema: { tags: ['events'], summary: 'Publish a draft (staff)', params: slugParams } },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event.publish', subjectType: 'event', subjectSlug: slug, responseCode: 200 }),
        async (tx) => fastify.services.eventsWrite.publish(tx, slug, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return ok(fastify.services.events.serialize(result.value.event, getCallerSession(request)));
    },
  );

  // POST /api/events/:slug/cancel --------------------------------------------
  fastify.post(
    '/api/events/:slug/cancel',
    {
      schema: {
        tags: ['events'],
        summary: 'Cancel an event (staff); attendees are emailed',
        params: slugParams,
        body: { type: ['object', 'null'], properties: { note: { type: ['string', 'null'] } } },
      },
    },
    async (request) => {
      const { slug } = request.params as { slug: string };
      const body = (request.body ?? {}) as { note?: string | null };
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event.cancel', subjectType: 'event', subjectSlug: slug, responseCode: 200 }),
        async (tx) => fastify.services.eventsWrite.cancel(tx, slug, body, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);

      const { event } = result.value;
      fanOut(request, 'event cancelled', async () => {
        const ics = buildEventIcs(event, siteHost());
        for (const a of await attendees(event.id)) {
          await fastify.notifier.notifyEventCancelled({
            ...a,
            event: facts(event),
            note: event.cancellationNote ?? null,
            ics,
          });
        }
      });
      return ok(fastify.services.events.serialize(event, getCallerSession(request)));
    },
  );

  // DELETE /api/events/:slug -------------------------------------------------
  fastify.delete(
    '/api/events/:slug',
    { schema: { tags: ['events'], summary: 'Hard-delete a draft or RSVP-less event (staff)', params: slugParams } },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const result = await fastify.store.transact(
        buildTransactionOptions({ request, action: 'event.delete', subjectType: 'event', subjectSlug: slug, responseCode: 204 }),
        async (tx) => fastify.services.eventsWrite.delete(tx, slug, request.session),
      );
      result.value.stateApply.apply(fastify.inMemoryState, fastify.fts);
      return reply.code(204).send();
    },
  );
}
