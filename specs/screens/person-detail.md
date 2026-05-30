# Screen: Person Detail

## Route

`/members/:slug` — public.

## Data Requirements

- `GET /api/people/:slug`
- `GET /api/auth/me`

## Display Rules

### Header

- Avatar (large, 192px)
- H1 — `fullName`
- Below name: small text "Member since {createdAt:'MMM yyyy'}"
- Tag chips row (topics + tech mixed, color-coded by namespace)
- Right side: "Edit profile" button if `permissions.canEdit`

### Bio

Section "About" with `bioHtml`. If empty: hidden.

### Projects

Heading "Projects" with count "(N)".

For each membership:

- Project title + slug (linked)
- Stage badge
- Role chip (e.g., "Designer") if present
- "Maintainer" chip if `isMaintainer`
- Joined date

Ordered by `isMaintainer DESC, joinedAt DESC`. If empty: "Not a member of any projects yet." With a "Browse projects" link.

### Recent activity

Heading "Recent updates" — last 5 ProjectUpdate items authored by this person, each as a compact card linking to the project's updates page.

### Sidebar (right, ≥ lg)

- "Contact" — Slack DM link if `slackHandle` is set; email shown for self + staff (per the Authorization table below); section hidden when both are absent.
- "Member since" date
- For self: "Manage account" link to `/account` (settings spec deferred; covered in account.md when written)
- For staff: "Audit log" link (deferred)

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Edit profile | Navigation to `/members/:slug/edit` | – |
| Project click | Navigation | – |
| Tag click | Navigation to `/tags/<handle>` | – |
| Send Slack message | External link | – |

## Navigation

**To here:** Members directory, project member avatars, update author links, "Edit profile" from account settings.

**From here:** `/members/:slug/edit`, `/projects/<slug>`, `/tags/...`.

## Authorization

| Caller | Sees |
| ------ | ---- |
| Anonymous | Public profile (no email, generic accountLevel) |
| User | Same as anonymous |
| Self | + email, + actual accountLevel, + "Manage account" link |
| Staff | + email, + actual accountLevel, + "Audit log" link |
| Administrator | + "Impersonate" button (deferred) |

If the person is soft-deleted:

- Non-staff: 404
- Staff: shows the profile with a banner "This member's account has been deleted" and a "Restore" button (admin-only)
