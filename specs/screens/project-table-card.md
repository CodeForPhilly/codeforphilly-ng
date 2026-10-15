# Screen: Project Table Card

## Route

`/projects/:slug/table-card` — public. A one-page printable sign for a
project's table at a hack night: a newcomer scans the code with their
phone and lands on the project page, where they can sign in and join.

## Data Requirements

- `GET /api/projects/:slug` — `title`, `summary`, `links.chatChannel`

If the slug is unknown or soft-deleted (and the caller isn't staff): the
same 404 page as [project-detail.md](project-detail.md).

## Display Rules

Centered on the page, top to bottom:

1. The Code for Philly logo.
2. The project's `title`, large.
3. The project's `summary`, if any, in one or two lines.
4. A QR code encoding the project page's absolute URL —
   `<site origin>/projects/<slug>` (the origin the card was opened on, so
   a card printed from production reads `https://codeforphilly.org/…`).
   About four inches square when printed.
5. "Scan to join this project".
6. The same URL as text without the scheme (`codeforphilly.org/projects/<slug>`)
   for anyone who can't scan.
7. "Chat: #<chatChannel> on the Code for Philly Slack" when the project has
   a `chatChannel`.

On screen, above the card, two controls: "Print" (opens the browser's print
dialog) and "Back to project" (→ `/projects/<slug>`). Neither prints.

**In print:** only the card. The app shell is already hidden by the print
stylesheet ([app-shell.md](../behaviors/app-shell.md#print)); the card
fits one US Letter or A4 page in portrait, black on white.

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Print | Browser print dialog | "Print" button |

## Navigation

**To here:** the "Table card" button in the project page's Share section.

**From here:** `/projects/<slug>`.

## Principles

**Local:**

- **The card points at the project page, nothing deeper.** The project page
  already walks a newcomer from "Sign in to contribute" back to "Join
  Project", and it is also what a curious passer-by should see. A link that
  joins on arrival would make scanning a commitment.
- **Anyone can print one.** The project page is public, so its card is
  too; whoever is staffing the table doesn't have to be the maintainer.
