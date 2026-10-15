---
status: in-progress
depends: [chat-redirect]
specs:
  - specs/screens/chat.md
issues: [230]
---

# Plan: In-app links to /chat navigate to the server

## Scope

Clicking "Slack" in the footer (and every other in-app link to `/chat`)
shows the SPA's 404 page, because the links are React Router `<Link>`s and
`/chat` is a server-side redirect the client router has no route for. A
new tab or a refresh works, which is why it went unnoticed.

**In:** the five `/chat` links (footer, Volunteer, events empty state,
project "Chat Channel" button, project card "Chat") become plain anchors;
a lint rule rejects router links whose literal target starts with `/chat`,
`/api/` or `/calendar`.

**Out:** the visible Slack entry point in the header (#231).

## Implements

- [screens/chat.md](../specs/screens/chat.md#linking-to-it-from-the-app)

## Approach

1. `<Link to="/chat…">` → `<a href="/chat…">`, keeping classes and the
   `Button asChild` wrappers.
2. `no-restricted-syntax` in `eslint.config.js` for `apps/web`: a
   `to` attribute whose string literal, or template literal's first
   chunk, starts with one of the server prefixes.

## Validation

- [ ] `npm run type-check && npm run lint && npm test` clean.
- [ ] The rule flags the five links before the fix (checked by running
  lint against the unfixed tree).
- [ ] In the built app, clicking footer "Slack" leaves the SPA for the
  Slack SSO start URL instead of rendering the 404 page.

## Risks / unknowns

- The lint rule only sees literal targets; a computed `to={someVar}`
  slips past. Acceptable: every current server link is a literal.

## Notes

## Follow-ups
