# Behavior: Help-Wanted Roles

## Rule

A "help-wanted role" is a concrete, time-boxed volunteer ask attached to a project: "We need a React dev for ~4 hrs/wk to build the admin dashboard." Roles live on projects, have a status lifecycle, attract interest expressions from prospective volunteers, and roll up into a cross-project browse.

This is the headline new feature in v1. It exists because the laddr project directory left "how to actually contribute" up to each project's README and Slack channel — high friction for newcomers.

## Applies To

- [data-model.md#helpwantedrole](../data-model.md#helpwantedrole)
- [api/projects-help-wanted.md](../api/projects-help-wanted.md)
- [screens/help-wanted-index.md](../screens/help-wanted-index.md)
- [screens/project-detail.md](../screens/project-detail.md) — Help Wanted section
- [screens/home.md](../screens/home.md) — Help-wanted rail

## Status lifecycle

```
                  ┌─────────────────────────┐
                  │                         │
                  ▼                         │
    [created] → open ──fill──> filled ──reopen──┐
                  │                             │
                  └──close──> closed ──reopen───┘
```

| Status | Set by | Set when |
| ------ | ------ | -------- |
| `open` | system | On creation. On `reopen`. |
| `filled` | maintainer/staff | A volunteer is committed; `filledAt = now`, optional `filledById`. |
| `closed` | maintainer/staff | Cancelled, expired, no-longer-needed. `closedAt = now`. |

Transitions are explicit endpoints, not a generic PATCH on `status`. This makes the audit trail clean and the UI obvious. See [api/projects-help-wanted.md](../api/projects-help-wanted.md) for endpoint details.

## Side effects

- **Fill with attribution** — if `filledBySlug` is passed and that person isn't already a member of the project, add them as a member with role `"Help-wanted: <role.title>"`. The maintainer can edit that role string later.
- **Express interest** notifies the project's maintainer:
  - Email — required (we always have the maintainer's email)
  - Slack DM — optional, fires only if the maintainer has linked Slack (deferred field) or if there's a project Slack channel; falls back to email only
- **Express-interest rate cap** — a single person can only express interest in the *same* role once per 30 days. Different roles on the same project are fine.

## Auto-aging

- Roles with `status = 'open'` and no activity (no interest expressions, no edits) for 90 days send an email reminder to the maintainer: "Is this still open?". Two clickable actions: "Still open" (extends 90 days), "Close it" (sets status closed).
- After 180 days of no activity, status auto-flips to `closed` with `closedBy` recorded as the system. Maintainer is notified.

Deferred to a follow-up release; v1 ships without this and we measure how stale the help-wanted board gets organically before tuning.

## Display rules across screens

- The **Project Detail** page renders the project's open roles inline (between README and Activity). Closed/filled roles are accessible via a "View all roles" link.
- The **Help-Wanted Index** shows roles where `status = open` across all (non-deleted) projects.
- The **Home Page** rail shows the 4 most recently created open roles.
- Cards always show: title, project (where shown out-of-context), description excerpt, commitment chip, tag chips, and one of: "Express Interest" / "Interest Sent ✓" / "Sign in to express interest".

## Tags

Roles can be tagged in any namespace that applies to projects (`topic`, `tech`, `event`). The schema adds `help_wanted_role` to the polymorphic `tag_assignments.taggableType` enum. See [data-model.md#tagassignment](../data-model.md#tagassignment).

Browse defaults sort by `-createdAt`. Tag facets surface in `metadata.facets`.

## What `commitmentHoursPerWeek` means

- An integer estimate per week.
- `0` means "flexible / unspecified" — show as "Flexible commitment" in the chip.
- `null` means "not set" — equivalent to `0` for display. We always render *something* so the chip layout doesn't shift.
- The field is non-binding — it's a hint to volunteers, not a contract. Maintainers can edit it any time.

## Interest expressions

- Store a row in a `help_wanted_interest_expressions` table:
  - `id`, `roleId`, `personId`, `message`, `createdAt`
- The list of interest expressions is **not** publicly visible. The role's `interestCount` is, so callers can see "this role has 3 interested people."
- The maintainer of the project can see the full list (people + messages) via a deferred endpoint `GET /api/projects/:slug/help-wanted/:roleId/interest`. Not in v1's API spec yet; promote when needed.

## Why a separate concept from project memberships

Memberships answer "who's on this project." Help-wanted answers "who do we need." A project can have any number of help-wanted roles open while also having stable membership; the two are independent. A filled role becomes a membership but the role record stays around for accountability and reopenability.

## Open questions

- Should a role specify *required* tags vs *helpful* tags? Probably not in v1 — extra knobs without proof we need them.
- Should we allow non-maintainers to "endorse" a help-wanted role? Probably not — endorsement makes sense for projects, not for tasks.
- Should we cross-reference Slack `#projectname` channel join links? Worth doing once Slack integration exists.
