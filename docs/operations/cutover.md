# Cutover runbook

The sequenced playbook for moving codeforphilly.org from legacy laddr to the
rewrite. Mirrors the timeline in [plans/cutover-prep.md](../../plans/cutover-prep.md)
and the policy in [specs/behaviors/account-migration.md#cutover-window-policy](../../specs/behaviors/account-migration.md#cutover-window-policy).

> Companion docs: [cutover-announcement.md](cutover-announcement.md) (Slack +
> email templates) and [cutover-rollback.md](cutover-rollback.md) (what to do
> if it goes sideways). For routine ops see [deploy.md](deploy.md),
> [runbook.md](runbook.md), [secrets.md](secrets.md).

## Roles

| Role | Responsibility |
|------|----------------|
| **Cutover lead** | Owns the timeline; the only person who runs the actual T-0 commands. |
| **Comms lead** | Owns Slack + email announcements; on standby for member questions. |
| **Engineering second** | Runs reconciliation + dry-run; co-pilot for cutover lead at T-0. |
| **On-call** | Watches `/api/health` and the alerts channel during T-0 → T+24h. |

These can be the same person at small org scale, but the role assignments
should be explicit in the cutover Slack post.

## Timeline at a glance

| When | What | Reversible? |
|------|------|-------------|
| T-7 days | Announce; freeze write workflow on legacy site | Yes |
| T-3 days | Final staging-rehearsal `cutover-dry-run.ts` | Yes |
| T-1 day | Final import from live laddr JSON; verify counts | Yes |
| T-0      | DNS flip, maintenance page comes down | **Point of no return** when first new sign-in lands |
| T+1h     | Active monitoring; smoke-test public flows | Yes (rollback) |
| T+24h    | Post-cutover all-clear in Slack | Yes (rollback) |
| T+90d    | Reminder mailout to unclaimed Persons | Information-only |
| T+180d   | Delete unclaimed `LegacyPasswordCredential` rows | Information-only |

## T-7 days: announce + freeze

1. Post the cutover announcement from [cutover-announcement.md](cutover-announcement.md)
   to `#announcements` and email all members via Resend.
2. Lower DNS TTL on `codeforphilly.org` to 60s. Verify with `dig`.
3. **Freeze legacy writes.** Either put a banner on the legacy site asking
   members to hold off on edits, or flip a feature flag making it read-only.
   The point is to reduce the size of the "delta" between the T-3 dump and
   T-0 dump.
4. Notify cluster operators that you'll be moving production traffic next week.
5. Confirm the GitHub OAuth app's production redirect URI is registered.
6. Confirm the Slack SAML connection is **pre-staged** (Slack admin has the
   new IdP metadata; not active yet).
7. Confirm sealed-secrets are in the production cluster — see
   [secrets.md](secrets.md). Missing secrets at T-0 is the most common
   single failure mode.

## T-3 days: full staging rehearsal

The rehearsal must run end-to-end against `codeforphilly-rewrite-staging.k8s.phl.io`
and produce a passing report.

1. Run the dry-run script against the live laddr site:

   ```bash
   npm run -w apps/api script:cutover-dry-run -- \
     --source-host=codeforphilly.org \
     --data-repo=/scratch/dry-run-data \
     --target=https://codeforphilly-rewrite-staging.k8s.phl.io \
     --json=/scratch/dry-run-T3.json
   ```

2. Review the JSON report:
   - `stages.import` must be `true`.
   - `stages.countDiff` must be `true` (every sheet's imported count is within tolerance of the server's reported `total`).
   - `stages.smoke` must be `true` (all probes return 2xx/3xx).
3. Manually verify Slack SAML continuity for a test laddr user.
   This is the highest-stakes single check. See
   [specs/api/saml.md](../../specs/api/saml.md): a user's `slackSamlNameId`
   must equal their pre-cutover Slack NameID byte-for-byte.
4. File any anomalies, schedule a re-run before T-0 if anything fails.

If the dry-run reports unexpectedly low imported counts for any sheet,
**stop**. Either the laddr JSON shape drifted (a new field broke Zod
validation) or the importer needs an update. Don't proceed to T-0 with
silently-dropped data.

## T-1 day: production migration

The production import is a snapshot commit on the `legacy-import` branch of
the production data repo. Private data (emails, password hashes) is **not**
populated by this importer — that is a separate one-shot run of the
credentials importer; see
[legacy-credentials-import.md](./legacy-credentials-import.md) for the
CSV format, run command, and deploy steps (sandbox PVC or production
S3-compat bucket).

1. **Bare-clone** the production data repo locally — the importer matches
   the running pod's invariant ([storage.md → "The data clone is bare"](../../specs/behaviors/storage.md))
   and `openPublicStore` rejects a non-bare path:

   ```bash
   git clone --bare git@github.com:CodeForPhilly/codeforphilly-data.git /scratch/codeforphilly-data
   ```

   For one-off imports the convention is to clone into `/tmp` and clean up
   after pushing — keeps your working data-repo clone clean.

2. Run the importer against the production target — **with `--dry-run` first**:

   ```bash
   npm run -w apps/api script:import-laddr -- \
     --source-host=codeforphilly.org \
     --data-repo=/scratch/codeforphilly-data \
     --branch=legacy-import \
     --dry-run
   ```

3. Review the dry-run report. Warnings about slug normalization, missing tag
   namespaces, and skipped HTTP-only buzz URLs are expected; zod errors are
   not.
4. Run the importer **without `--dry-run`**. This creates one snapshot
   commit on the `legacy-import` branch.
5. Push the `legacy-import` branch to the production GitHub remote.
6. Merge `legacy-import` into `main` (operator step — review the diff in a
   PR, resolve any path-template conflicts, then merge).
7. **Prune confident-spam** from the runtime branch before it goes live. The
   merge in step 6 re-adds the full raw import (spam included); the deployed pod
   cannot hold the unpruned set in memory, so this step is **mandatory** after
   every import/merge. See
   [spam-detection.md → Applying spam decisions](./spam-detection.md#applying-spam-decisions--the-prune-step):

   ```bash
   npm run -w apps/api script:prune-spam -- \
     --data-repo=/scratch/codeforphilly-data \
     --evaluations-ref=spam-detection \
     --branch=published \
     --dry-run            # review counts, then drop --dry-run and push the branch
   ```

   Newly-imported accounts with no spam verdict yet are kept (the rule only
   removes *confident* spam), so an incomplete eval pass is safe — it just keeps
   more people than strictly necessary.
8. Run reconciliation:

   ```bash
   npm run -w apps/api script:reconcile -- --json=/scratch/reconcile-T1.json
   ```

   Every counter should be zero in the orphan + inconsistent categories.
   If anything is flagged, **stop** and investigate before T-0.

9. Deploy the rewrite to production via the production GitOps repo (a
   sibling to [`cfp-sandbox-cluster`](https://github.com/CodeForPhilly/cfp-sandbox-cluster)
   — see [deploy.md](deploy.md)). The pod will boot against the
   just-imported data + bucket but receive no public traffic yet (Gateway
   hostname not pointed at the prod LoadBalancer yet).

10. Smoke-test the production hostname through `/etc/hosts` or via direct
    cluster IP: hit `/api/health`, `/api/people/<known-slug>`,
    `/api/projects/<known-slug>`. Don't yet flip DNS.

## T-0: cutover

At T-0 the team is on a call together. Cutover lead at the keyboard;
engineering second has the runbook open and reads checks back.

1. **0:00 — maintenance page.** Put a static maintenance page on
   the legacy `codeforphilly.org`. (Legacy site can stay up under
   the hood; we just don't want users hitting a half-state.)
2. **0:01 — final delta.** Re-run the importer against the live laddr site
   into the same data-repo path. UUIDs are read-forward from the previous
   snapshot's tree, so the diff between this commit and the T-1 commit is
   exactly the records that changed upstream since T-1. **Then merge into the
   runtime branch and re-run the spam prune (step 7 above) before the pod
   reloads** — the final-delta merge re-adds raw import records, so an unpruned
   reload would re-bloat memory.
3. **0:05 — DNS flip.** Update the `codeforphilly.org` A/CNAME to point
   at the rewrite's ingress. TTL was lowered to 60s a week ago, so
   propagation completes in under two minutes for most resolvers.
4. **0:10 — verify.** From four different networks (lead's laptop,
   engineering second's tethered phone, a VPN exit node, a CFP volunteer's
   home network), confirm `codeforphilly.org` serves the rewrite. Test:
   - Anonymous browse of `/projects` and `/members` (read paths).
   - Anonymous browse of a known legacy URL form like
     `/projects?ID=10` — must 301 to the slug URL.
   - A team member signs in via GitHub OAuth; if their account is in
     the laddr dataset they'll see the claim flow.
   - Slack SAML: a team member logs out of Slack and re-authenticates
     via the new IdP. Verify their Slack identity is preserved.
5. **0:15 — remove maintenance page.** The legacy site can stay up
   read-only forever; we just need it not to be the public landing page.

**Point of no return:** the moment **a real user creates a new record**
on the rewrite (a project, an update, a buzz post, even just their first
sign-in writing a `PrivateProfile`), data starts to diverge between the
two systems. Up to that point, a rollback (DNS flip back, see
[cutover-rollback.md](cutover-rollback.md)) is harmless. After it, a
rollback would discard those new records.

## T+1h: monitoring window

For the first hour after DNS flip, the cutover lead and engineering second
watch:

- `kubectl -n codeforphilly logs deploy/codeforphilly -f` — error rates
  (look for spikes in `ERROR` or `WARN`).
- `/api/health` and `/api/health/ready` via UptimeRobot / healthchecks.io.
- The cluster log aggregator (if wired up) — search for stack traces.
- The `#alerts` Slack channel — anything fired by the WARN+ webhook.

Specific things to watch:

- **OAuth callback failure rate.** Should be ~0%. A 4xx spike here
  indicates a misconfigured redirect URI or a GitHub OAuth app issue.
- **SAML assertion failure rate.** Should be ~0%. A spike here means
  the Slack integration is rejecting our assertions — usually a NameID
  mismatch.
- **Push daemon errors.** Surface as `git push failed` in logs; means
  the data repo's deploy key is wrong or rate-limited.

If any of these alarm: pause, triage, decide rollback vs forward-fix in
under 15 minutes.

## T+24h: all-clear post

If everything is stable through the first day:

1. Post a success message to `#announcements` from
   [cutover-announcement.md](cutover-announcement.md).
2. Add a note to the rewrite README that legacy laddr is decommissioned.
3. Schedule the T+90 mailout to run automatically (see below).

## T+7 days: reconciliation check

Re-run reconciliation:

```bash
npm run -w apps/api script:reconcile
```

After a week of real-world use, any orphans or inconsistencies that show
up are likely from a real bug (dual-write coordination, racing OAuth
callbacks). File issues; fix before T+90.

Schedule reconciliation weekly via a CI cron from this point on. Run the
script against production via `kubectl exec` into the deployed pod, or
configure a separate cron Deployment.

## T+90 days: unclaimed-account mailout

The active claim window from [account-migration.md](../../specs/behaviors/account-migration.md#cutover-window-policy)
ends at T+90. Send the reminder mail to anyone whose laddr account is
still unclaimed:

1. **Dry-run first** to inspect the recipient list:

   ```bash
   npm run -w apps/api script:cutover-mailout -- --dry-run \
     --json=/scratch/mailout-dry.json
   ```

2. Spot-check the recipient list — sample 5 entries, confirm each
   matches an unclaimed legacy Person.
3. Send:

   ```bash
   RESEND_API_KEY=... npm run -w apps/api script:cutover-mailout -- --send
   ```

4. Monitor Resend dashboard for bounces. Hard bounces are expected —
   defunct email providers are exactly why these accounts are
   unclaimed.

## T+180 days: drain legacy passwords

At T+180 the remaining `LegacyPasswordCredential` records are deleted.
This is irreversible — any user who hadn't claimed by then must go through
the staff-approval path from [account-migration.md](../../specs/behaviors/account-migration.md#c-staff-approval).

Run reconciliation with the legacy-purge follow-up (TBD: a small script
that calls `privateStore.deleteLegacyPassword` for every credential whose
Person is still unclaimed and whose `importedAt` is older than 180 days).

## Pre-cutover checklist

Before T-0 the cutover lead confirms each of these in writing in the
cutover Slack thread:

- [ ] DNS TTL lowered to 60s at least 7 days ago
- [ ] Sealed-secrets present in the production cluster (every var in
      [secrets.md inventory](secrets.md))
- [ ] GitHub OAuth app production redirect URI registered
- [ ] Slack SAML metadata pre-staged with workspace admin
- [ ] Data-repo deploy key uploaded to the data-repo's deploy-keys page
- [ ] Production S3 bucket exists with versioning enabled
- [ ] Staging dry-run from T-3 reports all stages passing
- [ ] On-call schedule covers T-0 through T+24h
- [ ] Rollback procedure rehearsed (see [cutover-rollback.md](cutover-rollback.md))

## Known unknowns

- **Single big import commit size.** The data repo will land thousands
  of `.toml` files in one push. Confirm with the gitsheets transaction
  API that this works at scale; chunk by entity type (one commit per
  sheet) if not. The importer already commits per-sheet.
- **GitHub OAuth rate limits.** A surge of users signing in within a
  cutover window could brush against GitHub's per-app rate limit
  (~5000/hr). Probably fine at CFP scale (~1240 members); worth
  monitoring.
- **Newsletter email bounces.** First OAuth sign-in refreshes
  `PrivateProfile.email` to GitHub primary. Users who never sign in
  keep their pre-cutover email and may bounce on newsletter sends.
  Acceptable; cleaned up by standard bounce handling.
