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

Two sources write the same record shape into the **`person-evaluations`** sheet
(path template `${personSlug}/${evaluator}` — one record per (person, evaluator)):

1. **Machine evaluators** (heuristic, LLM passes) run offline in the **private
   spam-detection repo** (`codeforphilly-spam-detection`), which also holds the
   Slack-derived inputs. That material — public-channel message text, Slack
   identities, LLM prose about named people — never enters the public data repo.
2. **Human votes** are cast by staff on the site ([api/moderation.md](../api/moderation.md))
   and committed to **`published`** in this repo as `evaluator = "human:<voterSlug>"`,
   authored by the voter. They are small, summary-only, and attributable, which is
   what a public civic dataset can carry.

Each record:

| Field | Meaning |
| ----- | ------- |
| `personSlug` | the evaluated person |
| `evaluator` | model/run id (e.g. `haiku-2026-05`) or `human:<voterSlug>` |
| `verdict` | `"spam"` \| `"legit"` \| `"uncertain"` |
| `confidence` | 0–1 (LLM); absent on heuristic records, which carry `score` instead; `1` on human votes |
| `flags` | array of short reason tags |
| `reasoning` | free-text justification (optional on human votes) |
| `evaluatedAt` | ISO 8601 UTC |

Machine evaluations stay in the private repo; the runtime never loads them. The
pipeline reads machine records from its own repo and human votes from
`published`, aggregates, and applies the result to `published`.

## Per-person verdict aggregation

A person may have multiple evaluator records. The aggregate decision is
deliberately **conservative — only confident spam is pruned**:

> **A human vote is final.** If any `human:*` records exist for the person, the
> latest one decides: `spam` → pruned (membership protection does not apply —
> a person looked at the profile); `legit` → kept.
>
> Otherwise a person is **pruned as spam** iff they have at least one `spam`
> verdict with `confidence ≥ SPAM_CONFIDENCE_THRESHOLD` (default **0.8**), no
> `legit` verdict at any confidence, **and no `project-membership`** (real
> project involvement overrides any machine verdict). Heuristic records carry
> a `score`, not a `confidence`, and therefore never prune on their own: the
> pipeline must LLM-confirm the heuristic-spam bucket (`evaluate-llm --filter spam`)
> before pruning, or those accounts stay. Otherwise they are **kept** — this
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

The runtime loads exactly one evaluation sheet: `person-evaluations` from
`published`, which by construction holds only human votes. It uses them for the
admin members screen and for the vote side effect (a `spam` vote deactivates the
person immediately — [person-lifecycle.md](./person-lifecycle.md)); the public
read services stay spam-unaware. After a prune, `published` holds
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
