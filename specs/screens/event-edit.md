# Screen: Event Create / Edit

## Route

- `/events/new` — create. Staff only.
- `/events/new?from=<slug>` — create, prefilled from an existing event ([behaviors/events.md#duplicating](../behaviors/events.md#duplicating)).
- `/events/new?series=<slug>` — create with the Series field preselected (from the series page).
- `/events/:slug/edit` — edit. Staff only.

Non-staff get the 403 page. Rules in [behaviors/events.md](../behaviors/events.md).

## Data Requirements

- Edit: `GET /api/events/:slug`
- Duplicate: `GET /api/events/<from>` to seed the form
- `GET /api/auth/me`

## Display Rules

A single-column form. Fields, in order:

| Field | Control | Rules |
| ----- | ------- | ----- |
| Title | text | required, 1–200 |
| Starts | date + time inputs, labelled "(Philadelphia time)" | required. Entered as `America/New_York` wall-clock; converted to UTC on submit. |
| Ends | date + time inputs | required, after Starts. Defaults to Starts + 2h30 when Starts is first filled and Ends hasn't been touched. |
| Venue name | text | optional, ≤ 120 |
| Venue address | text | optional, ≤ 300; helper "Shown as a Google Maps link." |
| Online link | url | optional, HTTPS |
| Meetup link | url | optional, HTTPS on meetup.com; helper "Shown as a secondary link while we transition off Meetup." |
| Description | markdown textarea with preview (same control as project overview) | optional, ≤ 20,000 |
| Series | combobox: existing series by title, or "Create '<typed text>'" which calls `POST /api/event-series` on save | optional. Duplicate mode carries the source's series. |
| Schedule | collapsed "Add a schedule" disclosure; a repeatable row editor with Starts (date + time), Ends (time, optional), Title, Venue (optional, with address), Description (markdown, optional); rows reorder by start on save | optional, ≤ 50 rows; each start within the event's range (inline error otherwise). Hidden behind the disclosure so a hack night form stays short. |
| Slug | text, collapsed under "Advanced" | create: placeholder shows the generated default (`2026-11-03-hack-night`) and leaves the field empty; edit: current slug, with helper "Changing this redirects the old link for 90 days." |
| Save as | radio: "Publish now" (default) / "Save as draft" | create only. Edit shows the current status read-only with a note that cancelling happens from the event page. |

When editing a `scheduled` event that has RSVPs and the time or location fields changed, the submit button reads "Save and notify 14 attendees" and a line above it explains the update email. Otherwise it reads "Save".

Duplicate mode: every field is prefilled from the source except slug and status; Starts/Ends and every schedule row are shifted forward one calendar month (same day-of-month, same wall-clock time in Philadelphia). A dismissible note at the top reads "Copied from <source title>. Check the date."

Validation errors render inline per field from `error.fields`; a `slug_taken` conflict renders on the slug field.

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Save (create) | `POST /api/events` → navigate to `/events/<slug>` | Submit |
| Save (edit) | `PATCH /api/events/:slug` → navigate to `/events/<slug>` | Submit |
| Cancel | Navigate back to the event (edit) or `/events` (create) | Cancel link; confirm when dirty |

## Navigation

**To here:** events index "New event", event detail "Edit" and "Duplicate".

**From here:** `/events/<slug>`, `/events`.

## Authorization

Staff only, enforced by the API (`POST`/`PATCH` require `staff`); the SPA hides the entry points and renders 403 on direct navigation.
