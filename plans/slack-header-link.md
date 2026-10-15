---
status: in-progress
depends: [chat-links-full-navigation]
specs:
  - specs/behaviors/app-shell.md
issues: [231]
---

# Plan: Slack in the header

## Scope

The only site-wide way into Slack is the footer's "Slack" link, which
newcomers at a hack night don't find. Put Slack in the header.

**In:** a Slack icon link in the desktop utility cluster, before GitHub;
a "Slack" row in the mobile sheet before GitHub. The desktop header now
starts at lg instead of md: at 768px the header already overflowed
(content links wrapping, Volunteer cut off), and there was no room for
another icon. Both are full-page navigations to `/chat`
in a new tab, like the GitHub link.

**Out:** a text "Chat" item in the content cluster (considered; an icon
next to GitHub reads as "where the community lives" without crowding the
content links); changing `/chat` itself.

## Implements

- [behaviors/app-shell.md](../specs/behaviors/app-shell.md#center--right-at--lg) —
  utility cluster and mobile sheet.

## Approach

1. `SlackIcon` beside `GitHubIcon` (monochrome mark, `currentColor`).
2. `SlackLink` in `AppHeader` mirroring `GitHubLink`; a sheet row
   mirroring the GitHub row.
3. Header breakpoint md → lg; GitHub loses its lg-only class, since the
   whole desktop header is lg-only now.

## Validation

- [ ] `npm run type-check && npm run lint && npm test` clean.
- [ ] At 1024px and 1280px the desktop header keeps every content link on
  one line with Slack and GitHub showing; at 768px the mobile header shows.
- [ ] At 390px the sheet lists Slack before GitHub.
- [ ] Clicking the header icon opens the Slack SSO start in a new tab.

## Risks / unknowns

- Tablets in portrait lose the inline nav for the hamburger. Accepted:
  the alternative was a header that runs off the screen.

## Notes

## Follow-ups
