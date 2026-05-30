---
status: done
depends: [screen-gaps-phase1]
specs:
  - specs/screens/person-detail.md
issues: [83]
pr: 103
---

# Plan: screen-gaps phase 2 — PersonDetail email + slackHandle

## Scope

[#83](https://github.com/CodeForPhilly/codeforphilly-ng/issues/83) phase 2 — the PersonDetail render gaps that need backend serializer changes (phase 1 only touched the SPA):

1. **`slackHandle`** — already on the `Person` schema (public field). Surface it in the `PersonDetail` serializer for everyone; render in the sidebar as a "Slack DM" link (`https://<SLACK_TEAM_HOST>/team/<slackHandle>` per Slack's deep-link convention) when present.
2. **`email`** — lives in `PrivateProfile`, not `Person`. Surface it in the `PersonDetail` serializer for **self** (`caller.id === person.id`) and **staff** (`accountLevel === 'staff' | 'administrator'`). Render in the sidebar Contact section.

The "Contact" sidebar groups Slack handle + email; visible to anyone if `slackHandle` is set or the caller can see email.

## Implements

- [screens/person-detail.md](../specs/screens/person-detail.md) — Contact sidebar + authorization-by-caller email rules.

## Approach

### 1. Serializer

`apps/api/src/services/serializers/person.ts`:

- Add `slackHandle: string | null` to `PersonDetail`. Pull from `person.slackHandle ?? null`. No caller gating — it's a public field per the schema.
- Add `email: string | null` to `PersonDetail`. Populated only when caller is self or staff; otherwise `null`. The serializer signature gets `callerEmail?: string` (the *target's* email, when the caller is allowed to see it) — the service is responsible for the gating + the private-store read.

### 2. Service

`PersonService.get` becomes `async`. After the existing in-memory work, conditionally `await this.#privateStore.getProfile(personId)` when the caller is self or staff. Pass the resulting email (or null) into the serializer.

The service grows a `#privateStore: PrivateStore` field. Wired through the constructor; updated in `apps/api/src/plugins/services.ts`.

### 3. Route

`GET /api/people/:slug` (in `apps/api/src/routes/people.ts`) gains an `await` on the now-async `services.people.get`. Same change at the PATCH-then-refetch site (line 139).

### 4. Screen

`apps/web/src/screens/PersonDetail.tsx` — add a Contact sidebar block that renders:

- "Slack DM" link when `slackHandle` is present.
- Email (`mailto:`) link when `email` is present.

If neither is set, the Contact section doesn't render.

### 5. API client type

`apps/web/src/lib/api.ts` `PersonDetailResponse` (or equivalent) picks up `slackHandle: string | null` and `email: string | null`.

### 6. Tests

- **Service test**: anonymous caller → email omitted, slackHandle present; self → email present; staff → email present.
- **Screen test**: slackHandle visible (DM link), email visible when present, sidebar hidden when neither is set.

## Validation

- [x] PersonDetail API response includes `slackHandle` for everyone (null when absent).
- [x] PersonDetail API response includes `email` for self + staff only.
- [x] PersonDetail screen renders Slack DM link when `slackHandle` is set.
- [x] PersonDetail screen renders mailto link when `email` is present.
- [x] Anonymous caller never sees `email` in the JSON response or the screen.
- [x] `npm run type-check && npm run lint && npm test` clean.

## Risks / unknowns

- **Async service breaking other callers.** Only two call sites for `PersonService.get` — both in `apps/api/src/routes/people.ts`. Easy to update.
- **PII surface in JSON.** Anonymous callers must never see `email`. The serializer enforces this by only setting the field when the service passes it in; the service only passes it in when it ran the private-store lookup. Test asserts the negative case.
- **Slack deep-link URL shape.** `https://<SLACK_TEAM_HOST>/team/<slackHandle>` is Slack's user-profile deep-link. If Slack changes it, the link breaks. Acceptable — same risk as the `/chat?channel=` redirect, fixable in one commit.

## Notes

Three commits: plan-open, backend (serializer + service + plugin DI + route awaits + seed fixture + 3 new read-api tests), SPA (PersonDetail Contact sidebar + 3 new screen tests).

Surprises:

- **The seed fixture didn't have a `slackHandle` set.** Adding one to
  the Jane Doe fixture (rather than seeding a separate person via
  `seedRawToml`) was simpler and didn't break any pre-existing tests
  — they all assert against fields they care about, not the absence
  of other fields. Now every test that touches the fixture has a
  public slackHandle to assert against if it wants to.
- **`PersonService.get` had only two callers.** Both in
  `apps/api/src/routes/people.ts` — the GET handler and the
  PATCH-then-refetch site. Easy mechanical await additions. No
  other consumer in the codebase reads through `services.people.get`.
- **The Contact section hides itself when both fields are absent.**
  This keeps the sidebar identical to today for the long tail of
  legacy profiles that have neither slackHandle nor email visible
  to the caller. Validated by the first PersonDetail.test.tsx case.

## Follow-ups

- **Phase 3 — `/pages/:slug` content rendering.** Mission, Leadership,
  CoC, Hackathons need a content directory + a route that reads +
  renders markdown server-side. *Deferred to plan* — `plans/static-pages.md`.
- **Phase 4 — `/projects/:slug/buzz/new` create form.** API endpoint
  exists; just the SPA form is missing. *Deferred to plan* —
  `plans/buzz-new-form.md`.
- **`slackHandle` write surface.** Today the field is read-only
  server-side; the ProfileEdit screen doesn't expose it. Tracking
  separately if/when content-author UX for this becomes a priority.
  *None* — not blocking #83 closure.
