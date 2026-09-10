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
- :white_check_mark: Your existing username + password keep working
- :arrows_counterclockwise: You can also "Sign in with GitHub" — if your
  GitHub email matches your CFP email your account links automatically;
  otherwise a one-click claim flow does it. We'd love you to link GitHub,
  but there's no deadline

What we need from you BEFORE cutover:
- Hold off on edits to your profile / projects starting {{ freeze_date }}
  (we're freezing writes to make the migration clean)
- If you plan to sign in with GitHub, check which GitHub account uses your
  CFP email — matching emails link automatically

If you have questions: drop them in this thread or DM @{{ cutover_lead_slack }}.
```

### Email (Postmark, to all members)

Subject: `codeforphilly.org is migrating on {{ cutover_date_long }}`

```text
Hi {{ first_name }},

On {{ cutover_date_long }} we're moving codeforphilly.org to a new platform.

What's changing
- The site is being rebuilt on a modern stack — same look, same URLs,
  same projects.
- Your existing username and password keep working. You can also sign in
  with GitHub and link the two.
- Your Slack identity is preserved automatically.

What you need to do
- Nothing right now — but please don't edit your profile or projects
  between {{ freeze_date }} and {{ cutover_date_short }}.
- After cutover, sign in as usual, or try the new "Sign in with GitHub"
  button. If your CFP email matches your GitHub email, your account is
  linked automatically. If not, follow the on-screen claim flow.

When it happens
- {{ cutover_date_long }} starting at {{ cutover_time }}.
- We expect about 15 minutes of downtime in the middle.

Questions? Reply to this email or ping us in Slack.

— Code for Philly
```

## T-0: maintenance page (optional)

A static page for the legacy site during the hostname move. Cutover is a
gateway-listener change with no DNS propagation
([cutover.md → T-0](cutover.md#t-0-cutover)), so the switch is effectively
instant per hostname and this page is optional — use it if you want a
visible "hold on" while the final data delta runs. Plain HTML; no
JavaScript needed.

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
https://github.com/CodeForPhilly/codeforphilly-ng/issues or just reply
here.
```

## Unclaimed-account reminder (not scheduled)

`apps/api/scripts/cutover-mailout.ts` can email members whose laddr account
has not yet been linked to GitHub. **It is not on the cutover timeline.**
Per [account-migration.md](../../specs/behaviors/account-migration.md#sunset-deferred)
legacy password sign-in has no deadline, so there is nothing to remind
people *of*; the only nudge is the "Connect GitHub" banner on `/account`.
If a future spec change sets a sunset date, this template is the starting
point — until then, don't send it. The template is in code — see
`buildEmailBody()` in that file. Reproduced here for review (note the last
paragraph about retiring accounts has no backing in the spec and would need
one before any send):

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

## Localization

We don't send in any language other than English at v1. If we ever expand
the brigade footprint to a multilingual community, these templates get
i18n + a translation review step before any send.
