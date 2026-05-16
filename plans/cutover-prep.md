---
status: planned
depends:
  - workspace
  - test-harness
  - storage-foundation
  - api-skeleton
  - auth-jwt-substrate
  - read-api
  - write-api
  - web-shell
  - public-screens
  - authoring-screens
  - github-oauth
  - account-claim
  - saml-idp
  - laddr-import
  - public-snapshot-scrub
  - deploy
specs:
  - specs/architecture.md
  - specs/behaviors/legacy-id-mapping.md
  - specs/behaviors/account-migration.md
issues: []
---

# Plan: Cutover prep

## Scope

Operational readiness for flipping production traffic from laddr to the rewrite. The reconciliation script, the cutover runbook, the dry-run + rehearsal, the rollback plan, the post-cutover monitoring.

This plan ships the *playbook* and the supporting tooling — not the cutover itself, which is a scheduled operational event.

## Implements

- The "Data migration" section of [architecture.md](../specs/architecture.md)
- [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md) — the URL-redirect contract verified end-to-end
- [behaviors/account-migration.md](../specs/behaviors/account-migration.md) — the cutover-window policy section, codified as a runbook + scheduled reminders

## Approach

### Reconciliation script (`apps/api/scripts/reconcile.ts`)

Walks the public Person records and ensures each has a matching `PrivateProfile`. Reports:

- **Orphan public Persons** (no matching PrivateProfile) — possible after a partial dual-write failure
- **Orphan PrivateProfiles** (no matching public Person)
- **Inconsistent newsletter state** — `optedIn: true` but no `unsubscribeToken`, etc.
- **Drained LegacyPasswordCredentials** — Persons with `githubUserId is not null` who still have a legacy-password record (should have been deleted on claim)

Output: a JSON report. `--fix` mode applies safe corrections (e.g., regenerates missing unsubscribe tokens, deletes drained credentials). Unsafe issues (orphan Persons) require human review.

Run weekly via a CI cron once production is live; manually during cutover window.

### Cutover runbook

`docs/operations/cutover.md` — a sequenced playbook. Outline:

1. **T-7 days:** announce cutover window via Slack + email. Freeze laddr writes (read-only mode).
2. **T-3 days:** stage-rehearsal — full import + smoke test against a staging copy of laddr's data.
3. **T-1 day:** final laddr `mysqldump`. Run the importer against production data + production buckets. Verify counts.
4. **T-0 (cutover):**
   - Put up a maintenance page on the legacy site
   - Final delta import (any laddr changes since the previous dump)
   - DNS flip: `codeforphilly.org` → new ingress
   - Verify a few user-facing flows (sign-in, project page, member page, /chat redirect)
5. **T+1h:** monitoring window — watch error rates, Slack SAML success rate, OAuth callback success rate
6. **T+1 day:** announce success in Slack; flag any anomalies
7. **T+90 days:** legacy redirect window closes; check for stragglers
8. **T+180 days:** delete unclaimed `LegacyPasswordCredential` records (after a final mailout reminder per the cutover-window policy)

### Dry-run + rehearsal tooling

`apps/api/scripts/cutover-dry-run.ts` — runs the entire migration pipeline against a non-production target (staging cluster + staging bucket). Outputs:

- Importer report
- Smoke-test results (curl 10 random Persons → expect their old slugs work; curl 10 random Projects → same; attempt Slack SAML for a test account; etc.)
- A diff between source mysqldump's record counts and what landed in the new system

The team runs this at least twice before T-0.

### URL redirect verification

Per [behaviors/legacy-id-mapping.md](../specs/behaviors/legacy-id-mapping.md), the web layer accepts legacy URL forms. The reconciliation script also includes a `--verify-redirects` mode that fetches a sample of laddr URLs (from the mysqldump's most-visited list if we have one, else a random sample) against the new system and reports mismatches.

### Rollback plan

If something catastrophic happens during cutover:

1. DNS flip back to legacy
2. The legacy site comes back online (its DB hasn't been touched; we only read it)
3. Triage what failed; pick a new cutover date

The rollback window is tight — once users start signing in to the new site and creating records, those records exist only on the new side. Document the point of no return clearly.

### Post-cutover monitoring

Add minimum-viable monitoring before cutover:

- A health-check ping (e.g., `uptimerobot` or `healthchecks.io`) hits `/api/health` every minute
- Pino logs go to stdout → cluster log aggregator
- Errors at WARN+ paged via the existing Code for Philly Slack notification setup (if one; else a `#alerts` channel)
- `/api/health/ready` failure pages an admin (it should never fail after boot)

Real metrics (Prometheus etc.) deferred until we hit a specific need.

### Communication

Drafts shipped with this plan:

- `docs/operations/cutover.md` — runbook
- `docs/operations/cutover-announcement.md` — the public Slack + email announcement template
- `docs/operations/cutover-rollback.md` — what to do if it goes sideways

### `T+90` mailout

A small one-off script + Resend send: pull the list of unclaimed Persons (every Person with `githubUserId is null` from the public state, who has a `PrivateProfile.email` from before cutover that we still have), send each a reminder mail with claim instructions. Run manually at T+90.

### Snapshot CI invocation (deferred from `public-snapshot-scrub`)

A scheduled GitHub Actions workflow in the data repo (or triggered from here) runs `npm run -w apps/api script:scrub-data -- --source=. --target=../codeforphilly-data-snapshot` weekly, force-pushes the result to the snapshot branch, and creates a dated tag (`snapshot-<year>-<quarter>-scrubbed`). This is the "how it gets invoked in CI" piece that `public-snapshot-scrub` explicitly deferred.

## Validation

- [ ] Dry-run runs end-to-end against a staging environment without errors
- [ ] Reconciliation script flags a deliberately-orphaned record (test: create a Person without a PrivateProfile manually, run reconciliation, confirm it's flagged)
- [ ] Sample of 100 laddr URLs all resolve correctly via redirects on the new system
- [ ] SAML assertion for a test laddr user matches their pre-cutover NameID byte-for-byte (this is the critical Slack-continuity check)
- [ ] Account-claim flow works for: email-match user, password-match user, dead-email user (staff-review path)
- [ ] Rollback procedure rehearsed at least once: bring up staging, simulate cutover, then "rollback" (DNS flip) and verify the legacy site still works
- [ ] Cutover runbook reviewed by at least one staff member who hasn't been deep in the code
- [ ] Post-cutover monitoring alarms verified by intentionally breaking `/api/health` in staging
- [ ] T+90 mailout script tested in dry-run mode against a fixture (no real emails sent)
- [ ] Snapshot CI workflow in place: `scrub-data.ts` runs on schedule, pushes to `codeforphilly-data-snapshot`, tags the run (deferred from `public-snapshot-scrub`)
- [ ] Snapshot clones + boots a fresh dev API (`STORAGE_BACKEND=filesystem`, empty private storage) — deferred from `public-snapshot-scrub` validation

## Risks / unknowns

- **DNS TTL.** Whatever the current TTL on `codeforphilly.org` is, pre-drop it to 60 seconds a week before cutover so the flip propagates fast.
- **Slack SAML cutover continuity.** This is the highest-stakes single check. Verify multiple times, with real legacy assertions captured + compared.
- **GitHub OAuth App rate limits.** A surge of users signing in within a cutover window could brush against GitHub's rate limits per app. Probably fine for our scale (~1240 users); worth monitoring.
- **Newsletter subscribers losing email-resolution.** The first OAuth signin updates `PrivateProfile.email` to the user's current GitHub primary. If their laddr-era email is on a defunct provider, they still need to log in to update it. Some users may never log in → their newsletter sends will bounce. Acceptable; cleanup via standard bounce handling.
- **The single big import commit.** Could be 100K+ files. Confirm with the gitsheets transaction handling that this works at scale; chunk by entity type if not.

## Notes
