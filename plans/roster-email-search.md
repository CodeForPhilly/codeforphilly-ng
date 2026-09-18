---
status: done
depends: [roster-signals]
specs:
  - specs/api/moderation.md
  - specs/screens/admin-members.md
issues: []
pr: 191
---

# Plan: roster search covers email; domain pivot

## Scope

Two things found on the first day of triage: searching for an email
substring did nothing unless the query contained an `@` (an accidental gate
in `listMembers`), and once one throwaway domain turns up staff want every
other account from it in one click.

In: search email for every query; the email's domain on each row is a button
that searches `@domain` across the whole roster. Out: a domain histogram.

## Implements

- [api/moderation.md](../specs/api/moderation.md) — `q` matches email for
  any query and applies to the whole roster before pagination.
- [screens/admin-members.md](../specs/screens/admin-members.md) — the domain
  button.

## Approach

Drop the `@` gate in `ModerationService.listMembers`; `EmailWithDomainSearch`
in the page sets `q=@domain`; the search input remounts on `q` so the URL
drives it.

## Validation

- API test: `q=example.org` returns both seeded members with that domain.
- `type-check` + `lint`; moderation suite green.

## Follow-ups

None.
