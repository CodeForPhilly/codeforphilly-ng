# Spam exclusion

Status: proposed

The legacy laddr import carried ~31.8k people, of which an offline evaluation
pass judged ~61% to be spam. The public runtime holds the full public dataset
in memory at boot (see [storage.md](./storage.md)); loading tens of thousands of
spam accounts is both a memory problem (a cold boot exceeded the heap budget on
the standard node size) and wrong on the merits — spam accounts should not
appear in the public, civic-transparency dataset at all.

This spec defines how spam verdicts are produced, aggregated, and applied so the
**`published` branch contains only non-spam people**. Pruning happens in the data
pipeline, not at runtime: the runtime loader is spam-unaware and simply loads
whatever `published` contains.

## Where verdicts come from

Spam evaluation runs offline and lands on the **`spam-detection`** branch of the
data repo, in the **`person-evaluations`** sheet (path template
`${personSlug}/${evaluator}` — one record per (person, evaluator)). Each record:

| Field | Meaning |
| ----- | ------- |
| `personSlug` | the evaluated person |
| `evaluator` | model/run id (e.g. `haiku-2026-05`) |
| `verdict` | `"spam"` \| `"legit"` \| `"uncertain"` |
| `confidence` | 0–1 |
| `flags` | array of short reason tags |
| `reasoning` | free-text justification |
| `evaluatedAt` | ISO 8601 UTC |

The evaluations stay on `spam-detection`; they are **not** merged into
`published` (they are bulky and not runtime data). The pipeline reads them from
`spam-detection` and applies the result to `published`.

## Per-person verdict aggregation

A person may have multiple evaluator records. The aggregate decision is
deliberately **conservative — only confident spam is pruned**:

> A person is **pruned as spam** iff they have at least one `spam` verdict with
> `confidence ≥ SPAM_CONFIDENCE_THRESHOLD` (default **0.8**), no `legit`
> verdict at any confidence, **and no `project-membership`** (real project
> involvement overrides any spam verdict). Otherwise they are **kept** — this
> includes `uncertain`, `legit`, low-confidence spam, anyone who is a project
> member, and people with no evaluation.

Rationale: false-positive spam removal is worse than keeping a borderline
account, so two signals protect a person — a single confident "legit" from any
evaluator, and any actual project membership (real engagement, not a throwaway
account). `uncertain` people are kept — inactivity is not spam. In practice
spam accounts essentially never hold a project membership, so this protection is
nearly free while it reliably spares real contributors a classifier may misjudge
on thin evidence (e.g. one off-topic intro message).

## The prune operation

Applied to `published`, re-runnably. For each pruned person:

1. Delete the `people` record.
2. Cascade-delete records that belong to that person:
   - `project-membership` where `personId` matches
   - `help-wanted-interest` where `personId` matches
   - `tag-assignment` where `taggableType = "person"` and the taggable is that person
3. Unlink (do **not** delete) `project-update` records whose `authorId` is the
   pruned person: set `authorId = null` so project history is preserved with an
   unknown author. `project-buzz` is project-scoped and needs no change.

The operation is **idempotent**: re-running with the same verdicts produces no
new changes; re-running after new verdicts prunes only the newly-confident-spam.
It coexists with runtime writes on `published` (a targeted delete of specific
records, not a full-tree replacement like the importer).

## What the runtime sees

Nothing changes in the loader or read services. After a prune, `published` holds
only kept people (legit + uncertain + unevaluated minus confident spam), so the
in-memory state, indices, and FTS are built over that smaller set. Dangling
references are avoided by the cascade, so member lists, help-wanted interest, and
person tags never point at a removed person.

## Re-runnability & operations

The prune is an operator step (a re-runnable script), run when a new evaluation
pass lands on `spam-detection`. It is documented alongside the other
operator-facing scripts. Counts (evaluated, pruned, cascade deletions, authors
unlinked) are reported each run.

## Open questions

- `SPAM_CONFIDENCE_THRESHOLD` default (0.8) — tune against the verdict
  distribution once we see false-positive/negative rates.
- Whether to later surface an admin view of pruned accounts (auditability) —
  out of scope here; the evaluations remain on `spam-detection` as the record.
