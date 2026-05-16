# Screen: Project Detail

## Route

`/projects/:slug` — public. Replaces laddr's `project.tpl`.

## Data Requirements

- `GET /api/projects/:slug` — full Project shape including `permissions`
- `GET /api/projects/:slug/updates?perPage=20` — activity feed (lazy after first paint)
- `GET /api/projects/:slug/buzz?perPage=20` — buzz feed (lazy after first paint)
- `GET /api/projects/:slug/help-wanted?status=open` — open roles
- `GET /api/auth/me`

If slug is unknown or soft-deleted (and caller isn't staff): 404 page.

## Display Rules

### Header

- **H1** — `project.title`
- **Stage indicator** — full-width horizontal progress bar styled per [behaviors/project-stages.md](../behaviors/project-stages.md). Tooltip on the bar shows the stage description. Pill on the right end shows the stage name.
- **Action buttons** (top right) — visibility per `permissions`:
  - "Edit Project" — `permissions.canEdit`
  - Dropdown "More ▼":
    - "Add Member" → opens modal
    - "Log Buzz" → links to `/projects/:slug/buzz/new`
    - "Post Update" → opens modal (`permissions.canPostUpdate`)
    - "Post Help-Wanted Role" → opens modal (`permissions.canPostHelpWanted`)
    - "Manage Members" → opens modal (`permissions.canManageMembers`)
  - "Delete Project" — `permissions.canDelete` (administrator)

### Main column (two-thirds width at lg, full at sm)

1. **README**
   - Heading "README"
   - Rendered HTML from `readmeHtml`
   - If `readme` is null/empty: hide the section

2. **Open help-wanted roles** _(new section, between README and Activity)_
   - Heading "Help Wanted"
   - One card per open role, oldest to newest within the screen:
     - Title (bold)
     - Description (rendered markdown, truncated to 4 lines with "Read more")
     - Commitment chip if set ("~4 hrs/week" or "Flexible commitment")
     - Tag chips
     - Action button — "Express Interest" if `permissions.canExpressInterest && !alreadyExpressedInterest`; "Interest Sent ✓" if already; hidden if not signed in (replaced by "Sign in to express interest" link)
   - If `permissions.canPostHelpWanted`: "Post new role" button at top of section
   - If there are no open roles AND the caller can't post: hide the whole section

3. **Activity**
   - Heading "Project Activity" with right-side button group:
     - "Post Update" (if `permissions.canPostUpdate`)
     - "Log Buzz" (any signed-in user)
   - Combined list of ProjectUpdate and ProjectBuzz items in reverse-chronological order. Card rendering rules in [behaviors/activity-feed.md](../behaviors/activity-feed.md).
   - Empty state: "This project doesn't have any activity yet, post an update or log some buzz!"

### Sidebar (one-third width at lg, full below)

1. **Project Info**

   Block of stacked CTAs:
   - "Users' Site" → `usersUrl` (primary button)
   - "Developers' Site" → `developersUrl` (success button)
   - "Chat Channel" → `/chat?channel=<chatChannel>` (success button) — falls back to plain text `#channel-name` if no chat linker configured

2. **Members**
   - Heading "Members"
   - Avatar grid: each member, maintainer largest (64px) and outlined, others 48px
   - Hover tooltip shows full name + role
   - "+ Add" button (if `permissions.canManageMembers`) opens add-member modal

3. **Tags**
   - "Tech:" then a list of tag chips (linked to tag pages) — if `tags.tech.length`
   - "Topics:" then chips — if `tags.topic.length`
   - "Events:" then chips — if `tags.event.length`

4. **Share**
   - "Copy link" button (copies `https://codeforphilly.org/projects/<slug>`)
   - "Share to Slack" button — opens a system share or copies a pre-formatted Slack message
   - _Twitter/X share removed_, see [deferred.md](../deferred.md)

5. **Info**
   - "Created" relative time + tooltip with absolute
   - "Last updated" relative time + tooltip with absolute
   - "Stage: <name>" with link "What does this stage mean?" → opens a modal with the full description from [behaviors/project-stages.md](../behaviors/project-stages.md)

### Footer

- "Edit on GitHub" link if `developersUrl` is a github.com URL — small, muted link
- Soft-delete banner across the top if `project.deletedAt is not null` and caller is staff: yellow strip "This project is deleted. [Restore]"

## Actions

| Action | Affects | Caused by |
| ------ | ------- | --------- |
| Edit project | Navigation to `/projects/:slug/edit` | "Edit Project" button |
| Post update | `POST /api/projects/:slug/updates`; modal then refetch activity | Modal submit |
| Log buzz | Navigation to `/projects/:slug/buzz/new` | "Log Buzz" button |
| Post help-wanted | `POST /api/projects/:slug/help-wanted`; modal then refetch help-wanted | Modal submit |
| Add member | `POST /api/projects/:slug/members` | Modal submit |
| Manage members | Modal listing memberships with role + remove + change-maintainer buttons | "Manage Members" |
| Join project | `POST /api/projects/:slug/members/join` | Sidebar "Join Project" button (visible to user who isn't a member yet) |
| Express interest in role | `POST /api/projects/:slug/help-wanted/:roleId/express-interest` | Card button |
| Mark role filled / close / reopen | Respective endpoints; modal with optional `filledBySlug` | Role card menu |
| Change maintainer | `POST /api/projects/:slug/change-maintainer` with `personSlug` | Manage members modal |
| Delete project | `DELETE /api/projects/:slug` then redirect to `/projects` | "Delete Project" button → confirm modal |

All modals are shadcn `Dialog` components. Forms post via fetch, show server validation errors inline (matching `error.fields`), and close on success.

## Navigation

**To here:** Project list, search results, member profile (memberships), activity feed cards, help-wanted browse.

**From here:**

- `/projects` (back)
- `/members/<slug>` (member avatars, author links)
- `/projects/<slug>/edit`
- `/projects/<slug>/updates/<number>` (permalink on individual updates)
- `/projects/<slug>/buzz/<buzzSlug>` (permalink on individual buzz)
- `/projects/<slug>/buzz/new`
- `/tags/<namespace>/<slug>` (tag chips)
- External: `usersUrl`, `developersUrl`, Slack channel

## Authorization

`permissions` on the response is authoritative for UI gating. Server enforces the same rules on every mutation; the response is just a hint to suppress disabled buttons.

| Action | Anonymous | User (non-member) | Member | Maintainer | Staff | Admin |
| ------ | :-------: | :---------------: | :----: | :--------: | :---: | :---: |
| View project | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Join project | – | ✓ | – | – | – | – |
| Leave project | – | – | ✓ | – (must transfer first) | – | – |
| Post update | – | – | ✓ | ✓ | ✓ | ✓ |
| Log buzz | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Add member | – | – | – | ✓ | ✓ | ✓ |
| Remove member | – | – | – | ✓ (not self if maintainer) | ✓ | ✓ |
| Change maintainer | – | – | – | ✓ | ✓ | ✓ |
| Post help-wanted role | – | – | – | ✓ | ✓ | ✓ |
| Express interest | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit project | – | – | – | ✓ | ✓ | ✓ |
| Edit slug | – | – | – | – | ✓ | ✓ |
| Delete project | – | – | – | – | – | ✓ |
| Restore project | – | – | – | – | ✓ | ✓ |
