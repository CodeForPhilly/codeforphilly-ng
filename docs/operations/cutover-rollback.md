# Cutover rollback

What to do when the cutover is going sideways and the right move is to put
legacy back in front of users. Read end-to-end before T-0 — at decision time
you want this in muscle memory, not on a screen you're scrolling through.

> Companion: [cutover.md](cutover.md) (runbook),
> [cutover-announcement.md](cutover-announcement.md) (Slack + email templates).

## The short version

Cutover is one commit in `cfp-live-cluster` (gateway listeners + HTTPRoute
hostnames + `CFP_SITE_HOST`). **Rollback is `git revert` of that commit**,
pushed through the same GitOps path. No DNS is involved in either direction.

## When to roll back

The criterion is "is the rewrite serving users worse than legacy was, and
will it stay that way longer than 15 minutes?" Concrete triggers:

- `/api/health` flapping or stuck 503 with no clear single-fix path
- The apex or `www` serving an invalid certificate that cert-manager isn't
  resolving within a few minutes
- OAuth callback failure rate > 50% for more than 5 minutes
- A data corruption that's already in the gitsheets commit history and
  hard to surgically revert
- Any unrecoverable cluster issue that isn't a five-minute fix (e.g. PVC
  provisioner is broken)

**Not rollback triggers:** a single failing route, a cosmetic UI bug, a
known-not-blocking warning during boot, OAuth callback failures for a
single GitHub account that's been deactivated, **or a Slack SSO failure** —
SSO is set to optional before cutover, members fall back to email magic
links, and the fix is correcting the SSO URL in Slack (see below), not
moving the hostname back.

## Point of no return

The rollback is only safe **before the first real-user mutation lands on
the rewrite via the apex**. After a user signs in for the first time a
`PrivateProfile` is written; after they edit anything a gitsheets commit
is created. Those records exist only on the new side. Rolling back would
either lose them or require a manual re-import after the next attempt.

(The rewrite has been live at `next.codeforphilly.org` since before
cutover, so some divergence from laddr already exists. The point-of-no-return
question is specifically about writes that arrive *because* the apex moved.)

In practice this means: the rollback window is the first ~15 minutes
after the cutover PR applies. After that, fix forward.

The cutover lead announces "point of no return crossed" in the cutover
Slack thread when the first user-created record (not the importer's
records) lands. After that, this document is informational only.

## Rollback procedure

Cutover lead at the keyboard; engineering second reads the steps back.

### 1. Revert the cutover commit

```bash
cd ~/Repositories/cfp-live-cluster
git fetch origin
git checkout -b revert/cutover origin/main
git revert <cutover-merge-sha> --mainline 1     # or the single commit sha if it was a plain commit
git push -u origin revert/cutover
gh-axi pr create --base main --title "Revert cutover: apex back to laddr"
```

Merge it. "Build k8s-manifests" projects to `releases/k8s-manifests`, the
bot opens the PR into `deploys/k8s-manifests`, merge that. The apex and
`www` listeners return to `_gateways/code-for-philly.yaml`, the rewrite's
`CFP_SITE_HOST` goes back to `next.codeforphilly.org`, and the rewrite pod
rolls once more.

**Emergency shortcut** if the GitOps round-trip is too slow: revert
directly on `deploys/k8s-manifests` (see [runbook.md → Last-resort
recovery](runbook.md#3-last-resort-recovery)) and reconcile `main`
afterwards.

Verify: `curl -sSI https://codeforphilly.org/` serves laddr;
`https://next.codeforphilly.org/` still serves the rewrite.

### 2. Put Slack SSO back

If the SSO URL in Slack was already updated to the apex, the Slack
workspace admin changes it back to
`https://next.codeforphilly.org/api/saml/slack/sso`. Because SSO is
optional, nothing here is urgent — members without a working SSO path use
email magic links until it's fixed. Do **not** move the hostname to fix a
SAML problem.

### 3. Re-enable legacy writes

If you flipped the legacy site to read-only at T-7, undo that flag now.
The legacy DB has not been touched during the migration window (the importer
only reads from `?format=json` endpoints and the credentials export is
read-only). Writes resume from the same state as just-before-freeze.

### 4. Point the hot-reload workflow back

If you already switched the prod URL in the data repo's
`notify-deployments.yml` to the apex, switch it back to
`https://next.codeforphilly.org/api/_internal/reload-data` so `published`
pushes keep reaching the rewrite pod.

### 5. Post the rollback notice

Slack `#announcements`:

```
:rotating_light: Cutover paused

We hit an issue partway through migrating to the new platform and have
rolled back to the legacy site. codeforphilly.org is back to normal — your
sign-ins, edits, and Slack access all work as before.

We'll diagnose, fix, and pick a new cutover date. ETA on the new date:
within 2 weeks.

What this affected: nothing on your side. The migration was paused before
any data on the new system was published.

Sorry for the noise!
```

Email is **not** sent for a rollback — it's noise. Slack is enough; users
who weren't watching won't notice.

## Diagnose

Once users are back on legacy and the pressure is off:

1. Capture the failure in writing — what error, what frequency, in what
   logs, what was happening on the user side.
2. Pull `kubectl -n codeforphilly-ng logs deploy/codeforphilly --previous`
   for the dead pod (if it CrashLoopBacked).
3. Pull the dry-run report from T-3 and the refresh counts from T-1 —
   compare against what landed on the production side.
4. File an issue documenting what we know vs. what we don't.

The point is to have a tight description of the failure mode before
attempting cutover again. "Tried again" with no diagnosis is how
production outages compound.

## Re-attempt

A second cutover attempt follows the same runbook (cutover.md) with these
modifications:

- T-7 announce step is shorter — refer to the original. "We're trying again
  on {{ new_date }}; same plan, no further changes from your side."
- T-3 rehearsal **must** explicitly reproduce the failure mode that triggered
  the rollback and confirm the fix.
- The cutover thread includes a "what we learned and changed" entry above
  the new timeline.

## After a partial-write rollback (rare and ugly)

The procedure above assumes nobody wrote anything to the rewrite via the
apex before rollback. If that assumption was wrong (you crossed
point-of-no-return and *still* had to roll back because something worse
happened):

1. **Don't panic.** The rewrite's public data is still in `git` history —
   nothing is silently deleted.
2. Identify the time window in which user writes happened on the rewrite.
   Pull every commit on the data repo's `published` branch between the
   refresh commit and the rollback moment. The private store is `.jsonl`
   on the pod's PVC (`/app/private-storage`) — it has no versioning, so
   snapshot it (`kubectl cp` out of the pod, kept in-cluster or on an
   operator machine only as long as needed) before anything else touches it.
3. Export those records as a JSON diff. Send to the legacy site's owner
   to manually replay if they're irreplaceable, or — much more commonly —
   email the affected users explaining their write didn't land and asking
   them to redo it after the second cutover attempt.
4. Hard-reset the rewrite's `published` branch to the post-refresh commit.
   Re-deploy when ready.

This case is operationally painful but not data-loss on the public side;
the records are in git history forever. The cost is reconciliation effort.

## What rollback does NOT cover

- **Slack SSO.** Reverting the gateway does nothing for SAML. A wrong SSO
  URL or a bad assertion is fixed in Slack's SAML settings; a member who
  can't sign in via SSO uses the email magic link because SSO is optional.
  If the workspace was mistakenly set to SSO *required*, the admin sets it
  back to optional — that is the actual lockout fix.
- **GitHub OAuth app suspension by GitHub.** If GitHub deactivated the
  OAuth app (rate limit, ToS issue), moving the hostname back doesn't help
  — legacy doesn't use OAuth. Contact GitHub support; legacy will work
  unaffected because legacy uses passwords.
- **Writes already made at `next.codeforphilly.org`.** The rewrite was
  live there before cutover and stays live after a rollback. Anything
  members did there is real and stays.
