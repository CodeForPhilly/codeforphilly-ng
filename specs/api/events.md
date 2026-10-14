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
| `PUT` | `/api/events/:slug/rsvp` | user | RSVP, or answer the follow-up. |
| `DELETE` | `/api/events/:slug/rsvp` | user | Withdraw the caller's RSVP. |
| `POST` | `/api/events` | staff | Create. |
| `PATCH` | `/api/events/:slug` | staff | Edit. |
| `POST` | `/api/events/:slug/publish` | staff | `draft` → `scheduled`. |
| `POST` | `/api/events/:slug/cancel` | staff | `scheduled` → `cancelled`; notifies attendees. |
| `DELETE` | `/api/events/:slug` | staff | Hard delete a draft or RSVP-less event. |
| `GET` | `/api/event-series` | public | List series. |
| `GET` | `/api/event-series/:slug` | public | Series detail with its events. |
| `POST` | `/api/event-series` | staff | Create a series. |
| `PATCH` | `/api/event-series/:slug` | staff | Edit a series. |
| `DELETE` | `/api/event-series/:slug` | staff | Delete an empty series. |

Events are keyed in URLs by `slug`. `feed.ics` is matched before `:slug` (and `feed` is a reserved slug). Series live under their own collection path so `/api/events/:slug` never has to disambiguate.

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

Sorted by `createdAt` ascending (first to RSVP first). Clients group per [behaviors/events.md#the-follow-up-what-are-you-coming-to-do](../behaviors/events.md#the-follow-up-what-are-you-coming-to-do). A paginated envelope like every other list.

```json
{
  "success": true,
  "data": [ EventRsvp, ... ],
  "metadata": { "page": 1, "perPage": 100, "totalItems": 14, "totalPages": 1 }
}
```

Deactivated people appear as the [placeholder](people.md#deactivated-person-placeholder) so counts stay honest.

## PUT /api/events/:slug/rsvp

Idempotent "I'm going" for the caller. Creates the RSVP if absent; otherwise updates only the follow-up answer.

### Request

```json
{ "plan": "project", "projectSlug": "squadquest" }
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| plan | no | `newcomer` \| `no_project` \| `project` \| `null` (clear the answer). Omitted = leave unchanged (on create: unanswered). |
| projectSlug | with `plan = project` | A non-deleted project's slug. Ignored and cleared for any other `plan`. |

An empty body `{}` is the plain one-click RSVP.

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
- `422 validation_failed` — `plan = project` without a `projectSlug`
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
  "seriesSlug": "monthly-hack-nights",
  "agenda": [
    { "startsAt": "2026-11-03T23:00:00Z", "endsAt": "2026-11-03T23:30:00Z", "title": "Welcome & project pitches" },
    { "startsAt": "2026-11-03T23:30:00Z", "title": "Hack", "description": "Find your table." }
  ],
  "status": "scheduled"
}
```

| Field | Required | Notes |
| ----- | -------- | ----- |
| title | yes | 1–200 chars. |
| seriesSlug | no | An existing series' slug, or `null`. To create a series inline, call `POST /api/event-series` first. |
| agenda | no | Array of agenda items per [data-model.md#agenda-items](../data-model.md#agenda-items); ≤ 50; each `startsAt` within the event; sorted on write. Default `[]`. |
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

Editable fields: `title`, `slug`, `description`, `startsAt`, `endsAt`, `venueName`, `venueAddress`, `onlineUrl`, `meetupUrl`, `seriesSlug`, `agenda`. Partial body; omitted fields are unchanged; `null` clears a nullable field; `agenda` is replaced whole when present. `status` is not editable here.

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
  "series": { "slug": "monthly-hack-nights", "title": "Monthly Hack Nights" } | null,
  "agenda": [
    { "startsAt": "...", "endsAt": "..." | null, "title": "...", "venueName": null, "venueAddress": null, "description": null, "descriptionHtml": null }
  ],
  "status": "scheduled",
  "cancelledAt": null,
  "cancellationNote": null,
  "rsvpCount": 14,
  "viewerRsvp": { "plan": "project" | "newcomer" | "no_project" | null, "project": { "slug": "squadquest", "title": "SquadQuest" } | null, "createdAt": "..." } | null,
  "viewerRecentProjects": [ { "slug": "squadquest", "title": "SquadQuest" } ],
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
- `viewerRecentProjects` is the projects the caller named on their RSVPs to *other* events, most recently answered first, de-duplicated, at most eight — what the follow-up's project picker offers before anything is typed ([screens/event-detail.md](../screens/event-detail.md)). `[]` for anonymous callers. Detail only; the list shape omits it.
- `permissions.canRsvp` is `true` exactly when a `PUT …/rsvp` from this caller would succeed (signed in, event `scheduled`, `endsAt > now`). Anonymous callers get `false`; the client renders "Sign in to RSVP" from the auth context.
- `icsSequence`, `reminders`, and `createdById` are internal and not serialized.

**EventSummary** is the same shape minus `description`, `descriptionHtml`, `cancellationNote`, `agenda`, and `permissions` (it keeps `series`).

## EventRsvp shape

```json
{
  "person": PersonAvatar,
  "plan": "project" | "newcomer" | "no_project" | null,
  "project": { "slug": "squadquest", "title": "SquadQuest" } | null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

## Event series

### GET /api/event-series

Query: `page`, `perPage` (default 50). Sorted by `title`. Response `data: [EventSeries, ...]`. Series whose events are all drafts are omitted for non-staff.

### GET /api/event-series/:slug

```json
{
  "success": true,
  "data": {
    "id": "<uuid>",
    "slug": "monthly-hack-nights",
    "title": "Monthly Hack Nights",
    "description": "…" | null,
    "descriptionHtml": "…" | null,
    "upcoming": [EventSummary, ...],
    "past": [EventSummary, ...],
    "permissions": { "canEdit": false, "canDelete": false },
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

`upcoming` sorts by `startsAt` ascending; `past` descending, capped at 50 (older events are reachable via `GET /api/events?when=past` — a series filter is not in v1). Drafts appear only for staff.

### POST /api/event-series

| Field | Required | Notes |
| ----- | -------- | ----- |
| title | yes | 1–120 chars. |
| slug | no | Defaults to the slugified title. |
| description | no | Markdown, ≤ 10,000 chars. |

`201` with the series. `409 slug_taken` on collision.

### PATCH /api/event-series/:slug

Editable: `title`, `slug`, `description`. A slug change writes `SlugHistory` (`entityType = "event_series"`). `200` with the series.

### DELETE /api/event-series/:slug

`204`. `409 conflict` with `error.code = "has_events"` while any event references the series — reassign or clear those first.
