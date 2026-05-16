# Screen: Project Edit / Create

## Route

- `/projects/create` — public route, requires `user` (anonymous redirected to `/login?return=/projects/create`)
- `/projects/:slug/edit` — public route, requires `permissions.canEdit` (anyone else gets 403)

Both render the same form component with different "mode" and pre-fill.

## Data Requirements

- On `create`: empty form, plus `GET /api/tags?namespace=tech` etc to populate tag pickers
- On `edit`: `GET /api/projects/:slug` + tag space
- `GET /api/auth/me` to confirm authorization

## Display Rules

### Header

- H1:
  - Create: "New project"
  - Edit: `"Edit project: " + project.title`
- Right side: "Save" (primary), "Cancel" (links back — to `/projects` on create, to `/projects/:slug` on edit)

### Form fields

In order:

| Field | Widget | Required | Notes |
| ----- | ------ | :------: | ----- |
| Title | Text input | ✓ | 1–200 chars |
| Slug | Text input | ✓ on create | Auto-filled from title via slugify on create. On edit, only visible to staff (matches PATCH allowed-fields). |
| Summary | Text input | – | ≤ 280, character counter |
| Overview | Markdown editor | – | Side-by-side preview, drag-drop image upload not in v1. Long-form project description authored on-site; *not* synced from any GitHub README. |
| Stage | Select | ✓ | Default `commenting` on create. Options labeled with name + description from [behaviors/project-stages.md](../behaviors/project-stages.md) |
| Users' URL | URL input | – | HTTPS only |
| Developers' URL | URL input | – | HTTPS only |
| Chat channel | Text input with `#` prefix decoration | – | No `#` stored |
| Topics | Multi-select with chips | – | Allows typing new tags; staff-only typing creates, non-staff sees autocomplete-only |
| Tech | Multi-select with chips | – | Same |
| Events | Multi-select with chips | – | Same |
| Featured | Checkbox | – | Staff-only, hidden for non-staff. Adds to home page rotation. |

When `permissions.canChangeStage === false` on edit, the Stage select is disabled with a tooltip. v1: this is always true if `permissions.canEdit` is true.

### Validation

- Inline per-field errors keyed on `error.fields`
- Submit button disabled while pristine or submitting
- Network errors surface a toast: "Couldn't save. Try again or check your connection."

### Slug behavior

- On create: typing in title auto-fills slug via slugify until the user manually edits slug. After manual edit, the link is broken.
- Slug field shows availability hint after debounce (calls `GET /api/projects/:proposedSlug` → 404 = available, 200 = taken).

### Delete (edit mode only, administrator only)

Bottom of the form, in a "Danger zone" section with red outline:

- "Delete project" button → opens confirm dialog (typed-confirmation: type the project's slug to confirm)
- After delete: redirect to `/projects` with a success toast "Project deleted. [Undo]" (the Undo button calls the restore endpoint)

### Cancel

- Create: navigate to `/projects`
- Edit: navigate to `/projects/:slug`
- If form is dirty, confirm modal "Discard changes?"

## Actions

| Action | API call | On success |
| ------ | -------- | ---------- |
| Save (create) | `POST /api/projects` | Navigate to `/projects/<newSlug>` |
| Save (edit) | `PATCH /api/projects/:slug` | Navigate to `/projects/<slug>` (with new slug if changed) |
| Delete | `DELETE /api/projects/:slug` | Navigate to `/projects` with undo toast |

## Navigation

**To here:** "Add Project" button on `/projects`, "Edit Project" button on project detail, search results when no project matches and user wants to create.

**From here:** Project detail page, projects list, login (if unauthenticated).

## Authorization

Same matrix as [project-detail.md](project-detail.md):

- `/projects/create` — any `user` or above
- `/projects/:slug/edit` — `maintainer` or `staff`
- Slug field visibility — `staff` only on edit
- Featured toggle — `staff` only
- Delete — `administrator` only
