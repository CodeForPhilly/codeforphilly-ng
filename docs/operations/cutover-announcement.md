# Cutover communications templates

The user-facing announcements sent before, during, and after cutover. Each
template has `{{ placeholder }}` slots; replace before sending.

> Companion: [cutover.md](cutover.md) (operational runbook),
> [cutover-rollback.md](cutover-rollback.md) (rollback plan).

## T-7 days: cutover announcement

### Slack (`#announcements`)

```
:tada: codeforphilly.org is moving to a new platform on {{ cutover_date_long }}

TL;DR — we're moving the site to a modernized stack. Same URLs, same projects,
same accounts. The active cutover is about an hour. Expect ~5 minutes of
"please wait" page mid-window, then everything's back.

What changes for you:
- :white_check_mark: All your URLs keep working (legacy redirects in place)
- :white_check_mark: Your Slack identity is preserved automatically
- :arrows_counterclockwise: First sign-in after cutover routes you through
  GitHub OAuth + a one-click "claim your account" flow
- :no_entry_sign: Username/password sign-in is going away — GitHub is the
  primary login from cutover forward

What we need from you BEFORE cutover:
- Hold off on edits to your profile / projects starting {{ freeze_date }}
  (we're freezing writes to make the migration clean)
- Make sure you remember which GitHub account is associated with your CFP
  email — your first sign-in needs to come from that GitHub account

If you have questions: drop them in this thread or DM @{{ cutover_lead_slack }}.
```

### Email (Resend, to all members)

Subject: `codeforphilly.org is migrating on {{ cutover_date_long }}`

```text
Hi {{ first_name }},

On {{ cutover_date_long }} we're moving codeforphilly.org to a new platform.

What's changing
- The site is being rebuilt on a modern stack — same look, same URLs,
  same projects.
- Sign-in is moving to GitHub OAuth. Your password is no longer needed.
- Your Slack identity is preserved automatically.

What you need to do
- Nothing right now — but please don't edit your profile or projects
  between {{ freeze_date }} and {{ cutover_date_short }}.
- After cutover, sign in via the new "Sign in with GitHub" button. If
  your CFP email matches your GitHub email, your account is claimed
  automatically. If not, follow the on-screen claim flow.

When it happens
- {{ cutover_date_long }} starting at {{ cutover_time }}.
- We expect about 15 minutes of downtime in the middle.

Questions? Reply to this email or ping us in Slack.

— Code for Philly
```

## T-0: maintenance page

The static page served from the legacy site while DNS propagates. Plain HTML;
no JavaScript needed.

```html
<!doctype html>
<title>codeforphilly.org — migrating now</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 36rem; margin: 4rem auto; padding: 1rem; line-height: 1.5; }
  h1 { color: #c00; }
</style>
<h1>codeforphilly.org is migrating</h1>
<p>We're moving the site to its new home right now. Should be back in 15 minutes or less.</p>
<p>If you're an active maintainer or staff member, the cutover team is in
<a href="https://codeforphilly.slack.com/archives/CXXXXXXXX">#site-cutover</a> on Slack.</p>
<p><small>Started: {{ start_iso }}</small></p>
```

## T+1h: cutover-window status pings

Short Slack updates in `#announcements` while T-0 → T+24h watch is active.
Reuse as needed; one ping every ~30 minutes is plenty.

```
:traffic_light: Cutover status @ T+{{ minutes }}m:
- /api/health: :white_check_mark:
- OAuth callback: :white_check_mark: ({{ requests }} successful, {{ failures }} failed)
- SAML assertions: :white_check_mark: ({{ assertions }} successful, {{ failures }} failed)
- {{ free_form_note }}
```

## T+24h: all-clear

Once the first 24h have passed without incident, post the success message.

### Slack

```
:tada: Cutover complete

codeforphilly.org has been running on the new stack for 24 hours with no
incidents. Huge thanks to {{ cutover_team_handles }} for shipping this.

What you can do now:
- Sign in via the "Sign in with GitHub" button on any page
- If you had a legacy account, the claim flow runs once on first sign-in
- Update your profile, add projects, post buzz — all the same as before
- Use the Slack workspace as normal; SSO is now backed by our own IdP

Bugs / weirdness: file an issue on
https://github.com/CodeForPhilly/codeforphilly-rewrite/issues or just reply
here.
```

## T+90 days: unclaimed-account reminder

Sent automatically by `apps/api/scripts/cutover-mailout.ts`. The template is
in code — see `buildEmailBody()` in that file. Reproduced here for review:

Subject: `Action needed: claim your Code for Philly account`

Body:

```text
Hi {{ name }},

We migrated codeforphilly.org to a new platform a few months ago. Your
account at @{{ slug }} is still waiting to be claimed.

Sign in with GitHub to claim it — your profile, projects, and Slack identity
all carry over: {{ claim_url }}

If you don't recognize this account, you can ignore the email. Accounts
unclaimed for one year may be retired.

— Code for Philly
```

## T+180 days: password-credential drain notice

A short Slack post in `#announcements` and an info-only email to remaining
unclaimed Persons. Honest about the irreversible step.

### Slack

```
:warning: Six months post-cutover

It's been six months since we moved to the new platform. We're cleaning up
the remaining legacy password records — about {{ count }} accounts.

If you signed in via GitHub at any point: you're already migrated, this
doesn't affect you.

If you have a laddr account you haven't logged into yet: please log in
in the next 14 days. After that, you'll need to contact a staff member
to verify your identity before reclaiming the account.

Questions: ping @{{ cutover_lead_slack }}.
```

## Localization

We don't send in any language other than English at v1. If we ever expand
the brigade footprint to a multilingual community, these templates get
i18n + a translation review step before any send.
