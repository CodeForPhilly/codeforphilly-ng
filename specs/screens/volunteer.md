# Screen: Volunteer

## Route

`/volunteer` — public. Port of codeforphilly.org's `volunteer.php` landing page.

## Data Requirements

- `GET /api/help-wanted?perPage=6` — featured open roles to seed the page
- `GET /api/auth/me` — toggles the primary CTA

This screen is mostly static content + the live help-wanted preview. The static copy ports from the current site's `html-templates/volunteer.tpl`.

## Display Rules

### Hero

- H1: "Volunteer with Code for Philly"
- Subhead: "No coding experience required. We have a project for you."
- Primary CTA:
  - Anonymous: "Create an account →" → `/register?return=/volunteer`
  - User: "Browse projects →" → `/projects`

### "How it works" (3 steps)

Three cards in a row at ≥ md, stacked below:

1. **Join Slack** — "We coordinate everything in our Slack workspace." Button: "Open Slack →" → `/chat`
2. **Pick a project** — "Browse 268 active projects and find one that matches your interests." Button: "Browse projects →" → `/projects`
3. **Show up to meetups** — "We meet weekly. Bring your laptop, or just yourself." Button: "When we meet →" → external link (currently the GitBook hack-night-program-details URL)

The "268" is read from a cheap call to `GET /api/projects?perPage=1` and rendered live; falls back to "hundreds of" if the call fails.

### Featured help-wanted roles

- Heading: "Looking for a concrete way to help?"
- Sub: "These projects have specific roles open right now:"
- Grid of up to 6 role cards (same card design as `help-wanted-index.md`)
- "See all open roles →" link to `/help-wanted`

If the help-wanted call returns zero results, hide the section.

### "Not a coder?" section

Static content emphasizing the non-developer roles (designers, project managers, researchers, community organizers). Three example "non-coder" pathways with paragraph descriptions and links to relevant tag pages (`/tags/topic/research`, etc.).

### "Start your own project" CTA

Footer-style band at the bottom: "Have an idea? Start your own project."

- Link to the external GitBook "creating-new-partnerships/first-steps" page (matches current codeforphilly.org)
- Secondary link "or create one on the site →" to `/projects/create` (signed-in) or `/register?return=/projects/create` (anonymous)

## Actions

All navigation. No mutations.

## Navigation

**To here:** Home page hero CTA, header nav, every "Volunteer" link across the site.

**From here:** `/register`, `/projects`, `/chat`, `/help-wanted`, `/projects/create`.

## Authorization

Public. CTA copy changes for authenticated users; no other gating.
