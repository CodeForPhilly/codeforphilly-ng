# Spam detection

The `codeforphilly-data` site has accumulated tens of thousands of legacy signups, the majority of which are spam — SEO link drops, gambling / adult / cleaning-service promotional bios, foreign-language commercial content, and so on. This document describes the multi-pass evaluation system that scores every person record and the workflow for refreshing the evaluations as new data arrives.

> See also: the [codeforphilly-data repo](https://github.com/CodeForPhilly/codeforphilly-data), currently on the `spam-detection` branch where the scripts, sheet configs, and evaluation data all live.

## Where everything lives

All work — scripts, sheet configs, and evaluation records — currently sits on the `spam-detection` branch of `codeforphilly-data`. Eventually this will migrate (scripts + configs up to `empty`, eval data down to `published`), but for now treat `spam-detection` as the source of truth for the spam moderation surface.

## Data model

Four sheets back the system, all defined under `.gitsheets/` in `codeforphilly-data`:

| Sheet | Path template | Purpose |
|---|---|---|
| `person-evaluations` | `${{ personSlug }}/${{ evaluator }}` | One verdict per (person, evaluator). Multiple evaluators coexist per person. |
| `slack-presence` | `${{ personSlug }}` | Per-person Slack snapshot: channel membership, message count, recent messages, spam-message aggregates. |
| `slack-channels` | `${{ id }}` | Workspace channel catalog (id, name, member count, is-default, etc.). |
| `slack-message-evaluations` | `${{ channelId }}/${{ ts }}` | Per-message LLM verdict. Used to compute per-user spam-message tallies. |

None of these sheets have inline `[gitsheet.schema]` blocks today — validation deferred until the schemas stabilize and migrate upstream into `@cfp/shared/schemas`.

## Pipeline

Four steps, each idempotent. Run in order:

```
fetch-slack-presence            → slack-presence + slack-channels
evaluate-slack-messages         → slack-message-evaluations (+ slack-presence spam aggregates)
evaluate-heuristic              → person-evaluations (evaluator=heuristic-v1)
evaluate-llm                    → person-evaluations (evaluator=haiku-2026-05)
```

### 1. `fetch-slack-presence`

Pulls workspace members, public channels, channel membership, and channel history from Slack. All responses cached under `.slack-cache/` so reruns are cheap (only new API hits cost Slack rate-limit budget).

```bash
npm run fetch-slack                  # uses cache where present
npm run fetch-slack -- --refresh     # force re-fetch from Slack
```

Auth: `SLACK_BOT_TOKEN` in `.env`. Currently a user token (xoxp) acting as `chris`, which gives broader public-channel-history visibility than a bot token. Required scopes (user-token equivalents): `users:read`, `channels:read`, `channels:history`.

Output:

- `slack-channels`: one record per channel
- `slack-presence`: one record per person who's in Slack, with channel ids joined, message counts, last 20 message snippets, default/non-default channel breakdown

The CFP workspace's default-channels list is hardcoded in the script (`#general` + 9 channels from the workspace's auto-join config). Edit `DEFAULT_CHANNELS` in `scripts/fetch-slack-presence.ts` if that changes.

### 2. `evaluate-slack-messages` (Pass B)

Per-message Haiku spam evaluator. Reads `.slack-cache/history_*.json`, filters trivial messages (text < 20 chars without URL, subtypes, bots), and batches 25 messages per Haiku call. System prompt holds the rubric and is prompt-cached.

```bash
npm run evaluate-slack-messages                    # full scan
npm run evaluate-slack-messages -- --limit 1000    # cap (testing)
npm run evaluate-slack-messages -- --channel CXXX  # single channel
```

Cost at current corpus volume (~119k raw messages, ~52k after filtering): ~$13.

Writes:

- `slack-message-evaluations`: one record per evaluated message
- Aggregates back onto `slack-presence`: `spamMessageCount`, `spamMessageSamples` (up to 5)

Per-channel verdict cache lives in `.slack-cache/message-evals_<channel>.json`. Re-runs skip messages already evaluated.

### 3. `evaluate-heuristic`

Mueller-adapted rule set, scoped to the data available here (no email, IP, sessions — those are PII and live elsewhere). Rules combine:

- bio-content patterns (markdown/HTML/BBCode commercial links, foreign-charset SEO bio)
- name patterns (random, doubled-uppercase, slug-name-numbered)
- positive signals (project memberships, project updates, Slack channel-active, Slack non-default channels)
- compound Pass-B-derived signals (`slack-spam-messages-many` is conclusive at -500; `slack-spam-messages-some` at -300)

```bash
npm run evaluate-heuristic
npm run evaluate-heuristic -- --dry-run          # tally only, no writes
npm run evaluate-heuristic -- --slug forager     # single person
```

Idempotent — re-running with unchanged data produces no commit. Free (no LLM calls).

### 4. `evaluate-llm` (Pass A)

Per-person Haiku evaluator. Builds the full profile for a person (bio, projects, memberships, buzz, updates, Slack presence with sample messages, Pass B spam aggregates, tags) and asks Haiku for a spam/legit/uncertain verdict with reasoning.

```bash
npm run evaluate-llm                            # uncertain bucket (default)
npm run evaluate-llm -- --filter all            # entire population
npm run evaluate-llm -- --slug forager          # single person
npm run evaluate-llm -- --concurrency 20        # faster
```

Defaults to evaluating only people the heuristic flagged `uncertain`, since the obvious cases are already decided. Cost on the uncertain bucket (~22k people): ~$45 at concurrency=5; ~50 min wall-clock at concurrency=20.

Per-person cache at `.llm-eval-cache/<evaluator>.json`, flushed every 50 evaluations — runs are resume-safe.

**Core rubric rule:** spam is determined by **content posted**, not by absence of activity. A person with zero engagement and no spammy content anywhere is `legit` — leave them alone. We only flag accounts whose posted content (bio, Slack messages, etc.) is actually spammy.

## Verdict aggregation

`person-evaluations` is keyed `personSlug/evaluator`, so multiple evaluator opinions coexist per person. To compute the authoritative verdict for a given slug, apply priority:

```
1. Any `human:*` evaluator        → use that  (manual override is final)
2. Latest `haiku-*` evaluator     → use that  (most recent LLM is current)
3. Latest `heuristic-*` evaluator → use that
4. No record                      → treat as legit (default-allow per
                                     "leave alone" rubric)
```

When new evaluator versions ship (e.g. `haiku-2026-06` with rubric improvements), older versions remain for diff and historical comparison but are superseded for aggregation purposes.

## Manual overrides

To override an LLM verdict for one person — for example, to mark a mis-flagged spammer as legit, or to confirm a high-confidence-spam call as definitely-spam before a deletion pass — upsert a `human:<your-handle>` record:

```bash
gitsheets-axi upsert person-evaluations --data '{
  "personSlug": "ackrolix123",
  "evaluator": "human:chris",
  "verdict": "legit",
  "confidence": 1.0,
  "flags": ["manual-override"],
  "reasoning": "Confirmed not spam after manual review",
  "evaluatedAt": "2026-05-20T15:30:00.000Z"
}'
```

Because the path template is `${{ personSlug }}/${{ evaluator }}` and `evaluator` is `human:chris`, the file lands at `person-evaluations/ackrolix123/human:chris.toml`. Verdict aggregation will pick it up automatically.

To unset a human override, `gitsheets-axi delete person-evaluations ackrolix123/human:chris`.

## Refreshing evaluations after new data arrives

`legacy-import` snapshots and live API writes land new + updated person records on `published`. To refresh:

```bash
# 1. Pull latest data
git fetch origin published
git merge origin/published     # or rebase onto spam-detection's data work

# 2. Refresh Slack snapshot (cheap — cache hits if no new channels)
npm run fetch-slack

# 3. Re-eval messages (only new messages since last run)
npm run evaluate-slack-messages

# 4. Re-run heuristic on everyone (idempotent, free, fast)
npm run evaluate-heuristic

# 5. LLM-eval the new uncertain bucket
npm run evaluate-llm
```

The heuristic re-evaluates everyone (deterministic, fast, free). Pass A skips slugs already in its cache — only new uncertains cost LLM tokens. Estimate: typical refresh after a `legacy-import` snapshot is dominated by Pass A's cost on newly-imported uncertain accounts — usually under $1 unless a huge batch of new signups landed.

### Stale-eval detection

When source records get updated (e.g., a previously-empty profile gets a new bio in a re-imported snapshot), the existing evaluation may no longer reflect the current data. The intended re-eval trigger is `person.updatedAt > evaluation.evaluatedAt`. The current scripts don't implement this filter — they just skip cached entries — so to force re-eval on a slug whose source changed, delete the cache entry first or use `--refresh`.

## Applying spam decisions

Currently the eval records are advisory — they describe verdicts but don't mutate the source data. The plan is to eventually run a **spam-purge** pass that hard-deletes confirmed-spam records and their associated content (memberships, buzz, updates) from `published`. Git history preserves everything for recovery; the deployed app no longer sees them.

Until that purge is written and run, code on the read path can filter person-evaluations records inline:

```typescript
const evals = await evaluationsSheet.queryAll({ personSlug });
const verdict = pickVerdict(evals);  // human > haiku > heuristic
if (verdict === 'spam') return null; // skip this person
```

No `tag-assignments` or moderation tags are used — verdicts live entirely in `person-evaluations` as the separate, dedicated record set.

## Inspection / auditing

Quick checks for sanity:

```bash
# Distribution across all evaluations
gitsheets-axi query person-evaluations --limit 1 \
  | head -1   # confirms record count

# Sample some spam verdicts
gitsheets-axi query person-evaluations --filter verdict=spam --limit 20

# Sample low-confidence calls (most likely human-review candidates)
# (needs a small jq pass since gitsheets-axi has no numeric-range filter)
gitsheets-axi query person-evaluations --filter verdict=spam --limit 10000 \
  | jq '... | select(.confidence < 0.85)'

# What did the LLM say about one person?
gitsheets-axi query person-evaluations --filter personSlug=forager
```

For deep inspection of an individual profile (what Haiku actually saw):

```bash
cd codeforphilly-data
npm run profile -- forager
```

## Cost reference

For the initial run on the full historical corpus (~31,470 people, ~119k Slack messages):

| Step | Cost |
|---|---|
| `fetch-slack-presence` | $0 (Slack API is free) |
| `evaluate-slack-messages` (Pass B) | ~$13 |
| `evaluate-heuristic` | $0 |
| `evaluate-llm` (Pass A on uncertain) | ~$45 |
| **Total initial spend** | **~$58** |

Incremental refreshes after `legacy-import` snapshots are dominated by Pass A on newly-imported accounts and typically run well under $1.

## Final distribution (initial run, 2026-05-20)

```
spam      19,422  (61.7%)  — heuristic-caught + Pass A on uncertain
legit     11,819  (37.6%)
uncertain     28  (0.09%)  — review backlog
```

The 28 uncertain are the small set worth eyeballing for tuning the rubric or supplying manual `human:*` overrides.
