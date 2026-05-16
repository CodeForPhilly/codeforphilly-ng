# Deferred Features

Features present in laddr or codeforphilly.org that are **intentionally not in scope** for the v1 rewrite. Listed here so the omission is documented, not accidental.

Categories:

- **Dropped** — we don't plan to bring this back. Removing surface area is the point.
- **Deferred** — we want it eventually, but not in v1.
- **Replaced** — superseded by something elsewhere; the user need is met by another system.

When a deferred item is promoted, move it from this file into the relevant spec, update the [data model](data-model.md) if needed, and write the screen/API/behavior specs.

## Dropped

### Event check-ins (Meetup.com integration)

- **What:** `member_checkins` table, `/checkin` endpoint, current-meetup card on the home page, "top members" list.
- **Why:** Meetup.com's API and pricing make this hard to maintain. The community no longer uses Meetup.com as the source of truth — meetups are coordinated in Slack and via Eventbrite/Google Calendar. SquadQuest (a Code for Philly project) covers the "RSVP to events" use case better.
- **What replaces it:** Nothing in v1. If we want a check-in flow back, it should be reframed around the actual event source (Slack channel auto-detection, or an Eventbrite/iCal feed).

### Big Screen mode (`/bigscreen`)

- **What:** Live event status page meant for displaying on a projector at hack nights, showing live checkins and announcements.
- **Why:** Only useful when in-person check-ins existed. If we restore some form of "who's here right now," big-screen can come back with it.

### Multi-brigade extensibility

- **What:** The laddr "extend" pattern via hologit overlays — other brigades cloning the platform and adding a thin customization layer.
- **Why:** The user-base for this pattern collapsed over the last several years. Maintaining it adds significant complexity for zero current users. The rewrite is a single-tenant codeforphilly.org app. Other brigades who want this codebase fork it.

### Localization (gettext)

- **What:** `_()` wrapping every user-facing string, Spanish + Korean + Croatian translations.
- **Why:** Translations are stale in laddr already, and the active user base is English-speaking. We design strings to be translatable (no inline concatenation, no string interpolation that breaks word order) but ship English only.

### Twitter "tweet this" share buttons

- **What:** `RemoteSystems\Twitter::getTweetIntentURL(...)` on project pages.
- **Why:** X/Twitter's role in the civic-tech community has cratered; the share button is essentially a no-op. If we want share buttons, they should target the platforms the community actually uses (Mastodon/Bluesky/Slack/LinkedIn).

### Discourse SSO forums

- **What:** `DiscourseSteering` and `DiscourseKids` classes — SSO endpoints letting members log into separate Discourse instances.
- **Why:** Both Discourse forums are essentially dormant; community discussion happens in Slack. If a forum is ever needed again, we'd set it up fresh with whatever SSO it natively supports.

### Discourse → Slack webhook bridge

- **What:** `discourse-webhook.php` posting new Discourse topics to Slack.
- **Why:** Direct consequence of dropping Discourse SSO.

### MailChimp newsletter integration

- **What:** `RemoteSystems\MailChimp` + the `newsletters/` directory.
- **Why:** Newsletter authoring/sending no longer happens through the site; the team uses MailChimp's web UI directly. The site doesn't need to know about it.

### "Drewm" / MailChimp PHP class

- **What:** Bundled third-party MailChimp PHP wrapper.
- **Why:** Goes with MailChimp integration.

## Deferred

### Blog (`/blog`)

- **What:** Long-form posts via Emergence CMS's `BlogPost` class.
- **Why deferred:** Useful for announcements and write-ups, but post velocity has been near-zero for years. Reintroduce when there's a stakeholder committed to writing content.
- **When promoted:** Likely use a markdown-files-in-repo approach (or hooks into a headless CMS) rather than a database-backed editor in the site. New spec needed.

### Project comments

- **What:** Inline comments on project pages (the `Comment::class` references in laddr's Project model). Largely commented-out in the template even in laddr — the feature was half-built.
- **Why deferred:** Slack is where conversations happen. If commenting is ever wanted on-site, it should be designed deliberately.

### Versioned record history

- **What:** laddr's `VersionedRecord` pattern that retained a full history of edits to projects and updates in `history_projects`/`history_project_updates`.
- **Why deferred:** Useful for moderation, but adds complexity. Audit logging for staff actions (see [behaviors/authorization.md](behaviors/authorization.md)) covers the most common need.

### Slack OAuth login

- **What:** Sign in with Slack as a *secondary* auth method, alongside GitHub.
- **Why deferred:** GitHub OAuth ships first as the sole primary auth method (see Replaced — Email/password auth). Slack OAuth is plausible later — most of the active community has a `codeforphilly.slack.com` account — but only after the GitHub flow is solid and only if there's a demonstrated need for a second provider.
- **When promoted:** Add a `slackId` field on Person, wire `@fastify/oauth2` with the Slack provider, update the auth specs.

### Project README sync from GitHub

- **What:** When a project's `developersUrl` is a GitHub repo, periodically fetch the repo's README and offer to use it as the project README on the site.
- **Why deferred:** Useful, but a polish feature. v1 has manual README editing.

### Project activity from GitHub

- **What:** Surface recent commits / merged PRs / releases on the project page.
- **Why deferred:** Polish. Adds an external dependency and webhook plumbing.

### CSV / JSON export of projects directory

- **What:** laddr's `/projects.csv` endpoint, used by Code for America's `cfapi`.
- **Why deferred:** Code for America's national project aggregator is itself dormant. If it comes back or another aggregator needs us, we restore the CSV endpoint trivially — it's just a different content-type on the projects list.
- **When promoted:** Add `?format=csv` to the projects list endpoint per [api/conventions.md](api/conventions.md).

### RSS feeds

- **What:** laddr's `/project-updates?format=rss` and per-project RSS variants.
- **Why deferred:** Same as CSV — useful, easy to restore, no current consumer that we know of.

### Search across content

- **What:** The site-wide search box hits projects, people, content. v1 ships a *projects-only* search (it's the most common query).
- **Why deferred:** Multi-entity search needs a proper indexer (Postgres FTS or Meilisearch). Projects search is doable with `tsvector` columns; broader search comes later.

### Newsletter "send-newsletter" admin tool

- **What:** `send-newsletter.php`, an admin UI for composing and sending email newsletters via MailChimp.
- **Why deferred:** Tied to MailChimp drop. If newsletters return through the site, they get a fresh spec.

### `connectors/` ingestion

- **What:** Various ingestion endpoints in `codeforphilly.org/site-root/connectors/`.
- **Why deferred:** Need to enumerate exactly what's there during cutover. Some may be dead, some may need reimplementation.

## Replaced

### "Powered by laddr" footer credit

- **What:** Footer link from project pages out to laddr.us.
- **Replaced by:** A simple "open source — view this site on GitHub" link to the rewrite repo. Self-promotion of the platform stops mattering once we're not pitching laddr to other brigades.

### Bootstrap 4 + jQuery widgets

- **What:** Modal dialogs, dropdowns, tooltips, the EpicEditor markdown component.
- **Replaced by:** shadcn/ui equivalents (Dialog, DropdownMenu, Tooltip) plus a modern markdown editor (TBD: `@uiw/react-md-editor` or a CodeMirror 6 setup with the `markdown` lang). Component selection lives in the implementation, not in a spec.

### Habitat + Emergence runtime

- **What:** The entire PHP/Emergence/Habitat layer cake.
- **Replaced by:** Node 22 + Fastify + gitsheets in a single container image, as described in [architecture.md](architecture.md).

### Email/password authentication

- **What:** laddr's email + password sign-in flow with password-reset, email verification, etc.
- **Replaced by:** **GitHub OAuth** as the only primary auth method, *once the OAuth + account-claim flow is specified*. Until then, sessions exist only via seeded data from the laddr migration.
- **Why:** Spam/scam load on the laddr sign-up form was unmanageable even with recaptcha. GitHub-account-creation friction filters bad actors meaningfully better. The audience (civic-tech volunteers) overwhelmingly already has a GitHub account. Side benefit: deletes a lot of code — no password storage, no reset flow, no verification flow, no MFA roadmap.
- **What about laddr users without a GitHub account?** During the account-claim flow they may prove ownership of an old laddr record by typing their old username + password, in which case the laddr-imported `LegacyPasswordCredential` record validates them and is then deleted. After all migration claims are completed (or expire), no password machinery remains in the system.

### MySQL / any persistent relational database

- **What:** Storing application data in a long-running OLTP — MySQL today, considered Postgres in an early version of the spec.
- **Replaced by:** [gitsheets](https://github.com/JarvusInnovations/gitsheets) — TOML records in a git repo, mirrored to GitHub. The whole corpus loads into memory on boot; queries are JS operations against typed in-memory structures; full-text search runs in a throwaway in-memory SQLite FTS5 index rebuilt at boot. See [behaviors/storage.md](behaviors/storage.md).
- **Why:** At civic scale (low thousands of records), the cost of operating a separate persistent database doesn't pay for itself. The gitsheets backend wins on: contributor onboarding (no DB to install), free audit trail (every mutation is a commit with author + message), trivial backup (`git push`), and propose-review-flow potential (git branches as edit sessions). Tradeoffs accepted: single-replica only, mutations serialized in-process, search index rebuilt at boot.
- **Trigger to revisit:** Adoption growth past low-tens-of-thousands of records, or a hard requirement for multi-writer concurrency, would push us toward Postgres for some subset of entities. v1 ships gitsheets-only.

### Hologit layer composition

- **What:** `.holo/` overlay system letting `codeforphilly.org` customize `laddr` without forking.
- **Replaced by:** Direct authorship in this single repo. The customization that lived in `codeforphilly.org` is now first-class content (home page, volunteer page, sponsor page) within `apps/web/src/pages/`.
