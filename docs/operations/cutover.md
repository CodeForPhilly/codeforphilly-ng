# Cutover runbook

The sequenced playbook for moving codeforphilly.org from legacy laddr to the
rewrite. Grew out of [plans/cutover-prep.md](../../plans/cutover-prep.md);
the account-side policy is [specs/behaviors/account-migration.md](../../specs/behaviors/account-migration.md).

> Companion docs: [cutover-announcement.md](cutover-announcement.md) (Slack +
> email templates) and [cutover-rollback.md](cutover-rollback.md) (what to do
> if it goes sideways). For routine ops see [deploy.md](deploy.md),
> [runbook.md](runbook.md), [secrets.md](secrets.md),
> [legacy-credentials-import.md](legacy-credentials-import.md).

## Where things run

| | GitOps repo | Namespace | Host |
|---|---|---|---|
| **Production** (the rewrite) | [`cfp-live-cluster`](https://github.com/CodeForPhilly/cfp-live-cluster) | `codeforphilly-ng` | `https://next.codeforphilly.org` before cutover; `https://codeforphilly.org` after |
| **Legacy laddr** | `cfp-live-cluster` | `code-for-philly` | `https://codeforphilly.org` before cutover; `https://codeforphilly.live.k8s.phl.io` throughout |
| **Sandbox** | [`cfp-sandbox-cluster`](https://github.com/CodeForPhilly/cfp-sandbox-cluster) | `codeforphilly-rewrite-sandbox` | `https://next-v2.codeforphilly.org` |

There is no separate staging environment; the sandbox plays that role. The
production pod is already running and serving real data at
`next.codeforphilly.org` — cutover changes which hostnames reach it, nothing
about the pod itself.

**Cutover needs no DNS change.** DNS for `codeforphilly.org` is managed in
[`CodeForPhilly/ops`](https://github.com/CodeForPhilly/ops) (`tf/dns`,
OpenTofu, Cloud DNS project `openphl-1177`). `codeforphilly.org`,
`*.codeforphilly.org` and `*.live.k8s.phl.io` all already resolve to the
live cluster's Envoy gateway. Which app answers for a hostname is decided
by the Gateway listeners in `cfp-live-cluster/_gateways/`, so T-0 is a
single commit in that repo. There is no TTL to lower and no propagation to
wait on.

## Roles

| Role | Responsibility |
|------|----------------|
| **Cutover lead** | Owns the timeline; the only person who merges the T-0 commit. |
| **Comms lead** | Owns Slack + email announcements; on standby for member questions. |
| **Engineering second** | Runs the data refresh + rehearsal; co-pilot for cutover lead at T-0. |
| **Slack workspace admin** | Owns the SAML SSO settings in Slack (SSO optional, Test configuration, SSO URL update). |
| **On-call** | Watches pod logs and `/api/health` during T-0 → T+24h. |

These can be the same person at small org scale, but the role assignments
should be explicit in the cutover Slack post.

## Timeline at a glance

| When | What | Reversible? |
|------|------|-------------|
| T-7 days | Announce; freeze write workflow on legacy site; Slack SSO to "optional" | Yes |
| T-3 days | Rehearsal: dry-run against sandbox, smoke prod at `next.codeforphilly.org`, Slack "Test configuration" | Yes |
| T-1 day | Data refresh (import → merge → prune → push); credentials load; verify counts | Yes |
| T-0 | Gateway hostname move + `CFP_SITE_HOST` flip (one commit); Slack SSO URL update | **Point of no return** when first new record lands |
| T+1h | Active monitoring; smoke-test public flows | Yes (revert) |
| T+24h | Post-cutover all-clear in Slack | Yes (revert) |
| T+7d | Reconciliation check | Information-only |

There is deliberately **no** T+90 claim-window mailout and **no** T+180
password purge. Per [account-migration.md](../../specs/behaviors/account-migration.md#sunset-deferred),
legacy password sign-in persists indefinitely with a link-GitHub nag on
`/account`; any future sunset is undated and needs its own spec change first.

## T-7 days: announce + freeze

1. Post the cutover announcement from [cutover-announcement.md](cutover-announcement.md)
   to `#announcements` and email all members via Postmark.
2. **Freeze legacy writes.** Either put a banner on the legacy site asking
   members to hold off on edits, or flip a feature flag making it read-only.
   The point is to reduce the size of the "delta" between the T-1 refresh
   and the T-0 refresh.
3. Notify cluster operators that you'll be moving the apex hostname next week.
4. **GitHub OAuth.** The production app is the org-owned OAuth app
   **"Code for Philly"** (the laddr one was renamed "Code for Philly
   (legacy)"). Its callback is registered on the apex; GitHub accepts
   redirects to subdomains of the registered callback, which is why
   `next.codeforphilly.org` already works against it. **No edit is needed
   at cutover.** Confirm the app still exists and its client ID matches the
   one in `codeforphilly-secrets`.
5. **Slack SAML — lockout insurance first.** Slack SSO cannot be tested in a
   throwaway workspace (SAML is enterprise-only), so the real workspace is
   the only test bed. Have the Slack workspace admin set SSO to
   **"optional"** now. Members can then always fall back to email magic
   links, so a wrong SAML setting at any later step is an inconvenience,
   not a lockout.
6. Confirm the three SealedSecrets are present in
   `cfp-live-cluster/codeforphilly-ng.secrets/` and decrypted in the
   `codeforphilly-ng` namespace — see [secrets.md](secrets.md). Missing
   secrets at T-0 is the most common single failure mode.

   ```bash
   kubectl -n codeforphilly-ng get secret codeforphilly-secrets codeforphilly-saml codeforphilly-data-deploy-key
   ```

## T-3 days: rehearsal

There is no staging cluster to rehearse the hostname move itself on; what
you can rehearse is everything that happens *behind* the hostname.

1. Run the dry-run script with the sandbox as target:

   ```bash
   npm run -w apps/api script:cutover-dry-run -- \
     --source-host=codeforphilly.org \
     --data-repo=/scratch/dry-run-data \
     --target=https://next-v2.codeforphilly.org \
     --json=/scratch/dry-run-T3.json
   ```

2. Review the JSON report:
   - `stages.import` must be `true`.
   - `stages.countDiff` must be `true` (every sheet's imported count is within tolerance of the server's reported `total`).
   - `stages.smoke` must be `true` (all probes return 2xx/3xx).
3. Repeat the smoke probes by hand against production at
   `https://next.codeforphilly.org` — `/api/health/ready`,
   `/api/people/<known-slug>`, `/api/projects/<known-slug>`,
   `/projects?ID=<n>` (must 301 to the slug URL), a GitHub sign-in.
4. **Slack SAML.** In Slack's SSO settings, point the IdP metadata at
   `https://next.codeforphilly.org/api/saml/slack/metadata` and use Slack's
   **"Test configuration"** against it. The IdP entity ID it reports must be
   `https://codeforphilly.org/api/saml/slack/metadata` — that value is
   `SAML_ENTITY_ID`'s default and does not follow the host, so it is the
   same before and after cutover ([specs/api/saml.md](../../specs/api/saml.md#idp-identity-and-hosts)).
   The signing cert is the one carried over from laddr's `saml2` secret, so
   Slack keeps trusting the same cert. A test user's NameID must equal
   their pre-cutover Slack NameID byte-for-byte.
5. File any anomalies, schedule a re-run before T-0 if anything fails.

If the dry-run reports unexpectedly low imported counts for any sheet,
**stop**. Either the laddr JSON shape drifted (a new field broke Zod
validation) or the importer needs an update. Don't proceed to T-0 with
silently-dropped data.

## T-1 day: data refresh + credentials

The data repo (`CodeForPhilly/codeforphilly-data`) has **no `main`**. The
runtime-served branch is **`published`**; `legacy-import` holds the raw
importer snapshots. The refresh pipeline is always:

**import → merge `legacy-import` into `published` → prune-spam → push**

Pushing `published` fires the data repo's
`.github/workflows/notify-deployments.yml`, which POSTs the hot-reload
webhook on sandbox *and* prod; both pods rebuild in-memory state in place
with no restart ([runbook.md#hot-reload-webhook](runbook.md#hot-reload-webhook)).

The first full refresh through this pipeline ran 2026-09-09/10: **36,254**
person records imported, **22,625** left on `published` after prune. Use
those as the order-of-magnitude sanity check for your counts.

### Public data

1. **Bare-clone** the data repo — the importer matches the running pod's
   invariant ([storage.md → "The data clone is bare"](../../specs/behaviors/storage.md))
   and `openPublicStore` rejects a non-bare path:

   ```bash
   git clone --bare git@github.com:CodeForPhilly/codeforphilly-data.git /scratch/codeforphilly-data.git
   ```

2. Run the importer — **with `--dry-run` first**:

   ```bash
   npm run -w apps/api script:import-laddr -- \
     --source-host=codeforphilly.org \
     --data-repo=/scratch/codeforphilly-data.git \
     --branch=legacy-import \
     --dry-run
   ```

3. Review the dry-run report. Warnings about slug normalization, missing tag
   namespaces, and skipped HTTP-only buzz URLs are expected; zod errors are
   not.
4. Run the importer **without `--dry-run`**. This creates one snapshot
   commit on `legacy-import`. Push it.
5. **Merge `legacy-import` into `published`.** This needs a working tree
   (clone from your bare clone). Expect **thousands of conflicts** of the
   form `deleted by us / modified by them`: every previously-pruned spam
   person is absent on `published` and present (possibly modified) in the
   fresh snapshot. Resolve them all by **taking the import's version** —
   the prune step in the next step removes them again:

   ```bash
   git clone /scratch/codeforphilly-data.git /scratch/codeforphilly-data-wt
   cd /scratch/codeforphilly-data-wt
   git checkout published
   git merge origin/legacy-import || true
   git diff --name-only --diff-filter=U | xargs git checkout --theirs --
   git add -A people/                       # the conflicts are person records
   git commit --no-edit
   git push origin published:published      # back to the bare clone only — don't push to GitHub yet
   ```

   Review `git status` before the `git add`; if conflicts show up outside
   `people/`, look at them individually rather than bulk-resolving.

6. **Prune confident-spam** from `published` before it goes anywhere. The
   merge re-added the full raw import (spam included); the deployed pod
   cannot hold the unpruned set in memory, so this step is **mandatory**
   after every import/merge. See
   [spam-detection.md → Applying spam decisions](./spam-detection.md#applying-spam-decisions--the-prune-step):

   ```bash
   npm run -w apps/api script:prune-spam -- \
     --data-repo=/scratch/codeforphilly-data.git \
     --evaluations-ref=spam-detection \
     --branch=published \
     --dry-run            # review counts, then drop --dry-run
   ```

   Newly-imported accounts with no spam verdict yet are kept (the rule only
   removes *confident* spam), so an incomplete eval pass is safe — it just
   keeps more people than strictly necessary.

7. **Push `published` to GitHub.** `notify-deployments.yml` hot-reloads
   sandbox and prod. Watch the workflow run go green for both targets, then
   confirm `https://next.codeforphilly.org/api/people/<slug>` reflects a
   record you know changed upstream.

### Private data (credentials)

Emails and password hashes are **not** in the public import. They come from
the laddr MySQL database via the credentials importer and are loaded onto
the production pod's private-storage PVC — full procedure in
[legacy-credentials-import.md](./legacy-credentials-import.md). In short:

1. Export `Username, Email, Password` from `emergence-site`.`people` inside
   the laddr pod (Habitat mysql client) to a quoted CSV.
2. Run `script:import-laddr-credentials` against the bare clone's
   `published` branch to produce `profiles.jsonl` + `legacy-passwords.jsonl`.
3. `kubectl -n codeforphilly-ng cp` both files into the pod's
   `/app/private-storage/`, then `kubectl -n codeforphilly-ng rollout
   restart deploy/codeforphilly`. **Hot reload does not cover the private
   store**; the restart is required.

The first production load ran 2026-09-10: **21,761** profiles/credentials.

Re-running after real users have signed in **reverts their rehashed
(argon2id) credentials to the legacy hashes** — see the safety notes in
that doc before repeating the load at T-0.

### Confirm the deployed version

Production is pinned in `cfp-live-cluster` by two values that move
together: `.holo/sources/codeforphilly-ng.toml` (`ref = "refs/tags/vX.Y.Z"`)
and `images[].newTag` in `codeforphilly-ng/app/kustomization.yaml`. Confirm
they match the release you intend to cut over on, and that the sandbox has
run that same tag for a while.

## T-0: cutover

At T-0 the team is on a call together. Cutover lead at the keyboard;
engineering second has the runbook open and reads checks back. Legacy stays
reachable at `https://codeforphilly.live.k8s.phl.io` throughout, so a
maintenance page is optional — the switch itself is atomic per hostname.

1. **0:00 — final delta.** Re-run the T-1 public-data pipeline (import →
   merge → prune → push). UUIDs are read-forward from the previous
   snapshot's tree, so the diff between this commit and the T-1 commit is
   exactly the records that changed upstream since T-1. The push
   hot-reloads prod. Only re-run the credentials load if nobody has signed
   in at `next.codeforphilly.org` since T-1 (or you accept the rehash reset).

2. **0:05 — the cutover commit.** One commit in `cfp-live-cluster`, on a
   branch, PR'd into `main`:

   - In `_gateways/code-for-philly.yaml`: remove the `https-apex`
     (`codeforphilly.org`) and `https-www` (`www.codeforphilly.org`)
     listeners and drop those hostnames from the legacy HTTPRoute. Leave
     the `codeforphilly.live.k8s.phl.io` listener so laddr stays reachable.
   - In `_gateways/codeforphilly-ng.yaml`: add those two listeners (with
     their `certificateRefs`) and hostnames to the rewrite's Gateway +
     HTTPRoute. **Keep the existing `next.codeforphilly.org` listener** —
     it is a permanent alias.
   - In `codeforphilly-ng/app/kustomization.yaml`: change the
     `CFP_SITE_HOST` patch value from `next.codeforphilly.org` to
     `codeforphilly.org`. This drives the markdown renderer's
     internal/external link split, canonical URLs in email, and the SAML
     metadata's `SingleSignOnService` locations.

   Merge to `main`. The **"Build k8s-manifests"** workflow projects to
   `releases/k8s-manifests`, a bot opens a PR into `deploys/k8s-manifests`,
   and merging *that* PR applies. The ConfigMap change rolls the pod
   (`Recreate` strategy) — expect a short readiness gap while it re-clones
   and reloads. cert-manager issues certificates for the moved hostnames
   into the `codeforphilly-ng` namespace; allow a minute or two for ACME.

3. **0:10 — verify.** From several networks (lead's laptop, engineering
   second's tethered phone, a volunteer's home network), confirm
   `https://codeforphilly.org` and `https://www.codeforphilly.org` serve
   the rewrite with valid certificates:
   - Anonymous browse of `/projects` and `/members` (read paths).
   - A known legacy URL form like `/projects?ID=10` — must 301 to the slug URL.
   - A team member signs in via GitHub OAuth; a member with a laddr
     account signs in with their legacy password.
   - `https://next.codeforphilly.org` still works (alias).
   - `https://codeforphilly.live.k8s.phl.io` still serves laddr.

4. **0:15 — Slack SSO URL.** The Slack workspace admin updates **only the
   SSO URL** in Slack's SAML settings from
   `https://next.codeforphilly.org/api/saml/slack/sso` to
   `https://codeforphilly.org/api/saml/slack/sso` (or re-fetches the
   metadata from the apex — the entity ID and cert are unchanged). A team
   member signs out of Slack and back in via SSO. If it fails, SSO is
   "optional" so nobody is locked out; fix the URL rather than rolling back
   the gateway.

5. **0:20 — hot-reload target.** In the data repo, switch the prod URL in
   `.github/workflows/notify-deployments.yml` from
   `https://next.codeforphilly.org/...` to
   `https://codeforphilly.org/api/_internal/reload-data`. (The alias would
   keep working, but the workflow should name the canonical host.)

6. **0:25 — legacy site.** If you put up a maintenance banner at T-7, it
   can stay; laddr is now reachable only at
   `codeforphilly.live.k8s.phl.io` and can remain read-only indefinitely.

**Point of no return:** the moment **a real user creates a new record**
on the rewrite at the apex (a project, an update, a buzz post, even just
their first sign-in writing a `PrivateProfile`), data starts to diverge
between the two systems. Up to that point, reverting the cutover commit
([cutover-rollback.md](cutover-rollback.md)) is harmless. After it, a
rollback would discard those new records. Note that people have been able
to sign in at `next.codeforphilly.org` since before cutover — the rewrite's
data is already live and diverging from laddr's; "point of no return" here
is about writes that arrive *because* the apex moved.

## T+1h: monitoring window

**Be honest about what exists:** as of this writing there are no external
uptime checks and no alerts webhook ([monitoring.md](monitoring.md)
describes the target state, not the current one). For the first hour after
the hostname move, the cutover lead and engineering second watch by hand:

- `kubectl -n codeforphilly-ng logs deploy/codeforphilly -f` — look for
  spikes in `ERROR` or `WARN`.
- `curl -sS https://codeforphilly.org/api/health` and
  `.../api/health/ready` every few minutes (a shell loop is fine).
- `kubectl -n codeforphilly-ng get pods -w` — restarts or OOMKills.

Specific things to watch:

- **OAuth callback failure rate.** Should be ~0%. A 4xx spike here
  indicates a GitHub OAuth app issue (the callback URL itself should not
  need changing — see T-7).
- **SAML assertion failure rate.** Should be ~0% once the SSO URL is
  updated. A spike means Slack is rejecting our assertions — usually a
  NameID or SSO URL mismatch. Members still have magic-link fallback.
- **Push daemon errors.** Surface as `git push failed` in logs; means the
  data repo's deploy key is wrong or rate-limited.
- **Hot-reload webhook.** The next `published` push should log a
  `hot-reload` line on the prod pod via the apex URL.

If any of these alarm: pause, triage, decide rollback vs forward-fix in
under 15 minutes.

## T+24h: all-clear post

If everything is stable through the first day:

1. Post a success message to `#announcements` from
   [cutover-announcement.md](cutover-announcement.md).
2. Add a note to the rewrite README that legacy laddr is decommissioned
   (or read-only at `codeforphilly.live.k8s.phl.io`).

## T+7 days: reconciliation check

Re-run reconciliation:

```bash
npm run -w apps/api script:reconcile
```

After a week of real-world use, any orphans or inconsistencies that show
up are likely from a real bug (dual-write coordination, racing OAuth
callbacks). File issues.

**Open gap:** the reconcile script needs both the public data and the
private store. The runtime image ships only `dist/` (no `tsx`, no
`scripts/`), so it cannot run inside the prod pod as-is, and production
private data must not be copied to a laptop
([private-storage.md](../../specs/behaviors/private-storage.md)). Until the
script ships in the image or gets an in-pod entrypoint, reconciliation in
production is a manual, in-cluster exercise; treat this as a follow-up.

## Legacy password sign-in stays on

Nothing in this runbook retires legacy credentials. Migrated members keep
signing in with their laddr password for as long as they like; the only
nudge is the "Connect GitHub" banner on `/account`
([account-migration.md → The nag](../../specs/behaviors/account-migration.md#the-nag-banner-on-account)).
The spec tracks a coverage metric for *future* sunset planning; when the
numbers justify it, a separate spec change sets a date. Do not schedule a
mailout or a purge from this doc.

## Pre-cutover checklist

Before T-0 the cutover lead confirms each of these in writing in the
cutover Slack thread:

- [ ] SealedSecrets present and decrypted in `codeforphilly-ng`
      (`codeforphilly-secrets`, `codeforphilly-saml`,
      `codeforphilly-data-deploy-key`) — see [secrets.md](secrets.md)
- [ ] GitHub OAuth app "Code for Philly" exists; client ID matches the sealed value
- [ ] Slack SSO set to **optional**; "Test configuration" passed against
      the `next.codeforphilly.org` metadata
- [ ] Data-repo deploy key has write access to `codeforphilly-data`
- [ ] `notify-deployments.yml` run green for both sandbox and prod on the last `published` push
- [ ] Credentials loaded on the prod PVC; a known legacy user can sign in
      with their password at `next.codeforphilly.org`
- [ ] Sandbox dry-run from T-3 reports all stages passing
- [ ] Production pin (`.holo/sources/codeforphilly-ng.toml` +
      `codeforphilly-ng/app/kustomization.yaml`) is the intended release
- [ ] The cutover commit is drafted on a branch in `cfp-live-cluster` and
      reviewed (listeners, HTTPRoute hostnames, `CFP_SITE_HOST`)
- [ ] On-call schedule covers T-0 through T+24h
- [ ] Rollback procedure read end-to-end (see [cutover-rollback.md](cutover-rollback.md))
- [ ] **Monitoring: none wired.** Acknowledged that the T+1h window is
      watched by hand; external checks + alerts are a post-cutover follow-up
      ([monitoring.md](monitoring.md))

## Known unknowns

- **Certificate issuance on the moved listeners.** The apex and `www` TLS
  Secrets are namespaced, so cert-manager mints new ones in
  `codeforphilly-ng` after the move. Let's Encrypt rate limits are
  generous for two names, but a wedged ACME challenge would leave the apex
  serving a bad cert — that is a revert trigger.
- **GitHub OAuth rate limits.** A surge of users signing in within a
  cutover window could brush against GitHub's per-app rate limit
  (~5000/hr). Probably fine at CFP scale; worth monitoring.
- **Newsletter email bounces.** First OAuth sign-in refreshes
  `PrivateProfile.email` to GitHub primary. Users who never sign in
  keep their pre-cutover email and may bounce on newsletter sends.
  Acceptable; cleaned up by standard bounce handling.
- **Reconcile in production** — see the open gap under T+7 days.
