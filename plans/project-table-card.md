---
status: in-progress
depends: []
specs:
  - specs/screens/project-table-card.md
  - specs/screens/project-detail.md
issues: [232]
---

# Plan: Project table card with a QR code

## Scope

At hack nights each project has a table; newcomers should be able to scan
a code there and land where they can join. Add a printable "table card"
per project.

**In:** `/projects/:slug/table-card` (logo, title, summary, QR code to the
project page, "Scan to join this project", the URL as text, the Slack
channel when set; Print and Back controls that don't print); a "Table
card" button in the project page's Share section. Visible to anyone.

**Out:** a QR that joins on arrival (the project page already walks a
newcomer from "Sign in to contribute" back to "Join Project"); folded
tent-card layouts; batch printing every project's card at once.

## Implements

- [screens/project-table-card.md](../specs/screens/project-table-card.md)
- [screens/project-detail.md](../specs/screens/project-detail.md) — Share
  section, Navigation.

## Approach

1. `qrcode.react` (`QRCodeSVG`) renders the code client-side as SVG, so it
   prints crisp at any size.
2. The URL uses `window.location.origin` so production cards read
   `codeforphilly.org` and test instances encode their own host.
3. The card is black on white in both themes; print hides the shell via
   the existing print stylesheet and the controls via `print:hidden`.

## Validation

- [ ] `npm run type-check && npm run lint && npm test` clean.
- [x] The card renders for a project with a summary and chat channel, and
  for one without.
- [x] Print preview (PDF) fits one Letter page with only the card.
- [ ] A phone scan of the printed code opens the project page.
- [x] An unknown slug shows "Project not found".

## Risks / unknowns

- None significant; the dependency is small (no transitive deps).

## Notes

## Follow-ups
