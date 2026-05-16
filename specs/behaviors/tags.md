# Behavior: Tags

## Rule

Tags are a flat, namespaced taxonomy applied polymorphically to projects, people, and help-wanted roles. A tag has three identifying pieces — `namespace`, `slug`, `id` — and one display piece, `title`. The URL form is `namespace.slug` (e.g., `tech.flutter`).

## Applies To

- [data-model.md#tag](../data-model.md#tag) and [data-model.md#tagassignment](../data-model.md#tagassignment)
- [api/tags.md](../api/tags.md), [api/projects.md](../api/projects.md), [api/people.md](../api/people.md), [api/projects-help-wanted.md](../api/projects-help-wanted.md)
- Every screen with a tag chip or facet rail

## Namespaces

| Namespace | Applies to | Example slugs |
| --------- | ---------- | ------------- |
| `topic` | projects, people, help-wanted roles | `transit`, `mapping`, `elections`, `civic-engagement` |
| `tech` | projects, people, help-wanted roles | `react`, `typescript`, `python`, `flutter` |
| `event` | projects, help-wanted roles | `hackathon-2025`, `code-across-america` |

Namespaces are fixed. We don't add new namespaces casually — that's a schema change.

## URL forms

- API: `?tag=tech.flutter` (single composite handle)
- Web: `/tags/tech/flutter` (path style, separate segments)
- Both resolve to the same tag row. The path form is canonical for sharing; the query form is canonical for API requests.

The legacy laddr form `?tag=tech.flutter` also resolves because the API accepts that form too — handy for any incoming links from old codeforphilly.org URLs.

## Slug rules

- Lowercase, ASCII, 1–50 chars, `^[a-z0-9][a-z0-9-]{0,49}$`
- Underscores are converted to hyphens on creation
- Uniqueness is within `(namespace, slug)` — both `topic.maps` and `tech.maps` can coexist

## Display

- Chips are color-coded by namespace; the implementation picks the palette but the *namespace → color* mapping is consistent across screens.
- The display string on chips is `tag.title`; never the slug.
- When a tag chip appears outside its namespace context (e.g., a mixed list of all of a project's tags), prefix with a namespace dot: `topic · Transit`. When inside a single-namespace context (the "Tech" tab on the projects sidebar), just the title.

## Filtering semantics

- Repeated `?tag=` parameters: **AND** across them. `?tag=tech.react&tag=topic.transit` means projects tagged with both. (Matches laddr behavior, which only supported a single tag filter; we extend to multi-tag AND.)
- An optional future "OR within namespace, AND across namespaces" semantics is desirable but defer.

## Tag creation policy

- **Staff and administrators** can create tags directly through `POST /api/tags` or implicitly by including a previously-unknown slug in a project/person/role tag list.
- **Users** can only assign existing tags. An unknown slug in their PATCH request returns `422 validation_failed` with `error.code = "tag_not_found"` and a hint to ask staff to add it.
- This is a tradeoff: the laddr tag space accumulated near-duplicates (e.g., `topic.maps`, `topic.mapping`, `topic.gis`). v1 keeps the gate so the taxonomy stays clean. If it proves too restrictive, lift the gate; if it proves too lax with staff, add an explicit moderation queue.

## Tag merge

Staff can merge two tags via `PATCH /api/tags/:handle { mergeInto: 'other.handle' }`. The source tag is deleted; all its `tag-assignments` records are reassigned to the target tag in the same commit. The merge target must be in the same namespace.

## Facets

`metadata.facets.byTopic`, `byTech`, `byEvent`, `byStage` (for projects) reflect the **unfiltered** corpus by default — so the sidebar counts represent "if I clicked this, here's how many I'd see," not "of my current filtered subset." This matches user expectation on every faceted browse and avoids the dropdown-to-zero problem.

When the user has applied filters, the facets still show whole-corpus counts; the difference is that the *active* filter chips above the grid show their own count after filtering.

## Migration from laddr

- laddr's `tags.Handle` was a single string like `tech.flutter`. On import we split on the first `.`:
  - `namespace = handle.split('.')[0]` if it matches one of `{topic, tech, event}`, else default to `topic`
  - `slug = handle.split('.').slice(1).join('-')`
  - `title = preserved from laddr`
- After import, a staff pass merges near-duplicates (e.g., `topic.maps` + `topic.mapping` → keep `mapping`, redirect both). This is a manual curation step, not automated.
