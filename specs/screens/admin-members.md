# Screen: Admin members

## Route

`/admin/members` — staff and administrators. Anyone else (including signed-out)
gets the site's 404, same as `/staff/account-claim`.

`/admin/members/:slug` — the expanded footprint view for one member (also
reachable in-page by expanding a row).

## Purpose

New members now arrive only through GitHub sign-in, so the volume is low and the
question is simple: *is this a real person?* Everyone listed here has already
passed the offline spam pipeline (or arrived after its last run), so the page
does **not** show machine evaluations. It shows the member's footprint on the
site in one place, and lets staff record a **human judgment** the pipeline treats
as final.

## Data Requirements

- `GET /api/admin/members` on entry and on every filter/sort/page change
- `GET /api/admin/members/:slug` when a row is expanded or the detail route opens
- `POST /api/admin/members/:slug/vote` on either vote button

See [api/moderation.md](../api/moderation.md).

## Display Rules

### Roster

- Newest signup first by default; sort toggles for name and last sign-in.
- Filter bar: text search; **Vote**: any / no vote yet (default) / voted spam /
  voted legit; joined date range; a "show deactivated" toggle (on by default —
  moderation needs to see what it hid).
- Each row: avatar, `fullName` (link to the public profile, opens in a new tab),
  `@slug`, "joined {createdAt relative}", GitHub-linked badge, last sign-in
  relative, email (staff-visible), bio excerpt, compact footprint counts
  (`2 projects · 1 update · 3 tags`), and the vote state:
  - no vote → two buttons **Spam** / **Not spam**
  - voted → a badge `Spam · by {voter} · {when}` or `Not spam · …` with a
    "Change" affordance that re-shows the buttons
- Deactivated members render dimmed with a "Deactivated" chip; a member hidden by
  a spam vote shows "Hidden by {voter}".

### Expanded row / detail

Full bio (rendered markdown, server-side), then the footprint as lists with
links: project memberships (role, joined), authored updates, buzz, blog posts,
help-wanted interest, tags. Then the vote history, newest first, each with
voter, verdict, reasoning, and time. Then the same two buttons, plus a link to
the person's Danger Zone for admins (purge lives there, not here).

### Voting

- **Spam** opens a small confirm with an optional reasoning field ("Why? —
  optional, saved with your vote"), then calls the vote endpoint. On success the
  row dims immediately ("Hidden by you"), because the API deactivates the person
  in the same transaction.
- **Not spam** calls the endpoint directly (reasoning optional via the same
  disclosure). If the member had been hidden by a spam vote, the row un-dims.
- The buttons are disabled on the caller's own row.
- Errors surface as a toast; the row state is refetched, never guessed.

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Filter / sort / page | `GET /api/admin/members?…` | Re-render roster |
| Expand row | `GET /api/admin/members/:slug` | Show footprint + votes |
| Spam | `POST …/vote { verdict: "spam", reasoning? }` | Row → deactivated + vote badge |
| Not spam | `POST …/vote { verdict: "legit", reasoning? }` | Row → vote badge; un-dim if vote-hidden |

## Authorization

Staff and administrators. Purge is not offered here (admin-only, on the person
page). Votes are attributed to the individual caller and can be changed by that
caller at any time.

## Out of scope (v1)

- Machine verdicts, confidence, or reasoning on this page — the pipeline's
  concern, and its data lives in a private repo.
- Bulk actions.
- Running the heuristic in-process at signup (natural follow-up).
