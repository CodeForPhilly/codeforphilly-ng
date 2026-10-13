# API: Events

Events and RSVPs. Rules in [behaviors/events.md](../behaviors/events.md); records in [data-model.md#event](../data-model.md#event) and [data-model.md#eventrsvp](../data-model.md#eventrsvp).

## Endpoints

| Method | Path | Auth | Summary |
| ------ | ---- | ---- | ------- |
| `GET` | `/api/events` | public | List events, upcoming by default. |
| `GET` | `/api/events/feed.ics` | public | iCalendar subscription feed. |
| `GET` | `/api/events/:slug` | public | Event detail with the caller's RSVP state. |
| `GET` | `/api/events/:slug/ics` | public | One event as an `.ics` file. |
| `GET` | `/api/events/:slug/rsvps` | public | Going attendees. |
| `PUT` | `/api/events/:slug/rsvp` | user | RSVP, or update the caller's project choice. |
| `DELETE` | `/api/events/:slug/rsvp` | user | Withdraw the caller's RSVP. |
| `POST` | `/api/events` | staff | Create. |
| `PATCH` | `/api/events/:slug` | staff | Edit. |
| `POST` | `/api/events/:slug/publish` | staff | `draft` → `scheduled`. |
| `POST` | `/api/events/:slug/cancel` | staff | `scheduled` → `cancelled`; notifies attendees. |
| `DELETE` | `/api/events/:slug` | staff | Hard delete a draft or RSVP-less event. |

Events are keyed in URLs by `slug`. `feed.ics` is matched before `:slug` (and `feed` is a reserved slug).

The two `.ics` routes are the documented exception to [conventions.md#content-type](conventions.md#content-type): they respond `text/calendar; charset=utf-8` with a `Content-Disposition: attachment; filename="<slug>.ics"` (single event) or `inline` (feed), and on error fall back to the normal JSON envelope.

## GET /api/events

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `when` | enum | `upcoming` (default) \| `past` \| `all`. Upcoming = `endsAt > now`. |
| `page`, `perPage` | int | Default `perPage = 30`. |
| `sort` | sort | Default `startsAt` when `when=upcoming` or `all`, `-startsAt` when `when=past`. Allowed: `startsAt`. |

Drafts are included only when the caller is staff; cancelled events are always included (clients render the badge).

### Response — 200

```json
{ "success": true, "data": [EventSummary, ...], "metadata": { "page": 1, "perPage": 30, "totalItems": 2, "totalPages": 1 } }
```

## GET /api/events/feed.ics

One `VCALENDAR` (`METHOD:PUBLISH`, `X-WR-CALNAME: Code for Philly`, `X-WR-TIMEZONE: America/New_York`) containing a `VEVENT` per `scheduled` or `cancelled` event with `endsAt ≥ now − 90 days`, built per [behaviors/events.md#calendar-files](../behaviors/events.md#calendar-files). Never includes drafts.

`Cache-Control: public, max-age=300`. Not rate-limited differently from other reads; calendar clients poll hourly or slower.

## GET /api/events/:slug

### Response — 200

```json
{ "success": true, "data": Event }
```

### Errors

- `404 not_found` — unknown slug, or a `draft` and the caller is not staff. Expired-redirect slugs follow [slug-handles.md](../behaviors/slug-handles.md).

## GET /api/events/:slug/ics

The event as a single-`VEVENT` `VCALENDAR`. Available for `scheduled` and `cancelled` events; drafts 404 to non-staff.

## GET /api/events/:slug/rsvps

### Query

| Param | Type | Notes |
| ----- | ---- | ----- |
| `page`, `perPage` | int | Default `perPage = 100`. |

### Response — 200

Sorted by `createdAt` ascending (first to RSVP first). Clients group by project per [behaviors/events.md#rsvp-to-a-project](../behaviors/events.md#rsvp-to-a-project).

```json
{
  "success": true,
  "data": [
    { "person": PersonAvatar, "project": { "slug": "squadquest", "title": "SquadQuest" } | null, "createdAt": "..." }
  ]
}
```

Deactivated people appear as the [placeholder](people.md#deactivated-person-placeholder) so counts stay honest.

## PUT /api/events/:slug/rsvp

Idempotent "I'm going" for the caller. Creates the RSVP if absent; otherwise updates only the project choice.

### Request

```json
{ "projectSlug": "squadquest" }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| projectSlug | no | A non-deleted project's slug, or `null` to clear. Omitted = leave unchanged (on create: none). |

### Response — 200 (updated) / 201 (created)

```json
{
  "success": true,
  "data": {
    "rsvp": EventRsvp,
    "rsvpCount": 15,
    "confirmationDelivered": true | false | null
  }
}
```

`confirmationDelivered` is the notifier's result on create and `null` on update (no mail is sent).

### Errors

- `409 conflict` with `error.code = "rsvp_closed"` — event is `draft`, `cancelled`, or `endsAt ≤ now`
- `404 not_found` — unknown event, or `projectSlug` doesn't resolve
- `401 unauthenticated`

## DELETE /api/events/:slug/rsvp

Withdraws the caller's RSVP. No mail.

### Response — 204

Also `204` when there was no RSVP to remove (idempotent).

### Errors

- `409 conflict` with `error.code = "rsvp_closed"` — `endsAt ≤ now`; the attendance record is history now.

## POST /api/events

### Request

```json
{
  "title": "Code for Philly Hack Night",
  "slug": "2026-11-03-hack-night",
  "description": "Bring a laptop. Pizza at 6:30.",
  "startsAt": "2026-11-03T23:00:00Z",
  "endsAt": "2026-11-04T01:30:00Z",
  "venueName": "Indy Hall",
  "venueAddress": "709 N 2nd St, 3rd Floor, Philadelphia, PA 19123",
  "onlineUrl": null,
  "meetupUrl": "https://www.meetup.com/code-for-philly/events/123456789/",
  "status": "scheduled"
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| title | yes | 1–200 chars. |
| slug | no | Defaults to `<YYYY-MM-DD of startsAt in America/New_York>-<slugified title>`, de-duplicated with `-2`, `-3`, … Must match the event slug pattern in [slug-handles.md](../behaviors/slug-handles.md). |
| description | no | Markdown, ≤ 20,000 chars. |
| startsAt | yes | ISO 8601 UTC. |
| endsAt | yes | ISO 8601 UTC, strictly after `startsAt`. |
| venueName | no | ≤ 120 chars. |
| venueAddress | no | ≤ 300 chars. Only meaningful with `venueName`. |
| onlineUrl | no | HTTPS URL. |
| meetupUrl | no | HTTPS URL on `meetup.com`. |
| status | no | `draft` \| `scheduled`. Default `scheduled`. `cancelled` is not accepted here. |

### Response — 201

```json
{ "success": true, "data": Event }
```

### Errors

- `409 conflict` with `error.code = "slug_taken"`
- `422 validation_failed` — including `error.fields.endsAt = "must be after startsAt"` and `error.code = "slug_reserved"` per slug rules

## PATCH /api/events/:slug

Editable fields: `title`, `slug`, `description`, `startsAt`, `endsAt`, `venueName`, `venueAddress`, `onlineUrl`, `meetupUrl`. Partial body; omitted fields are unchanged; `null` clears a nullable field. `status` is not editable here.

Side effects per [behaviors/events.md](../behaviors/events.md#changing-and-cancelling-after-people-rsvpd): calendar-relevant changes bump `icsSequence`; time/location changes on a `scheduled` event with RSVPs email every attendee. A `slug` change writes `SlugHistory` (`entityType = "event"`) and moves the event's RSVP records to the new path in the same commit.

### Response — 200

```json
{ "success": true, "data": Event }
```

### Errors

- `409 conflict` with `error.code = "slug_taken"`
- `422 validation_failed`

## POST /api/events/:slug/publish

`draft` → `scheduled`. No body.

### Response — 200

```json
{ "success": true, "data": Event }
```

### Errors

- `409 conflict` with `error.code = "not_draft"`

## POST /api/events/:slug/cancel

`scheduled` → `cancelled`. Sets `cancelledAt`, stores the note, bumps `icsSequence`, emails every going attendee (fire-and-forget).

### Request

```json
{ "note": "Indy Hall is closed for the holiday — see you in December." }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| note | no | ≤ 500 chars plain text. Shown in the cancelled banner and the email. |

### Response — 200

```json
{ "success": true, "data": Event }
```

### Errors

- `409 conflict` with `error.code = "not_scheduled"` — already cancelled, or still a draft (delete drafts instead)

## DELETE /api/events/:slug

Hard delete. Permitted only when `status = draft` or the event has no RSVPs. Removes the event and any RSVP records in one commit.

### Response — 204

### Errors

- `409 conflict` with `error.code = "has_rsvps"` — cancel instead

## Event shape

```json
{
  "id": "<uuid>",
  "slug": "2026-11-03-hack-night",
  "title": "Code for Philly Hack Night",
  "description": "Bring a laptop…",
  "descriptionHtml": "<p>Bring a laptop…</p>",
  "startsAt": "2026-11-03T23:00:00Z",
  "endsAt": "2026-11-04T01:30:00Z",
  "venueName": "Indy Hall" | null,
  "venueAddress": "709 N 2nd St…" | null,
  "onlineUrl": null,
  "meetupUrl": "https://www.meetup.com/…" | null,
  "status": "scheduled",
  "cancelledAt": null,
  "cancellationNote": null,
  "rsvpCount": 14,
  "viewerRsvp": { "project": { "slug": "squadquest", "title": "SquadQuest" } | null, "createdAt": "..." } | null,
  "icsUrl": "/api/events/2026-11-03-hack-night/ics",
  "permissions": {
    "canRsvp": true,
    "canEdit": false,
    "canPublish": false,
    "canCancel": false,
    "canDelete": false
  },
  "createdAt": "...",
  "updatedAt": "..."
}
```

- `descriptionHtml` is server-rendered per [markdown-rendering.md](../behaviors/markdown-rendering.md).
- `rsvpCount` counts going RSVPs.
- `viewerRsvp` is `null` for anonymous callers and for members who haven't RSVP'd.
- `permissions.canRsvp` is `true` exactly when a `PUT …/rsvp` from this caller would succeed (signed in, event `scheduled`, `endsAt > now`). Anonymous callers get `false`; the client renders "Sign in to RSVP" from the auth context.
- `icsSequence`, `reminders`, and `createdById` are internal and not serialized.

**EventSummary** is the same shape minus `description`, `descriptionHtml`, `cancellationNote`, and `permissions`.

## EventRsvp shape

```json
{
  "person": PersonAvatar,
  "project": { "slug": "squadquest", "title": "SquadQuest" } | null,
  "createdAt": "...",
  "updatedAt": "..."
}
```
