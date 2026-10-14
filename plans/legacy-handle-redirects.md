---
status: planned
depends: []
specs:
  - specs/behaviors/slug-handles.md
  - specs/behaviors/legacy-id-mapping.md
---

# Plan: permanent redirects for pre-normalization legacy handles

## Scope

**Live bug.** laddr matched handles case-insensitively, and the import
(`safeSlug`, `import-laddr/translators.ts:125`) lowercased and re-punctuated
handles. Slug lookups on the new site are exact-match, so every inbound link
carrying a legacy capitalization or punctuation 404s.

- Projects: 66 of 269 (63 by case alone, plus `sheldon.md`, `o.s.c.a.v.-…`,
  and one truncated handle).
- People: not measured (the legacy people list is personal data), but
  plausibly many, since person slugs also drop `_` and `.`.

In: the [legacy handle normalization](../specs/behaviors/slug-handles.md#legacy-handle-normalization)
fallback in the web-layer redirect plugin, for projects, people, tags and
buzz.

Out:

- API lookups stay exact-match (spec).
- Recovering collision-suffixed (`-2`) handles exactly; this is an accepted
  limit in the spec.

## Implements

- [behaviors/slug-handles.md](../specs/behaviors/slug-handles.md) → Legacy
  handle normalization; Migration from laddr.
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md)
  → Legacy URL forms.

## Approach

1. A shared `normalizeLegacyHandle(input, entityType)` in `packages/shared`.
   The importer's `safeSlug` and the tag translator call it, so the import
   transform and the redirect can't drift. Collision suffixing stays in the
   importer.
2. In `plugins/slug-redirect.ts` `resolveSlug`: when the slug isn't live and
   has no slug-history entry, normalize it and, if the result differs,
   resolve that (live, or through slug-history). Then 301 with
   `Cache-Control: public, max-age=86400`, since it never expires.
3. `/people/:username` already static-rewrites to `/members/:username`. The
   second hop normalizes. Two 301s is acceptable; fold them only if trivial.

## Validation

- [ ] `normalizeLegacyHandle` unit tests cover case, `.`, `_` (person vs.
      project), leading punctuation, truncation, and the `s` prefix
- [ ] Importer uses the shared function; the existing importer tests are
      green and unchanged
- [ ] Redirect tests: `/projects/Apps_for_Philly` → 301
      `/projects/apps_for_philly`; `/projects/sheldon.md/edit` → 301
      `/projects/sheldon-md/edit`; `/members/Jane_Doe?x=1` → 301
      `/members/jane-doe?x=1`; `/people/Jane_Doe` reaches the canonical member
      URL; `/tags/topic.Urban_Design` reaches `/tags/topic/urban-design`; an
      unknown handle still falls through to not-found; a live slug is never
      redirected
- [ ] Production spot check: the 66 changed project handles from the
      2026-09-08 import all 301 to their canonical slug
- [ ] `type-check` + `lint` + full api suite green

## Risks / unknowns

- A normalized form that collides with a *different* live entity sends the
  user there. This is bounded to punctuation collisions; see the spec.

## Notes

## Follow-ups
