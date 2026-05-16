# Behavior: Project Stages

## Rule

Every project has exactly one `stage` from a fixed seven-value enum that signals the project's lifecycle position. Stages are advisory — they don't gate any action — but they drive sorting, visual treatment, and filter facets across the site.

## Applies To

- [data-model.md#project](../data-model.md#project) — `stage` enum column
- [api/projects.md](../api/projects.md) — stage filter & sort
- [screens/projects-index.md](../screens/projects-index.md) — stage tab + chips + sort
- [screens/project-detail.md](../screens/project-detail.md) — progress-bar header + stage badge
- [screens/project-edit.md](../screens/project-edit.md) — stage selector

## The seven stages

The order matters: this is the lifecycle progression, the rank used for sorting by stage, and the order presented in the stage selector.

| Rank | Stage | Description | Progress bar | Color tone |
| :--: | ----- | ----------- | :----------: | ---------- |
| 0 | `commenting` | Initial status — it's an idea people are commenting on | 10% | warning (yellow) |
| 1 | `bootstrapping` | People and resources are being recruited to start | 30% | warning |
| 2 | `prototyping` | Something is being built | 60% | info (blue) |
| 3 | `testing` | Something has been built and some people are using it | 85% | info |
| 4 | `maintaining` | The project is publicly accessible, useable, and responding to ongoing feedback | 100% | success (green) |
| 5 | `drifting` | The project is still usable but not being actively maintained | 100% (faded) | warning |
| 6 | `hibernating` | The project is not currently usable or maintained | 100% (faded) | danger (red) |

The description column is the canonical short text. Render it in tooltips on stage badges and in the help dialog the project detail page exposes via "What does this stage mean?".

## Transition policy

v1 imposes no transition restrictions. Anyone permitted to edit a project (`maintainer | staff`) can set any stage.

We track the desired-but-deferred policy for a future release:

> A project moves forward through stages 0→4 freely. Backward moves (e.g., `maintaining → prototyping`) require a confirmation. Moves to `drifting` or `hibernating` are reachable from any active stage. Moves *out of* `hibernating` go back to `bootstrapping` rather than the previous active stage.

When that policy ships, this section becomes the rule and the v1 carve-out goes in [deferred.md](../deferred.md).

## Sorting

When `?sort=stage` is applied to the projects list, sort ascending by the rank above (`commenting → hibernating`). Use `?sort=-stage` for the reverse (most-mature first). The default sort surface on the projects index does not include `stage`; `-updatedAt` is the default.

## Auto-aging (deferred)

We may eventually add a background job that auto-flips inactive projects to `drifting` after 6 months without an update/buzz/membership change, and to `hibernating` after 12 months. Not in v1 — the staleness on the live site (lots of `Hibernating` rows) tells us we want this, but a stricter help-wanted experience is the first lever to try.

## Migration from laddr

laddr stored stages in `TitleCase` (`Commenting`, `Bootstrapping`, etc.). The import lowercases. Distribution at time of writing:

```
Hibernating    (most rows)
Maintaining    ...
Prototyping    ...
Testing        ...
Bootstrapping  ...
Drifting       ...
Commenting     (fewest)
```

The cutover spec calls this out — the rewrite is going to *inherit* a directory dominated by hibernating projects on day one. The home page featured-projects mechanism is the primary defense against that being the first impression.
