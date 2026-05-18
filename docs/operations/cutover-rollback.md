# Cutover rollback

What to do when the cutover is going sideways and the right move is to put
legacy back in front of users. Read end-to-end before T-0 — at decision time
you want this in muscle memory, not on a screen you're scrolling through.

> Companion: [cutover.md](cutover.md) (runbook),
> [cutover-announcement.md](cutover-announcement.md) (Slack + email templates).

## When to roll back

The criterion is "is the rewrite serving users worse than legacy was, and
will it stay that way longer than 15 minutes?" Concrete triggers:

- `/api/health` flapping or stuck 503 with no clear single-fix path
- OAuth callback failure rate > 50% for more than 5 minutes
- Slack SAML failure rate > 50% for more than 5 minutes (Slack is critical
  to brigade ops — this is a bigger deal than the OAuth callback)
- A data corruption that's already in the gitsheets commit history and
  hard to surgically revert
- Any unrecoverable cluster issue that isn't a five-minute fix (e.g. PVC
  provisioner is broken)

**Not rollback triggers:** a single failing route, a cosmetic UI bug, a
known-not-blocking warning during boot, OAuth callback failures for a
single GitHub account that's been deactivated.

## Point of no return

The rollback is only safe **before the first real-user mutation lands on
the rewrite**. After a user signs in for the first time on the rewrite a
`PrivateProfile` is written; after they edit anything a gitsheets commit
is created. Those records exist only on the new side. Rolling back would
either lose them or require a manual re-import after the next attempt.

In practice this means: the rollback window is the first ~15 minutes
after DNS flip. After that, fix forward.

The cutover lead announces "point of no return crossed" in the cutover
Slack thread when the first user-created record (not the importer's
records) lands. After that, this document is informational only.

## Rollback procedure

The 4-step sequence. Cutover lead at the keyboard; engineering second
reads the steps back.

### 1. DNS flip back to legacy

```bash
# Whatever your DNS provider is, flip codeforphilly.org back to the
# legacy ingress / load balancer.
```

TTL was lowered to 60s a week before cutover, so propagation completes
in under two minutes for most resolvers. Verify with `dig +short codeforphilly.org`
from a fresh resolver.

### 2. Re-enable legacy writes

If you flipped the legacy site to read-only at T-7, undo that flag now.
The legacy DB has not been touched during the migration window (the importer
only reads from `?format=json` endpoints). Writes resume from the same state
as just-before-freeze.

### 3. Take down the rewrite ingress

```bash
# Scale the rewrite Deployment to zero so no traffic can hit it even if
# a stale DNS resolver still points there.
kubectl -n codeforphilly scale deploy/codeforphilly --replicas=0
```

Or just remove the Ingress resource. The Deployment can stay running for
future debugging; what matters is no public traffic reaches it.

### 4. Post the rollback notice

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
2. Pull `kubectl logs` for the dead pod (`--previous` if it CrashLoopBacked).
3. Pull the reconciliation report from T-1 and the dry-run report from
   T-3 — compare against what landed on the production side.
4. File an issue documenting what we know vs. what we don't.

The point is to have a tight description of the failure mode before
attempting cutover again. "Tried again" with no diagnosis is how
production outages compound.

## Re-attempt

A second cutover attempt follows the same runbook (cutover.md) with these
modifications:

- T-7 announce step is shorter — refer to the original. "We're trying again
  on {{ new_date }}; same plan, no further changes from your side."
- T-3 dry-run **must** explicitly reproduce the failure mode that triggered
  the rollback and confirm the fix.
- The cutover thread includes a "what we learned and changed" entry above
  the new timeline.

## After a partial-write rollback (rare and ugly)

The procedure above assumes nobody wrote anything to the rewrite before
rollback. If that assumption was wrong (you crossed point-of-no-return
and *still* had to roll back because something worse happened):

1. **Don't panic.** The rewrite's data is still in `git` history — nothing
   is silently deleted.
2. Identify the time window in which user writes happened on the rewrite.
   Pull every commit on the data repo between import-commit and the
   rollback moment. Same for the private-storage bucket's versioned
   `.jsonl` history.
3. Export those records as a JSON diff. Send to the legacy site's owner
   to manually replay if they're irreplaceable, or — much more commonly —
   email the affected users explaining their write didn't land and asking
   them to redo it after the second cutover attempt.
4. Hard-reset the rewrite's data repo to the post-import commit. Re-deploy
   when ready.

This case is operationally painful but not data-loss; the records are in
git history forever. The cost is reconciliation effort.

## What rollback does NOT cover

- **Slack workspace SAML disconnection.** If you flipped the Slack SSO
  config over to the new IdP *before* validating, you may need to ask
  the Slack workspace owner to swap back. This is why the runbook says
  to pre-stage but not activate the SAML connection at T-7.
- **GitHub OAuth app suspension by GitHub.** If GitHub deactivated the
  OAuth app (rate limit, ToS issue), rolling back the DNS doesn't help
  — legacy doesn't use OAuth. Contact GitHub support; legacy will work
  unaffected because legacy uses passwords.
- **DNS resolver caching beyond TTL.** Some corporate networks ignore
  DNS TTLs and cache for hours. Users behind such a network will see
  the rewrite for longer than the 60s flip implies. Rare; document the
  user-side workaround (open a private tab / change DNS).
