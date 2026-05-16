# Screen: Sponsor

## Route

`/sponsor` — public. Port of codeforphilly.org's `sponsor.php`.

## Data Requirements

None beyond `GET /api/auth/me` for header rendering. This is a static marketing page in v1; sponsor logos and copy are baked into the React component (no CMS).

When we want sponsor management in the database, this screen gains a `GET /api/sponsors` call. Until then it's pure content.

## Display Rules

### Hero

- H1: "Sponsor Code for Philly"
- Subhead: "Help us put tech to work for Philadelphia's communities."
- Two CTAs:
  - Primary: "Get in touch →" → `mailto:sponsor@codeforphilly.org` (or `/contact` once that exists)
  - Secondary: "Read our sponsorship deck →" → external PDF link

### "Why sponsor?" (3 cards)

| Heading | Body |
| ------- | ---- |
| Visibility | "Your logo and brand on the codeforphilly.org homepage and at our weekly hack nights." |
| Talent | "Show our community of 1,000+ technologists what your team is working on." |
| Civic impact | "Underwrite work that makes Philadelphia better." |

### Current sponsors

Grid of sponsor logos with links out. Three tiers:

- "Sustaining"
- "Hack night"
- "In-kind"

Logos render in grayscale by default, colorized on hover.

The actual list of sponsors is hard-coded in the React component for v1. A staff-managed sponsor table is deferred.

### Past sponsors

Smaller grid below the current sponsors, with the same treatment.

### FAQ

Accordion of 5–8 common questions ("How much does it cost? What do we get? Can we sponsor a specific project?"). Static content.

### Footer CTA

- "Ready to talk? Email <sponsor@codeforphilly.org>" with a copy-to-clipboard button on the email.

## Actions

All navigation and email-link clicks.

## Navigation

**To here:** Header "About > Sponsor" dropdown, footer link, home page "Get involved" card.

**From here:** External mailto and PDF URLs; sponsor logo targets.

## Authorization

Public. No variations.
